import { useEffect } from 'react';
import { Play, X } from 'lucide-react';

export default function MovieDetailsDialog({ movie, onClose, onPlay }) {
  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog movie-details-dialog" role="dialog" aria-modal="true" aria-labelledby="movie-details-title">
        <button className="icon-button dialog-close" type="button" aria-label="Close" onClick={onClose}>
          <X size={19} />
        </button>
        <span className="eyebrow">FILM DETAILS</span>
        <h2 id="movie-details-title">{movie.title}</h2>
        <div className="hero-meta">
          {movie.release_year && <span>{movie.release_year}</span>}
          {movie.duration_minutes && <span>{movie.duration_minutes} min</span>}
          <span className={`tier-tag tier-${movie.tier}`}>{movie.tier}</span>
        </div>
        <p className="dialog-copy movie-details-description">
          {movie.description || 'No description available for this film.'}
        </p>
        <button className="button button-watch" type="button" onClick={onPlay}>
          <Play size={16} fill="currentColor" /> Watch now
        </button>
      </section>
    </div>
  );
}
