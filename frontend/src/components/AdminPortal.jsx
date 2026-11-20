import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  ArrowLeft, Clapperboard, Film, LayoutDashboard, LoaderCircle, Pencil, Plus,
  RefreshCw, Search, ShieldCheck, Trash2, Tv, Upload, X,
} from 'lucide-react';
import api, { apiErrorMessage } from '../services/api';
import { uploadVideoFile } from '../services/adminUploads';
import { createArtworkUploadCache, uploadArtworkFile, validateArtworkFile } from '../services/artworkUpload';

const EMPTY_COUNTS = { movies: 0, series: 0, episodes: 0 };

function AdminDialog({ title, children, onClose, wide = false }) {
  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`dialog admin-dialog ${wide ? 'admin-dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="admin-dialog-title">
        <button className="icon-button dialog-close" type="button" aria-label="Close dialog" onClick={onClose}><X size={19} /></button>
        <span className="eyebrow">RAYN VIDEOS ADMIN</span>
        <h2 id="admin-dialog-title">{title}</h2>
        {children}
      </section>
    </div>
  );
}

function ErrorState({ error, retry }) {
  return (
    <div className="admin-state admin-state-error" role="alert">
      <p>{error}</p>
      {retry && <button className="button button-outline" type="button" onClick={retry}>Try again</button>}
    </div>
  );
}

function ContentLoading() {
  return <div className="admin-state" role="status"><LoaderCircle className="admin-spinner" size={22} /> Loading workspace…</div>;
}

function Toast({ message, error, onDismiss }) {
  if (!message) return null;
  return (
    <div className={`admin-toast ${error ? 'admin-toast-error' : ''}`} role={error ? 'alert' : 'status'}>
      <span>{message}</span>
      <button className="icon-button" type="button" aria-label="Dismiss notification" onClick={onDismiss}><X size={16} /></button>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }) {
  return (
    <article className="admin-stat-card">
      <span className="admin-stat-icon"><Icon size={18} /></span>
      <span className="admin-stat-label">{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </article>
  );
}

function EditMovieDialog({ movie, onClose, onSaved }) {
  const [vjs, setVjs] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/vjs.php', { params: { include_inactive: 'true' } })
      .then(({ data }) => setVjs(data.vjs))
      .catch((requestError) => setError(apiErrorMessage(requestError)));
  }, []);

  async function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api.put('/admin/movies.php', {
        id: movie.id,
        title: fields.get('title'),
        description: fields.get('description'),
        tier: fields.get('tier'),
        release_year: Number(fields.get('release_year')),
        duration_minutes: Number(fields.get('duration_minutes')),
        vj_id: Number(fields.get('vj_id')),
      }, { params: { id: movie.id } });
      onSaved();
      onClose();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminDialog title={`Edit ${movie.title}`} onClose={onClose}>
      <form className="form-stack admin-form" onSubmit={submit}>
        <label>Title<input name="title" defaultValue={movie.title} maxLength="255" required /></label>
        <label>Description<textarea name="description" defaultValue={movie.description} maxLength="10000" rows="4" /></label>
        <div className="form-row">
          <label>Access tier<select name="tier" defaultValue={movie.tier}><option value="free">Free</option><option value="vip">VIP</option></select></label>
          <label>Release year<input name="release_year" type="number" min="1888" max={new Date().getFullYear() + 5} defaultValue={movie.release_year} required /></label>
          <label>Runtime<input name="duration_minutes" type="number" min="1" max="1000" defaultValue={movie.duration_minutes} required /></label>
        </div>
        <label>VJ<select name="vj_id" defaultValue={movie.vj_id || ''} required><option value="" disabled>Select a VJ</option>{vjs.map((vj) => <option key={vj.id} value={vj.id}>{vj.name}{vj.is_active ? '' : ' (inactive)'}</option>)}</select></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary form-submit" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      </form>
    </AdminDialog>
  );
}

function VideoUploadDialog({ title, onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [completedUpload, setCompletedUpload] = useState(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abortControllerRef = useRef(null);

  async function submit(event) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      let upload = completedUpload;
      if (!upload) {
        upload = await uploadVideoFile(file, {
          api,
          signal: controller.signal,
          onProgress: (value) => setProgress(value.percent),
          putFile: (url, body, options) => axios.put(url, body, {
            signal: options.signal,
            headers: options.headers || { 'Content-Type': 'application/octet-stream' },
            onUploadProgress: options.onUploadProgress,
          }),
        });
        setCompletedUpload(upload);
      }
      await onUploaded(upload);
      setCompletedUpload(null);
      onClose();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setBusy(false);
      abortControllerRef.current = null;
    }
  }

  return (
    <AdminDialog title={title} onClose={busy ? () => {} : onClose}>
      <form className="form-stack admin-form" onSubmit={submit}>
        <p className="dialog-copy">Select a processed MP4. The video uploads directly to private R2 storage using the existing secure upload flow.</p>
        <label className="file-picker"><Upload size={18} /><span>{file ? file.name : 'Choose processed MP4'}</span><input type="file" accept=".mp4,video/mp4" onChange={(event) => { setFile(event.target.files?.[0] || null); setCompletedUpload(null); setProgress(0); setError(''); }} required /></label>
        {completedUpload && !busy && <p className="form-success" role="status">Video upload completed. Retry the registration without re-uploading.</p>}
        {busy && <div className="upload-status" role="status">Uploading · {progress}%<div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div>}
        {busy && <button className="button button-upload-cancel form-submit" type="button" onClick={() => abortControllerRef.current?.abort()}>Cancel upload</button>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary form-submit" type="submit" disabled={busy || !file}>{busy ? 'Working…' : completedUpload ? 'Retry registration' : 'Upload video'}</button>
      </form>
    </AdminDialog>
  );
}

function SeriesDialog({ series, onClose, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [posterFile, setPosterFile] = useState(null);
  const [backdropFile, setBackdropFile] = useState(null);
  const artworkUploadCacheRef = useRef(null);
  if (!artworkUploadCacheRef.current) {
    artworkUploadCacheRef.current = createArtworkUploadCache();
  }

  async function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      validateArtworkFile(posterFile);
      validateArtworkFile(backdropFile);
      const posterKey = await uploadArtworkFile(posterFile, 'poster', { api, cache: artworkUploadCacheRef.current, putFile: (url, file, options) => axios.put(url, file, options) });
      const backdropKey = await uploadArtworkFile(backdropFile, 'backdrop', { api, cache: artworkUploadCacheRef.current, putFile: (url, file, options) => axios.put(url, file, options) });
      const payload = {
        title: fields.get('title'),
        description: fields.get('description'),
        ...(posterKey ? { poster_key: posterKey } : {}),
        ...(backdropKey ? { backdrop_key: backdropKey } : {}),
      };
      if (series) {
        await api.put('/admin/series.php', payload, { params: { id: series.id } });
      } else {
        await api.post('/series/create.php', payload);
      }
      onSaved();
      onClose();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminDialog title={series ? `Edit ${series.title}` : 'Add TV series'} onClose={busy ? () => {} : onClose}>
      <form className="form-stack admin-form" onSubmit={submit}>
        <label>Series title<input name="title" defaultValue={series?.title} maxLength="255" required /></label>
        <label>Description<textarea name="description" defaultValue={series?.description || ''} maxLength="10000" rows="4" /></label>
        {!series && <>
          <label className="file-picker"><Clapperboard size={18} /><span>{posterFile?.name || 'Poster (optional)'}</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setPosterFile(event.target.files?.[0] || null)} /></label>
          <label className="file-picker"><Clapperboard size={18} /><span>{backdropFile?.name || 'Backdrop (optional)'}</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setBackdropFile(event.target.files?.[0] || null)} /></label>
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary form-submit" type="submit" disabled={busy}>{busy ? 'Saving…' : series ? 'Save changes' : 'Create series'}</button>
      </form>
    </AdminDialog>
  );
}

function ChildMetadataDialog({ kind, item, onClose, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const season = kind === 'season';
  async function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const payload = season ? {
      season_number: Number(fields.get('season_number')),
      release_year: fields.get('release_year') ? Number(fields.get('release_year')) : null,
    } : {
      episode_number: Number(fields.get('episode_number')),
      title: fields.get('title'),
      description: fields.get('description'),
      duration_minutes: Number(fields.get('duration_minutes')),
      tier: fields.get('tier'),
    };
    setBusy(true);
    setError('');
    try {
      await api.put(`/admin/${season ? 'seasons' : 'episodes'}.php`, payload, { params: { id: item.id } });
      onSaved();
      onClose();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AdminDialog title={`Edit ${season ? 'season' : 'episode'}`} onClose={onClose}>
      <form className="form-stack admin-form" onSubmit={submit}>
        {season ? <>
          <label>Season number<input name="season_number" type="number" min="1" defaultValue={item.season_number} required /></label>
          <label>Release year<input name="release_year" type="number" min="1888" max={new Date().getFullYear() + 5} defaultValue={item.release_year || ''} /></label>
        </> : <>
          <label>Episode number<input name="episode_number" type="number" min="1" defaultValue={item.episode_number} required /></label>
          <label>Title<input name="title" defaultValue={item.title} maxLength="255" required /></label>
          <label>Description<textarea name="description" defaultValue={item.description} maxLength="10000" rows="3" /></label>
          <div className="form-row">
            <label>Runtime<input name="duration_minutes" type="number" min="1" max="1000" defaultValue={item.duration_minutes} required /></label>
            <label>Tier<select name="tier" defaultValue={item.tier}><option value="free">Free</option><option value="vip">VIP</option></select></label>
          </div>
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary form-submit" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      </form>
    </AdminDialog>
  );
}

function CreateChildDialog({ kind, parentId, onClose, onSaved }) {
  const season = kind === 'season';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const payload = season ? {
      series_id: parentId,
      season_number: Number(fields.get('season_number')),
      release_year: fields.get('release_year') ? Number(fields.get('release_year')) : null,
    } : {
      season_id: parentId,
      episode_number: Number(fields.get('episode_number')),
      title: fields.get('title'),
      description: fields.get('description'),
      duration_minutes: Number(fields.get('duration_minutes')),
      tier: fields.get('tier'),
    };
    setBusy(true);
    setError('');
    try {
      await api.post(`/series/${season ? 'seasons/create' : 'episodes/create'}.php`, payload);
      onSaved();
      onClose();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AdminDialog title={season ? 'Add season' : 'Add episode'} onClose={onClose}>
      <form className="form-stack admin-form" onSubmit={submit}>
        {season ? <>
          <label>Season number<input name="season_number" type="number" min="1" required /></label>
          <label>Release year<input name="release_year" type="number" min="1888" max={new Date().getFullYear() + 5} /></label>
        </> : <>
          <label>Episode number<input name="episode_number" type="number" min="1" required /></label>
          <label>Title<input name="title" maxLength="255" required /></label>
          <label>Description<textarea name="description" maxLength="10000" rows="3" /></label>
          <div className="form-row">
            <label>Runtime<input name="duration_minutes" type="number" min="1" max="1000" required /></label>
            <label>Tier<select name="tier" defaultValue="free"><option value="free">Free</option><option value="vip">VIP</option></select></label>
          </div>
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary form-submit" type="submit" disabled={busy}>{busy ? 'Creating…' : season ? 'Add season' : 'Add episode'}</button>
      </form>
    </AdminDialog>
  );
}

export default function AdminPortal({ user, onExit, onAddMovie, onContentChanged, refreshKey }) {
  const [section, setSection] = useState('dashboard');
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [activity, setActivity] = useState([]);
  const [deletionJobs, setDeletionJobs] = useState([]);
  const [movies, setMovies] = useState([]);
  const [series, setSeries] = useState([]);
  const [vjs, setVjs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [movieTier, setMovieTier] = useState('all');
  const [selectedSeries, setSelectedSeries] = useState('');
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState('');
  const [toastError, setToastError] = useState(false);
  const [dataReloadKey, setDataReloadKey] = useState(0);

  const notify = useCallback((message, isError = false) => {
    setToast(message);
    setToastError(isError);
  }, []);
  const reload = useCallback(() => setDataReloadKey((key) => key + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([
      api.get('/admin/dashboard.php'),
      api.get('/admin/movies.php'),
      api.get('/admin/series.php'),
      api.get('/vjs.php', { params: { include_inactive: 'true' } }),
      api.get('/admin/deletions.php'),
    ]).then(([dashboard, movieResponse, seriesResponse, vjResponse, deletions]) => {
      if (!active) return;
      setCounts(dashboard.data.counts);
      setActivity(dashboard.data.activity);
      setMovies(movieResponse.data.movies);
      setSeries(seriesResponse.data.series);
      setVjs(vjResponse.data.vjs);
      setDeletionJobs(deletions.data.deletion_jobs);
      setSelectedSeries((current) => current && seriesResponse.data.series.some((item) => String(item.id) === current)
        ? current : (seriesResponse.data.series[0] ? String(seriesResponse.data.series[0].id) : ''));
    }).catch((requestError) => {
      if (active) setError(apiErrorMessage(requestError));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [refreshKey, dataReloadKey]);

  const filteredMovies = useMemo(() => movies.filter((movie) => (
    (movieTier === 'all' || movie.tier === movieTier)
    && `${movie.title} ${movie.vj_name || ''}`.toLowerCase().includes(search.trim().toLowerCase())
  )), [movies, movieTier, search]);
  const filteredSeries = useMemo(() => series.filter((item) => item.title.toLowerCase().includes(search.trim().toLowerCase())), [series, search]);
  const activeSeries = series.find((item) => String(item.id) === selectedSeries);

  async function deleteItem(path, label, onDone = reload) {
    if (!window.confirm(`Delete ${label}? This action cannot be undone.`)) return;
    try {
      await api.delete(path);
      notify(`${label} deleted.`);
      onDone();
      onContentChanged?.();
    } catch (requestError) {
      notify(apiErrorMessage(requestError), true);
      reload();
      onContentChanged?.();
    }
  }

  async function deleteMovie(movie) {
    if (!window.confirm(`Delete “${movie.title}” and its unshared R2 video/artwork? This cannot be undone.`)) return;
    try {
      await api.delete('/admin/movies.php', { params: { id: movie.id } });
      notify(`Deleted ${movie.title}.`);
      reload();
      onContentChanged?.();
    } catch (requestError) {
      notify(apiErrorMessage(requestError), true);
      reload();
      onContentChanged?.();
    }
  }

  async function retryDeletion(job) {
    try {
      await api.post('/admin/deletions/retry.php', {}, { params: { id: job.id } });
      notify(`Deletion job ${job.id} completed.`);
      reload();
      onContentChanged?.();
    } catch (requestError) {
      notify(apiErrorMessage(requestError), true);
      reload();
    }
  }

  async function replaceMovieVideo(movie, upload) {
    const { data } = await api.post('/admin/movies/replace.php', { id: movie.id, ...upload });
    if (data.cleanup_warning) notify(data.cleanup_warning, true);
    else notify(`Video replaced for ${movie.title}.`);
    reload();
    onContentChanged?.();
  }

  async function addEpisodeVersion(episode, upload) {
    const { data } = await api.post('/series/versions/create.php', {
      episode_id: episode.id,
      vj_id: Number(dialog.vjId),
      ...upload,
    });
    notify(`Video version added for ${episode.title}.`);
    setDialog(null);
    reload();
    onContentChanged?.();
    return data;
  }

  async function deleteVersion(version) {
    await deleteItem(`/admin/episode-versions.php?id=${encodeURIComponent(version.id)}`, `video version by ${version.vj_name}`);
  }

  async function reloadAfterAction() {
    reload();
    onContentChanged?.();
  }

  const nav = [
    { id: 'dashboard', title: 'Overview', icon: LayoutDashboard },
    { id: 'movies', title: 'Movies', icon: Film },
    { id: 'series', title: 'TV series', icon: Tv },
    { id: 'deletions', title: 'Deletion recovery', icon: RefreshCw },
  ];

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="#admin" onClick={(event) => event.preventDefault()}>
          <span className="brand-mark"><Clapperboard size={19} /></span>
          <span>RAYN<span className="brand-light">VIDEOS</span></span>
        </a>
        <div className="admin-sidebar-label">WORKSPACE</div>
        <nav className="admin-nav" aria-label="Administration">
          {nav.map(({ id, title, icon: Icon }) => (
            <button type="button" className={`admin-nav-item ${section === id ? 'admin-nav-active' : ''}`} key={id} onClick={() => { setSection(id); setSearch(''); }}>
              <Icon size={17} />{title}{id === 'movies' && <span>{counts.movies}</span>}{id === 'series' && <span>{counts.series}</span>}
              {id === 'deletions' && deletionJobs.length > 0 && <span>{deletionJobs.length}</span>}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <div className="admin-user-mark"><ShieldCheck size={17} /></div>
          <span><strong>{user?.display_name || 'Administrator'}</strong><small>Administrator</small></span>
          <button className="icon-button" type="button" aria-label="Return to catalogue" title="Return to catalogue" onClick={onExit}><ArrowLeft size={17} /></button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar">
          <div><span className="section-kicker">RAYN VIDEOS / ADMIN</span><h1>{nav.find((item) => item.id === section)?.title}</h1></div>
          <div className="admin-top-actions">
            {section === 'movies' && <button className="button button-admin" type="button" onClick={onAddMovie}><Plus size={16} /> Add movie</button>}
            {section === 'series' && <button className="button button-admin" type="button" onClick={() => setDialog({ type: 'series' })}><Plus size={16} /> Add series</button>}
            <button className="button button-quiet admin-return-mobile" type="button" onClick={onExit}><ArrowLeft size={15} /> Catalogue</button>
          </div>
        </header>
        <div className="admin-content">
          {loading ? <ContentLoading /> : error ? <ErrorState error={error} retry={reload} /> : <>
            {section === 'dashboard' && (
              <>
                <div className="admin-welcome"><div><span className="eyebrow">CONTENT OPERATIONS</span><h2>Good to see you, {user?.display_name || 'Admin'}.</h2><p>Manage your RAYN VIDEOS library from one workspace.</p></div><button className="button button-primary" type="button" onClick={onAddMovie}><Plus size={16} /> Publish a movie</button></div>
                <div className="admin-stats">
                  <StatCard icon={Film} label="TOTAL MOVIES" value={counts.movies} />
                  <StatCard icon={Tv} label="TV SERIES" value={counts.series} />
                  <StatCard icon={Clapperboard} label="TOTAL EPISODES" value={counts.episodes} />
                </div>
                <section className="admin-panel">
                  <div className="admin-panel-heading"><div><span className="section-kicker">LATEST CHANGES</span><h2>Recent activity</h2></div></div>
                  {activity.length === 0 ? <p className="admin-empty">Administrative activity will appear here.</p> : (
                    <ol className="admin-activity">{activity.map((entry) => (
                      <li key={entry.id}><span className="admin-activity-dot" /><div><strong>{entry.summary}</strong><small>{entry.actor_name} · {new Date(entry.created_at).toLocaleString()}</small></div></li>
                    ))}</ol>
                  )}
                </section>
              </>
            )}
            {section === 'movies' && (
              <section className="admin-panel">
                <div className="admin-panel-heading"><div><span className="section-kicker">LIBRARY</span><h2>Movies <span className="admin-count">{filteredMovies.length} / {movies.length}</span></h2></div><div className="admin-list-controls"><label className="admin-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title or VJ" aria-label="Search movies" /></label><label className="admin-tier-filter"><span className="sr-only">Filter movies by access tier</span><select value={movieTier} onChange={(event) => setMovieTier(event.target.value)}><option value="all">All tiers</option><option value="free">Free</option><option value="vip">VIP</option></select></label></div></div>
                <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Title</th><th>Release</th><th>Access</th><th>VJ</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
                  {filteredMovies.map((movie) => <tr key={movie.id}>
                    <td><button className="admin-title-button" type="button" onClick={() => setDialog({ type: 'movie-details', item: movie })}>{movie.title}</button><small>{movie.duration_minutes} min</small></td>
                    <td>{movie.release_year}</td><td><span className={`admin-badge admin-badge-${movie.tier}`}>{movie.tier}</span></td><td>{movie.vj_name || '—'}</td><td>{new Date(movie.created_at).toLocaleDateString()}</td>
                    <td><div className="admin-row-actions"><button className="icon-button" type="button" title={`Edit ${movie.title}`} aria-label={`Edit ${movie.title}`} onClick={() => setDialog({ type: 'edit-movie', item: movie })}><Pencil size={15} /></button><button className="icon-button" type="button" title={`Replace video for ${movie.title}`} aria-label={`Replace video for ${movie.title}`} onClick={() => setDialog({ type: 'replace-movie', item: movie })}><Upload size={15} /></button><button className="icon-button admin-delete-button" type="button" title={`Delete ${movie.title}`} aria-label={`Delete ${movie.title}`} onClick={() => deleteMovie(movie)}><Trash2 size={15} /></button></div></td>
                  </tr>)}
                  {filteredMovies.length === 0 && <tr><td className="admin-table-empty" colSpan="6">No movies match your search.</td></tr>}
                </tbody></table></div>
              </section>
            )}
            {section === 'series' && (
              <div className="admin-series-layout">
                <section className="admin-panel admin-series-list">
                  <div className="admin-panel-heading"><div><span className="section-kicker">LIBRARY</span><h2>TV series <span className="admin-count">{series.length}</span></h2></div><label className="admin-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search series" aria-label="Search series" /></label></div>
                  <div className="admin-series-items">{filteredSeries.map((item) => <button type="button" key={item.id} className={`admin-series-item ${selectedSeries === String(item.id) ? 'admin-series-selected' : ''}`} onClick={() => setSelectedSeries(String(item.id))}>
                    <span className="admin-series-thumb">{item.poster_url ? <img src={item.poster_url} alt="" /> : <Tv size={18} />}</span>
                    <span><strong>{item.title}</strong><small>{item.seasons.length} seasons · {item.seasons.reduce((total, season) => total + season.episodes.length, 0)} episodes</small></span>
                  </button>)}
                  {filteredSeries.length === 0 && <p className="admin-empty">No series match your search.</p>}</div>
                </section>
                {activeSeries ? <section className="admin-panel admin-series-detail">
                  <div className="admin-series-heading"><div><span className="section-kicker">SERIES MANAGEMENT</span><h2>{activeSeries.title}</h2><p>{activeSeries.description || 'No description'}</p></div><div className="admin-row-actions"><button className="icon-button" type="button" title="Edit series metadata" aria-label="Edit series metadata" onClick={() => setDialog({ type: 'series', item: activeSeries })}><Pencil size={16} /></button><button className="icon-button admin-delete-button" type="button" title="Delete series" aria-label="Delete series" onClick={() => deleteItem(`/admin/series.php?id=${encodeURIComponent(activeSeries.id)}`, `series “${activeSeries.title}”`)}><Trash2 size={16} /></button></div></div>
                  <button className="button button-quiet admin-add-child" type="button" onClick={() => setDialog({ type: 'create-season', parentId: activeSeries.id })}><Plus size={14} /> Add season</button>
                  {activeSeries.seasons.map((season) => <section className="admin-season" key={season.id}>
                    <div className="admin-season-heading"><div><span>SEASON {season.season_number}</span>{season.release_year && <small>{season.release_year}</small>}</div><div className="admin-row-actions"><button className="icon-button" type="button" title={`Edit season ${season.season_number}`} aria-label={`Edit season ${season.season_number}`} onClick={() => setDialog({ type: 'edit-child', kind: 'season', item: season })}><Pencil size={14} /></button><button className="icon-button admin-delete-button" type="button" title={`Delete season ${season.season_number}`} aria-label={`Delete season ${season.season_number}`} onClick={() => deleteItem(`/admin/seasons.php?id=${encodeURIComponent(season.id)}`, `season ${season.season_number}`)}><Trash2 size={14} /></button></div></div>
                    <button className="button button-quiet admin-add-child" type="button" onClick={() => setDialog({ type: 'create-episode', parentId: season.id })}><Plus size={13} /> Add episode</button>
                    {season.episodes.map((episode) => <article className="admin-episode" key={episode.id}>
                      <div className="admin-episode-heading"><div><strong>{episode.episode_number}. {episode.title}</strong><small>{episode.duration_minutes} min · {episode.tier}</small></div><div className="admin-row-actions"><button className="icon-button" type="button" title={`Edit ${episode.title}`} aria-label={`Edit ${episode.title}`} onClick={() => setDialog({ type: 'edit-child', kind: 'episode', item: episode })}><Pencil size={14} /></button><button className="icon-button" type="button" title={`Upload video version for ${episode.title}`} aria-label={`Upload video version for ${episode.title}`} onClick={() => setDialog({ type: 'episode-vj', item: episode })}><Upload size={14} /></button><button className="icon-button admin-delete-button" type="button" title={`Delete ${episode.title}`} aria-label={`Delete ${episode.title}`} onClick={() => deleteItem(`/admin/episodes.php?id=${encodeURIComponent(episode.id)}`, `episode “${episode.title}”`)}><Trash2 size={14} /></button></div></div>
                      <div className="admin-version-list">{episode.versions.length ? episode.versions.map((version) => <div className="admin-version" key={version.id}><span><strong>{version.vj_name}</strong>{version.is_current && <i>Current</i>}</span><button className="icon-button admin-delete-button" type="button" aria-label={`Delete ${version.vj_name} video version`} title="Delete video version" onClick={() => deleteVersion(version)}><Trash2 size={13} /></button></div>) : <small>No video versions yet.</small>}</div>
                    </article>)}
                    {season.episodes.length === 0 && <p className="admin-empty admin-empty-small">No episodes in this season.</p>}
                  </section>)}
                  {activeSeries.seasons.length === 0 && <p className="admin-empty">This series has no seasons yet.</p>}
                </section> : <section className="admin-panel admin-state"><Tv size={24} /><p>Select a series or add your first one.</p></section>}
              </div>
            )}
            {section === 'deletions' && (
              <section className="admin-panel">
                <div className="admin-panel-heading"><div><span className="section-kicker">RECOVERABLE OPERATIONS</span><h2>Pending cleanup <span className="admin-count">{deletionJobs.length}</span></h2></div></div>
                <p className="admin-empty">Failed or deferred cleanup is retained here. Records marked for deletion are hidden from the public catalogue and playback while their jobs remain recoverable.</p>
                {deletionJobs.length > 0 && <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Job</th><th>Content</th><th>Status</th><th>Attempts</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
                  {deletionJobs.map((job) => <tr key={job.id}>
                    <td>#{job.id}</td>
                    <td>{job.operation === 'cleanup_only' ? 'Replaced movie video' : `${job.entity_type.replace('_', ' ')} #${job.entity_id}`}</td>
                    <td><span className={`admin-badge admin-badge-${job.status}`}>{job.status.replace('_', ' ')}</span><small>{job.deleted_object_count}/{job.object_count} objects cleaned · {job.shared_object_count} shared</small></td>
                    <td>{job.attempt_count}</td>
                    <td><button className="button button-outline" type="button" aria-label={`Retry deletion job ${job.id}`} onClick={() => retryDeletion(job)}><RefreshCw size={14} /> Retry</button></td>
                  </tr>)}
                </tbody></table></div>}
                {deletionJobs.length === 0 && <p className="admin-empty">There are no pending deletion or storage-cleanup jobs.</p>}
              </section>
            )}
          </>}
        </div>
      </main>
      <Toast message={toast} error={toastError} onDismiss={() => setToast('')} />
      {dialog?.type === 'edit-movie' && <EditMovieDialog movie={dialog.item} onClose={() => setDialog(null)} onSaved={reloadAfterAction} />}
      {dialog?.type === 'replace-movie' && <VideoUploadDialog title={`Replace video · ${dialog.item.title}`} onClose={() => setDialog(null)} onUploaded={(upload) => replaceMovieVideo(dialog.item, upload)} />}
      {dialog?.type === 'series' && <SeriesDialog series={dialog.item} onClose={() => setDialog(null)} onSaved={reloadAfterAction} />}
      {dialog?.type === 'create-season' && <CreateChildDialog kind="season" parentId={dialog.parentId} onClose={() => setDialog(null)} onSaved={reloadAfterAction} />}
      {dialog?.type === 'create-episode' && <CreateChildDialog kind="episode" parentId={dialog.parentId} onClose={() => setDialog(null)} onSaved={reloadAfterAction} />}
      {dialog?.type === 'edit-child' && <ChildMetadataDialog kind={dialog.kind} item={dialog.item} onClose={() => setDialog(null)} onSaved={reloadAfterAction} />}
      {dialog?.type === 'episode-vj' && <AdminDialog title={`Add video · ${dialog.item.title}`} onClose={() => setDialog(null)}>
        <form className="form-stack admin-form" onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          setDialog((current) => ({ ...current, vjId: fields.get('vj_id') }));
          setDialog((current) => ({ ...current, type: 'episode-upload' }));
        }}>
          <label>VJ<select name="vj_id" required defaultValue=""><option value="" disabled>Select the version’s VJ</option>{vjs.filter((vj) => vj.is_active).map((vj) => <option key={vj.id} value={vj.id}>{vj.name}</option>)}</select></label>
          <button className="button button-primary form-submit" type="submit">Continue to upload</button>
        </form>
      </AdminDialog>}
      {dialog?.type === 'episode-upload' && <VideoUploadDialog title={`Upload episode video · ${dialog.item.title}`} onClose={() => setDialog(null)} onUploaded={(upload) => addEpisodeVersion(dialog.item, upload)} />}
      {dialog?.type === 'movie-details' && <AdminDialog title={dialog.item.title} onClose={() => setDialog(null)}>
        <div className="admin-movie-details">
          <p>{dialog.item.description || 'No description provided.'}</p>
          <dl><dt>Release year</dt><dd>{dialog.item.release_year}</dd><dt>Runtime</dt><dd>{dialog.item.duration_minutes} minutes</dd><dt>Access</dt><dd>{dialog.item.tier.toUpperCase()}</dd><dt>VJ</dt><dd>{dialog.item.vj_name || '—'}</dd><dt>Added</dt><dd>{new Date(dialog.item.created_at).toLocaleString()}</dd></dl>
        </div>
      </AdminDialog>}
    </div>
  );
}
