const fs = require('fs');
const path = require('path');

function getQueryParams(req) {
  return new URL(req.url, `http://${req.headers.host}`).searchParams;
}

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveStatic(filename, contentType) {
  return (req, res) => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'public', filename));
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  };
}

module.exports = { getQueryParams, sendJson, serveStatic };
