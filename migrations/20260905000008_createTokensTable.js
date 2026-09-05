exports.up = async (knex) => {
  await knex.schema.createTable('tokens', (table) => {
    table.text('user_id').primary().references('id').inTable('users');
    table.text('access_token');
    table.text('refresh_token');
    table.integer('expires_at');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('tokens');
};
