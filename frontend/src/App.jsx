import { useCallback, useEffect, useRef, useState } from 'react';
import { Clapperboard, LogIn, LogOut, Play, Plus, Search, ShieldCheck } from 'lucide-react';
import AuthDialog from './components/AuthDialog';
import MovieDetailsDialog from './components/MovieDetailsDialog';
import PlayerDialog from './components/PlayerDialog';
import UploadDialog from './components/UploadDialog';
import AdminPortal from './components/AdminPortal';
import api, { apiErrorMessage } from './services/api';

const SELECTED_VJ_STORAGE_KEY = 'rayn_selected_vj';

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('rayn_user') || 'null');
  } catch {
    return null;
  }
}

function readStoredVj() {
  try {
    return localStorage.getItem(SELECTED_VJ_STORAGE_KEY) || 'all';
  } catch {
    return 'all';
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

function MovieTile({ movie, onPlay, onArtworkError, showAddedDate = false }) {
  const addedDate = showAddedDate ? formatAddedDate(movie.created_at) : '';

  return (
    <article className="movie-tile">
      <button className="poster-frame" type="button" aria-label={`Play ${movie.title}`} onClick={() => onPlay(movie)}>
        {movie.poster_url ? (
          <img
            className="poster-image"
            src={movie.poster_url}
            alt={`${movie.title} poster`}
            loading="lazy"
            onError={() => onArtworkError(movie)}
          />
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
        {movie.vj_name && <p className="movie-vj">VJ · {movie.vj_name}</p>}
        {addedDate && <p className="movie-added-date">Added {addedDate}</p>}
      </div>
    </article>
  );
}

function MovieRow({ id, title, description, movies, onPlay, onArtworkError, showAddedDate = false }) {
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
          <MovieTile key={movie.id} movie={movie} onPlay={onPlay} onArtworkError={onArtworkError} showAddedDate={showAddedDate} />
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
  const [infoMovie, setInfoMovie] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminRefreshKey, setAdminRefreshKey] = useState(0);
  const [tier, setTier] = useState('all');
  const [selectedVj, setSelectedVj] = useState(readStoredVj);
  const [search, setSearch] = useState('');
  const [movies, setMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const searchInputRef = useRef(null);
  const artworkRefreshesRef = useRef(new Set());

  const refreshArtwork = useCallback(async (movie) => {
    if (!movie.poster_signed && !movie.backdrop_signed) return;
    const refreshKeyForMovie = String(movie.id);
    if (artworkRefreshesRef.current.has(refreshKeyForMovie)) return;
    artworkRefreshesRef.current.add(refreshKeyForMovie);
    try {
      const { data } = await api.get('/movies.php', { params: { tier: 'all' } });
      const refreshedMovie = data.movies.find((item) => String(item.id) === refreshKeyForMovie);
      if (!refreshedMovie) return;
      setMovies((current) => current.map((item) => (
        String(item.id) === refreshKeyForMovie ? { ...item, ...refreshedMovie } : item
      )));
      setError('');
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      artworkRefreshesRef.current.delete(refreshKeyForMovie);
    }
  }, []);

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
    setAdminOpen(false);
  }

  function addMovie(movie) {
    setMovies((current) => [movie, ...current.filter((item) => item.id !== movie.id)]);
    setUploadOpen(false);
    setAdminRefreshKey((key) => key + 1);
  }

  const sortedMovies = sortByCreatedAt(movies);
  const filteredMovies = selectedVj === 'all'
    ? sortedMovies
    : sortedMovies.filter((movie) => String(movie.vj_id) === selectedVj);
  const featuredMovie = filteredMovies[0];
  const trendingSelection = filteredMovies.slice(0, 8);
  const recentlyAdded = filteredMovies.slice(0, 8);
  const usesBattleshipBackdrop = featuredMovie?.title.trim().toLowerCase() === 'battleship';
  const heroImage = featuredMovie?.backdrop_url
    || (usesBattleshipBackdrop ? '/backdrops/battleship-naval.svg' : featuredMovie?.poster_url);
  const usesPosterBackdrop = !featuredMovie?.backdrop_url
    && !usesBattleshipBackdrop
    && Boolean(featuredMovie?.poster_url);
  const normalizedSearch = search.trim().toLowerCase();
  const availableVjs = [...new Map(
    sortedMovies
      .filter((movie) => movie.vj_id != null && movie.vj_is_active)
      .map((movie) => [String(movie.vj_id), { id: String(movie.vj_id), name: movie.vj_name }]),
  ).values()].sort((first, second) => first.name.localeCompare(second.name));
  const visibleMovies = filteredMovies.filter((movie) => (
    (tier === 'all' || movie.tier === tier)
    && movie.title.toLowerCase().includes(normalizedSearch)
  ));

  useEffect(() => {
    if (loading || error) return;

    const hasSelectedVj = movies.some((movie) => (
      movie.vj_is_active && String(movie.vj_id) === selectedVj
    ));
    const nextVj = selectedVj !== 'all' && !hasSelectedVj ? 'all' : selectedVj;
    if (nextVj !== selectedVj) setSelectedVj(nextVj);
    try {
      localStorage.setItem(SELECTED_VJ_STORAGE_KEY, nextVj);
    } catch {
      // The selector remains usable when browser storage is unavailable.
    }
  }, [selectedVj, loading, error, movies]);

  function chooseVj(vjId) {
    setSelectedVj(vjId);
  }

  if (adminOpen && user?.role === 'admin') {
    return (
      <>
        <AdminPortal
          user={user}
          onExit={() => setAdminOpen(false)}
          onAddMovie={() => setUploadOpen(true)}
          onContentChanged={() => {
            setAdminRefreshKey((key) => key + 1);
            setRefreshKey((key) => key + 1);
          }}
          refreshKey={adminRefreshKey}
        />
        {uploadOpen && (
          <UploadDialog
            onClose={() => setUploadOpen(false)}
            onCreated={addMovie}
            onVjsChanged={() => {
              setRefreshKey((key) => key + 1);
              setAdminRefreshKey((key) => key + 1);
            }}
          />
        )}
      </>
    );
  }

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
          {user?.role === 'admin' && (
            <button className="button button-quiet" type="button" onClick={() => setAdminOpen(true)}>
              <ShieldCheck size={16} /> <span>Admin</span>
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
          className={`hero-section ${heroImage ? 'hero-has-image' : ''}`}
          aria-labelledby={loading ? undefined : 'hero-title'}
          aria-label={loading ? 'Featured film' : undefined}
        >
          {heroImage && (
            <img
              className={`hero-backdrop ${usesPosterBackdrop ? 'hero-backdrop-poster' : ''}`}
              src={heroImage}
              alt=""
              fetchPriority="high"
              onError={(event) => {
                event.currentTarget.hidden = true;
                if (featuredMovie.backdrop_signed || featuredMovie.poster_signed) refreshArtwork(featuredMovie);
              }}
              onLoad={(event) => { event.currentTarget.hidden = false; }}
            />
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
                <div className="hero-kicker">
                  <span className="hero-label">FEATURED FILM</span>
                  <span className={`tier-tag tier-${featuredMovie.tier}`}>{featuredMovie.tier}</span>
                </div>
                <h1 id="hero-title">{featuredMovie.title}</h1>
                <div className="hero-meta">
                  {featuredMovie.release_year && <span>{featuredMovie.release_year}</span>}
                  {featuredMovie.duration_minutes && <span>{featuredMovie.duration_minutes} min</span>}
                </div>
                <p className="hero-description">
                  {featuredMovie.description || 'No description available for this film.'}
                </p>
                <div className="hero-actions">
                  <button className="button button-watch" type="button" onClick={() => setActiveMovie(featuredMovie)}>
                    <Play size={17} fill="currentColor" /> Watch now
                  </button>
                  <button className="button button-explore" type="button" onClick={() => setInfoMovie(featuredMovie)}>
                    More info
                  </button>
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

        {filteredMovies.length > 0 && (
          <>
            <MovieRow
              id="popular-picks"
              title="Trending This Week"
              description="An editorial selection from the Rayn collection."
              movies={trendingSelection}
              onPlay={setActiveMovie}
              onArtworkError={refreshArtwork}
            />
            <MovieRow
              id="recently-added"
              title="Recently added"
              description="Fresh additions to the collection."
              movies={recentlyAdded}
              onPlay={setActiveMovie}
              onArtworkError={refreshArtwork}
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
              <div className="vj-selector" role="group" aria-label="Choose your VJ">
                <span className="vj-selector-label">Choose your VJ</span>
                <div className="vj-selector-options">
                  <button
                    className={`filter-tab ${selectedVj === 'all' ? 'filter-active' : ''}`}
                    type="button"
                    aria-pressed={selectedVj === 'all'}
                    onClick={() => chooseVj('all')}
                  >
                    All VJs
                  </button>
                  {availableVjs.map((vj) => (
                    <button
                      className={`filter-tab ${selectedVj === vj.id ? 'filter-active' : ''}`}
                      key={vj.id}
                      type="button"
                      aria-pressed={selectedVj === vj.id}
                      onClick={() => chooseVj(vj.id)}
                    >
                      {vj.name}
                    </button>
                  ))}
                </div>
                {loading ? (
                  <span className="vj-selector-status" role="status">Loading VJs…</span>
                ) : error ? (
                  <span className="vj-selector-status" role="status">VJ filters are unavailable.</span>
                ) : availableVjs.length === 0 ? (
                  <span className="vj-selector-status">No VJs have available films.</span>
                ) : null}
              </div>
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
                <h2>
                  {search || tier !== 'all' || selectedVj !== 'all'
                    ? 'No films match these filters.'
                    : 'The collection is waiting.'}
                </h2>
                <p>
                  {search || tier !== 'all' || selectedVj !== 'all'
                    ? 'Try another title or choose different filters.'
                    : 'New additions will appear here.'}
                </p>
              </div>
            ) : (
              <div className="movie-grid">
                {visibleMovies.map((movie) => (
                  <MovieTile key={movie.id} movie={movie} onPlay={setActiveMovie} onArtworkError={refreshArtwork} />
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
      {infoMovie && (
        <MovieDetailsDialog
          movie={infoMovie}
          onClose={() => setInfoMovie(null)}
          onPlay={() => {
            setActiveMovie(infoMovie);
            setInfoMovie(null);
          }}
        />
      )}
      {uploadOpen && (
        <UploadDialog
          onClose={() => setUploadOpen(false)}
          onCreated={addMovie}
          onVjsChanged={() => setRefreshKey((key) => key + 1)}
        />
      )}
    </div>
  );
}
