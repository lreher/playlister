const FindMyWay = require('find-my-way');
const spotify = require('../sources/spotify');
const session = require('../sources/session');
const syncQueue = require('../sources/syncQueue');
const { wipeDatabase } = require('../sources/wipeDatabase');
const enrichmentProgress = require('../sources/enrichmentProgress');
const usersDb = require('../db/users');
const artistsDb = require('../db/artists');
const songsController = require('../controllers/songs');
const { getQueryParams, sendJson } = require('./utils');
const { registerStaticRoutes } = require('./static');

const router = FindMyWay();

// A library older than this is re-synced automatically on the user's next
// login — in the background (the app shows immediately with existing data),
// unlike a first-ever sync which blocks. Also the only automatic re-sync
// trigger; anything sooner is the manual Sync button.
const SYNC_STALE_MS = 24 * 60 * 60 * 1000;

// Whether logging in should kick off a sync: never synced, a previous sync
// errored, or the last one is stale. Skips if one's already running. Used
// by /callback and /api/sync.
function enqueueSyncIfNeeded(userId, { force = false } = {}) {
  const user = usersDb.getById(userId);
  if (!user || user.syncStatus === 'syncing') return;
  const stale =
    !user.lastSyncedAt || Date.now() - Date.parse(user.lastSyncedAt) > SYNC_STALE_MS;
  if (force || user.syncStatus === 'error' || stale) {
    usersDb.setSyncStatus(userId, 'syncing');
    syncQueue.enqueueSync(userId);
  }
}

// Register static routes
registerStaticRoutes(router);

// Every /api/* route requires a real session now — there's no anonymous
// default library to fall back to any more (each user's data is theirs
// alone). find-my-way has no middleware chaining, so this just wraps the
// handler directly.
function requireSession(handler) {
  return (req, res, ...rest) => {
    const userId = session.getSessionUserId(req);
    // A validly-signed cookie can still point at a user row that no longer
    // exists (e.g. the database was reset) — check both, not just
    // signature validity, so a stale cookie 401s cleanly on the first
    // request instead of the frontend having to fail its way there.
    if (!userId || !usersDb.getById(userId)) {
      // no-store matters here specifically: a cached 401 would keep being
      // served from that same fixed URL even after a real login succeeds.
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'not_authenticated' }));
      return;
    }
    return handler(req, res, userId, ...rest);
  };
}

router.on('GET', '/login', (req, res) => {
  const state = session.generateState();
  session.setStateCookie(res, state);
  res.writeHead(302, { Location: spotify.getAuthorizeUrl(state) });
  res.end();
});

router.on('GET', '/callback', async (req, res) => {
  const params = getQueryParams(req);
  const code = params.get('code');
  const state = params.get('state');

  if (!session.verifyState(req, state)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid or expired login attempt — please try /login again.');
    return;
  }

  try {
    const { userId } = await spotify.exchangeCodeForTokens(code);
    session.setSessionCookie(res, userId);
    // Only sync on login when there's a reason to (first login, prior
    // error, or a stale library) — a returning user with a fresh library
    // goes straight to the app. The manual Sync button covers "update now."
    enqueueSyncIfNeeded(userId);
    res.writeHead(302, { Location: '/' });
    res.end();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(err.message);
  }
});

router.on('GET', '/logout', (req, res) => {
  session.clearSessionCookie(res);
  res.writeHead(302, { Location: '/' });
  res.end();
});

router.on(
  'GET',
  '/api/me',
  requireSession((req, res, userId) => {
    const user = usersDb.getById(userId);
    sendJson(res, { userId, displayName: user?.displayName ?? null });
  })
);

router.on(
  'GET',
  '/api/sync-status',
  requireSession((req, res, userId) => {
    sendJson(res, usersDb.getSyncStatus(userId));
  })
);

// Manual "sync now" — the Sync button. Force-enqueues regardless of
// staleness (that's the point of the button), unless one's already
// running. Returns the current sync-status so the frontend can start
// polling immediately.
router.on(
  'POST',
  '/api/sync',
  requireSession((req, res, userId) => {
    enqueueSyncIfNeeded(userId, { force: true });
    sendJson(res, usersDb.getSyncStatus(userId));
  })
);

// Global, not user-scoped (see db/artists.js) — polled by the app shell
// while browsing, separately from /api/sync-status which only matters
// during the initial login/fast-sync wait.
router.on(
  'GET',
  '/api/enrichment-status',
  requireSession((req, res) => {
    sendJson(res, { ...artistsDb.getEnrichmentStatus(), activeStep: enrichmentProgress.getStep() });
  })
);

router.on(
  'GET',
  '/api/songs',
  requireSession((req, res, userId) => {
    try {
      const params = getQueryParams(req);
      sendJson(
        res,
        songsController.getSongs({
          userId,
          limit: Math.min(Number(params.get('limit')) || 50, 50),
          offset: Number(params.get('offset')) || 0,
          genre: params.get('genre'),
          year: params.get('year'),
          decade: params.get('decade'),
          country: params.get('country'),
          albumType: params.get('albumType'),
          artist: params.get('artist'),
          playlist: params.get('playlist'),
          durationMin: params.has('durationMin') ? Number(params.get('durationMin')) : null,
          durationMax: params.has('durationMax') ? Number(params.get('durationMax')) : null,
          addedFrom: params.get('addedFrom'),
          addedTo: params.get('addedTo'),
          popularityMin: params.has('popularityMin') ? Number(params.get('popularityMin')) : null,
          popularityMax: params.has('popularityMax') ? Number(params.get('popularityMax')) : null,
        })
      );
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.message }));
    }
  })
);

router.on(
  'GET',
  '/api/filters',
  requireSession((req, res, userId) => {
    sendJson(res, songsController.getFilterOptions(userId));
  })
);

router.on(
  'GET',
  '/api/stats',
  requireSession((req, res, userId) => {
    sendJson(res, songsController.getStats(userId));
  })
);

// Testing/dev tool, not a real multi-tenant feature — deletes the ENTIRE
// database, for every user, not just the caller's. Deliberately open to
// any logged-in session, not just one admin — Lucas's explicit call.
router.on(
  'POST',
  '/api/wipe-database',
  requireSession((req, res, userId) => {
    session.clearSessionCookie(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Wait for the response to actually flush before tearing the process
    // down — process.exit() right after queuing res.end() risks the client
    // never seeing the response at all. The exit code matters: 1 (not 0)
    // is what makes systemd's Restart=on-failure actually bring the
    // process back up, fresh, against a freshly-recreated empty database.
    res.end(JSON.stringify({ ok: true }), () => {
      wipeDatabase();
      process.exit(1);
    });
  })
);

module.exports = router;
