const cache = require('../utils/cache').createCache();
const db = require('./db').setFile('../data/songs.json');

const getAll = () => cache() ?? cache(db.read([]));

const getById = (id) => getAll().find((s) => s.id === id) ?? null;

const mapTrack = (item) => ({
  id: item.track.id,
  name: item.track.name,
  // Spotify occasionally has an artist entry with a null name on an
  // otherwise-valid track (e.g. a withdrawn/unlisted contributor) —
  // drop those rather than let a null propagate into every place that
  // reads an artist's name.
  artists: item.track.artists.filter((a) => a.name).map((a) => ({ id: a.id, name: a.name })),
  album: {
    name: item.track.album.name,
    releaseDate: item.track.album.release_date,
    albumType: item.track.album.album_type,
  },
  addedAt: item.added_at,
  isrc: item.track.external_ids?.isrc ?? null,
  durationMs: item.track.duration_ms,
  explicit: item.track.explicit,
  spotifyUrl: item.track.external_urls?.spotify ?? null,
});

// Dedupes raw Spotify track items (`{added_at, track: {...}}` — same shape
// whether they came from Liked Songs or a playlist) against what's already
// stored by Spotify track ID, and appends whatever's new. Returns just the
// newly-added songs. Batch operation — writes once via db.write() rather
// than upserting record by record.
const mergeTracks = (items) => {
  const songs = getAll();
  const existingIds = new Set(songs.map((s) => s.id));
  const newSongs = [];

  for (const item of items) {
    if (existingIds.has(item.track.id)) continue;
    // Spotify occasionally returns a stub for a track it has since
    // unlisted from its catalog: real ID, but blank name/artist/album and
    // duration 0. Not meaningfully browsable, so skip it.
    if (!item.track.name) continue;

    existingIds.add(item.track.id); // guards against duplicates within the same batch
    newSongs.push(mapTrack(item));
  }

  if (newSongs.length > 0) {
    const updated = [...newSongs, ...songs];
    db.write(updated);
    cache(updated);
  }

  return newSongs;
};

module.exports = {
  getAll,
  getById,
  mergeTracks,
};
