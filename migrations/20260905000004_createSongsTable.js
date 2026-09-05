exports.up = async (knex) => {
  await knex.schema.createTable('songs', (table) => {
    table.text('id').primary();
    table.text('name').notNullable();
    table.text('album_name');
    table.text('album_release_date');
    table.text('album_type');
    table.text('isrc');
    table.integer('duration_ms');
    table.integer('explicit');
    table.text('spotify_url');
    // Computed once at write time (db/songs.js), not re-derived on every read via a view.
    table.integer('year');
    table.text('decade');
    table.text('country');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('songs');
};
