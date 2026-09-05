// better-sqlite3 is synchronous, so a bigger pool buys no concurrency — one connection
// per role (db/index.js) plus SQLite's own WAL mode is what actually allows concurrency.
const path = require('path');

module.exports = {
  client: 'better-sqlite3',
  connection: {
    filename: path.join(__dirname, 'data/playlister.db'),
  },
  useNullAsDefault: true,
  pool: {
    min: 1,
    max: 1,
    afterCreate: (conn, done) => {
      conn.pragma('journal_mode = WAL');
      done(null, conn);
    },
  },
  migrations: {
    directory: path.join(__dirname, 'migrations'),
  },
};
