const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const STATIC_FILES = ['index.html', 'style.css', 'world.geo.json', 'bundle.js'];

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
    const routePath = filename === 'index.html' ? '/' : `/${filename}`;
    router.on('GET', routePath, serveStatic(filename));
  });
}

module.exports = { registerStaticRoutes };
