const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const STATIC_FILES = ['world.geo.json', 'bundle.js', 'bundle.css'];

// Each of these serves the same index.html shell — the client reads the URL itself to
// pick the tab. Needed so a direct load of e.g. /dashboards works, not just in-app clicks.
const APP_ROUTES = ['/', '/dashboards', '/events'];

const serveStatic = (filename) => {
  const contentType = MIME_TYPES[path.extname(filename)] || 'application/octet-stream';
  return (req, res) => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'static', filename));
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  };
};

const registerStaticRoutes = (router) => {
  STATIC_FILES.forEach((filename) => {
    router.on('GET', `/${filename}`, serveStatic(filename));
  });
  APP_ROUTES.forEach((routePath) => {
    router.on('GET', routePath, serveStatic('index.html'));
  });
};

module.exports = { registerStaticRoutes };
