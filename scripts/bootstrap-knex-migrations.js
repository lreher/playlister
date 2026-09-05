// One-time bootstrap for adopting knex migrations on a database that
// already has the pre-migrations schema (local dev right now; the droplet
// needs this run once too, before its first `npm run migrate` post-
// upgrade). Manually creates knex's own tracking tables and marks
// 20260905000001_initial_schema.js as already applied — its CREATE TABLEs
// would otherwise fail against tables that already exist. Everything after
// that migration runs for real via the normal `npm run migrate`.
//
// Idempotent: no-ops if knex_migrations already exists, so safe to run
// more than once (and harmless on a genuinely fresh install, which should
// just use `npm run migrate` directly and never needs this at all).
const knex = require('../db/index')();

const BASELINE_MIGRATION = '20260905000001_initial_schema.js';

async function main() {
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
  await knex('knex_migrations').insert({
    name: BASELINE_MIGRATION,
    batch: 1,
    migration_time: new Date(),
  });

  console.log(`Marked ${BASELINE_MIGRATION} as already applied. Run "npm run migrate" next.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
