import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_UPLOAD_BYTES,
  uploadMultipartParts,
  validateUploadFileSize,
} from '../src/services/multipartUpload.js';

const PART_SIZE = 5 * 1024 * 1024;

function makeFile(size) {
  return new Blob([new Uint8Array(size)]);
}

function successfulUpload(overrides = {}) {
  return {
    file: makeFile(PART_SIZE + 17),
    r2Key: 'uploads/test.mp4',
    uploadId: 'test-upload',
    partSizeBytes: PART_SIZE,
    requestPartUrl: async ({ part_number }) => ({ upload_url: `https://r2.test/part/${part_number}` }),
    putPart: async (_url, _chunk, { onUploadProgress }) => {
      onUploadProgress({ loaded: _chunk.size });
      return { headers: { etag: '"part-etag"' } };
    },
    ...overrides,
  };
}

test('accepts 889 MB and 950 MB files within the upload maximum', () => {
  assert.equal(MAX_UPLOAD_BYTES, 1_000_000_000);
  assert.doesNotThrow(() => validateUploadFileSize(889_000_000));
  assert.doesNotThrow(() => validateUploadFileSize(950_000_000));
});

test('rejects files larger than 1 GB before multipart upload', async () => {
  assert.throws(() => validateUploadFileSize(MAX_UPLOAD_BYTES + 1), /maximum upload size/);
  await assert.rejects(
    uploadMultipartParts(successfulUpload({ file: { size: MAX_UPLOAD_BYTES + 1 } })),
    /maximum upload size/,
  );
});

test('uploads and returns ordered part ETags with aggregate progress', async () => {
  const progress = [];
  const parts = await uploadMultipartParts({
    ...successfulUpload(),
    concurrency: 2,
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(parts, [
    { part_number: 1, etag: '"part-etag"' },
    { part_number: 2, etag: '"part-etag"' },
  ]);
  assert.equal(progress.at(-1).loaded, PART_SIZE + 17);
  assert.equal(progress.at(-1).percent, 100);
});

test('re-presigns and retries a failed part', async () => {
  let attempts = 0;
  let signedRequests = 0;
  const parts = await uploadMultipartParts(successfulUpload({
    requestPartUrl: async () => {
      signedRequests += 1;
      return { upload_url: 'https://r2.test/retry' };
    },
    putPart: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary network failure');
      return { headers: { etag: 'retried-etag' } };
    },
  }));

  assert.equal(attempts, 3);
  assert.equal(signedRequests, 3);
  assert.equal(parts[0].etag, 'retried-etag');
});

test('rejects after the configured retry count', async () => {
  await assert.rejects(
    uploadMultipartParts(successfulUpload({
      file: makeFile(PART_SIZE),
      putPart: async () => { throw new Error('storage unavailable'); },
      maxAttempts: 2,
    })),
    /Part 1 failed after 2 attempts/,
  );
});

test('reports the failed part instead of a sibling cancellation', async () => {
  await assert.rejects(
    uploadMultipartParts(successfulUpload({
      file: makeFile(PART_SIZE * 2),
      concurrency: 2,
      maxAttempts: 1,
      requestPartUrl: async ({ part_number }) => ({ upload_url: `https://r2.test/part/${part_number}` }),
      putPart: (url, _chunk, { signal }) => {
        if (url.endsWith('/2')) throw new Error('part storage failed');
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('sibling cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    })),
    /Part 2 failed after 1 attempts: part storage failed/,
  );
});

test('stops active part requests on cancellation', async () => {
  const controller = new AbortController();
  const upload = uploadMultipartParts(successfulUpload({
    file: makeFile(PART_SIZE),
    signal: controller.signal,
    putPart: (_url, _chunk, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  }));
  setImmediate(() => controller.abort());

  await assert.rejects(upload, { name: 'AbortError' });
});
