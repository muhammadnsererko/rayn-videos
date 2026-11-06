function abortError() {
  const error = new Error('Upload cancelled.');
  error.name = 'AbortError';
  return error;
}

export const MAX_UPLOAD_BYTES = 1_000_000_000;

export function validateUploadFileSize(fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 1) {
    throw new TypeError('A non-empty file is required.');
  }
  if (fileSize > MAX_UPLOAD_BYTES) {
    throw new RangeError(`Video exceeds the maximum upload size of ${MAX_UPLOAD_BYTES.toLocaleString('en-US')} bytes.`);
  }
}

export async function uploadMultipartParts({
  file,
  r2Key,
  uploadId,
  partSizeBytes,
  requestPartUrl,
  putPart,
  signal,
  onProgress = () => {},
  concurrency = 3,
  maxAttempts = 3,
}) {
  if (!file) throw new TypeError('A non-empty file is required.');
  validateUploadFileSize(file.size);
  if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes < 5 * 1024 * 1024) {
    throw new TypeError('Multipart part size must be at least 5 MiB.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('Concurrency and retry attempts must be positive integers.');
  }

  const totalParts = Math.ceil(file.size / partSizeBytes);
  if (totalParts > 10_000) throw new RangeError('Upload exceeds the S3 multipart part limit.');
  const partProgress = new Array(totalParts).fill(0);
  const completedParts = new Array(totalParts);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  const publishProgress = () => {
    const loaded = partProgress.reduce((sum, value) => sum + value, 0);
    onProgress({ loaded, total: file.size, percent: Math.min(100, Math.floor(loaded / file.size * 100)) });
  };

  let nextPart = 0;
  async function worker() {
    while (true) {
      if (controller.signal.aborted) throw abortError();
      const index = nextPart;
      nextPart += 1;
      if (index >= totalParts) return;

      const partNumber = index + 1;
      const start = index * partSizeBytes;
      const chunk = file.slice(start, Math.min(start + partSizeBytes, file.size));
      let lastError;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (controller.signal.aborted) throw abortError();
        partProgress[index] = 0;
        publishProgress();
        try {
          const signedPart = await requestPartUrl({
            r2_key: r2Key,
            upload_id: uploadId,
            part_number: partNumber,
            signal: controller.signal,
          });
          const response = await putPart(signedPart.upload_url, chunk, {
            signal: controller.signal,
            onUploadProgress: (event) => {
              const loaded = Math.min(chunk.size, event.loaded || 0);
              partProgress[index] = loaded;
              publishProgress();
            },
          });
          const etag = response.headers?.etag || response.headers?.ETag;
          if (typeof etag !== 'string' || etag.length === 0) {
            throw new Error(`R2 did not return an ETag for part ${partNumber}. Check the bucket CORS ExposeHeaders setting.`);
          }
          completedParts[index] = { part_number: partNumber, etag };
          partProgress[index] = chunk.size;
          publishProgress();
          lastError = null;
          break;
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'CanceledError') {
            controller.abort();
            throw abortError();
          }
          lastError = error;
          if (attempt === maxAttempts) {
            controller.abort();
            throw new Error(`Part ${partNumber} failed after ${maxAttempts} attempts: ${error.message || 'unknown error'}`);
          }
        }
      }

      if (lastError) throw lastError;
    }
  }

  try {
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, totalParts) }, () => worker()),
    );
    const failedResult = results.find((result) => (
      result.status === 'rejected'
      && result.reason?.name !== 'AbortError'
      && result.reason?.name !== 'CanceledError'
    )) || results.find((result) => result.status === 'rejected');
    if (failedResult) throw failedResult.reason;
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
  }

  return completedParts;
}
