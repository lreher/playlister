// One-time migration: reads the old JSON files and populates the new
// SQLite tables (db/database.js). Long since run everywhere and kept only
// for history — it still writes a `songs.added_at` column that later
// migrations dropped, so it would now fail if re-run. Not worth updating a
// dead script; noted so it isn't a surprise.
//
// Read-only against the JSON — they're
// left on disk untouched afterward, both as a natural backup and because
// deleting hard-won data (the country/genre/popularity enrichment took
// real API work) isn't this script's call to make. Idempotent — every
// insert is ON CONFLICT DO NOTHING / INSERT OR IGNORE, so re-running it
// (e.g. after a partial run) never duplicates or clobbers anything.
const fs = require('fs');
const path = require('path');
const db = require('../db/database');

function loadJson(relativePath, defaultValue) {
  const filePath = path.join(__dirname, '..', relativePath);
  if (!fs.existsSync(filePath)) return defaultValue;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function migrateArtists() {
  const artists = loadJson('data/artists.json', []);
  const insertArtist = db.prepare(`
    INSERT INTO artists (id, name, country, popularity, followers, details_resolved)
    VALUES (@id, @name, @country, @popularity, @followers, @detailsResolved)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertGenre = db.prepare('INSERT OR IGNORE INTO artist_genres (artist_id, genre) VALUES (?, ?)');

  db.exec('BEGIN');
  for (const artist of artists) {
    insertArtist.run({
      id: artist.id,
      // A couple of artists.json entries have name: null (a leftover from
      // before mapTrack started filtering null-named track artists —
      // neither is referenced by any actual song). name is NOT NULL here,
      // so treat it the same as the sibling entry that's already "".
      name: artist.name ?? '',
      country: artist.country ?? null,
      popularity: artist.popularity ?? null,
      followers: artist.followers ?? null,
      // Matches the old "does the key exist at all" resolved-check —
      // see db/database.js's details_resolved comment.
      detailsResolved: 'genres' in artist || 'popularity' in artist ? 1 : 0,
    });
    for (const genre of artist.genres ?? []) {
      insertGenre.run(artist.id, genre);
    }
  }
  db.exec('COMMIT');
  console.log(`[migrate] ${artists.length} artists`);
}

function migrateSongs() {
  const songs = loadJson('data/songs.json', []);
  const insertSong = db.prepare(`
    INSERT INTO songs (id, name, album_name, album_release_date, album_type, added_at, isrc, duration_ms, explicit, spotify_url)
    VALUES (@id, @name, @albumName, @albumReleaseDate, @albumType, @addedAt, @isrc, @durationMs, @explicit, @spotifyUrl)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertSongArtist = db.prepare('INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) VALUES (?, ?, ?)');
  // Defensive only — every song's artists should already exist from
  // migrateArtists(), but if one somehow doesn't, this keeps the row
  // consistent with a fresh sync's own behavior (db/songs.js's
  // mergeTracks does the same stub-insert).
  const upsertArtistStub = db.prepare('INSERT INTO artists (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name');

  db.exec('BEGIN');
  for (const song of songs) {
    insertSong.run({
      id: song.id,
      name: song.name,
      albumName: song.album?.name ?? null,
      albumReleaseDate: song.album?.releaseDate ?? null,
      albumType: song.album?.albumType ?? null,
      addedAt: song.addedAt,
      isrc: song.isrc ?? null,
      durationMs: song.durationMs ?? null,
      explicit: song.explicit ? 1 : 0,
      spotifyUrl: song.spotifyUrl ?? null,
    });
    song.artists.forEach((artist, position) => {
      upsertArtistStub.run(artist.id, artist.name);
      insertSongArtist.run(song.id, artist.id, position);
    });
  }
  db.exec('COMMIT');
  console.log(`[migrate] ${songs.length} songs`);
}

function migratePlaylists() {
  const playlists = loadJson('data/playlists.json', []);
  const insertPlaylist = db.prepare(`
    INSERT INTO playlists (id, name, owner_name, public, collaborative, snapshot_id)
    VALUES (@id, @name, @ownerName, @public, @collaborative, @snapshotId)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertTrack = db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, song_id, added_at) VALUES (?, ?, ?)');

  db.exec('BEGIN');
  for (const playlist of playlists) {
    insertPlaylist.run({
      id: playlist.id,
      name: playlist.name,
      ownerName: playlist.ownerName ?? null,
      public: playlist.public ? 1 : 0,
      collaborative: playlist.collaborative ? 1 : 0,
      snapshotId: playlist.snapshotId ?? null,
    });
    for (const track of playlist.tracks) {
      insertTrack.run(playlist.id, track.id, track.addedAt);
    }
  }
  db.exec('COMMIT');
  console.log(`[migrate] ${playlists.length} playlists`);
}

function migrateTokens() {
  const tokens = loadJson('data/tokens.json', null);
  if (!tokens) {
    console.log('[migrate] no tokens.json found, skipping');
    return;
  }
  db.prepare(
    `INSERT INTO tokens (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET access_token = ?, refresh_token = ?, expires_at = ?`
  ).run(tokens.access_token, tokens.refresh_token, tokens.expires_at, tokens.access_token, tokens.refresh_token, tokens.expires_at);
  console.log('[migrate] tokens (session preserved, no need to re-log-in)');
}

function main() {
  migrateArtists();
  migrateSongs();
  migratePlaylists();
  migrateTokens();
  console.log('[migrate] done');
}

main();
