import { useEffect, useState } from 'preact/hooks';
import { EMPTY_FILTERS } from './pages/songList/Filters';
import { SongList } from './pages/songList';
import { Dashboards } from './pages/dashboards';
import { Events } from './pages/events';
import { getMe, getSyncStatus, getEnrichmentStatus, wipeDatabase, requestSync } from './api';
import { THEMES, getTheme, setTheme } from './theme';

const PATH_FOR_TAB = { list: '/', dashboards: '/dashboards', events: '/events' };
const TAB_FOR_PATH = { '/': 'list', '/dashboards': 'dashboards', '/events': 'events' };

const tabFromLocation = () => TAB_FOR_PATH[window.location.pathname] ?? 'list';

const SYNC_POLL_MS = 2500;
const ENRICHMENT_POLL_MS = 10000;

const SYNC_PHASE_LABELS = {
  songs: 'Fetching your songs',
  playlists: 'Fetching your playlists',
  details: 'Resolving genres and popularity',
};

// No percent until the first poll returns real counts (total can be null).
const syncPct = (progress) =>
  progress?.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : null;

// e.g. "Fetching your songs — 1700/5045 (34%)"; just the phase label until counts are known.
const syncProgressLabel = (progress) => {
  const phase = SYNC_PHASE_LABELS[progress?.phase] ?? 'Syncing…';
  const pct = syncPct(progress);
  return pct !== null ? `${phase} — ${progress.current}/${progress.total} (${pct}%)` : phase;
};

// Shows which resolution step is running, since resolved/total plateaus below 100% forever
// (some artists never resolve).
const ENRICHMENT_STEP_LABELS = {
  'musicbrainz-search': 'MusicBrainz Search',
  'musicbrainz-fallback': 'MusicBrainz Fallback Lookup',
  'wikidata-exact': 'Wikidata Match',
  'wikidata-fuzzy': 'Wikidata Fuzzy Search',
};

export const App = () => {
  const [tab, setTab] = useState(tabFromLocation);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [dashboardsVisited, setDashboardsVisited] = useState(() => tabFromLocation() === 'dashboards');

  // loading -> unauthenticated | checking-sync -> ready | sync-error
  const [status, setStatus] = useState('loading');
  const [user, setUser] = useState(null);
  const [syncError, setSyncError] = useState(null);
  const [syncProgress, setSyncProgress] = useState(null);
  const [enrichmentStatus, setEnrichmentStatus] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // True while a non-blocking sync runs in the background (stale-library refresh or manual Sync).
  const [syncing, setSyncing] = useState(false);
  const [bgSyncError, setBgSyncError] = useState(null);
  // Bumped after a sync completes so List/Dashboards refetch.
  const [dataVersion, setDataVersion] = useState(0);
  // Mirrors the theme index.jsx already applied before first paint into render state.
  const [theme, setThemeState] = useState(getTheme);

  // Decides whether to show the app shell, a first-sync screen, or bounce to login.
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => {
        if (cancelled) return null;
        setUser(me);
        return getSyncStatus();
      })
      .then((sync) => {
        if (cancelled || !sync) return;
        const hasData = !!sync.lastSyncedAt;
        if (sync.status === 'error' && !hasData) {
          setSyncError(sync.error);
          setStatus('sync-error');
        } else if (sync.status !== 'done' && !hasData) {
          setSyncProgress(sync.progress);
          setStatus('checking-sync');
        } else {
          setStatus('ready');
          if (sync.status === 'syncing') setSyncing(true);
        }
      })
      .catch(() => !cancelled && setStatus('unauthenticated'));
    return () => {
      cancelled = true;
    };
  }, []);

  // Polls while a sync is in flight — the blocking first-build, or a background/manual sync.
  useEffect(() => {
    const blocking = status === 'checking-sync';
    if (!blocking && !syncing) return;
    let cancelled = false;
    let timer = null;

    const poll = () => {
      getSyncStatus()
        .then((result) => {
          if (cancelled) return;
          if (result.status === 'done') {
            if (blocking) {
              setStatus('ready');
            } else {
              setSyncing(false);
              setDataVersion((v) => v + 1);
            }
          } else if (result.status === 'error') {
            if (blocking) {
              setSyncError(result.error);
              setStatus('sync-error');
            } else {
              setSyncing(false);
              setBgSyncError(result.error || 'Sync failed');
            }
          } else {
            setSyncProgress(result.progress);
            timer = setTimeout(poll, SYNC_POLL_MS);
          }
        })
        .catch(() => {
          if (cancelled) return;
          // Only the blocking screen bails to login on a failed poll; a
          // background poll just stops quietly.
          if (blocking) setStatus('unauthenticated');
          else setSyncing(false);
        });
    };
    poll();

    // Backgrounding the tab throttles chained setTimeouts hard, which looks like "stuck at
    // 100%" until you switch back — re-poll immediately once the tab is visible again.
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer);
        poll();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [status, syncing]);

  // Polls the slow global enrichment pass separately once the app shell is showing. Stops
  // once fully resolved; a new dataVersion restarts it since a sync can queue more work.
  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    let timer = null;

    const poll = () => {
      getEnrichmentStatus()
        .then((result) => {
          if (cancelled) return;
          setEnrichmentStatus(result);
          const done = result.countries.resolved >= result.countries.total && result.details.resolved >= result.details.total;
          if (!done) timer = setTimeout(poll, ENRICHMENT_POLL_MS);
        })
        .catch(() => {}); // best-effort status display — not worth bouncing the user over
    };
    poll();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer);
        poll();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [status, dataVersion]);

  // Keeps tab state in sync with browser back/forward (switchTab pushes real URLs).
  useEffect(() => {
    const handlePopState = () => {
      const next = tabFromLocation();
      setTab(next);
      if (next === 'dashboards') setDashboardsVisited(true);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  if (status === 'loading' || status === 'checking-sync') {
    const pct = syncPct(syncProgress);

    return (
      <div className="login-container">
        <p>{status === 'checking-sync' ? 'Building your library…' : 'Loading…'}</p>
        {syncProgress && (
          <div className="sync-progress">
            <p className="sync-progress-label">{syncProgressLabel(syncProgress)}</p>
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

  // No idle/complete resting state — only renders while a step is actively running, since
  // some artists never fully resolve.
  const renderEnrichmentStatus = () => {
    const activeStep = enrichmentStatus?.activeStep;
    if (!activeStep) return null;

    const label = ENRICHMENT_STEP_LABELS[activeStep.phase] ?? activeStep.phase;
    return (
      <span className="enrichment-status">
        Artist Enrichment — {label} ({activeStep.checked}/{activeStep.total} checked)
      </span>
    );
  };

  // Testing tool (routes/index.js's /api/wipe-database) — wipes every user's data, not just this account.
  const handleDelete = () => {
    if (
      !confirm(
        'This permanently deletes the ENTIRE database for ALL users, not just your own account, and cannot be undone. Continue?'
      )
    ) {
      return;
    }
    setDeleting(true);
    wipeDatabase()
      .then(() => {
        // systemd waits RestartSec=5 before restarting — reload sooner and you'll hit the dead window.
        setTimeout(() => window.location.reload(), 7000);
      })
      .catch((err) => {
        setDeleting(false);
        alert(`Failed to delete: ${err.message}`);
      });
  };

  // CSS recolors instantly via [data-theme]; only echarts (inside Dashboards) needs the remount.
  const switchTheme = (id) => {
    if (id === theme) return;
    setTheme(id);
    setThemeState(id);
  };

  // Sets `syncing` optimistically so the poll effect starts immediately; server-side is a no-op if already syncing.
  const handleSync = () => {
    setBgSyncError(null);
    setSyncProgress(null);
    setSyncing(true);
    requestSync().catch((err) => {
      setSyncing(false);
      setBgSyncError(err.message);
    });
  };

  const switchTab = (next) => {
    setTab(next);
    if (next === 'dashboards') setDashboardsVisited(true);
    const path = PATH_FOR_TAB[next];
    if (window.location.pathname !== path) history.pushState(null, '', path);
  };

  // A chart click replaces the whole filter set rather than merging into whatever was active.
  const applyDashboardFilter = (updates) => {
    setFilters({ ...EMPTY_FILTERS, ...updates });
    switchTab('list');
  };

  // Rendered into SongList's bottom pagination row (List tab only).
  const renderLibraryControls = () => <div className="library-controls">
        <button className="page-button filled" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <button className="page-button filled" onClick={handleDelete} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
        {syncing && (
          <span className="sync-status-text">
            {syncProgress ? syncProgressLabel(syncProgress) : 'Syncing…'}
          </span>
        )}
        {bgSyncError && !syncing && (
          <span className="sync-status-text failed" title={bgSyncError}>
            Sync failed
          </span>
        )}
      </div>;

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
        <div className="tabs-status">
          {renderEnrichmentStatus()}
          <div className="theme-toggle" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={theme === t.id ? 'active' : ''}
                onClick={() => switchTheme(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: tab === 'list' ? '' : 'none' }}>
        <SongList
          filters={filters}
          onChange={setFilters}
          onReset={() => setFilters(EMPTY_FILTERS)}
          dataVersion={dataVersion}
          controls={renderLibraryControls()}
        />
      </div>

      <div style={{ display: tab === 'dashboards' ? '' : 'none' }}>
        {dashboardsVisited && (
          <Dashboards key={`${dataVersion}:${theme}`} onFilterClick={applyDashboardFilter} />
        )}
      </div>

      <div style={{ display: tab === 'events' ? '' : 'none' }}>
        <Events />
      </div>
    </>
  );
};
