// One shared config for both connections db/index.js can hand out (see
// that file for why there are two — an 'app' one and a 'sync' one), plus
// the knex CLI (`npx knex migrate:make`/`migrate:latest`, both wired as npm
// scripts — see package.json). better-sqlite3 is synchronous under the
// hood, so a pool bigger than one connection buys no real concurrency and
// only risks contention — one connection per role (app vs. sync) is the
// actual fix, with SQLite's own WAL mode handling file-level concurrency
// between them.
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
