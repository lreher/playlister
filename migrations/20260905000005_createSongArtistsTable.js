exports.up = async (knex) => {
  await knex.schema.createTable('song_artists', (table) => {
    table.text('song_id').notNullable();
    table.text('artist_id').notNullable();
    table.integer('position').notNullable(); // 0 = primary
    table.primary(['song_id', 'artist_id']);
    table.index('song_id', 'idx_song_artists_song');
    table.index('artist_id', 'idx_song_artists_artist');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('song_artists');
};
