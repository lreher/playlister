const http = require('http');
const router = require('../routes');

// Exportable server creator: builds an http.Server wired to the app's
// routes, but doesn't start listening — that's left to whoever calls this
// (the top-level index.js in normal use).
function createServer() {
  return http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);
    try {
      router.lookup(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err.message);
    }
  });
}

module.exports = { createServer };
