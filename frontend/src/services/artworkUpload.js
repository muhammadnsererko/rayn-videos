export const MAX_ARTWORK_UPLOAD_BYTES = 5_000_000;

const ALLOWED_ARTWORK_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function validateArtworkFile(file) {
  if (!file) return;
  if (!ALLOWED_ARTWORK_TYPES.has(file.type)) {
    throw new Error('Choose a JPG, PNG, or WebP image.');
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ARTWORK_UPLOAD_BYTES) {
    throw new Error('Image files must be between 1 byte and 5 MB.');
  }
}

export function createArtworkUploadCache() {
  const uploadsByFile = new WeakMap();
  return {
    get(file, kind) {
      return uploadsByFile.get(file)?.get(kind) || null;
    },
    set(file, kind, key) {
      const uploads = uploadsByFile.get(file) || new Map();
      uploads.set(kind, key);
      uploadsByFile.set(file, uploads);
    },
  };
}

export async function uploadArtworkFile(file, kind, { api, putFile, signal, cache }) {
  if (!file) return null;
  validateArtworkFile(file);

  const cachedKey = cache.get(file, kind);
  if (cachedKey) return cachedKey;

  const { data: presign } = await api.post('/upload/artwork-presign.php', {
    kind,
    content_type: file.type,
    file_size_bytes: file.size,
  }, { signal });
  await putFile(presign.upload_url, file, {
    headers: presign.required_headers,
    signal,
  });
  cache.set(file, kind, presign.artwork_key);
  return presign.artwork_key;
}
