// Composite PK: two users can both follow the same real playlist, each with their own row.
exports.up = async (knex) => {
  await knex.schema.createTable('playlists', (table) => {
    table.text('id').notNullable();
    table.text('user_id').notNullable().references('id').inTable('users');
    table.text('name').notNullable();
    table.text('owner_name');
    table.integer('public');
    table.integer('collaborative');
    table.text('snapshot_id');
    table.primary(['id', 'user_id']);
    table.index('user_id', 'idx_playlists_user');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('playlists');
};
