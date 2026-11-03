import { useCallback, useEffect, useRef, useState } from 'react';
import { Clapperboard, LogIn, LogOut, Play, Plus, Search, ShieldCheck } from 'lucide-react';
import AuthDialog from './components/AuthDialog';
import PlayerDialog from './components/PlayerDialog';
import UploadDialog from './components/UploadDialog';
import api, { apiErrorMessage } from './services/api';

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('rayn_user') || 'null');
  } catch {
    return null;
  }
}

function sortByCreatedAt(movies) {
  return [...movies].sort((first, second) => {
    const firstDate = Date.parse(first.created_at || '');
    const secondDate = Date.parse(second.created_at || '');
    const firstHasDate = Number.isFinite(firstDate);
    const secondHasDate = Number.isFinite(secondDate);

    if (firstHasDate && secondHasDate) return secondDate - firstDate;
    if (firstHasDate) return -1;
    if (secondHasDate) return 1;
    return 0;
  });
}

function formatAddedDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function MovieTile({ movie, onPlay, showAddedDate = false }) {
  const addedDate = showAddedDate ? formatAddedDate(movie.created_at) : '';

  return (
    <article className="movie-tile">
      <button className="poster-frame" type="button" aria-label={`Play ${movie.title}`} onClick={() => onPlay(movie)}>
        {movie.poster_url ? (
          <img className="poster-image" src={movie.poster_url} alt={`${movie.title} poster`} loading="lazy" />
        ) : (
          <span className="poster-placeholder" aria-hidden="true">
            <Clapperboard size={30} strokeWidth={1.4} />
            <span>RAYN<br />PICTURES</span>
          </span>
        )}
        <span className={`tier-tag tier-${movie.tier}`}>{movie.tier}</span>
        <span className="poster-play-overlay" aria-hidden="true"><Play size={28} fill="currentColor" /></span>
      </button>
      <div className="movie-info">
        <h3 title={movie.title}>{movie.title}</h3>
        <p>{movie.release_year} <span aria-hidden="true">·</span> {movie.duration_minutes} min</p>
        {addedDate && <p className="movie-added-date">Added {addedDate}</p>}
      </div>
    </article>
  );
}

function MovieRow({ id, title, description, movies, onPlay, showAddedDate = false }) {
  return (
    <section className="content-section movie-row-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="section-heading">
        <div>
          <span className="section-kicker">RAYN COLLECTION</span>
          <h2 id={`${id}-title`}>{title}</h2>
        </div>
        <p>{description}</p>
      </div>
      <div className="movie-row">
        {movies.map((movie) => (
          <MovieTile key={movie.id} movie={movie} onPlay={onPlay} showAddedDate={showAddedDate} />
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [user, setUser] = useState(readStoredUser);
  const [authMode, setAuthMode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [activeMovie, setActiveMovie] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [tier, setTier] = useState('all');
  const [search, setSearch] = useState('');
  const [movies, setMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const searchInputRef = useRef(null);

  const closePlayer = useCallback(() => setActiveMovie(null), []);
  const signInFromPlayer = useCallback(() => {
    setActiveMovie(null);
    setAuthMode('login');
  }, []);

  useEffect(() => {
    const resetTokenFromUrl = new URLSearchParams(window.location.hash.slice(1)).get('reset_token');
    if (!resetTokenFromUrl) return;

    setResetToken(resetTokenFromUrl);
    setAuthMode('reset');
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.get('/movies.php', { params: { tier: 'all' } })
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
  }, [refreshKey]);

  function signInComplete(token, nextUser) {
    localStorage.setItem('rayn_token', token);
    localStorage.setItem('rayn_user', JSON.stringify(nextUser));
    setUser(nextUser);
    setAuthMode('');
    setResetToken('');
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

  const sortedMovies = sortByCreatedAt(movies);
  const featuredMovie = sortedMovies[0];
  const popularPicks = sortedMovies.slice(0, 8);
  const recentlyAdded = sortedMovies.slice(0, 8);
  const normalizedSearch = search.trim().toLowerCase();
  const visibleMovies = sortedMovies.filter((movie) => (
    (tier === 'all' || movie.tier === tier)
    && movie.title.toLowerCase().includes(normalizedSearch)
  ));

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="RAYN STREAM home">
          <span className="brand-mark"><Clapperboard size={20} /></span>
          <span>RAYN<span className="brand-light">STREAM</span></span>
        </a>
        <nav className="topnav" aria-label="Main navigation">
          <a className="nav-active" href="#top">Discover</a>
          <a href="#popular-picks">Movies</a>
          <a href="#collection" onClick={() => searchInputRef.current?.focus()}>
            <Search size={14} aria-hidden="true" /> Search
          </a>
        </nav>
        <div className="account-actions">
          {user?.role === 'admin' && (
            <button className="button button-admin" type="button" aria-label="Add film" onClick={() => setUploadOpen(true)}>
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
        <section
          className={`hero-section ${featuredMovie?.poster_url ? 'hero-has-art' : ''}`}
          aria-labelledby={loading ? undefined : 'hero-title'}
          aria-label={loading ? 'Featured film' : undefined}
        >
          {featuredMovie?.poster_url && (
            <img className="hero-art" src={featuredMovie.poster_url} alt="" fetchPriority="high" />
          )}
          <div className="hero-shade" aria-hidden="true" />
          <div className="hero-content">
            <span className="eyebrow"><span className="live-dot" /> THE RAYN COLLECTION</span>
            {loading ? (
              <div className="hero-empty" role="status">
                <span className="loader" />
                <p>Finding your next film</p>
              </div>
            ) : featuredMovie ? (
              <>
                <span className="hero-label">FEATURED FILM</span>
                <h1 id="hero-title">{featuredMovie.title}</h1>
                <div className="hero-meta">
                  {featuredMovie.release_year && <span>{featuredMovie.release_year}</span>}
                  {featuredMovie.duration_minutes && <span>{featuredMovie.duration_minutes} min</span>}
                  <span className={`tier-tag tier-${featuredMovie.tier}`}>{featuredMovie.tier}</span>
                </div>
                <p className="hero-description">
                  {featuredMovie.description || 'No description available for this film.'}
                </p>
                <div className="hero-actions">
                  <button className="button button-watch" type="button" onClick={() => setActiveMovie(featuredMovie)}>
                    <Play size={17} fill="currentColor" /> Watch now
                  </button>
                  <a className="button button-explore" href="#collection">Explore collection</a>
                </div>
              </>
            ) : error ? (
              <>
                <span className="hero-label">THE SCREENING ROOM</span>
                <h1 id="hero-title">A home for independent film.</h1>
                <p className="hero-description">The collection is temporarily unavailable. Please try again shortly.</p>
                <button className="button button-explore" type="button" onClick={() => setRefreshKey((key) => key + 1)}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <span className="hero-label">INDEPENDENT BY NATURE</span>
                <h1 id="hero-title">Stories worth<br />settling in for.</h1>
                <p className="hero-description">The collection is waiting for its first film.</p>
                <a className="button button-explore" href="#collection">Explore collection</a>
              </>
            )}
          </div>
          <span className="hero-index" aria-hidden="true">RAYN / 01</span>
        </section>

        {sortedMovies.length > 0 && (
          <>
            <MovieRow
              id="popular-picks"
              title="Popular picks"
              description="A few stories to start with."
              movies={popularPicks}
              onPlay={setActiveMovie}
            />
            <MovieRow
              id="recently-added"
              title="Recently added"
              description="Fresh additions to the collection."
              movies={recentlyAdded}
              onPlay={setActiveMovie}
              showAddedDate
            />
          </>
        )}

        <section className="content-section collection-section" id="collection" aria-labelledby="collection-title">
          <div className="collection-heading">
            <div className="section-heading">
              <div>
                <span className="section-kicker">FIND YOUR NEXT FILM</span>
                <h2 id="collection-title">The collection</h2>
              </div>
              <span className="result-count">
                {loading ? '…' : `${visibleMovies.length} ${visibleMovies.length === 1 ? 'FILM' : 'FILMS'}`}
              </span>
            </div>
            <div className="catalog-controls" aria-label="Filter movies">
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
                <Search size={17} aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search titles"
                  aria-label="Search titles"
                />
                <kbd aria-hidden="true">/</kbd>
              </label>
            </div>
          </div>

          <div className="catalog-body" aria-live="polite">
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
                {visibleMovies.map((movie) => (
                  <MovieTile key={movie.id} movie={movie} onPlay={setActiveMovie} />
                ))}
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <a className="footer-brand" href="#top">RAYN<span>STREAM</span></a>
        <span>Independent by nature. Stories for everyone.</span>
        <span>© {new Date().getFullYear()} RAYN</span>
      </footer>

      {authMode && (
        <AuthDialog
          mode={authMode}
          resetToken={resetToken}
          onClose={() => {
            setAuthMode('');
            setResetToken('');
          }}
          onSuccess={signInComplete}
          onSwitch={() => setAuthMode((mode) => mode === 'login' ? 'signup' : 'login')}
          onForgotPassword={() => setAuthMode('reset-request')}
        />
      )}
      {activeMovie && (
        <PlayerDialog movie={activeMovie} onClose={closePlayer} onSignIn={signInFromPlayer} />
      )}
      {uploadOpen && <UploadDialog onClose={() => setUploadOpen(false)} onCreated={addMovie} />}
    </div>
  );
}
