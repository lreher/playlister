// One-time: marks the baseline migration as already-applied on a database that predates
// knex migrations, so its CREATE TABLEs don't fail against tables that already exist.
// Idempotent — safe to re-run, and a no-op on a genuinely fresh install.
// NOTE: createSongsTable now also creates year/decade/country — bootstrap-marking it
// as already-applied means a pre-knex songs table (no such columns) never gets them.
// Not handled here on purpose; sort out that gap at actual deploy time.
const knex = require('../db/index')();

const BASELINE_MIGRATIONS = [
  '20260905000001_createUsersTable.js',
  '20260905000002_createArtistsTable.js',
  '20260905000003_createArtistGenresTable.js',
  '20260905000004_createSongsTable.js',
  '20260905000005_createSongArtistsTable.js',
  '20260905000006_createPlaylistsTable.js',
  '20260905000007_createPlaylistTracksTable.js',
  '20260905000008_createTokensTable.js',
];

const main = async () => {
  const alreadyBootstrapped = await knex.schema.hasTable('knex_migrations');
  if (alreadyBootstrapped) {
    console.log('knex_migrations already exists — nothing to do.');
    return;
  }

  await knex.schema.createTable('knex_migrations', (table) => {
    table.increments();
    table.string('name');
    table.integer('batch');
    table.dateTime('migration_time');
  });
  await knex.schema.createTable('knex_migrations_lock', (table) => {
    table.increments('index');
    table.integer('is_locked');
  });
  await knex('knex_migrations_lock').insert({ is_locked: 0 });
  await knex('knex_migrations').insert(
    BASELINE_MIGRATIONS.map((name) => ({ name, batch: 1, migration_time: new Date() })),
  );

  console.log(`Marked ${BASELINE_MIGRATIONS.length} baseline migrations as already applied. Run "npm run migrate" next.`);
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
