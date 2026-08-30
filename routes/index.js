const FindMyWay = require('find-my-way');
const spotify = require('../sources/spotify');
const songsController = require('../controllers/songs');
const { getQueryParams, sendJson } = require('./utils');
const { registerStaticRoutes } = require('./static');

const router = FindMyWay();

// Register static routes
registerStaticRoutes(router);

router.on('GET', '/login', (req, res) => {
  res.writeHead(302, { Location: spotify.getAuthorizeUrl() });
  res.end();
});

router.on('GET', '/callback', async (req, res) => {
  const code = getQueryParams(req).get('code');
  try {
    await spotify.exchangeCodeForTokens(code);
    res.writeHead(302, { Location: '/' });
    res.end();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(err.message);
  }
});

router.on('GET', '/api/songs', async (req, res) => {
  try {
    const accessToken = await spotify.getValidAccessToken();
    if (!accessToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_authenticated' }));
      return;
    }

    const params = getQueryParams(req);
    sendJson(
      res,
      songsController.getSongs({
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
});

router.on('GET', '/api/filters', (req, res) => {
  sendJson(res, songsController.getFilterOptions());
});

router.on('GET', '/api/stats', (req, res) => {
  sendJson(res, songsController.getStats());
});

module.exports = router;
