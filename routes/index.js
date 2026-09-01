const FindMyWay = require('find-my-way');
const spotify = require('../sources/spotify');
const session = require('../sources/session');
const syncQueue = require('../sources/syncQueue');
const { wipeDatabase } = require('../sources/wipeDatabase');
const usersDb = require('../db/users');
const artistsDb = require('../db/artists');
const songsController = require('../controllers/songs');
const { getQueryParams, sendJson } = require('./utils');
const { registerStaticRoutes } = require('./static');

const router = FindMyWay();

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
      res.writeHead(401, { 'Content-Type': 'application/json' });
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
    usersDb.setSyncStatus(userId, 'syncing');
    syncQueue.enqueueSync(userId);
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

// Global, not user-scoped (see db/artists.js) — polled by the app shell
// while browsing, separately from /api/sync-status which only matters
// during the initial login/fast-sync wait.
router.on(
  'GET',
  '/api/enrichment-status',
  requireSession((req, res) => {
    sendJson(res, artistsDb.getEnrichmentStatus());
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
      res.writeHead(500, { 'Content-Type': 'application/json' });
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
// database (every user's data, not just the caller's). Restricted to
// ADMIN_USER_ID specifically: once other real people log in, any logged-in
// user having a button that wipes everyone else's data too would be a real
// footgun, not just a "delete my own stuff" action.
router.on(
  'POST',
  '/api/wipe-database',
  requireSession((req, res, userId) => {
    if (!process.env.ADMIN_USER_ID || userId !== process.env.ADMIN_USER_ID) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_authorized' }));
      return;
    }

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
