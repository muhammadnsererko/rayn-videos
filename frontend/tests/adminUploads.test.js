import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadVideoFile } from '../src/services/adminUploads.js';

function fakeApi(response) {
  const calls = [];
  return {
    calls,
    post: async (path, body) => {
      calls.push({ path, body });
      return { data: response[path] };
    },
  };
}

test('uploads a replacement as a single private PUT and reports progress', async () => {
  const api = fakeApi({
    '/upload/presign.php': {
      mode: 'single',
      upload_url: 'https://r2.test/video',
      r2_key: `uploads/${'a'.repeat(32)}.mp4`,
      required_headers: { 'Content-Type': 'video/mp4' },
    },
  });
  const progress = [];
  const putRequests = [];
  const uploaded = await uploadVideoFile(new Blob(['video'], { type: 'video/mp4' }), {
    api,
    putFile: async (url, body, options) => {
      putRequests.push({ url, body, options });
    },
    onProgress: (value) => progress.push(value),
  });

  assert.equal(putRequests[0].url, 'https://r2.test/video');
  assert.equal(putRequests[0].options.headers['Content-Type'], 'video/mp4');
  assert.equal(uploaded.r2_key, `uploads/${'a'.repeat(32)}.mp4`);
  assert.equal(uploaded.file_size_bytes, 5);
  assert.equal(progress.at(-1).percent, 100);
});

test('completes multipart replacement uploads with ETags', async () => {
  const partSize = 5 * 1024 * 1024;
  const api = fakeApi({
    '/upload/presign.php': {
      mode: 'multipart',
      r2_key: `uploads/${'b'.repeat(32)}.mp4`,
      upload_id: 'session-id',
      part_size_bytes: partSize,
    },
    '/upload/multipart/part.php': { upload_url: 'https://r2.test/part' },
    '/upload/multipart/complete.php': { completed: true },
  });
  const uploaded = await uploadVideoFile(new Blob([new Uint8Array(partSize + 1)], { type: 'video/mp4' }), {
    api,
    putFile: async () => ({ headers: { etag: '"part-etag"' } }),
  });

  const completion = api.calls.find((call) => call.path === '/upload/multipart/complete.php');
  assert.equal(completion.body.parts.length, 2);
  assert.equal(completion.body.parts[0].etag, '"part-etag"');
  assert.equal(completion.body.expected_size_bytes, partSize + 1);
  assert.equal(uploaded.r2_key, `uploads/${'b'.repeat(32)}.mp4`);
});

test('aborts incomplete multipart uploads when a part fails', async () => {
  const api = fakeApi({
    '/upload/presign.php': {
      mode: 'multipart',
      r2_key: `uploads/${'c'.repeat(32)}.mp4`,
      upload_id: 'session-id',
      part_size_bytes: 5 * 1024 * 1024,
    },
    '/upload/multipart/part.php': { upload_url: 'https://r2.test/part' },
    '/upload/multipart/abort.php': { aborted: true },
  });

  await assert.rejects(uploadVideoFile(new Blob(['video'], { type: 'video/mp4' }), {
    api,
    putFile: async () => { throw new Error('R2 unavailable'); },
  }), /Part 1 failed/);
  assert.equal(api.calls.some((call) => call.path === '/upload/multipart/abort.php'), true);
});
