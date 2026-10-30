import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import api, { apiErrorMessage } from '../services/api';

export default function PlayerDialog({ movie, onClose, onSignIn }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [requiresSignIn, setRequiresSignIn] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setUrl('');
    setLoading(true);
    setError('');
    setRequiresSignIn(false);

    api.get('/movies/play.php', {
      params: { id: movie.id },
      signal: controller.signal,
    })
      .then(({ data }) => {
        if (typeof data.url !== 'string' || data.url === '') {
          throw new Error('The playback link was invalid.');
        }
        if (active) setUrl(data.url);
      })
      .catch((requestError) => {
        if (active) {
          setError(apiErrorMessage(requestError));
          setRequiresSignIn(requestError.response?.status === 401);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [movie.id]);

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog player-dialog" role="dialog" aria-modal="true" aria-labelledby="player-title">
        <button className="icon-button dialog-close" type="button" aria-label="Close" onClick={onClose}>
          <X size={19} />
        </button>
        <span className="eyebrow">NOW PLAYING</span>
        <h2 id="player-title">{movie.title}</h2>
        {loading && (
          <div className="player-state" role="status">
            <span className="loader" />
            <p>Preparing your film</p>
          </div>
        )}
        {error && (
          <div className="player-state player-error" role="alert">
            <p>{error}</p>
            {requiresSignIn && (
              <button className="button button-primary" type="button" onClick={onSignIn}>Sign in</button>
            )}
          </div>
        )}
        {url && <video className="player-video" src={url} controls autoPlay playsInline controlsList="nodownload" />}
      </section>
    </div>
  );
}
