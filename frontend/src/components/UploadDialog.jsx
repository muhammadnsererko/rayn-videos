import { useEffect, useState } from 'react';
import axios from 'axios';
import { Film, X } from 'lucide-react';
import api, { apiErrorMessage } from '../services/api';

export default function UploadDialog({ onClose, onCreated }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

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

    setBusy(true);
    setError('');
    setProgress(0);

    try {
      setStatus('Preparing secure upload…');
      const { data: upload } = await api.post('/upload/presign.php', { content_type: file.type });

      setStatus('Uploading video to storage…');
      await axios.put(upload.upload_url, file, {
        headers: upload.required_headers,
        onUploadProgress: (event) => {
          if (event.total) setProgress(Math.round((event.loaded * 100) / event.total));
        },
      });

      setStatus('Saving movie details…');
      const { data } = await api.post('/movies/create.php', {
        title: form.get('title'),
        description: form.get('description'),
        tier: form.get('tier'),
        release_year: Number(form.get('release_year')),
        duration_minutes: Number(form.get('duration_minutes')),
        poster_url: form.get('poster_url') || '',
        r2_key: upload.r2_key,
      });
      onCreated(data.movie);
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="dialog upload-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-title">
        <button className="icon-button dialog-close" type="button" aria-label="Close" disabled={busy} onClick={onClose}>
          <X size={19} />
        </button>
        <span className="eyebrow">LIBRARY MANAGEMENT</span>
        <h2 id="upload-title">Add a film</h2>
        <p className="dialog-copy">Video uploads go directly to your private storage bucket.</p>
        <form className="form-stack" onSubmit={submit}>
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
            Poster image URL <span className="optional-label">Optional, HTTPS</span>
            <input name="poster_url" type="url" placeholder="https://…" />
          </label>
          <label className="file-picker">
            <Film size={19} />
            <span>{file ? file.name : 'Choose video file'}</span>
            <input
              accept="video/mp4,video/webm,video/quicktime"
              type="file"
              required
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>
          {busy && (
            <div className="upload-status" aria-live="polite">
              <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
              <span>{status}{status.startsWith('Uploading') ? ` ${progress}%` : ''}</span>
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button button-primary form-submit" type="submit" disabled={busy}>
            {busy ? 'Working…' : 'Upload and publish'}
          </button>
        </form>
      </section>
    </div>
  );
}