exports.up = async (knex) => {
  await knex.schema.createTable('event_artists', (table) => {
    table.integer('event_id').notNullable();
    table.text('artist_id').notNullable();
    table.primary(['event_id', 'artist_id']);
    table.index('event_id', 'idx_event_artists_event');
    table.index('artist_id', 'idx_event_artists_artist');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('event_artists');
};
