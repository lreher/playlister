const http = require('http');
const router = require('../routes');
const syncQueue = require('../sources/syncQueue');

// /callback's query string carries the OAuth authorization code and CSRF
// state token — both one-time, security-sensitive values that have no
// business sitting in plaintext in journalctl. Redacted before logging,
// not just for /callback specifically — any current or future route with
// a `code`/`state` param gets the same treatment automatically.
function safeUrlForLog(rawUrl) {
  const url = new URL(rawUrl, 'http://placeholder');
  for (const param of ['code', 'state']) {
    if (url.searchParams.has(param)) url.searchParams.set(param, '[redacted]');
  }
  return url.pathname + url.search;
}

// Exportable server creator: builds an http.Server wired to the app's
// routes, but doesn't start listening — that's left to whoever calls this
// (the top-level index.js in normal use). Async now (awaits
// recoverStuckSyncs) — index.js awaits this before calling .listen().
async function createServer() {
  // Clears any sync left stuck 'syncing' by a previous process's restart —
  // see sources/syncQueue.js.
  await syncQueue.recoverStuckSyncs();

  return http.createServer((req, res) => {
    console.log(`${req.method} ${safeUrlForLog(req.url)}`);
    // Route handlers are async now (they await db calls) — router.lookup
    // calls the matched handler and returns whatever it returns, so an
    // async handler's rejection would otherwise become an unhandled
    // rejection instead of a caught 500. Running the lookup inside a
    // .then() catches both that and any synchronous throw the same way.
    Promise.resolve()
      .then(() => router.lookup(req, res))
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      });
  });
}

module.exports = { createServer };
