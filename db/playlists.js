const cache = require('../utils/cache').createCache();
const db = require('./db').setFile('../data/playlists.json');

// Well-known ID for the Liked-Songs pseudo-playlist entry, so it shows up
// in the same Playlist filter/list as real playlists.
const LIKED_SONGS_ID = 'liked-songs';

const getAll = () => cache() ?? cache(db.read([]));

const getById = (id) => getAll().find((p) => p.id === id) ?? null;

// Whole-collection replace, not a per-record upsert: a sync run always
// recomputes every playlist's current state in one pass (including
// detecting playlists that were deleted/unfollowed and should disappear),
// so the correct write here is "this is the truth now," not "merge this
// one record in."
const set = (playlists) => {
  db.write(playlists);
  cache(playlists);
  return playlists;
};

module.exports = {
  getAll,
  getById,
  set,
  LIKED_SONGS_ID,
};
