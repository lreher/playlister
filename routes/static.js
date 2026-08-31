const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const STATIC_FILES = ['world.geo.json', 'bundle.js', 'bundle.css'];

// Client-side page routes — the SPA has no server-side pages, every one of
// these serves the same index.html shell; the client reads the URL itself
// (App.jsx) to decide which tab to show. Needed so a direct load/refresh of
// e.g. /dashboards works, not just clicking there from within the app.
const APP_ROUTES = ['/', '/dashboards', '/events'];

function serveStatic(filename) {
  const contentType = MIME_TYPES[path.extname(filename)] || 'application/octet-stream';
  return (req, res) => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'static', filename));
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  };
}

function registerStaticRoutes(router) {
  STATIC_FILES.forEach((filename) => {
    router.on('GET', `/${filename}`, serveStatic(filename));
  });
  APP_ROUTES.forEach((routePath) => {
    router.on('GET', routePath, serveStatic('index.html'));
  });
}

module.exports = { registerStaticRoutes };
