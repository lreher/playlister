// Baseline schema. Pre-knex databases (local dev, the droplet) are manually marked as
// already applied — 20260905000002 brings those up to date instead.
//
// No PRAGMA foreign_keys: artist resolution runs after song ingestion, so a song_artists
// row can reference an artist that doesn't exist yet. The .references() calls below are
// unenforced without that pragma — kept for documentation only.
exports.up = async (knex) => {
  await knex.schema.createTable('users', (table) => {
    table.text('id').primary(); // Spotify user id, from GET /v1/me
    table.text('display_name');
    table.text('sync_status').notNullable().defaultTo('idle'); // idle|syncing|done|error
    table.text('sync_error');
    table.text('sync_progress_phase'); // 'songs' | 'playlists' | 'details', NULL unless syncing
    table.integer('sync_progress_current');
    table.integer('sync_progress_total');
    table.text('last_synced_at'); // NULL = never synced
    table.text('created_at').notNullable();
  });

  await knex.schema.createTable('artists', (table) => {
    table.text('id').primary();
    table.text('name').notNullable();
    table.text('country');
    table.integer('popularity');
    table.integer('followers');
    table.integer('details_resolved').notNullable().defaultTo(0); // resolved-but-empty vs never-resolved
  });

  await knex.schema.createTable('artist_genres', (table) => {
    table.text('artist_id').notNullable();
    table.text('genre').notNullable();
    table.primary(['artist_id', 'genre']);
    table.index('artist_id', 'idx_artist_genres_artist');
    table.index('genre', 'idx_artist_genres_genre');
  });

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
    // Computed once at write time (db/songs.js), not re-derived on every read.
    table.integer('year');
    table.text('decade');
    table.text('country');
  });

  await knex.schema.createTable('song_artists', (table) => {
    table.text('song_id').notNullable();
    table.text('artist_id').notNullable();
    table.integer('position').notNullable(); // 0 = primary
    table.primary(['song_id', 'artist_id']);
    table.index('song_id', 'idx_song_artists_song');
    table.index('artist_id', 'idx_song_artists_artist');
  });

  // Composite PK: two users can both follow the same real playlist, each with their own row.
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

  // No user_id — a real playlist's tracks are global. Liked Songs gets a per-user id
  // instead (db/playlists.js's likedSongsId) so it never collides here.
  await knex.schema.createTable('playlist_tracks', (table) => {
    table.text('playlist_id').notNullable();
    table.text('song_id').notNullable();
    table.text('added_at').notNullable();
    table.primary(['playlist_id', 'song_id']);
    table.index('playlist_id', 'idx_playlist_tracks_playlist');
    table.index('song_id', 'idx_playlist_tracks_song');
  });

  await knex.schema.createTable('tokens', (table) => {
    table.text('user_id').primary().references('id').inTable('users');
    table.text('access_token');
    table.text('refresh_token');
    table.integer('expires_at');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('tokens');
  await knex.schema.dropTableIfExists('playlist_tracks');
  await knex.schema.dropTableIfExists('playlists');
  await knex.schema.dropTableIfExists('song_artists');
  await knex.schema.dropTableIfExists('songs');
  await knex.schema.dropTableIfExists('artist_genres');
  await knex.schema.dropTableIfExists('artists');
  await knex.schema.dropTableIfExists('users');
};
