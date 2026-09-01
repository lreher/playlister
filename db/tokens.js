const db = require('./database');

// One row per user now (was a singleton) — same get/set shape otherwise.
const get = (userId) => {
  const row = db.prepare('SELECT * FROM tokens WHERE user_id = ?').get(userId);
  if (!row) return null;
  return { access_token: row.access_token, refresh_token: row.refresh_token, expires_at: row.expires_at };
};

const set = (userId, tokens) => {
  db.prepare(
    `INSERT INTO tokens (user_id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET access_token = ?, refresh_token = ?, expires_at = ?`
  ).run(
    userId,
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
