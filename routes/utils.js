function getQueryParams(req) {
  return new URL(req.url, `http://${req.headers.host}`).searchParams;
}

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

module.exports = { getQueryParams, sendJson };
