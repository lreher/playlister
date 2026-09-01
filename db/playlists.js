const db = require('./database');

// Liked Songs isn't a real shared Spotify playlist — it's synthetic per
// user — so unlike a real playlist_id, its id can't be one global constant
// any more (two users' liked-songs content must never collide in the
// still-global playlist_tracks table). Deriving it from userId keeps it
// stable/predictable without a separate lookup.
const likedSongsId = (userId) => `liked-songs:${userId}`;

const selectTracks = db.prepare('SELECT song_id, added_at FROM playlist_tracks WHERE playlist_id = ? ORDER BY added_at DESC');
const insertPlaylist = db.prepare(`
  INSERT INTO playlists (id, user_id, name, owner_name, public, collaborative, snapshot_id)
  VALUES (@id, @userId, @name, @ownerName, @public, @collaborative, @snapshotId)
  ON CONFLICT(id, user_id) DO UPDATE SET
    name = @name, owner_name = @ownerName, public = @public,
    collaborative = @collaborative, snapshot_id = @snapshotId
`);
const insertTrack = db.prepare('INSERT INTO playlist_tracks (playlist_id, song_id, added_at) VALUES (?, ?, ?)');
const deletePlaylistTracks = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?');
const deletePlaylist = db.prepare('DELETE FROM playlists WHERE user_id = ? AND id = ?');
const selectExistingIds = db.prepare('SELECT id FROM playlists WHERE user_id = ?');

function rowToPlaylist(row) {
  return {
    id: row.id,
    name: row.name,
    ownerName: row.owner_name,
    public: !!row.public,
    collaborative: !!row.collaborative,
    snapshotId: row.snapshot_id,
    tracks: selectTracks.all(row.id).map((t) => ({ id: t.song_id, addedAt: t.added_at })),
  };
}

const getAll = (userId) => db.prepare('SELECT * FROM playlists WHERE user_id = ?').all(userId).map(rowToPlaylist);

const getById = (userId, id) => {
  const row = db.prepare('SELECT * FROM playlists WHERE user_id = ? AND id = ?').get(userId, id);
  return row ? rowToPlaylist(row) : null;
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
const set = (userId, playlists) => {
  db.exec('BEGIN');
  try {
    const keepIds = new Set(playlists.map((p) => p.id));
    const existingIds = selectExistingIds.all(userId).map((r) => r.id);
    for (const id of existingIds) {
      if (!keepIds.has(id)) deletePlaylist.run(userId, id);
      // playlist_tracks for `id` is left alone here on purpose — another
      // user's own playlists row may still reference this same real
      // playlist_id. If nobody does any more, its rows become harmless
      // orphaned dead weight rather than something worth chasing down.
    }
    for (const playlist of playlists) {
      insertPlaylist.run({
        id: playlist.id,
        userId,
        name: playlist.name,
        ownerName: playlist.ownerName,
        public: playlist.public ? 1 : 0,
        collaborative: playlist.collaborative ? 1 : 0,
        snapshotId: playlist.snapshotId,
      });
      deletePlaylistTracks.run(playlist.id);
      for (const track of playlist.tracks) {
        insertTrack.run(playlist.id, track.id, track.addedAt);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return playlists;
};

module.exports = {
  getAll,
  getById,
  set,
  likedSongsId,
};
