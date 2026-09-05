const db = require('./index')();
const isrcCountry = require('../utils/isrcCountry');

// Every exported function here takes the knex connection as its last,
// optional argument, defaulting to the main app connection — scripts/sync.js
// and sources/syncQueue.js pass db/index.js's 'sync' connection explicitly
// instead, so a long-running sync never contends with a live request for
// the app connection's one pooled slot (see knexfile.js).

// One batched query for a set of songs' full artist lists (id/name, in
// position order) instead of one query per song — used by getAll/getById,
// which need every artist, not just the primary one mergeTracks cares about.
async function artistsBySongId(knexInstance, songIds) {
  if (songIds.length === 0) return new Map();
  const rows = await knexInstance('song_artists')
    .join('artists', 'artists.id', 'song_artists.artist_id')
    .whereIn('song_artists.song_id', songIds)
    .orderBy('song_artists.position')
    .select({ songId: 'song_artists.song_id', id: 'artists.id', name: 'artists.name' });

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.songId)) map.set(row.songId, []);
    map.get(row.songId).push({ id: row.id, name: row.name });
  }
  return map;
}

function rowToSong(row, artists) {
  return {
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
  };
}

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

// Dedupes raw Spotify track items (`{added_at, track: {...}}` — same shape
// whether they came from Liked Songs or a playlist) against what's already
// stored by Spotify track ID, and appends whatever's new. Returns just the
// newly-added songs. `added_at` on each item is deliberately ignored here —
// it's a per-user fact recorded on playlist_tracks by the caller, not on
// the shared songs row.
//
// year/decade/country are computed here, once, at insert time — not
// recomputed on every read (see playlister_focus.md). country prefers the
// primary artist's already-known country (checked fresh per song, since
// this shared cache may already have it from another user's earlier sync)
// and falls back to this song's own ISRC; if the primary artist's country
// resolves *later*, artists.js's upsert() re-derives this song's country
// then (see updatePrimaryArtistCountry below).
const mergeTracks = async (items, knexInstance = db) => {
  const existingIds = new Set((await knexInstance('songs').select('id')).map((r) => r.id));
  const newSongs = [];

  await knexInstance.transaction(async (trx) => {
    for (const item of items) {
      if (existingIds.has(item.track.id)) continue;
      // Spotify occasionally returns a stub for a track it has since
      // unlisted from its catalog: real ID, but blank name/artist/album
      // and duration 0. Not meaningfully browsable, so skip it.
      if (!item.track.name) continue;
      existingIds.add(item.track.id); // guards against duplicates within the same batch

      // Spotify occasionally has an artist entry with a null name on an
      // otherwise-valid track (e.g. a withdrawn/unlisted contributor) —
      // drop those rather than let a null propagate into every place that
      // reads an artist's name.
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

      // name gets refreshed (Spotify occasionally corrects a display name)
      // but nothing else — an artist's real record (country/genres/
      // popularity) is a separate, later resolution pass, not something a
      // song mention should ever overwrite.
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

// Called from db/artists.js's upsert() whenever an artist's country
// resolves to a real (non-null) value — propagates it to every song where
// this artist is the primary (position 0) artist, so a song's stored
// country stays correct even though it was computed once, at insert time,
// rather than live-joined on every read.
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
