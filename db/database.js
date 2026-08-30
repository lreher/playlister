// The SQLite connection + schema — the low-level foundation everything
// else in db/ is built on, same role db/db.js used to play for JSON files.
// node:sqlite (Node's built-in driver) is still flagged experimental as of
// this Node version, but is synchronous and needs zero new dependencies —
// matches this project's "minimal, justified tooling" bar better than
// pulling in better-sqlite3 for the same synchronous API.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const isrcCountry = require('../utils/isrcCountry');

const db = new DatabaseSync(path.join(__dirname, '../data/playlister.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS artists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT,
    popularity INTEGER,
    followers INTEGER,
    -- distinguishes "genres/popularity resolution has run for this artist"
    -- from "resolved to genuinely empty/null" (a real artist can have no
    -- genres at all) — the JSON-era code told these apart by whether the
    -- key existed on the object at all, which every SQL row can't express
    -- on its own.
    details_resolved INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS artist_genres (
    artist_id TEXT NOT NULL,
    genre TEXT NOT NULL,
    PRIMARY KEY (artist_id, genre)
  );
  CREATE INDEX IF NOT EXISTS idx_artist_genres_artist ON artist_genres(artist_id);
  CREATE INDEX IF NOT EXISTS idx_artist_genres_genre ON artist_genres(genre);

  CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    album_name TEXT,
    album_release_date TEXT,
    album_type TEXT,
    added_at TEXT NOT NULL,
    isrc TEXT,
    duration_ms INTEGER,
    explicit INTEGER,
    spotify_url TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_songs_added_at ON songs(added_at);

  CREATE TABLE IF NOT EXISTS song_artists (
    song_id TEXT NOT NULL,
    artist_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (song_id, artist_id)
  );
  CREATE INDEX IF NOT EXISTS idx_song_artists_song ON song_artists(song_id);
  CREATE INDEX IF NOT EXISTS idx_song_artists_artist ON song_artists(artist_id);

  CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_name TEXT,
    public INTEGER,
    collaborative INTEGER,
    snapshot_id TEXT
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (playlist_id, song_id)
  );
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_song ON playlist_tracks(song_id);

  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER
  );
`);

// No PRAGMA foreign_keys — deliberately off (SQLite's own default). Artist
// resolution (country/genres/popularity) is a separate, later pass from
// song ingestion, same as it was with the JSON files; a song_artists row
// can reference an artist not yet resolved, and the LEFT JOINs below just
// produce NULL for it until it is.

// Wraps utils/isrcCountry's pure JS function as real SQL, so song_details
// below can compute the ISRC fallback in the query itself instead of every
// caller re-deriving it in JS.
db.function('isrc_country', (isrc) => isrcCountry.countryFromIsrc(isrc) ?? null);

db.exec(`
  CREATE VIEW IF NOT EXISTS song_details AS
  SELECT
    s.id,
    s.name,
    s.album_name,
    s.album_release_date,
    s.album_type,
    s.added_at,
    s.isrc,
    s.duration_ms,
    s.explicit,
    s.spotify_url,
    pa.id AS primary_artist_id,
    pa.popularity AS artist_popularity,
    pa.followers AS artist_followers,
    COALESCE(pa.country, isrc_country(s.isrc)) AS country,
    substr(s.album_release_date, 1, 4) AS year,
    (substr(s.album_release_date, 1, 3) || '0s') AS decade
  FROM songs s
  LEFT JOIN song_artists psa ON psa.song_id = s.id AND psa.position = 0
  LEFT JOIN artists pa ON pa.id = psa.artist_id;
`);

module.exports = db;
