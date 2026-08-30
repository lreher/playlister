const db = require('./database');

// Well-known ID for the Liked-Songs pseudo-playlist entry, so it shows up
// in the same Playlist filter/list as real playlists.
const LIKED_SONGS_ID = 'liked-songs';

const selectTracks = db.prepare('SELECT song_id, added_at FROM playlist_tracks WHERE playlist_id = ? ORDER BY added_at DESC');
const insertPlaylist = db.prepare(`
  INSERT INTO playlists (id, name, owner_name, public, collaborative, snapshot_id)
  VALUES (@id, @name, @ownerName, @public, @collaborative, @snapshotId)
`);
const insertTrack = db.prepare('INSERT INTO playlist_tracks (playlist_id, song_id, added_at) VALUES (?, ?, ?)');

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

const getAll = () => db.prepare('SELECT * FROM playlists').all().map(rowToPlaylist);

const getById = (id) => {
  const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
  return row ? rowToPlaylist(row) : null;
};

// Whole-collection replace, not a per-record upsert: a sync run always
// recomputes every playlist's current state in one pass (including
// detecting playlists that were deleted/unfollowed and should disappear),
// so the correct write here is "this is the truth now," not "merge this
// one record in." Runs in one transaction so a mid-write failure can't
// leave the tables half-replaced.
const set = (playlists) => {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM playlist_tracks');
    db.exec('DELETE FROM playlists');
    for (const playlist of playlists) {
      insertPlaylist.run({
        id: playlist.id,
        name: playlist.name,
        ownerName: playlist.ownerName,
        public: playlist.public ? 1 : 0,
        collaborative: playlist.collaborative ? 1 : 0,
        snapshotId: playlist.snapshotId,
      });
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
  LIKED_SONGS_ID,
};
