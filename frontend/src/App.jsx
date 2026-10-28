import { useEffect, useState } from 'react';
import { Clapperboard, LogIn, LogOut, Plus, Search, ShieldCheck } from 'lucide-react';
import AuthDialog from './components/AuthDialog';
import UploadDialog from './components/UploadDialog';
import api, { apiErrorMessage } from './services/api';

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('rayn_user') || 'null');
  } catch {
    return null;
  }
}

function MovieTile({ movie }) {
  return (
    <article className="movie-tile">
      <div className="poster-frame">
        {movie.poster_url ? (
          <img className="poster-image" src={movie.poster_url} alt={`${movie.title} poster`} loading="lazy" />
        ) : (
          <div className="poster-placeholder" aria-label="No poster available">
            <Clapperboard size={30} strokeWidth={1.4} />
            <span>RAYN<br />PICTURES</span>
          </div>
        )}
        <span className={`tier-tag tier-${movie.tier}`}>{movie.tier}</span>
      </div>
      <div className="movie-info">
        <h3 title={movie.title}>{movie.title}</h3>
        <p>{movie.release_year} <span aria-hidden="true">·</span> {movie.duration_minutes} min</p>
      </div>
    </article>
  );
}

export default function App() {
  const [user, setUser] = useState(readStoredUser);
  const [authMode, setAuthMode] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [tier, setTier] = useState('all');
  const [search, setSearch] = useState('');
  const [movies, setMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.get('/movies.php', { params: { tier } })
      .then(({ data }) => {
        if (active) setMovies(data.movies);
      })
      .catch((requestError) => {
        if (active) setError(apiErrorMessage(requestError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [tier, refreshKey]);

  function signInComplete(token, nextUser) {
    localStorage.setItem('rayn_token', token);
    localStorage.setItem('rayn_user', JSON.stringify(nextUser));
    setUser(nextUser);
    setAuthMode('');
  }

  function signOut() {
    localStorage.removeItem('rayn_token');
    localStorage.removeItem('rayn_user');
    setUser(null);
  }

  function addMovie(movie) {
    setMovies((current) => [movie, ...current.filter((item) => item.id !== movie.id)]);
    setUploadOpen(false);
  }

  const visibleMovies = movies.filter((movie) => movie.title.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="RAYN STREAM home">
          <span className="brand-mark"><Clapperboard size={20} /></span>
          <span>RAYN<span className="brand-light">STREAM</span></span>
        </a>
        <nav className="topnav" aria-label="Main navigation">
          <a className="nav-active" href="#collection">Discover</a>
          <a href="#collection">Collection</a>
        </nav>
        <div className="account-actions">
          {user?.role === 'admin' && (
            <button className="button button-admin" type="button" onClick={() => setUploadOpen(true)}>
              <Plus size={16} /> <span>Add film</span>
            </button>
          )}
          {user ? (
            <div className="signed-in">
              {user.role === 'admin' && <ShieldCheck className="admin-indicator" size={16} aria-label="Administrator" />}
              <span className="user-name">{user.display_name}</span>
              <button className="icon-button" type="button" aria-label="Sign out" title="Sign out" onClick={signOut}>
                <LogOut size={18} />
              </button>
            </div>
          ) : (
            <button className="button button-quiet" type="button" onClick={() => setAuthMode('login')}>
              <LogIn size={16} /> <span>Sign in</span>
            </button>
          )}
        </div>
      </header>

      <main id="top">
        <section className="catalog-heading" id="collection">
          <div className="heading-copy">
            <span className="eyebrow"><span className="live-dot" /> THE RAYN COLLECTION</span>
            <h1>Find your next<br /><em>favorite film.</em></h1>
            <p>A considered collection of stories, ready when you are.</p>
          </div>
          <div className="heading-index" aria-hidden="true"><span>01</span><i /><span>R/S</span></div>
        </section>

        <section className="catalog-controls" aria-label="Filter movies">
          <div className="filter-tabs" role="group" aria-label="Access tier">
            {['all', 'free', 'vip'].map((option) => (
              <button
                className={`filter-tab ${tier === option ? 'filter-active' : ''}`}
                key={option}
                type="button"
                aria-pressed={tier === option}
                onClick={() => setTier(option)}
              >
                {option === 'all' ? 'All films' : option.toUpperCase()}
              </button>
            ))}
          </div>
          <label className="search-box">
            <Search size={17} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles" aria-label="Search titles" />
            <kbd>/</kbd>
          </label>
          <span className="result-count">{loading ? '…' : `${visibleMovies.length} ${visibleMovies.length === 1 ? 'FILM' : 'FILMS'}`}</span>
        </section>

        <section className="catalog-body" aria-live="polite">
          {loading ? (
            <div className="state-panel"><span className="loader" /><p>Loading the collection</p></div>
          ) : error ? (
            <div className="state-panel state-error">
              <span className="state-kicker">CONNECTION INTERRUPTED</span>
              <h2>We can’t reach the collection.</h2>
              <p>{error}</p>
              <button className="button button-outline" type="button" onClick={() => setRefreshKey((key) => key + 1)}>Try again</button>
            </div>
          ) : visibleMovies.length === 0 ? (
            <div className="state-panel empty-state">
              <Clapperboard size={27} strokeWidth={1.3} />
              <h2>{search ? 'No matching films.' : 'The collection is waiting.'}</h2>
              <p>{search ? 'Try another title or clear your search.' : 'New additions will appear here.'}</p>
            </div>
          ) : (
            <div className="movie-grid">
              {visibleMovies.map((movie) => <MovieTile key={movie.id} movie={movie} />)}
            </div>
          )}
        </section>
      </main>

      <footer className="site-footer">
        <span>RAYN STREAM <span className="footer-separator">/</span> INDEPENDENT BY NATURE</span>
        <span>© {new Date().getFullYear()} RAYN</span>
      </footer>

      {authMode && (
        <AuthDialog
          mode={authMode}
          onClose={() => setAuthMode('')}
          onSuccess={signInComplete}
          onSwitch={() => setAuthMode((mode) => mode === 'login' ? 'signup' : 'login')}
        />
      )}
      {uploadOpen && <UploadDialog onClose={() => setUploadOpen(false)} onCreated={addMovie} />}
    </div>
  );
}