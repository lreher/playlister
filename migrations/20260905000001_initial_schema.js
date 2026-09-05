// Baseline schema — the full, final desired shape (including songs.year/
// decade/country as real stored columns, computed at write time; see
// 20260905000002 for why those replaced the old song_details view).
//
// This does NOT run against the databases that already existed before
// knex migrations were adopted (local dev + the droplet) — those had this
// schema already, minus the new columns and still with the old view. For
// those two, this migration is manually marked as already-applied (a row
// inserted into knex_migrations) so it's skipped, and 20260905000002 is
// what actually brings them up to the current shape. A genuinely fresh
// install runs both in order and ends up in the exact same place.
//
// No PRAGMA foreign_keys anywhere (SQLite's own default, left off
// deliberately) — artist resolution (country/genres/popularity) is a
// separate, later pass from song ingestion, so a song_artists row can
// reference an artist not yet resolved. The `.references()` calls below on
// playlists/tokens are unenforced without that pragma, same as they always
// were — kept for documentation, not constraint enforcement.
exports.up = async function up(knex) {
  await knex.schema.createTable('users', (table) => {
    table.text('id').primary(); // Spotify user id, from GET /v1/me
    table.text('display_name');
    table.text('sync_status').notNullable().defaultTo('idle'); // idle|syncing|done|error
    table.text('sync_error');
    // Only meaningful while sync_status = 'syncing' — set by runFastSync's
    // own progress reporting, read by /api/sync-status. NULL the rest of
    // the time.
    table.text('sync_progress_phase'); // 'songs' | 'playlists' | 'details'
    table.integer('sync_progress_current');
    table.integer('sync_progress_total');
    // Timestamp of the last completed fast sync, set in JS (db/users.js)
    // at the moment sync_status becomes 'done'. NULL = never synced.
    table.text('last_synced_at');
    table.text('created_at').notNullable();
  });

  await knex.schema.createTable('artists', (table) => {
    table.text('id').primary();
    table.text('name').notNullable();
    table.text('country');
    table.integer('popularity');
    table.integer('followers');
    // Distinguishes "genres/popularity resolution has run for this artist"
    // from "resolved to genuinely empty/null" (a real artist can have no
    // genres at all).
    table.integer('details_resolved').notNullable().defaultTo(0);
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
    // Derived from album_release_date/isrc/the primary artist's country —
    // computed once in JS at write time (db/songs.js), not re-derived on
    // every read. See 20260905000002 for the migration that added these to
    // a database that predates this design and the backfill that populated
    // them for existing rows.
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

  // Composite PK, not just id: a real Spotify playlist can be followed by
  // more than one Playlister account (e.g. two users both follow the same
  // collaborative playlist) — a single-id PK would let the second user's
  // sync silently steal the row's ownership from the first.
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

  // Deliberately no user_id here: a real playlist's track list is the same
  // objective content no matter which user is looking at it (same
  // reasoning as artists/songs staying global). The one pseudo-playlist
  // that isn't real shared Spotify data — Liked Songs — gets a per-user-
  // unique id instead (db/playlists.js's likedSongsId) so two users'
  // liked-songs content can never collide here.
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

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tokens');
  await knex.schema.dropTableIfExists('playlist_tracks');
  await knex.schema.dropTableIfExists('playlists');
  await knex.schema.dropTableIfExists('song_artists');
  await knex.schema.dropTableIfExists('songs');
  await knex.schema.dropTableIfExists('artist_genres');
  await knex.schema.dropTableIfExists('artists');
  await knex.schema.dropTableIfExists('users');
};
