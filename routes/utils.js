const getQueryParams = (req) => new URL(req.url, `http://${req.headers.host}`).searchParams;

const sendJson = (res, data) => {
  // no-store: Cloudflare caches by default with no cache-control guidance, and a polled
  // GET like /api/sync-status has a fixed URL with nothing to bust a cache with.
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

module.exports = { getQueryParams, sendJson };
