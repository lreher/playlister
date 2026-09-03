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

// A song's "added" date for THIS user: the earliest date it entered any of
// their playlists (their Liked Songs among them — it's a playlist here too).
// Per-user by nature — the same track is liked/added on a different date by
// each person — so it can't live on the shared songs row or the
// song_details view; every read that sorts, filters, or buckets by "added"
// threads a userId param through this instead. Takes one `?` (the user id).
const USER_ADDED_AT_SUBQUERY = `(
  SELECT MIN(pt.added_at) FROM playlist_tracks pt
  JOIN playlists pl ON pl.id = pt.playlist_id
  WHERE pt.song_id = sd.id AND pl.user_id = ?
)`;

// The same per-user "added" date as a standalone row source (one row per
// song in the user's library, its value = first date that song entered any
// of their playlists) — for the range/histogram reads that aggregate over
// it rather than attaching it to a song_details row. Membership *is* the
// FROM clause here, so no separate visibleToUser check is needed. The
// `JOIN songs` keeps this in step with getSongs, which is `FROM songs`:
// without it an orphaned playlist_tracks row (membership pointing at a
// song_id absent from `songs` — the residue of an interrupted/older sync)
// would inflate these aggregates past the visible song count. One `?`.
const USER_ADDED_AT_ROWS = `(
  SELECT MIN(pt.added_at) AS added_at FROM playlist_tracks pt
  JOIN playlists pl ON pl.id = pt.playlist_id
  JOIN songs s ON s.id = pt.song_id
  WHERE pl.user_id = ? GROUP BY pt.song_id
)`;

// `artists`/`songs`/`song_artists`/`artist_genres` are a shared cache across
// every user (see playlister_focus.md's "Data layer" section) — a song or
// artist's own metadata doesn't depend on who's browsing. What's user-
// specific is *membership*: a song only belongs to a user's library if it's
// in one of their playlists (including their own Liked Songs pseudo-
// playlist). Every read in this file goes through this same check, applied
// to whichever id column that particular query's FROM clause exposes.
function visibleToUser(songIdColumn) {
  return `EXISTS (
    SELECT 1 FROM playlist_tracks pt
    JOIN playlists pl ON pl.id = pt.playlist_id
    WHERE pt.song_id = ${songIdColumn} AND pl.user_id = ?
  )`;
}

// Builds a parameterized WHERE clause from getSongs()'s filter object, plus
// the mandatory per-user visibility check (always applied, not just when an
// explicit filter is set — this is what actually scopes "all songs" to
// "your songs"). Genre and artist are EXISTS subqueries (a song can match
// on any of its artists, not just the primary one — genre is a many-valued
// union across them).
function buildWhere(
  {
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
  },
  userId
) {
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
    // Joins through playlists (not just a bare playlist_tracks check) and
    // scopes to this user: the same real playlist_id can now legitimately
    // belong to more than one user's own `playlists` row (composite PK),
    // so an unscoped check here would be a cross-tenant leak vector.
    clauses.push(
      'EXISTS (SELECT 1 FROM playlist_tracks pt JOIN playlists pl ON pl.id = pt.playlist_id WHERE pt.playlist_id = ? AND pl.user_id = ? AND pt.song_id = sd.id)'
    );
    params.push(playlist, userId);
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
    clauses.push(`${USER_ADDED_AT_SUBQUERY} >= ?`);
    params.push(userId, addedFrom);
  }
  if (addedTo) {
    clauses.push(`${USER_ADDED_AT_SUBQUERY} <= ?`);
    params.push(userId, addedTo);
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

  clauses.push(visibleToUser('sd.id'));
  params.push(userId);

  return { where: `WHERE ${clauses.join(' AND ')}`, params };
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

// Filters, sorts (newest-added first, by this user's own added date), and
// paginates the calling user's own visible songs via real SQL against the
// song_details view.
function getSongs({ userId, limit = 50, offset = 0, ...filters }) {
  const { where, params } = buildWhere(filters, userId);

  const { count: total } = db.prepare(`SELECT COUNT(*) AS count FROM song_details sd ${where}`).get(...params);

  const items = db
    .prepare(
      `SELECT sd.*, ${USER_ADDED_AT_SUBQUERY} AS added_at,
              ${ARTIST_NAMES_SUBQUERY} AS artist_names, ${GENRES_SUBQUERY} AS genres
       FROM song_details sd
       ${where}
       ORDER BY added_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(userId, ...params, limit, offset)
    .map(rowToSong);

  return { items, total, limit, offset };
}

// Distinct filter option lists + ranges, for populating the List tab's
// dropdowns/sliders — scoped to the calling user's own visible songs, same
// as getSongs, so these never reveal another user's library composition
// (which genres/artists/countries exist elsewhere in the system) even
// though individual song rows already stay hidden.
function getFilterOptions(userId) {
  const genres = db
    .prepare(
      `SELECT DISTINCT ag.genre FROM artist_genres ag JOIN song_artists sa ON sa.artist_id = ag.artist_id
       WHERE ${visibleToUser('sa.song_id')} ORDER BY ag.genre`
    )
    .all(userId)
    .map((r) => r.genre);
  const years = db
    .prepare(`SELECT DISTINCT year FROM song_details sd WHERE year IS NOT NULL AND ${visibleToUser('sd.id')} ORDER BY year DESC`)
    .all(userId)
    .map((r) => r.year);
  const decades = db
    .prepare(`SELECT DISTINCT decade FROM song_details sd WHERE decade IS NOT NULL AND ${visibleToUser('sd.id')} ORDER BY decade DESC`)
    .all(userId)
    .map((r) => r.decade);
  const countries = db
    .prepare(`SELECT DISTINCT country FROM song_details sd WHERE country IS NOT NULL AND ${visibleToUser('sd.id')} ORDER BY country`)
    .all(userId)
    .map((r) => r.country);
  const albumTypes = db
    .prepare(`SELECT DISTINCT album_type FROM songs s WHERE album_type IS NOT NULL AND ${visibleToUser('s.id')} ORDER BY album_type`)
    .all(userId)
    .map((r) => r.album_type);
  const artists = db
    .prepare(
      `SELECT DISTINCT a.name FROM song_artists sa JOIN artists a ON a.id = sa.artist_id
       WHERE ${visibleToUser('sa.song_id')} ORDER BY a.name`
    )
    .all(userId)
    .map((r) => r.name);

  const durationRange = db
    .prepare(`SELECT MIN(duration_ms) AS min, MAX(duration_ms) AS max FROM songs s WHERE ${visibleToUser('s.id')}`)
    .get(userId);
  const addedRange = db
    .prepare(`SELECT MIN(added_at) AS min, MAX(added_at) AS max FROM ${USER_ADDED_AT_ROWS}`)
    .get(userId);
  const popularityRange = db
    .prepare(
      `SELECT MIN(artist_popularity) AS min, MAX(artist_popularity) AS max FROM song_details sd
       WHERE artist_popularity IS NOT NULL AND ${visibleToUser('sd.id')}`
    )
    .get(userId);

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
    playlists: playlists.getAll(userId).map((p) => ({ id: p.id, name: p.name, trackCount: p.tracks.length })),
  };
}

// Pre-aggregated counts for the Dashboards tab's charts, via GROUP BY —
// scoped to the calling user's own visible songs, same reasoning as
// getFilterOptions.
function getStats(userId) {
  const yearCounts = db
    .prepare(
      `SELECT year, COUNT(*) AS count FROM song_details sd
       WHERE year IS NOT NULL AND ${visibleToUser('sd.id')} GROUP BY year ORDER BY year`
    )
    .all(userId);
  const decadeCounts = db
    .prepare(
      `SELECT decade, COUNT(*) AS count FROM song_details sd
       WHERE decade IS NOT NULL AND ${visibleToUser('sd.id')} GROUP BY decade ORDER BY decade`
    )
    .all(userId);
  const popularityCounts = db
    .prepare(
      `SELECT (CAST(artist_popularity / 10 AS INTEGER) * 10) || '-' || (CAST(artist_popularity / 10 AS INTEGER) * 10 + 9) AS bucket,
              COUNT(*) AS count
       FROM song_details sd
       WHERE artist_popularity IS NOT NULL AND ${visibleToUser('sd.id')}
       GROUP BY CAST(artist_popularity / 10 AS INTEGER)
       ORDER BY CAST(artist_popularity / 10 AS INTEGER)`
    )
    .all(userId);
  const countryCounts = db
    .prepare(
      `SELECT country AS code, COUNT(*) AS count FROM song_details sd
       WHERE country IS NOT NULL AND ${visibleToUser('sd.id')} GROUP BY country ORDER BY count DESC`
    )
    .all(userId);
  const likedCounts = db
    .prepare(
      `SELECT substr(added_at, 1, 7) AS month, COUNT(*) AS count FROM ${USER_ADDED_AT_ROWS}
       GROUP BY month ORDER BY month`
    )
    .all(userId);

  return { yearCounts, decadeCounts, popularityCounts, countryCounts, likedCounts };
}

module.exports = { getSongs, getFilterOptions, getStats };
