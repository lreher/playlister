const http = require('http');
const router = require('../routes');
const syncQueue = require('../sources/syncQueue');

// Redacts code/state query params before logging — OAuth's one-time, security-sensitive
// values have no business sitting in plaintext in journalctl.
const safeUrlForLog = (rawUrl) => {
  const url = new URL(rawUrl, 'http://placeholder');
  for (const param of ['code', 'state']) {
    if (url.searchParams.has(param)) url.searchParams.set(param, '[redacted]');
  }
  return url.pathname + url.search;
};

// Builds the http.Server but doesn't call .listen() — that's left to index.js.
const createServer = async () => {
  await syncQueue.recoverStuckSyncs();

  return http.createServer((req, res) => {
    console.log(`${req.method} ${safeUrlForLog(req.url)}`);
    // Runs the (async) route handler inside .then() so a rejected promise becomes a
    // caught 500 instead of an unhandled rejection.
    Promise.resolve()
      .then(() => router.lookup(req, res))
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      });
  });
};

module.exports = { createServer };
