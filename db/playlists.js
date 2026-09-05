const db = require('./index')();

// Liked Songs isn't a real shared Spotify playlist — it's synthetic per
// user — so unlike a real playlist_id, its id can't be one global constant
// any more (two users' liked-songs content must never collide in the
// still-global playlist_tracks table). Deriving it from userId keeps it
// stable/predictable without a separate lookup.
const likedSongsId = (userId) => `liked-songs:${userId}`;

async function tracksByPlaylistId(knexInstance, playlistId) {
  const rows = await knexInstance('playlist_tracks')
    .where({ playlist_id: playlistId })
    .orderBy('added_at', 'desc')
    .select('song_id', 'added_at');
  return rows.map((r) => ({ id: r.song_id, addedAt: r.added_at }));
}

function rowToPlaylist(row, tracks) {
  return {
    id: row.id,
    name: row.name,
    ownerName: row.owner_name,
    public: !!row.public,
    collaborative: !!row.collaborative,
    snapshotId: row.snapshot_id,
    tracks,
  };
}

const getAll = async (userId, knexInstance = db) => {
  const rows = await knexInstance('playlists').where({ user_id: userId }).select('*');
  const playlists = [];
  for (const row of rows) {
    playlists.push(rowToPlaylist(row, await tracksByPlaylistId(knexInstance, row.id)));
  }
  return playlists;
};

const getById = async (userId, id, knexInstance = db) => {
  const row = await knexInstance('playlists').where({ user_id: userId, id }).first();
  if (!row) return null;
  return rowToPlaylist(row, await tracksByPlaylistId(knexInstance, row.id));
};

// Whole-collection replace, scoped to one user — a sync run recomputes that
// user's current playlist set in one pass (including playlists they've
// unfollowed/deleted, which should disappear). NOT a blanket table wipe:
// the same real playlist_id can legitimately belong to another user's own
// `playlists` row too (both following the same real playlist), so deletes
// here only ever touch this user's ownership rows.
//
// playlist_tracks is deliberately rewritten per playlist_id, not per user —
// its content is the same real playlist's objectively-true current state
// regardless of who triggered the sync, so whichever user's sync runs last
// simply refreshes it to the latest truth; harmless for any other user who
// also follows that same playlist.
const set = async (userId, playlists, knexInstance = db) => {
  await knexInstance.transaction(async (trx) => {
    const keepIds = new Set(playlists.map((p) => p.id));
    const existingIds = await trx('playlists').where({ user_id: userId }).pluck('id');
    for (const id of existingIds) {
      if (!keepIds.has(id)) {
        await trx('playlists').where({ user_id: userId, id }).del();
        // playlist_tracks for `id` is left alone here on purpose — another
        // user's own playlists row may still reference this same real
        // playlist_id. If nobody does any more, its rows become harmless
        // orphaned dead weight rather than something worth chasing down.
      }
    }

    for (const playlist of playlists) {
      const record = {
        id: playlist.id,
        user_id: userId,
        name: playlist.name,
        owner_name: playlist.ownerName,
        public: playlist.public ? 1 : 0,
        collaborative: playlist.collaborative ? 1 : 0,
        snapshot_id: playlist.snapshotId,
      };
      await trx('playlists').insert(record).onConflict(['id', 'user_id']).merge(record);

      await trx('playlist_tracks').where({ playlist_id: playlist.id }).del();
      if (playlist.tracks.length > 0) {
        // OR IGNORE equivalent: a real Spotify playlist can legitimately
        // contain the same track more than once (add it twice, no error on
        // Spotify's end) — our schema only tracks membership, not
        // multiplicity, so a repeat within one playlist's fetched track
        // list should just no-op rather than crash on the (playlist_id,
        // song_id) primary key.
        await trx('playlist_tracks')
          .insert(playlist.tracks.map((t) => ({ playlist_id: playlist.id, song_id: t.id, added_at: t.addedAt })))
          .onConflict(['playlist_id', 'song_id'])
          .ignore();
      }
    }
  });
  return playlists;
};

module.exports = {
  getAll,
  getById,
  set,
  likedSongsId,
};
