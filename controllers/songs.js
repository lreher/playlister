const db = require('../db/database');
const playlists = require('../db/playlists');

// Correlated subqueries reused by every song_details read below — the
// view itself only covers one-to-one fields (a song has one primary
// artist), these two are one-to-many (every artist on the track, every
// genre across all of them) so they don't fit as plain view columns.
const ARTIST_NAMES_SUBQUERY = `(
  SELECT GROUP_CONCAT(name, ', ') FROM (
    SELECT a.name FROM song_artists sa JOIN artists a ON a.id = sa.artist_id
    WHERE sa.song_id = sd.id ORDER BY sa.position
  )
)`;
const GENRES_SUBQUERY = `(
  SELECT GROUP_CONCAT(DISTINCT ag.genre) FROM song_artists sa
  JOIN artist_genres ag ON ag.artist_id = sa.artist_id WHERE sa.song_id = sd.id
)`;

// Builds a parameterized WHERE clause from getSongs()'s filter object.
// Every field optional/nullable — omit a filter to not apply it. Genre and
// artist are EXISTS subqueries (a song can match on any of its artists,
// not just the primary one — genre is a many-valued union across them).
function buildWhere({
  genre,
  year,
  decade,
  country,
  albumType,
  artist,
  playlist,
  durationMin,
  durationMax,
  addedFrom,
  addedTo,
  popularityMin,
  popularityMax,
}) {
  const clauses = [];
  const params = [];

  if (genre) {
    clauses.push(
      `EXISTS (SELECT 1 FROM song_artists sa JOIN artist_genres ag ON ag.artist_id = sa.artist_id WHERE sa.song_id = sd.id AND lower(ag.genre) = lower(?))`
    );
    params.push(genre);
  }
  if (year) {
    clauses.push('sd.year = ?');
    params.push(year);
  }
  if (decade) {
    clauses.push('sd.decade = ?');
    params.push(decade);
  }
  if (country) {
    clauses.push('sd.country = ?');
    params.push(country.toUpperCase());
  }
  if (albumType) {
    clauses.push('sd.album_type = ?');
    params.push(albumType);
  }
  if (artist) {
    clauses.push(
      `EXISTS (SELECT 1 FROM song_artists sa JOIN artists a ON a.id = sa.artist_id WHERE sa.song_id = sd.id AND lower(a.name) = lower(?))`
    );
    params.push(artist);
  }
  if (playlist) {
    clauses.push('EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.playlist_id = ? AND pt.song_id = sd.id)');
    params.push(playlist);
  }
  if (durationMin != null) {
    clauses.push('sd.duration_ms >= ?');
    params.push(durationMin);
  }
  if (durationMax != null) {
    clauses.push('sd.duration_ms <= ?');
    params.push(durationMax);
  }
  if (addedFrom) {
    clauses.push('sd.added_at >= ?');
    params.push(addedFrom);
  }
  if (addedTo) {
    clauses.push('sd.added_at <= ?');
    params.push(addedTo);
  }
  // NULL naturally fails these comparisons in SQL — a song with no
  // resolved artist popularity is excluded exactly like the old
  // `artistPopularity !== null && ...` check, with no extra clause needed.
  if (popularityMin != null) {
    clauses.push('sd.artist_popularity >= ?');
    params.push(popularityMin);
  }
  if (popularityMax != null) {
    clauses.push('sd.artist_popularity <= ?');
    params.push(popularityMax);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function rowToSong(row) {
  return {
    id: row.id,
    name: row.name,
    artists: row.artist_names ?? '',
    album: row.album_name,
    addedAt: row.added_at,
    country: row.country,
    genres: row.genres ? row.genres.split(',') : [],
    year: row.year,
    decade: row.decade,
    explicit: !!row.explicit,
    durationMs: row.duration_ms,
    albumType: row.album_type,
    spotifyUrl: row.spotify_url,
    artistPopularity: row.artist_popularity,
    artistFollowers: row.artist_followers,
  };
}

// Filters, sorts (newest-added first), and paginates the local song
// snapshot via real SQL against the song_details view.
function getSongs({ limit = 50, offset = 0, ...filters } = {}) {
  const { where, params } = buildWhere(filters);

  const { count: total } = db.prepare(`SELECT COUNT(*) AS count FROM song_details sd ${where}`).get(...params);

  const items = db
    .prepare(
      `SELECT sd.*, ${ARTIST_NAMES_SUBQUERY} AS artist_names, ${GENRES_SUBQUERY} AS genres
       FROM song_details sd
       ${where}
       ORDER BY sd.added_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset)
    .map(rowToSong);

  return { items, total, limit, offset };
}

// Distinct filter option lists + ranges, for populating the List tab's
// dropdowns/sliders. Genres/artists are scoped to ones that actually
// appear on a song (via song_artists), same as the old per-song union.
function getFilterOptions() {
  const genres = db
    .prepare('SELECT DISTINCT ag.genre FROM artist_genres ag JOIN song_artists sa ON sa.artist_id = ag.artist_id ORDER BY ag.genre')
    .all()
    .map((r) => r.genre);
  const years = db
    .prepare('SELECT DISTINCT year FROM song_details WHERE year IS NOT NULL ORDER BY year DESC')
    .all()
    .map((r) => r.year);
  const decades = db
    .prepare('SELECT DISTINCT decade FROM song_details WHERE decade IS NOT NULL ORDER BY decade DESC')
    .all()
    .map((r) => r.decade);
  const countries = db
    .prepare('SELECT DISTINCT country FROM song_details WHERE country IS NOT NULL ORDER BY country')
    .all()
    .map((r) => r.country);
  const albumTypes = db
    .prepare('SELECT DISTINCT album_type FROM songs WHERE album_type IS NOT NULL ORDER BY album_type')
    .all()
    .map((r) => r.album_type);
  const artists = db
    .prepare('SELECT DISTINCT a.name FROM song_artists sa JOIN artists a ON a.id = sa.artist_id ORDER BY a.name')
    .all()
    .map((r) => r.name);

  const durationRange = db.prepare('SELECT MIN(duration_ms) AS min, MAX(duration_ms) AS max FROM songs').get();
  const addedRange = db.prepare('SELECT MIN(added_at) AS min, MAX(added_at) AS max FROM songs').get();
  const popularityRange = db
    .prepare('SELECT MIN(artist_popularity) AS min, MAX(artist_popularity) AS max FROM song_details WHERE artist_popularity IS NOT NULL')
    .get();

  return {
    genres,
    years,
    decades,
    countries,
    albumTypes,
    artists,
    durationRange,
    addedRange,
    popularityRange,
    playlists: playlists.getAll().map((p) => ({ id: p.id, name: p.name, trackCount: p.tracks.length })),
  };
}

// Pre-aggregated counts for the Dashboards tab's charts, via GROUP BY.
function getStats() {
  const yearCounts = db
    .prepare('SELECT year, COUNT(*) AS count FROM song_details WHERE year IS NOT NULL GROUP BY year ORDER BY year')
    .all();
  const decadeCounts = db
    .prepare('SELECT decade, COUNT(*) AS count FROM song_details WHERE decade IS NOT NULL GROUP BY decade ORDER BY decade')
    .all();
  const popularityCounts = db
    .prepare(
      `SELECT (CAST(artist_popularity / 10 AS INTEGER) * 10) || '-' || (CAST(artist_popularity / 10 AS INTEGER) * 10 + 9) AS bucket,
              COUNT(*) AS count
       FROM song_details
       WHERE artist_popularity IS NOT NULL
       GROUP BY CAST(artist_popularity / 10 AS INTEGER)
       ORDER BY CAST(artist_popularity / 10 AS INTEGER)`
    )
    .all();
  const countryCounts = db
    .prepare('SELECT country AS code, COUNT(*) AS count FROM song_details WHERE country IS NOT NULL GROUP BY country ORDER BY count DESC')
    .all();
  const likedCounts = db
    .prepare("SELECT substr(added_at, 1, 7) AS month, COUNT(*) AS count FROM songs GROUP BY month ORDER BY month")
    .all();

  return { yearCounts, decadeCounts, popularityCounts, countryCounts, likedCounts };
}

module.exports = { getSongs, getFilterOptions, getStats };
