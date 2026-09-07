const FindMyWay = require('find-my-way');
const spotify = require('../sources/spotify');
const session = require('../sources/session');
const syncQueue = require('../sources/syncQueue');
const { wipeDatabase } = require('../sources/wipeDatabase');
const enrichmentProgress = require('../sources/enrichmentProgress');
const eventsSearch = require('../sources/eventsSearch');
const eventsSearchProgress = require('../sources/eventsSearchProgress');
const usersDb = require('../db/users');
const artistsDb = require('../db/artists');
const eventsDb = require('../db/events');
const songsController = require('../controllers/songs');
const playlistsController = require('../controllers/playlists');
const { getQueryParams, sendJson, readJsonBody } = require('./utils');
const { registerStaticRoutes } = require('./static');

const router = FindMyWay();

// A library older than this re-syncs automatically (in the background) on next login.
const SYNC_STALE_MS = 24 * 60 * 60 * 1000;

// Syncs on login if never synced, errored, or stale. Skips if one's already running.
const enqueueSyncIfNeeded = async (userId, { force = false } = {}) => {
  const user = await usersDb.getById(userId);
  if (!user || user.syncStatus === 'syncing') return;
  const stale =
    !user.lastSyncedAt || Date.now() - Date.parse(user.lastSyncedAt) > SYNC_STALE_MS;
  if (force || user.syncStatus === 'error' || stale) {
    await usersDb.setSyncStatus(userId, 'syncing');
    syncQueue.enqueueSync(userId);
  }
};

registerStaticRoutes(router);

// find-my-way has no middleware chaining, so this wraps each /api/* handler directly.
const requireSession = (handler) => async (req, res, ...rest) => {
    const userId = session.getSessionUserId(req);
    // A validly-signed cookie can still point at a deleted user row — check both.
    if (!userId || !(await usersDb.getById(userId))) {
      // no-store: a cached 401 would keep being served even after a real login succeeds.
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'not_authenticated' }));
      return;
    }
    return handler(req, res, userId, ...rest);
  };

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
    await enqueueSyncIfNeeded(userId);
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
  requireSession(async (req, res, userId) => {
    const user = await usersDb.getById(userId);
    sendJson(res, { userId, displayName: user?.displayName ?? null });
  })
);

router.on(
  'GET',
  '/api/sync-status',
  requireSession(async (req, res, userId) => {
    sendJson(res, await usersDb.getSyncStatus(userId));
  })
);

// The Sync button — force-enqueues regardless of staleness, unless one's already running.
router.on(
  'POST',
  '/api/sync',
  requireSession(async (req, res, userId) => {
    await enqueueSyncIfNeeded(userId, { force: true });
    sendJson(res, await usersDb.getSyncStatus(userId));
  })
);

// Global, not user-scoped — polled separately from /api/sync-status.
router.on(
  'GET',
  '/api/enrichment-status',
  requireSession(async (req, res) => {
    sendJson(res, { ...(await artistsDb.getEnrichmentStatus()), activeStep: enrichmentProgress.getStep() });
  })
);

router.on(
  'GET',
  '/api/songs',
  requireSession(async (req, res, userId) => {
    try {
      const params = getQueryParams(req);
      sendJson(
        res,
        await songsController.getSongs({
          userId,
          limit: Math.min(Number(params.get('limit')) || 50, 50),
          offset: Number(params.get('offset')) || 0,
          genres: params.getAll('genres'),
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
  requireSession(async (req, res, userId) => {
    sendJson(res, await songsController.getFilterOptions(userId));
  })
);

router.on(
  'GET',
  '/api/stats',
  requireSession(async (req, res, userId) => {
    sendJson(res, await songsController.getStats(userId));
  })
);

router.on(
  'GET',
  '/api/events',
  requireSession(async (req, res, userId) => {
    sendJson(res, await eventsDb.getForUser(userId));
  })
);

// Global, not user-scoped — same shape as /api/enrichment-status. No-ops if already running.
router.on(
  'POST',
  '/api/events/search',
  requireSession((req, res) => {
    eventsSearch.enqueue();
    sendJson(res, eventsSearchProgress.getStatus());
  })
);

router.on(
  'GET',
  '/api/events/search-status',
  requireSession((req, res) => {
    sendJson(res, eventsSearchProgress.getStatus());
  })
);

router.on(
  'POST',
  '/api/playlists',
  requireSession(async (req, res, userId) => {
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    const { name, isPublic, songIds } = payload;
    if (!name || !Array.isArray(songIds) || songIds.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name and songIds are required' }));
      return;
    }

    try {
      sendJson(res, await playlistsController.createPlaylistFromSongs(userId, { name, isPublic: !!isPublic, songIds }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.message }));
    }
  })
);

// Dev tool — deletes the ENTIRE database for every user. Open to any logged-in
// session, not gated to one admin (Lucas's explicit call).
router.on(
  'POST',
  '/api/wipe-database',
  requireSession((req, res) => {
    session.clearSessionCookie(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Wait for the response to flush before exiting. Exit code 1, not 0, so systemd's
    // Restart=on-failure brings the process back up against the freshly-empty database.
    res.end(JSON.stringify({ ok: true }), () => {
      wipeDatabase();
      process.exit(1);
    });
  })
);

module.exports = router;
