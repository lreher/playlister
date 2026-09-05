exports.up = async (knex) => {
  await knex.schema.createTable('artists', (table) => {
    table.text('id').primary();
    table.text('name').notNullable();
    table.text('country');
    table.integer('popularity');
    table.integer('followers');
    table.integer('details_resolved').notNullable().defaultTo(0); // resolved-but-empty vs never-resolved
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('artists');
};
