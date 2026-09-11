const db = require('./index')();
const isrcCountry = require('../utils/isrcCountry');

// SQLite has a hard cap on bound parameters per query ("too many SQL variables") —
// getAll() feeds this the whole (global, cross-user) songs table, easily past it.
const SONG_ID_CHUNK_SIZE = 400;

// One batched query for a set of songs' full artist lists instead of one query per song.
const artistsBySongId = async (knexInstance, songIds) => {
  if (songIds.length === 0) return new Map();

  const map = new Map();
  for (let i = 0; i < songIds.length; i += SONG_ID_CHUNK_SIZE) {
    const chunk = songIds.slice(i, i + SONG_ID_CHUNK_SIZE);
    const rows = await knexInstance('song_artists')
      .join('artists', 'artists.id', 'song_artists.artist_id')
      .whereIn('song_artists.song_id', chunk)
      .orderBy('song_artists.position')
      .select({ songId: 'song_artists.song_id', id: 'artists.id', name: 'artists.name' });

    for (const row of rows) {
      if (!map.has(row.songId)) map.set(row.songId, []);
      map.get(row.songId).push({ id: row.id, name: row.name });
    }
  }
  return map;
};

const rowToSong = (row, artists) => ({
    id: row.id,
    name: row.name,
    artists,
    album: { name: row.album_name, releaseDate: row.album_release_date, albumType: row.album_type },
    isrc: row.isrc,
    durationMs: row.duration_ms,
    explicit: !!row.explicit,
    spotifyUrl: row.spotify_url,
    year: row.year,
    decade: row.decade,
    country: row.country,
  });

const getAll = async (knexInstance = db) => {
  const rows = await knexInstance('songs').select('*');
  const byId = await artistsBySongId(knexInstance, rows.map((r) => r.id));
  return rows.map((row) => rowToSong(row, byId.get(row.id) ?? []));
};

const getById = async (id, knexInstance = db) => {
  const row = await knexInstance('songs').where({ id }).first();
  if (!row) return null;
  const byId = await artistsBySongId(knexInstance, [id]);
  return rowToSong(row, byId.get(id) ?? []);
};

// Dedupes raw Spotify track items against what's already stored, appends what's new,
// and returns just the newly-added songs. year/decade/country are computed once here
// (not on every read) — country prefers the primary artist's known country, else ISRC.
const mergeTracks = async (items, knexInstance = db) => {
  const existingIds = new Set((await knexInstance('songs').select('id')).map((r) => r.id));
  const newSongs = [];

  await knexInstance.transaction(async (trx) => {
    for (const item of items) {
      if (existingIds.has(item.track.id)) continue;
      // Spotify sometimes returns a blank stub for a track it's since unlisted — skip it.
      if (!item.track.name) continue;
      existingIds.add(item.track.id); // guards against duplicates within the same batch

      // Drop artist entries with a null name (a withdrawn/unlisted contributor) rather
      // than let a null propagate into every place that reads an artist's name.
      const trackArtists = item.track.artists.filter((a) => a.name);
      const primaryArtistId = trackArtists[0]?.id ?? null;
      const primaryArtist = primaryArtistId
        ? await trx('artists').where({ id: primaryArtistId }).first('country')
        : null;

      const albumReleaseDate = item.track.album.release_date;
      const isrc = item.track.external_ids?.isrc ?? null;
      const year = albumReleaseDate?.length >= 4 ? Number(albumReleaseDate.slice(0, 4)) : null;
      const decade = albumReleaseDate?.length >= 3 ? `${albumReleaseDate.slice(0, 3)}0s` : null;
      const country = primaryArtist?.country ?? isrcCountry.countryFromIsrc(isrc) ?? null;

      await trx('songs').insert({
        id: item.track.id,
        name: item.track.name,
        album_name: item.track.album.name,
        album_release_date: albumReleaseDate,
        album_type: item.track.album.album_type,
        isrc,
        duration_ms: item.track.duration_ms,
        explicit: item.track.explicit ? 1 : 0,
        spotify_url: item.track.external_urls?.spotify ?? null,
        year,
        decade,
        country,
      });

      // Only the name gets refreshed here — country/genres/popularity are a separate,
      // later resolution pass that a song mention should never overwrite.
      for (const [position, artist] of trackArtists.entries()) {
        await trx('artists').insert({ id: artist.id, name: artist.name }).onConflict('id').merge({ name: artist.name });
        await trx('song_artists').insert({ song_id: item.track.id, artist_id: artist.id, position });
      }

      newSongs.push(
        rowToSong(
          {
            id: item.track.id,
            name: item.track.name,
            album_name: item.track.album.name,
            album_release_date: albumReleaseDate,
            album_type: item.track.album.album_type,
            isrc,
            duration_ms: item.track.duration_ms,
            explicit: item.track.explicit ? 1 : 0,
            spotify_url: item.track.external_urls?.spotify ?? null,
            year,
            decade,
            country,
          },
          trackArtists.map((a) => ({ id: a.id, name: a.name }))
        )
      );
    }
  });

  return newSongs;
};

// Called when an artist's country resolves — updates every song where they're the primary artist.
const updatePrimaryArtistCountry = async (artistId, country, knexInstance = db) => {
  const songIds = await knexInstance('song_artists').where({ artist_id: artistId, position: 0 }).pluck('song_id');
  if (songIds.length > 0) {
    await knexInstance('songs').whereIn('id', songIds).update({ country });
  }
};

module.exports = {
  getAll,
  getById,
  mergeTracks,
  updatePrimaryArtistCountry,
};
