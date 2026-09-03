import { useEffect, useState } from 'preact/hooks';
import { EMPTY_FILTERS } from './pages/songList/Filters';
import { SongList } from './pages/songList';
import { Dashboards } from './pages/dashboards';
import { Events } from './pages/events';
import { getMe, getSyncStatus, getEnrichmentStatus, wipeDatabase } from './api';

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

  // The slow global enrichment pass (country/genre/popularity resolution)
  // keeps running in the background long after a user's own library is
  // ready — poll for it separately, only once the app shell is actually
  // showing, so there's a persistent sense of "still working" rather than
  // it silently happening with no visibility. Stops polling once fully
  // resolved rather than continuing to hit the endpoint for no reason.
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
              {SYNC_PHASE_LABELS[syncProgress.phase] ?? 'Working…'}
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
          <button className="page-button danger" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
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
