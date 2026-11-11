import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ARTWORK_UPLOAD_BYTES,
  createArtworkUploadCache,
  uploadArtworkFile,
  validateArtworkFile,
} from '../src/services/artworkUpload.js';

function imageFile(type = 'image/png', size = 10) {
  return { type, size };
}

test('accepts supported image types within the configured maximum', () => {
  assert.equal(MAX_ARTWORK_UPLOAD_BYTES, 5_000_000);
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    assert.doesNotThrow(() => validateArtworkFile(imageFile(type)));
  }
  assert.doesNotThrow(() => validateArtworkFile(imageFile('image/png', MAX_ARTWORK_UPLOAD_BYTES)));
  assert.doesNotThrow(() => validateArtworkFile(null));
});

test('rejects unsupported image types, empty files, and oversized artwork', () => {
  assert.throws(() => validateArtworkFile(imageFile('image/gif')), /JPG, PNG, or WebP/);
  assert.throws(() => validateArtworkFile(imageFile('image/png', 0)), /between 1 byte and 5 MB/);
  assert.throws(() => validateArtworkFile(imageFile('image/png', MAX_ARTWORK_UPLOAD_BYTES + 1)), /between 1 byte and 5 MB/);
});

test('caches successful poster and backdrop uploads independently across retries', async () => {
  const cache = createArtworkUploadCache();
  const poster = imageFile('image/jpeg');
  const backdrop = imageFile('image/webp');
  const requests = [];
  let failBackdropOnce = true;
  const api = {
    async post(_path, body) {
      requests.push(body.kind);
      return {
        data: {
          artwork_key: `${body.kind}s/${body.kind}-key`,
          upload_url: `https://r2.test/${body.kind}`,
          required_headers: { 'Content-Type': body.content_type },
        },
      };
    },
  };
  const putFile = async (_url, _file, options) => {
    assert.equal(options.signal, signal);
    if (_url.endsWith('/backdrop') && failBackdropOnce) {
      failBackdropOnce = false;
      throw new Error('temporary upload failure');
    }
  };
  const signal = new AbortController().signal;
  const options = { api, putFile, signal, cache };

  assert.equal(await uploadArtworkFile(poster, 'poster', options), 'posters/poster-key');
  await assert.rejects(uploadArtworkFile(backdrop, 'backdrop', options), /temporary upload failure/);
  assert.equal(await uploadArtworkFile(poster, 'poster', options), 'posters/poster-key');
  assert.equal(await uploadArtworkFile(backdrop, 'backdrop', options), 'backdrops/backdrop-key');
  assert.deepEqual(requests, ['poster', 'backdrop', 'backdrop']);
});
