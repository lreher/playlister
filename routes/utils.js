function getQueryParams(req) {
  return new URL(req.url, `http://${req.headers.host}`).searchParams;
}

function sendJson(res, data) {
  // Every JSON response here is dynamic/session-scoped — no-store, not just
  // "no explicit guidance." This project has a documented precedent for
  // exactly the failure this prevents: Cloudflare caches by default when
  // the origin gives it no cache-control at all (bit a static-asset deploy
  // before; the risk is identical for a polled GET like /api/sync-status —
  // a fixed URL, no query string, nothing to bust a cache with).
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

module.exports = { getQueryParams, sendJson };
