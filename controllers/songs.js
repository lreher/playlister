const db = require('../db/index')();
const playlists = require('../db/playlists');

// `artists`/`songs`/`song_artists`/`artist_genres` are a shared cache across
// every user (see playlister_focus.md's "Data layer" section) — a song or
// artist's own metadata doesn't depend on who's browsing. What's user-
// specific is *membership*: a song only belongs to a user's library if it's
// in one of their playlists (including their own Liked Songs pseudo-
// playlist). Every read in this file applies this same check.
function visibleToUser(knexInstance, userId) {
  return function whereExistsCallback() {
    this.select(1)
      .from('playlist_tracks')
      .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
      .where('playlist_tracks.song_id', knexInstance.ref('songs.id'))
      .andWhere('playlists.user_id', userId);
  };
}

// A song's "added" date for THIS user: the earliest date it entered any of
// their playlists (their Liked Songs among them — it's a playlist here
// too). Per-user by nature — the same track is liked/added on a different
// date by each person — so it isn't a stored column on the shared songs
// row; every read that needs it goes through this correlated subquery
// (used as a SELECT-list value below) or the EXISTS-based checks in
// buildWhere for the addedFrom/addedTo filters.
function userAddedAtSubquery(knexInstance, userId) {
  return knexInstance('playlist_tracks')
    .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
    .where('playlists.user_id', userId)
    .andWhere('playlist_tracks.song_id', knexInstance.ref('songs.id'))
    .min('added_at as addedAt');
}

// Builds the shared, fully-joined-and-filtered query (no select/order/limit
// yet) used by both the COUNT and the page fetch in getSongs — a LEFT JOIN
// to the primary (position 0) artist for popularity/followers display and
// filtering, plus every WHERE/EXISTS filter including the mandatory
// per-user visibility check (always applied, not just when an explicit
// filter is set — this is what actually scopes "all songs" to "your
// songs"). Genre/artist/playlist are EXISTS subqueries since a song can
// match on any of its artists, not just the primary one.
function buildFilteredQuery(
  knexInstance,
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
  const query = knexInstance('songs')
    .leftJoin('song_artists as primary_sa', function joinPrimaryArtist() {
      this.on('primary_sa.song_id', '=', 'songs.id').andOnVal('primary_sa.position', '=', 0);
    })
    .leftJoin('artists as primary_artist', 'primary_artist.id', 'primary_sa.artist_id')
    .whereExists(visibleToUser(knexInstance, userId));

  if (genre) {
    query.whereExists(function () {
      this.select(1)
        .from('song_artists as sa')
        .join('artist_genres as ag', 'ag.artist_id', 'sa.artist_id')
        .where('sa.song_id', knexInstance.ref('songs.id'))
        .andWhere('ag.genre', genre);
    });
  }
  if (year) query.andWhere('songs.year', year);
  if (decade) query.andWhere('songs.decade', decade);
  if (country) query.andWhere('songs.country', country.toUpperCase());
  if (albumType) query.andWhere('songs.album_type', albumType);
  if (artist) {
    query.whereExists(function () {
      this.select(1)
        .from('song_artists as sa')
        .join('artists as a', 'a.id', 'sa.artist_id')
        .where('sa.song_id', knexInstance.ref('songs.id'))
        .andWhere('a.name', artist);
    });
  }
  if (playlist) {
    // Scoped to this user (not just a bare playlist_id check): the same
    // real playlist_id can now legitimately belong to more than one user's
    // own `playlists` row (composite PK), so an unscoped check here would
    // be a cross-tenant leak vector.
    query.whereExists(function () {
      this.select(1)
        .from('playlist_tracks as pt')
        .join('playlists as pl', 'pl.id', 'pt.playlist_id')
        .where('pt.playlist_id', playlist)
        .andWhere('pl.user_id', userId)
        .andWhere('pt.song_id', knexInstance.ref('songs.id'));
    });
  }
  if (durationMin != null) query.andWhere('songs.duration_ms', '>=', durationMin);
  if (durationMax != null) query.andWhere('songs.duration_ms', '<=', durationMax);
  // A song's earliest-added date is a MIN across potentially several
  // playlist_tracks rows (this user's own) — "MIN >= addedFrom" is
  // equivalent to "no matching row is earlier than addedFrom", and
  // "MIN <= addedTo" is equivalent to "at least one matching row is that
  // early or earlier". Expressing it this way keeps both checks as plain
  // EXISTS/NOT EXISTS, with no need to compare against a subquery's result.
  if (addedFrom) {
    query.whereNotExists(function () {
      this.select(1)
        .from('playlist_tracks')
        .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
        .where('playlists.user_id', userId)
        .andWhere('playlist_tracks.song_id', knexInstance.ref('songs.id'))
        .andWhere('playlist_tracks.added_at', '<', addedFrom);
    });
  }
  if (addedTo) {
    query.whereExists(function () {
      this.select(1)
        .from('playlist_tracks')
        .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
        .where('playlists.user_id', userId)
        .andWhere('playlist_tracks.song_id', knexInstance.ref('songs.id'))
        .andWhere('playlist_tracks.added_at', '<=', addedTo);
    });
  }
  // NULL naturally fails these comparisons in SQL — a song with no
  // resolved artist popularity is excluded exactly like the old
  // `artistPopularity !== null && ...` check, with no extra clause needed.
  if (popularityMin != null) query.andWhere('primary_artist.popularity', '>=', popularityMin);
  if (popularityMax != null) query.andWhere('primary_artist.popularity', '<=', popularityMax);

  return query;
}

// Batch-loads every artist (id/name, in position order) and the distinct
// genre set for a page of songs in two queries total, instead of one
// GROUP_CONCAT-style correlated subquery per song per row — display-only,
// and bounded to the current page (~50 rows), so there's no full-table
// cost the way there would be if this ran per visible song.
async function loadDisplayFields(knexInstance, songIds) {
  if (songIds.length === 0) return { artistsBySong: new Map(), genresBySong: new Map() };

  const artistRows = await knexInstance('song_artists')
    .join('artists', 'artists.id', 'song_artists.artist_id')
    .whereIn('song_artists.song_id', songIds)
    .orderBy('song_artists.position')
    .select({ songId: 'song_artists.song_id', name: 'artists.name' });
  const artistsBySong = new Map();
  for (const row of artistRows) {
    if (!artistsBySong.has(row.songId)) artistsBySong.set(row.songId, []);
    artistsBySong.get(row.songId).push(row.name);
  }

  const genreRows = await knexInstance('song_artists')
    .join('artist_genres', 'artist_genres.artist_id', 'song_artists.artist_id')
    .whereIn('song_artists.song_id', songIds)
    .select({ songId: 'song_artists.song_id', genre: 'artist_genres.genre' });
  const genresBySong = new Map();
  for (const row of genreRows) {
    if (!genresBySong.has(row.songId)) genresBySong.set(row.songId, new Set());
    genresBySong.get(row.songId).add(row.genre);
  }

  return { artistsBySong, genresBySong };
}

function rowToSong(row, artistNames, genres) {
  return {
    id: row.id,
    name: row.name,
    artists: artistNames.join(', '),
    album: row.album_name,
    addedAt: row.addedAt,
    country: row.country,
    genres,
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
// paginates the calling user's own visible songs.
async function getSongs({ userId, limit = 50, offset = 0, ...filters }, knexInstance = db) {
  const { count } = await buildFilteredQuery(knexInstance, filters, userId).count('songs.id as count').first();

  const rows = await buildFilteredQuery(knexInstance, filters, userId)
    .select(
      'songs.id',
      'songs.name',
      'songs.album_name',
      'songs.country',
      'songs.year',
      'songs.decade',
      'songs.explicit',
      'songs.duration_ms',
      'songs.album_type',
      'songs.spotify_url',
      { artist_popularity: 'primary_artist.popularity', artist_followers: 'primary_artist.followers' },
      { addedAt: userAddedAtSubquery(knexInstance, userId) }
    )
    .orderBy('addedAt', 'desc')
    .limit(limit)
    .offset(offset);

  const { artistsBySong, genresBySong } = await loadDisplayFields(knexInstance, rows.map((r) => r.id));
  const items = rows.map((row) =>
    rowToSong(row, artistsBySong.get(row.id) ?? [], [...(genresBySong.get(row.id) ?? [])])
  );

  return { items, total: count, limit, offset };
}

// Distinct filter option lists + ranges, for populating the List tab's
// dropdowns/sliders — scoped to the calling user's own visible songs, same
// as getSongs, so these never reveal another user's library composition
// (which genres/artists/countries exist elsewhere in the system) even
// though individual song rows already stay hidden.
async function getFilterOptions(userId, knexInstance = db) {
  const genres = (
    await knexInstance('artist_genres as ag')
      .join('song_artists as sa', 'sa.artist_id', 'ag.artist_id')
      .whereExists(visibleToUserWithSongIdColumn(knexInstance, 'sa.song_id', userId))
      .distinct('ag.genre')
      .orderBy('ag.genre')
  ).map((r) => r.genre);

  const years = (
    await knexInstance('songs')
      .whereNotNull('year')
      .whereExists(visibleToUser(knexInstance, userId))
      .distinct('year')
      .orderBy('year', 'desc')
  ).map((r) => r.year);

  const decades = (
    await knexInstance('songs')
      .whereNotNull('decade')
      .whereExists(visibleToUser(knexInstance, userId))
      .distinct('decade')
      .orderBy('decade', 'desc')
  ).map((r) => r.decade);

  const countries = (
    await knexInstance('songs')
      .whereNotNull('country')
      .whereExists(visibleToUser(knexInstance, userId))
      .distinct('country')
      .orderBy('country')
  ).map((r) => r.country);

  const albumTypes = (
    await knexInstance('songs')
      .whereNotNull('album_type')
      .whereExists(visibleToUser(knexInstance, userId))
      .distinct('album_type')
      .orderBy('album_type')
  ).map((r) => r.album_type);

  const artists = (
    await knexInstance('artists as a')
      .join('song_artists as sa', 'sa.artist_id', 'a.id')
      .whereExists(visibleToUserWithSongIdColumn(knexInstance, 'sa.song_id', userId))
      .distinct('a.name')
      .orderBy('a.name')
  ).map((r) => r.name);

  const durationRange = await knexInstance('songs')
    .whereExists(visibleToUser(knexInstance, userId))
    .min('duration_ms as min')
    .max('duration_ms as max')
    .first();

  const addedAtRows = await userAddedAtRows(knexInstance, userId);
  const addedTimes = addedAtRows.map((r) => r.addedAt).sort();
  const addedRange = { min: addedTimes[0] ?? null, max: addedTimes[addedTimes.length - 1] ?? null };

  const popularityRange = await knexInstance('songs')
    .leftJoin('song_artists as primary_sa', function () {
      this.on('primary_sa.song_id', '=', 'songs.id').andOnVal('primary_sa.position', '=', 0);
    })
    .leftJoin('artists as primary_artist', 'primary_artist.id', 'primary_sa.artist_id')
    .whereExists(visibleToUser(knexInstance, userId))
    .whereNotNull('primary_artist.popularity')
    .min('primary_artist.popularity as min')
    .max('primary_artist.popularity as max')
    .first();

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
    playlists: (await playlists.getAll(userId, knexInstance)).map((p) => ({
      id: p.id,
      name: p.name,
      trackCount: p.tracks.length,
    })),
  };
}

// Same visibility check as visibleToUser, but for a query whose FROM
// clause exposes the song id under a different alias (e.g. song_artists'
// sa.song_id rather than songs.id) — genre/artist option lists join
// through song_artists directly rather than starting from songs.
function visibleToUserWithSongIdColumn(knexInstance, songIdColumn, userId) {
  return function whereExistsCallback() {
    this.select(1)
      .from('playlist_tracks')
      .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
      .where('playlist_tracks.song_id', knexInstance.ref(songIdColumn))
      .andWhere('playlists.user_id', userId);
  };
}

// One row per song this user has (via any of their playlists, Liked Songs
// included), value = the earliest date it entered any of them. The
// membership join itself *is* the visibility check here — no separate
// EXISTS needed, unlike the songs-table reads above. The join to `songs`
// isn't just for shape — it guards against an orphaned playlist_tracks row
// (membership pointing at a song_id absent from `songs`, the residue of an
// interrupted/older sync) inflating these aggregates past the visible
// song count.
function userAddedAtRows(knexInstance, userId) {
  return knexInstance('playlist_tracks')
    .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
    .join('songs', 'songs.id', 'playlist_tracks.song_id')
    .where('playlists.user_id', userId)
    .groupBy('playlist_tracks.song_id')
    .min('playlist_tracks.added_at as addedAt');
}

// Pre-aggregated counts for the Dashboards tab's charts — scoped to the
// calling user's own visible songs, same reasoning as getFilterOptions.
// year/decade/country are plain GROUP BYs on stored columns (pure SQL,
// pushed down); popularity buckets and liked-by-month need JS-side
// grouping (bucket-label formatting and month-string slicing aren't
// expressible as knex builder calls without a raw SQL function) — both are
// bounded to this user's own visible library, not a full-table scan, so
// there's no real cost to doing that grouping in JS instead.
async function getStats(userId, knexInstance = db) {
  const yearCounts = await knexInstance('songs')
    .whereNotNull('year')
    .whereExists(visibleToUser(knexInstance, userId))
    .groupBy('year')
    .orderBy('year')
    .select('year')
    .count('* as count');

  const decadeCounts = await knexInstance('songs')
    .whereNotNull('decade')
    .whereExists(visibleToUser(knexInstance, userId))
    .groupBy('decade')
    .orderBy('decade')
    .select('decade')
    .count('* as count');

  const countryCounts = await knexInstance('songs')
    .whereNotNull('country')
    .whereExists(visibleToUser(knexInstance, userId))
    .groupBy('country')
    .orderBy('count', 'desc')
    .select({ code: 'country' })
    .count('* as count');

  const popularityRows = await knexInstance('songs')
    .leftJoin('song_artists as primary_sa', function () {
      this.on('primary_sa.song_id', '=', 'songs.id').andOnVal('primary_sa.position', '=', 0);
    })
    .leftJoin('artists as primary_artist', 'primary_artist.id', 'primary_sa.artist_id')
    .whereExists(visibleToUser(knexInstance, userId))
    .whereNotNull('primary_artist.popularity')
    .select({ popularity: 'primary_artist.popularity' });
  const popularityBuckets = new Map();
  for (const { popularity } of popularityRows) {
    const bucket = Math.floor(popularity / 10) * 10;
    popularityBuckets.set(bucket, (popularityBuckets.get(bucket) ?? 0) + 1);
  }
  const popularityCounts = [...popularityBuckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucket, count]) => ({ bucket: `${bucket}-${bucket + 9}`, count }));

  const addedAtRows = await userAddedAtRows(knexInstance, userId);
  const monthCounts = new Map();
  for (const { addedAt } of addedAtRows) {
    const month = addedAt.slice(0, 7);
    monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
  }
  const likedCounts = [...monthCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => ({ month, count }));

  return { yearCounts, decadeCounts, popularityCounts, countryCounts, likedCounts };
}

module.exports = { getSongs, getFilterOptions, getStats };
