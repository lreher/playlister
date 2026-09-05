// No user_id — a real playlist's tracks are global. Liked Songs gets a per-user id
// instead (db/playlists.js's likedSongsId) so it never collides here.
exports.up = async (knex) => {
  await knex.schema.createTable('playlist_tracks', (table) => {
    table.text('playlist_id').notNullable();
    table.text('song_id').notNullable();
    table.text('added_at').notNullable();
    table.primary(['playlist_id', 'song_id']);
    table.index('playlist_id', 'idx_playlist_tracks_playlist');
    table.index('song_id', 'idx_playlist_tracks_song');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('playlist_tracks');
};
