import { useEffect, useState } from 'preact/hooks';
import { EMPTY_FILTERS } from './pages/songList/Filters';
import { SongList } from './pages/songList';
import { Dashboards } from './pages/dashboards';
import { Events } from './pages/events';
import { getMe, getSyncStatus } from './api';

const PATH_FOR_TAB = { list: '/', dashboards: '/dashboards', events: '/events' };
const TAB_FOR_PATH = { '/': 'list', '/dashboards': 'dashboards', '/events': 'events' };

const tabFromLocation = () => TAB_FOR_PATH[window.location.pathname] ?? 'list';

const SYNC_POLL_MS = 2500;

export function App() {
  const [tab, setTab] = useState(tabFromLocation);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [dashboardsVisited, setDashboardsVisited] = useState(() => tabFromLocation() === 'dashboards');

  // loading -> unauthenticated | checking-sync -> ready | sync-error
  const [status, setStatus] = useState('loading');
  const [user, setUser] = useState(null);
  const [syncError, setSyncError] = useState(null);
  const [syncProgress, setSyncProgress] = useState(null);

  // On mount: who is this, if anyone? Every /api/* route requires a real
  // session now, so this is the one place that decides whether to show the
  // app shell at all, rather than every page checking for a 401 itself.
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setStatus('checking-sync');
      })
      .catch(() => !cancelled && setStatus('unauthenticated'));
    return () => {
      cancelled = true;
    };
  }, []);

  // A user's first login triggers a background sync server-side (see
  // routes/index.js's /callback) — poll until it's done before showing any
  // data, so a brand-new user doesn't land on an empty-looking library.
  useEffect(() => {
    if (status !== 'checking-sync') return;
    let cancelled = false;
    let timer = null;

    function poll() {
      getSyncStatus()
        .then((result) => {
          if (cancelled) return;
          if (result.status === 'done') {
            setStatus('ready');
          } else if (result.status === 'error') {
            setSyncError(result.error);
            setStatus('sync-error');
          } else {
            setSyncProgress(result.progress);
            timer = setTimeout(poll, SYNC_POLL_MS);
          }
        })
        .catch(() => !cancelled && setStatus('unauthenticated'));
    }
    poll();

    // Chained setTimeout gets throttled hard by the browser once a tab is
    // backgrounded/minimized — doesn't die, just slows to a crawl, which
    // looks exactly like "stuck at 100%" until you switch back. Re-poll
    // immediately the moment the tab is visible again, rather than waiting
    // for whatever's left of a throttled interval.
    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer);
        poll();
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [status]);

  // Keeps the tab in sync with browser back/forward, since switchTab below
  // makes tab state a real part of the URL.
  useEffect(() => {
    function handlePopState() {
      const next = tabFromLocation();
      setTab(next);
      if (next === 'dashboards') setDashboardsVisited(true);
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  if (status === 'loading' || status === 'checking-sync') {
    // total is nullable (the songs phase doesn't know it until its first
    // page comes back) — no percent/bar until there's something real to
    // show, rather than a misleading 0%.
    const pct =
      syncProgress?.total > 0 ? Math.min(100, Math.round((syncProgress.current / syncProgress.total) * 100)) : null;

    return (
      <div className="login-container">
        <p>{status === 'checking-sync' ? 'Building your library…' : 'Loading…'}</p>
        {syncProgress && (
          <div className="sync-progress">
            <p className="sync-progress-label">
              {syncProgress.phase === 'songs' ? 'Fetching your songs' : 'Fetching your playlists'}
              {pct !== null && ` — ${syncProgress.current}/${syncProgress.total} (${pct}%)`}
            </p>
            {pct !== null && (
              <div className="sync-progress-bar">
                <div className="sync-progress-fill" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <div className="login-container">
        <a className="login-button" href="/login">
          Login with Spotify
        </a>
      </div>
    );
  }

  if (status === 'sync-error') {
    return (
      <div className="login-container">
        <p>Something went wrong syncing your library: {syncError}</p>
        <a className="login-button" href="/login">
          Try again
        </a>
      </div>
    );
  }

  function switchTab(next) {
    setTab(next);
    if (next === 'dashboards') setDashboardsVisited(true);
    const path = PATH_FOR_TAB[next];
    if (window.location.pathname !== path) history.pushState(null, '', path);
  }

  // Called from a dashboard chart click (year bar, decade bar, popularity
  // bucket, liked-date bar, country bubble). Clicking a chart element means
  // "show me exactly this," not "also narrow whatever was already
  // filtered" — replaces the whole filter set rather than merging into it.
  function applyDashboardFilter(updates) {
    setFilters({ ...EMPTY_FILTERS, ...updates });
    switchTab('list');
  }

  return (
    <>
      <div className="app-header">
        <h1>playlister</h1>
        <p className="current-user">
          {user.displayName ?? user.userId} · <a href="/logout">Log out</a>
        </p>
      </div>
      <div id="tabs">
        <button className={`tab-button ${tab === 'list' ? 'active' : ''}`} onClick={() => switchTab('list')}>
          List
        </button>
        <button
          className={`tab-button ${tab === 'dashboards' ? 'active' : ''}`}
          onClick={() => switchTab('dashboards')}
        >
          Dashboards
        </button>
        <button className={`tab-button ${tab === 'events' ? 'active' : ''}`} onClick={() => switchTab('events')}>
          Events
        </button>
      </div>

      <div style={{ display: tab === 'list' ? '' : 'none' }}>
        <SongList filters={filters} onChange={setFilters} onReset={() => setFilters(EMPTY_FILTERS)} />
      </div>

      <div style={{ display: tab === 'dashboards' ? '' : 'none' }}>
        {dashboardsVisited && <Dashboards onFilterClick={applyDashboardFilter} />}
      </div>

      <div style={{ display: tab === 'events' ? '' : 'none' }}>
        <Events />
      </div>
    </>
  );
}
