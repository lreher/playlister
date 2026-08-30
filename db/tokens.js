const db = require('./database');

// Not a collection — just the one current Spotify OAuth token set — so
// this doesn't fit the getAll/getById/upsert shape the other db/*.js files
// use. Singleton row (id = 1, enforced by the table's CHECK constraint).
const get = () => {
  const row = db.prepare('SELECT * FROM tokens WHERE id = 1').get();
  if (!row) return null;
  return { access_token: row.access_token, refresh_token: row.refresh_token, expires_at: row.expires_at };
};

const set = (tokens) => {
  db.prepare(
    `INSERT INTO tokens (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET access_token = ?, refresh_token = ?, expires_at = ?`
  ).run(
    tokens.access_token,
    tokens.refresh_token,
    tokens.expires_at,
    tokens.access_token,
    tokens.refresh_token,
    tokens.expires_at
  );
  return tokens;
};

module.exports = { get, set };
