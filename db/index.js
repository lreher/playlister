// Single source of the app's two SQLite connections, lazily created and
// cached per role — every other db/*.js file, plus controllers/songs.js
// and sources/spotify.js, call this instead of opening their own.
//
// 'app' (the default) is used by every request-serving path (routes ->
// controllers -> db). 'sync' is a second, separate connection used only by
// scripts/sync.js and sources/syncQueue.js, so a long-running sync (minutes
// during a first-ever sync, hours during country enrichment) never
// contends with a live request for the app connection's one pooled slot —
// see knexfile.js's pool comment for why each connection is capped at one.
// SQLite's own WAL mode (turned on via knexfile.js's shared afterCreate
// hook) is what actually lets these two connections read/write the same
// file concurrently without blocking each other.
const knexfile = require('../knexfile');

const connections = {};

const getDb = (role = 'app') => {
  if (!connections[role]) {
    connections[role] = require('knex')(knexfile);
  }
  return connections[role];
};

module.exports = getDb;
