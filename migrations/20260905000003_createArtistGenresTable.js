exports.up = async (knex) => {
  await knex.schema.createTable('artist_genres', (table) => {
    table.text('artist_id').notNullable();
    table.text('genre').notNullable();
    table.primary(['artist_id', 'genre']);
    table.index('artist_id', 'idx_artist_genres_artist');
    table.index('genre', 'idx_artist_genres_genre');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('artist_genres');
};
