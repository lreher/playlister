const db = require('./index')();

// Stays comfortably under SQLite's default compound-SELECT term limit (500).
const TRACK_INSERT_CHUNK_SIZE = 400;

// Per-user id so two users' Liked Songs never collide in the shared playlist_tracks table.
const likedSongsId = (userId) => `liked-songs:${userId}`;

const tracksByPlaylistId = async (knexInstance, playlistId) => {
  const rows = await knexInstance('playlist_tracks')
    .where({ playlist_id: playlistId })
    .orderBy('added_at', 'desc')
    .select('song_id', 'added_at');
  return rows.map((r) => ({ id: r.song_id, addedAt: r.added_at }));
};

const rowToPlaylist = (row, tracks) => ({
    id: row.id,
    name: row.name,
    ownerName: row.owner_name,
    public: !!row.public,
    collaborative: !!row.collaborative,
    snapshotId: row.snapshot_id,
    tracks,
  });

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

// Whole-collection replace, scoped to this user only — a shared playlist_id can belong
// to another user's own playlists row too, so deletes never touch their ownership rows.
const set = async (userId, playlists, knexInstance = db) => {
  await knexInstance.transaction(async (trx) => {
    const keepIds = new Set(playlists.map((p) => p.id));
    const existingIds = await trx('playlists').where({ user_id: userId }).pluck('id');
    for (const id of existingIds) {
      if (!keepIds.has(id)) {
        // playlist_tracks for `id` is left alone — another user's playlists row may still reference it.
        await trx('playlists').where({ user_id: userId, id }).del();
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
      // Chunked: knex compiles a multi-row SQLite insert with onConflict as a UNION ALL
      // of SELECTs, one term per row — SQLite's compound-SELECT limit (500) rejects a
      // single call for any playlist (Liked Songs especially) past that many tracks.
      for (let i = 0; i < playlist.tracks.length; i += TRACK_INSERT_CHUNK_SIZE) {
        const chunk = playlist.tracks.slice(i, i + TRACK_INSERT_CHUNK_SIZE);
        // A real Spotify playlist can contain the same track twice — ignore the conflict
        // rather than crash on the (playlist_id, song_id) primary key.
        await trx('playlist_tracks')
          .insert(chunk.map((t) => ({ playlist_id: playlist.id, song_id: t.id, added_at: t.addedAt })))
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
