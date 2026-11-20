import { uploadMultipartParts, validateUploadFileSize } from './multipartUpload.js';
import { apiErrorMessage } from './errors.js';

export async function uploadVideoFile(file, {
  api,
  putFile,
  signal,
  onProgress = () => {},
}) {
  if (!file || (file.type && file.type !== 'video/mp4')) {
    throw new TypeError('Select a processed MP4 video.');
  }
  validateUploadFileSize(file.size);

  let multipartUpload = null;
  let completionAttempted = false;
  try {
    const { data: upload } = await api.post('/upload/presign.php', {
      content_type: 'video/mp4',
      file_size_bytes: file.size,
    }, { signal });

    if (upload.mode === 'multipart') {
      multipartUpload = { r2_key: upload.r2_key, upload_id: upload.upload_id };
      const parts = await uploadMultipartParts({
        file,
        r2Key: upload.r2_key,
        uploadId: upload.upload_id,
        partSizeBytes: upload.part_size_bytes,
        signal,
        onProgress,
        requestPartUrl: async ({ r2_key, upload_id, part_number, signal: requestSignal }) => {
          const { data } = await api.post('/upload/multipart/part.php', {
            r2_key,
            upload_id,
            part_number,
          }, { signal: requestSignal });
          return data;
        },
        putPart: putFile,
      });
      completionAttempted = true;
      await api.post('/upload/multipart/complete.php', {
        ...multipartUpload,
        parts,
        expected_size_bytes: file.size,
      }, { signal });
    } else {
      await putFile(upload.upload_url, file, {
        signal,
        headers: upload.required_headers,
        onUploadProgress: (event) => {
          if (event.total) onProgress({
            loaded: event.loaded,
            total: event.total,
            percent: Math.round(event.loaded * 100 / event.total),
          });
        },
      });
    }

    onProgress({ loaded: file.size, total: file.size, percent: 100 });
    return { r2_key: upload.r2_key, file_size_bytes: file.size };
  } catch (error) {
    if (multipartUpload && !completionAttempted) {
      try {
        await api.post('/upload/multipart/abort.php', multipartUpload);
      } catch (abortError) {
        throw new Error(`${apiErrorMessage(error)} Incomplete-upload cleanup also failed: ${apiErrorMessage(abortError)}`);
      }
    }
    throw error;
  }
}
