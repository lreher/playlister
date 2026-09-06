exports.up = async (knex) => {
  await knex.schema.createTable('events', (table) => {
    // First table with a surrogate id - unlike songs/artists/playlists, these sources
    // (Polvo Manco, Ao Vivo) give no stable external id to key off of.
    table.increments('id').primary();
    table.text('source').notNullable();
    table.text('raw_artist').notNullable();
    table.date('date').notNullable();
    table.text('date_label').notNullable();
    table.text('venue');
    table.text('city');
    table.text('neighborhood');
    table.text('time');
    table.text('genre');
    table.text('ticket_url');
    table.unique(['source', 'raw_artist', 'date', 'venue']);
    table.index('date', 'idx_events_date');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('events');
};
