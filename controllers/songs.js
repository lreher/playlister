const db = require('../db/index')();
const playlists = require('../db/playlists');

// A song is visible to a user only if it's in one of their playlists (Liked Songs included).
const visibleToUser = (knexInstance, userId) =>
  knexInstance('playlist_tracks')
    .select(1)
    .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
    .where('playlist_tracks.song_id', knexInstance.ref('songs.id'))
    .andWhere('playlists.user_id', userId);

// Per-user "added" date: earliest date this song entered any of the user's playlists.
const userAddedAtSubquery = (knexInstance, userId) => knexInstance('playlist_tracks')
    .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
    .where('playlists.user_id', userId)
    .andWhere('playlist_tracks.song_id', knexInstance.ref('songs.id'))
    .min('added_at as addedAt');

// Shared filtered/joined query for both the count and the page fetch in getSongs.
// The visibility check always runs, not just when a filter is set — it's what scopes
// "all songs" down to "this user's songs."
const buildFilteredQuery = (
  knexInstance,
  {
    genres,
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
) => {
  const query = knexInstance('songs')
    .leftJoin('song_artists as primary_sa', (join) => {
      join.on('primary_sa.song_id', '=', 'songs.id').andOnVal('primary_sa.position', '=', 0);
    })
    .leftJoin('artists as primary_artist', 'primary_artist.id', 'primary_sa.artist_id')
    .whereExists(visibleToUser(knexInstance, userId));

  // OR across selected genres: a song matches if any of its (union-of-artists) genres is selected.
  if (genres && genres.length > 0) {
    query.whereExists(
      knexInstance('song_artists as sa')
        .select(1)
        .join('artist_genres as ag', 'ag.artist_id', 'sa.artist_id')
        .where('sa.song_id', knexInstance.ref('songs.id'))
        .whereIn('ag.genre', genres)
    );
  }
  if (year) query.andWhere('songs.year', year);
  if (decade) query.andWhere('songs.decade', decade);
  if (country) query.andWhere('songs.country', country.toUpperCase());
  if (albumType) query.andWhere('songs.album_type', albumType);
  if (artist) {
    query.whereExists(
      knexInstance('song_artists as sa')
        .select(1)
        .join('artists as a', 'a.id', 'sa.artist_id')
        .where('sa.song_id', knexInstance.ref('songs.id'))
        .andWhere('a.name', artist)
    );
  }
  if (playlist) {
    // A playlist_id can belong to more than one user's playlists row, so this must
    // also check pl.user_id — otherwise it'd leak another user's playlist contents.
    query.whereExists(
      knexInstance('playlist_tracks as pt')
        .select(1)
        .join('playlists as pl', 'pl.id', 'pt.playlist_id')
        .where('pt.playlist_id', playlist)
        .andWhere('pl.user_id', userId)
        .andWhere('pt.song_id', knexInstance.ref('songs.id'))
    );
  }
  if (durationMin !== null && durationMin !== undefined) query.andWhere('songs.duration_ms', '>=', durationMin);
  if (durationMax !== null && durationMax !== undefined) query.andWhere('songs.duration_ms', '<=', durationMax);
  // addedFrom: no playlist row is earlier. addedTo: at least one row is that early or earlier.
  if (addedFrom) {
    query.whereNotExists(
      knexInstance('playlist_tracks')
        .select(1)
        .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
        .where('playlists.user_id', userId)
        .andWhere('playlist_tracks.song_id', knexInstance.ref('songs.id'))
        .andWhere('playlist_tracks.added_at', '<', addedFrom)
    );
  }
  if (addedTo) {
    query.whereExists(
      knexInstance('playlist_tracks')
        .select(1)
        .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
        .where('playlists.user_id', userId)
        .andWhere('playlist_tracks.song_id', knexInstance.ref('songs.id'))
        .andWhere('playlist_tracks.added_at', '<=', addedTo)
    );
  }
  // NULL fails these comparisons in SQL, so songs with no resolved popularity drop out naturally.
  if (popularityMin !== null && popularityMin !== undefined) query.andWhere('primary_artist.popularity', '>=', popularityMin);
  if (popularityMax !== null && popularityMax !== undefined) query.andWhere('primary_artist.popularity', '<=', popularityMax);

  return query;
};

// Batches artist/genre lookups for a page of songs into two queries instead of one per song.
const loadDisplayFields = async (knexInstance, songIds) => {
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
};

const rowToSong = (row, artistNames, genres) => ({
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
  });

// Filters, sorts by this user's own added date, and paginates their visible songs.
const getSongs = async ({ userId, limit = 50, offset = 0, ...filters }, knexInstance = db) => {
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
};

// Filter dropdown options + ranges, scoped to this user's visible songs — never
// reveals another user's library composition (which genres/artists/countries exist elsewhere).
const getFilterOptions = async (userId, knexInstance = db) => {
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
    .leftJoin('song_artists as primary_sa', (join) => {
      join.on('primary_sa.song_id', '=', 'songs.id').andOnVal('primary_sa.position', '=', 0);
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
};

// Same check as visibleToUser, for queries where the song id column has a different alias.
const visibleToUserWithSongIdColumn = (knexInstance, songIdColumn, userId) =>
  knexInstance('playlist_tracks')
    .select(1)
    .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
    .where('playlist_tracks.song_id', knexInstance.ref(songIdColumn))
    .andWhere('playlists.user_id', userId);

// One row per visible song, earliest added date. Joins to songs to exclude orphaned
// playlist_tracks rows (residue of an old interrupted sync) from the count.
const userAddedAtRows = (knexInstance, userId) => knexInstance('playlist_tracks')
    .join('playlists', 'playlists.id', 'playlist_tracks.playlist_id')
    .join('songs', 'songs.id', 'playlist_tracks.song_id')
    .where('playlists.user_id', userId)
    .groupBy('playlist_tracks.song_id')
    .min('playlist_tracks.added_at as addedAt');

// Dashboard aggregate counts, scoped to this user's visible songs. Popularity buckets
// and liked-by-month need JS-side grouping; the rest is a plain SQL GROUP BY.
const getStats = async (userId, knexInstance = db) => {
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
    .leftJoin('song_artists as primary_sa', (join) => {
      join.on('primary_sa.song_id', '=', 'songs.id').andOnVal('primary_sa.position', '=', 0);
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
};

module.exports = { getSongs, getFilterOptions, getStats };
