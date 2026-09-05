const db = require('./index')();

const get = async (userId, knexInstance = db) => {
  const row = await knexInstance('tokens').where({ user_id: userId }).first();
  if (!row) return null;
  return { access_token: row.access_token, refresh_token: row.refresh_token, expires_at: row.expires_at };
};

const set = async (userId, tokens, knexInstance = db) => {
  const record = {
    user_id: userId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
  };
  await knexInstance('tokens').insert(record).onConflict('user_id').merge(record);
  return tokens;
};

module.exports = { get, set };
