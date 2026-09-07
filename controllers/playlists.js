const db = require('../db/index')();
const spotify = require('../sources/spotify');
const playlistsDb = require('../db/playlists');

// Creates a real Spotify playlist from the given song ids, then mirrors it into the
// local db immediately so it shows up without waiting for the next full sync.
const createPlaylistFromSongs = async (userId, { name, isPublic, songIds }, knexInstance = db) => {
  const accessToken = await spotify.getValidAccessToken(userId, knexInstance);
  if (!accessToken) throw new Error('not_authenticated');

  const created = await spotify.createPlaylist(accessToken, userId, { name, isPublic });
  const snapshotId = await spotify.addTracksToPlaylist(accessToken, created.id, songIds);

  await playlistsDb.create(
    userId,
    {
      id: created.id,
      name: created.name,
      ownerName: created.ownerName,
      public: created.public,
      collaborative: false,
      snapshotId,
      tracks: songIds.map((id) => ({ id, addedAt: new Date().toISOString() })),
    },
    knexInstance
  );

  return { id: created.id, name: created.name };
};

module.exports = { createPlaylistFromSongs };
