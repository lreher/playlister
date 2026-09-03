import { useEffect, useState } from 'preact/hooks';
import { EMPTY_FILTERS } from './pages/songList/Filters';
import { SongList } from './pages/songList';
import { Dashboards } from './pages/dashboards';
import { Events } from './pages/events';
import { getMe, getSyncStatus, getEnrichmentStatus, wipeDatabase, requestSync } from './api';

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

// current/total known only once a phase's first poll comes back — no
// percent before that (a phase can also legitimately report total: null).
const syncPct = (progress) =>
  progress?.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : null;

// "Fetching your songs — 1700/5045 (34%)" once counts are known, just the
// phase label before that. Shared by the blocking first-sync screen and
// the header indicator for a background/manual sync.
const syncProgressLabel = (progress) => {
  const phase = SYNC_PHASE_LABELS[progress?.phase] ?? 'Syncing…';
  const pct = syncPct(progress);
  return pct !== null ? `${phase} — ${progress.current}/${progress.total} (${pct}%)` : phase;
};

// The country-resolution cascade (scripts/sync.js's resolveCountries) —
// cheapest/most-accurate source first. Some artists never resolve through
// any of these (genuinely obscure/independent, absent from every free
// structured source tried — see playlister_focus.md), so the overall
// resolved/total count alone plateaus below 100% forever. Showing which
// step is actively running (and its own checked/total) is what makes
// continued progress visible instead of a stalled-looking percentage.
const ENRICHMENT_STEP_LABELS = {
  'musicbrainz-search': 'MusicBrainz Search',
  'musicbrainz-fallback': 'MusicBrainz Fallback Lookup',
  'wikidata-exact': 'Wikidata Match',
  'wikidata-fuzzy': 'Wikidata Fuzzy Search',
};

export function App() {
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
  // A non-blocking sync is running (a stale-library refresh kicked off at
  // login, or the manual Sync button) — the app is already showing, this
  // just drives the header indicator and the post-sync data refresh.
  const [syncing, setSyncing] = useState(false);
  const [bgSyncError, setBgSyncError] = useState(null);
  // Bumped when a background/manual sync completes — threaded into the List
  // and Dashboards so they re-fetch against the updated library.
  const [dataVersion, setDataVersion] = useState(0);

  // On mount: who is this, and is their library already built? Every
  // /api/* route requires a real session, so this is the one place that
  // decides whether to show the app shell at all. Only a genuine
  // first-ever sync (no lastSyncedAt) gets the blocking "building your
  // library" screen — a returning user sees the app immediately, and a
  // sync that happens to be running (stale-library refresh from
  // /callback) just surfaces in the header via `syncing`.
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

  // Polls sync status while a sync is in flight — the blocking first-build
  // (status 'checking-sync') or a non-blocking background/manual sync
  // (`syncing`, app already showing). On completion the background case
  // bumps dataVersion to re-fetch the now-updated library; the blocking
  // case flips to 'ready'.
  useEffect(() => {
    const blocking = status === 'checking-sync';
    if (!blocking && !syncing) return;
    let cancelled = false;
    let timer = null;

    function poll() {
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
  }, [status, syncing]);

  // The slow global enrichment pass (country/genre/popularity resolution)
  // keeps running in the background long after a user's own library is
  // ready — poll for it separately, only once the app shell is actually
  // showing, so there's a persistent sense of "still working" rather than
  // it silently happening with no visibility. Stops polling once fully
  // resolved rather than continuing to hit the endpoint for no reason;
  // re-runs on dataVersion so a just-finished sync (which may have queued
  // fresh enrichment work) starts it polling again.
  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    let timer = null;

    function poll() {
      getEnrichmentStatus()
        .then((result) => {
          if (cancelled) return;
          setEnrichmentStatus(result);
          const done = result.countries.resolved >= result.countries.total && result.details.resolved >= result.details.total;
          if (!done) timer = setTimeout(poll, ENRICHMENT_POLL_MS);
        })
        .catch(() => {}); // best-effort status display — not worth bouncing the user over
    }
    poll();

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
  }, [status, dataVersion]);

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

  // Only ever renders while a step is actually running — no "idle" or
  // "fully enriched" resting state. Some artists never resolve through any
  // automated source at all, so a static summary here would just sit
  // there forever once a pass settles; showing nothing when there's
  // nothing actively happening is more honest than a number that looks
  // perpetually "in progress" (or, worse, stuck).
  function renderEnrichmentStatus() {
    const activeStep = enrichmentStatus?.activeStep;
    if (!activeStep) return null;

    const label = ENRICHMENT_STEP_LABELS[activeStep.phase] ?? activeStep.phase;
    return (
      <span className="enrichment-status">
        Artist Enrichment — {label} ({activeStep.checked}/{activeStep.total} checked)
      </span>
    );
  }

  // Testing tool, not a real feature (see routes/index.js's
  // /api/wipe-database) — wipes the ENTIRE database for every user, not
  // just this account, so the confirm text says so explicitly rather than
  // reading like a normal "delete my data" action.
  function handleDelete() {
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
        // The server process exits and systemd (RestartSec=5 — verified in
        // the actual unit file, not assumed) waits a full 5s before
        // bringing it back up. Reloading sooner than that lands in the
        // dead window and shows a connection error instead of the fresh
        // login screen.
        setTimeout(() => window.location.reload(), 7000);
      })
      .catch((err) => {
        setDeleting(false);
        alert(`Failed to delete: ${err.message}`);
      });
  }

  // Manual "sync now." Sets `syncing` optimistically so the poll effect
  // starts immediately; the server has already flipped sync_status to
  // 'syncing' (or was already syncing, in which case this is a no-op).
  function handleSync() {
    setBgSyncError(null);
    setSyncProgress(null);
    setSyncing(true);
    requestSync().catch((err) => {
      setSyncing(false);
      setBgSyncError(err.message);
    });
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
        <div className="tabs-status">
          {renderEnrichmentStatus()}
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
          <button className="page-button" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <button className="page-button danger" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>

      <div style={{ display: tab === 'list' ? '' : 'none' }}>
        <SongList
          filters={filters}
          onChange={setFilters}
          onReset={() => setFilters(EMPTY_FILTERS)}
          dataVersion={dataVersion}
        />
      </div>

      <div style={{ display: tab === 'dashboards' ? '' : 'none' }}>
        {dashboardsVisited && <Dashboards key={dataVersion} onFilterClick={applyDashboardFilter} />}
      </div>

      <div style={{ display: tab === 'events' ? '' : 'none' }}>
        <Events />
      </div>
    </>
  );
}
