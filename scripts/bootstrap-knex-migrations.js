// One-time: marks the baseline migration as already-applied on a database that predates
// knex migrations, so its CREATE TABLEs don't fail against tables that already exist.
// Idempotent — safe to re-run, and a no-op on a genuinely fresh install.
const knex = require('../db/index')();

const BASELINE_MIGRATION = '20260905000001_initial_schema.js';

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
  await knex('knex_migrations').insert({
    name: BASELINE_MIGRATION,
    batch: 1,
    migration_time: new Date(),
  });

  console.log(`Marked ${BASELINE_MIGRATION} as already applied. Run "npm run migrate" next.`);
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
