import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Check, Film, Image, X } from 'lucide-react';
import api, { apiErrorMessage } from '../services/api';
import { uploadMultipartParts, validateUploadFileSize } from '../services/multipartUpload';
import { createArtworkUploadCache, uploadArtworkFile, validateArtworkFile } from '../services/artworkUpload';
import VjManagementDialog from './VjManagementDialog';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export default function UploadDialog({ onClose, onCreated }) {
  const [file, setFile] = useState(null);
  const [posterFile, setPosterFile] = useState(null);
  const [backdropFile, setBackdropFile] = useState(null);
  const [posterPreview, setPosterPreview] = useState('');
  const [backdropPreview, setBackdropPreview] = useState('');
  const [vjs, setVjs] = useState([]);
  const [vjError, setVjError] = useState('');
  const [vjManagementOpen, setVjManagementOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('selecting');
  const [publishedMovie, setPublishedMovie] = useState(null);
  const [completedUpload, setCompletedUpload] = useState(null);
  const [error, setError] = useState('');
  const abortControllerRef = useRef(null);
  const artworkUploadCacheRef = useRef(null);
  if (!artworkUploadCacheRef.current) {
    artworkUploadCacheRef.current = createArtworkUploadCache();
  }

  const loadVjs = useCallback(async () => {
    setVjError('');
    try {
      const { data } = await api.get('/vjs.php');
      setVjs(data.vjs);
    } catch (requestError) {
      setVjError(apiErrorMessage(requestError));
    }
  }, []);

  useEffect(() => {
    loadVjs();
  }, [loadVjs]);

  useEffect(() => {
    if (!posterFile) {
      setPosterPreview('');
      return undefined;
    }
    const previewUrl = URL.createObjectURL(posterFile);
    setPosterPreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [posterFile]);

  useEffect(() => {
    if (!backdropFile) {
      setBackdropPreview('');
      return undefined;
    }
    const previewUrl = URL.createObjectURL(backdropFile);
    setBackdropPreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [backdropFile]);

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape' && !busy) onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, onClose]);

  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!file) {
      setError('Choose a video file first.');
      return;
    }
    if (!form.get('vj_id')) {
      setError('Choose the VJ who translated this movie.');
      return;
    }
    try {
      validateUploadFileSize(file.size);
      validateArtworkFile(posterFile);
      validateArtworkFile(backdropFile);
    } catch (sizeError) {
      setError(sizeError.message);
      return;
    }
    if (file.type && file.type !== 'video/mp4') {
      setError('Select the compressed MP4 produced by the Rayn video pipeline.');
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setBusy(true);
    setError('');
    const retryUpload = completedUpload?.file === file ? completedUpload : null;
    let upload = retryUpload ? { r2_key: retryUpload.r2_key } : null;
    setProgress(upload ? 100 : 0);
    setUploadStatus(upload ? 'registering' : 'preparing');
    let multipartUpload = retryUpload?.multipartUpload ?? null;
    let multipartParts = retryUpload?.parts ?? null;
    let completionPending = Boolean(retryUpload?.completionPending);
    let uploadCompleted = Boolean(upload && !completionPending);
    let completionAttempted = false;
    let cleanupError = '';

    try {
      if (!upload) {
        const { data: presign } = await api.post('/upload/presign.php', {
          content_type: 'video/mp4',
          file_size_bytes: file.size,
        }, { signal: controller.signal });
        upload = presign;

        if (upload.mode === 'multipart') {
          multipartUpload = { r2_key: upload.r2_key, upload_id: upload.upload_id };
          setUploadStatus('uploading');
          const parts = await uploadMultipartParts({
            file,
            r2Key: upload.r2_key,
            uploadId: upload.upload_id,
            partSizeBytes: upload.part_size_bytes,
            signal: controller.signal,
            onProgress: ({ percent }) => setProgress(percent),
            requestPartUrl: async ({ r2_key, upload_id, part_number, signal }) => {
              const { data } = await api.post('/upload/multipart/part.php', {
                r2_key,
                upload_id,
                part_number,
              }, { signal });
              return data;
            },
            putPart: (url, chunk, options) => axios.put(url, chunk, {
              signal: options.signal,
              headers: { 'Content-Type': 'application/octet-stream' },
              onUploadProgress: options.onUploadProgress,
            }),
          });

          multipartParts = parts;
          completionPending = true;
          setCompletedUpload({
            file,
            r2_key: upload.r2_key,
            multipartUpload,
            parts: multipartParts,
            completionPending: true,
          });
        } else {
          setUploadStatus('uploading');
          await axios.put(upload.upload_url, file, {
            headers: upload.required_headers,
            signal: controller.signal,
            onUploadProgress: (event) => {
              if (event.total) setProgress(Math.round((event.loaded * 100) / event.total));
            },
          });
          uploadCompleted = true;
        }
      }

      if (multipartUpload && completionPending) {
        setUploadStatus('completing');
        completionAttempted = true;
        await api.post('/upload/multipart/complete.php', {
          ...multipartUpload,
          parts: multipartParts,
          expected_size_bytes: file.size,
        }, { signal: controller.signal });
        uploadCompleted = true;
        completionPending = false;
      }

      if (uploadCompleted) {
        setCompletedUpload({ file, r2_key: upload.r2_key });
        setProgress(100);
        setUploadStatus('uploaded');
      }

      setUploadStatus('uploading-poster');
      const posterKey = await uploadArtworkFile(posterFile, 'poster', {
        api,
        signal: controller.signal,
        cache: artworkUploadCacheRef.current,
        putFile: (url, image, options) => axios.put(url, image, options),
      });
      setUploadStatus('uploading-backdrop');
      const backdropKey = await uploadArtworkFile(backdropFile, 'backdrop', {
        api,
        signal: controller.signal,
        cache: artworkUploadCacheRef.current,
        putFile: (url, image, options) => axios.put(url, image, options),
      });

      setUploadStatus('registering');
      const { data } = await api.post('/movies/create.php', {
        title: form.get('title'),
        description: form.get('description'),
        tier: form.get('tier'),
        release_year: Number(form.get('release_year')),
        duration_minutes: Number(form.get('duration_minutes')),
        poster_key: posterKey,
        backdrop_key: backdropKey,
        vj_id: Number(form.get('vj_id')),
        file_size_bytes: file.size,
        r2_key: upload.r2_key,
      }, { signal: controller.signal });
      setCompletedUpload(null);
      setPublishedMovie(data.movie);
      setUploadStatus('published');
    } catch (requestError) {
      if (multipartUpload && !uploadCompleted && !completionAttempted) {
        try {
          await api.post('/upload/multipart/abort.php', multipartUpload);
        } catch (abortError) {
          cleanupError = ` Incomplete-upload cleanup also failed: ${apiErrorMessage(abortError)}`;
        }
      }
      if (controller.signal.aborted || axios.isCancel(requestError) || requestError.name === 'AbortError') {
        setUploadStatus('cancelled');
        const incompleteMultipartWasAborted = multipartUpload && !uploadCompleted && !completionAttempted;
        const cleanupMessage = cleanupError || (incompleteMultipartWasAborted ? ' Incomplete multipart parts were aborted.' : '');
        setError(`Upload cancelled.${cleanupMessage}`);
      } else {
        setUploadStatus('failed');
        setError(`${apiErrorMessage(requestError)}${cleanupError}`);
      }
    } finally {
      setBusy(false);
      abortControllerRef.current = null;
    }
  }

  function cancelUpload() {
    setUploadStatus('cancelling');
    abortControllerRef.current?.abort();
  }

  const statusLabels = {
    selecting: 'Select compressed MP4',
    preparing: 'Preparing secure upload',
    uploading: 'Uploading to private storage',
    'uploading-poster': 'Uploading poster image',
    'uploading-backdrop': 'Uploading backdrop image',
    completing: 'Completing multipart upload',
    uploaded: 'Upload completed',
    registering: 'Registering movie',
    published: 'Movie successfully published',
    cancelling: 'Cancelling and cleaning up',
    cancelled: 'Upload cancelled',
    failed: 'Upload failed',
  };
  const cancelableUploadStatuses = ['uploading', 'uploading-poster', 'uploading-backdrop'];
  const canCancel = busy && cancelableUploadStatuses.includes(uploadStatus);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="dialog upload-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-title">
        <button className="icon-button dialog-close" type="button" aria-label="Close" disabled={busy} onClick={onClose}>
          <X size={19} />
        </button>
        <span className="eyebrow">LIBRARY MANAGEMENT</span>
        <h2 id="upload-title">Add a film</h2>
        <p className="dialog-copy">Select the MP4 encoded with the Rayn video pipeline. Large files upload in retryable parts directly to private storage.</p>
        {publishedMovie ? (
          <div className="upload-result" role="status" aria-live="polite">
            <span className="upload-result-icon"><Check size={19} /></span>
            <span className="eyebrow">{statusLabels.published}</span>
            <h3>{publishedMovie.title}</h3>
            <p>{file?.name} · {formatBytes(file?.size)}</p>
            <button className="button button-primary form-submit" type="button" onClick={() => onCreated(publishedMovie)}>
              Done
            </button>
          </div>
        ) : <form className="form-stack" onSubmit={submit}>
          <label>
            Title
            <input name="title" maxLength="255" required />
          </label>
          <div className="form-row">
            <label>
              Access tier
              <select name="tier" defaultValue="free" required>
                <option value="free">Free</option>
                <option value="vip">VIP</option>
              </select>
            </label>
            <label>
              Release year
              <input name="release_year" type="number" min="1888" max={new Date().getFullYear() + 5} required />
            </label>
            <label>
              Runtime (min)
              <input name="duration_minutes" type="number" min="1" max="1000" required />
            </label>
          </div>
          <label>
            Description
            <textarea name="description" maxLength="10000" rows="3" />
          </label>
          <label>
            VJ <span className="optional-label">Required</span>
            <select name="vj_id" defaultValue="" required disabled={busy}>
              <option value="" disabled>{vjs.length ? 'Select the VJ' : 'No active VJs available'}</option>
              {vjs.map((vj) => <option key={vj.id} value={vj.id}>{vj.name}</option>)}
            </select>
            {vjError && <span className="form-error" role="alert">{vjError}</span>}
          </label>
          <button className="button button-quiet" type="button" disabled={busy} onClick={() => setVjManagementOpen(true)}>
            Manage VJs
          </button>
          <label className="file-picker">
            <Image size={19} />
            <span>{posterFile ? `Poster: ${posterFile.name} · ${formatBytes(posterFile.size)}` : 'Select poster image (optional)'}</span>
            <input
              accept="image/jpeg,image/png,image/webp"
              type="file"
              disabled={busy}
              onChange={(event) => {
                setPosterFile(event.target.files?.[0] || null);
                setError('');
              }}
            />
          </label>
          {posterPreview && <img className="artwork-preview artwork-preview-poster" src={posterPreview} alt="Poster preview" />}
          <label className="file-picker">
            <Image size={19} />
            <span>{backdropFile ? `Backdrop: ${backdropFile.name} · ${formatBytes(backdropFile.size)}` : 'Select landscape backdrop (optional)'}</span>
            <input
              accept="image/jpeg,image/png,image/webp"
              type="file"
              disabled={busy}
              onChange={(event) => {
                setBackdropFile(event.target.files?.[0] || null);
                setError('');
              }}
            />
          </label>
          {backdropPreview && <img className="artwork-preview artwork-preview-backdrop" src={backdropPreview} alt="Backdrop preview" />}
          <label className="file-picker">
            <Film size={19} />
            <span>{file ? `${file.name} · ${formatBytes(file.size)}` : 'Select compressed MP4'}</span>
            <input
              accept=".mp4,video/mp4"
              type="file"
              required
              disabled={busy}
              onChange={(event) => {
                setFile(event.target.files?.[0] || null);
                setCompletedUpload(null);
                setUploadStatus('selecting');
                setProgress(0);
                setError('');
              }}
            />
          </label>
          {uploadStatus !== 'selecting' && (
            <div className={`upload-status upload-status-${uploadStatus}`} aria-live="polite">
              <span>{statusLabels[uploadStatus]}{uploadStatus === 'uploading' ? ` · ${progress}%` : ''}</span>
              {uploadStatus === 'registering' && <span className="upload-complete-note">Upload completed</span>}
              {(uploadStatus === 'uploading' || uploadStatus === 'uploaded' || uploadStatus === 'registering') && (
                <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
              )}
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          {canCancel && <button className="button button-upload-cancel form-submit" type="button" onClick={cancelUpload}>Cancel upload</button>}
          {uploadStatus === 'cancelling' && <button className="button button-upload-cancel form-submit" type="button" disabled>Cancelling…</button>}
          <button className="button button-primary form-submit" type="submit" disabled={busy}>
            {busy ? 'Working…' : completedUpload?.file === file ? completedUpload.completionPending ? 'Retry completion' : 'Retry registration' : uploadStatus === 'failed' || uploadStatus === 'cancelled' ? 'Try upload again' : 'Upload and publish'}
          </button>
        </form>}
        {vjManagementOpen && (
          <VjManagementDialog
            onClose={() => setVjManagementOpen(false)}
            onChanged={loadVjs}
          />
        )}
      </section>
    </div>
  );
}