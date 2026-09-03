const db = require('./database');

const selectSongs = db.prepare('SELECT * FROM songs WHERE id = ?');
const selectSongArtists = db.prepare(
  'SELECT sa.song_id, a.id, a.name FROM song_artists sa JOIN artists a ON a.id = sa.artist_id WHERE sa.song_id = ? ORDER BY sa.position'
);
const insertSong = db.prepare(`
  INSERT INTO songs (id, name, album_name, album_release_date, album_type, isrc, duration_ms, explicit, spotify_url)
  VALUES (@id, @name, @albumName, @albumReleaseDate, @albumType, @isrc, @durationMs, @explicit, @spotifyUrl)
`);
const insertSongArtist = db.prepare('INSERT INTO song_artists (song_id, artist_id, position) VALUES (?, ?, ?)');
// name gets refreshed (Spotify occasionally corrects a display name) but
// nothing else — an artist's real record (country/genres/popularity) is a
// separate, later resolution pass, not something a song mention should
// ever overwrite.
const upsertArtistStub = db.prepare(`
  INSERT INTO artists (id, name) VALUES (?, ?)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name
`);

function rowToSong(row) {
  return {
    id: row.id,
    name: row.name,
    artists: selectSongArtists.all(row.id).map((a) => ({ id: a.id, name: a.name })),
    album: { name: row.album_name, releaseDate: row.album_release_date, albumType: row.album_type },
    isrc: row.isrc,
    durationMs: row.duration_ms,
    explicit: !!row.explicit,
    spotifyUrl: row.spotify_url,
  };
}

const getAll = () => db.prepare('SELECT * FROM songs').all().map(rowToSong);

const getById = (id) => {
  const row = selectSongs.get(id);
  return row ? rowToSong(row) : null;
};

// Dedupes raw Spotify track items (`{added_at, track: {...}}` — same shape
// whether they came from Liked Songs or a playlist) against what's already
// stored by Spotify track ID, and appends whatever's new. Returns just the
// newly-added songs. `added_at` on each item is deliberately ignored here —
// it's a per-user fact recorded on playlist_tracks by the caller, not on
// the shared songs row.
const mergeTracks = (items) => {
  const existingIds = new Set(db.prepare('SELECT id FROM songs').all().map((r) => r.id));
  const newSongs = [];

  db.exec('BEGIN');
  try {
    for (const item of items) {
      if (existingIds.has(item.track.id)) continue;
      // Spotify occasionally returns a stub for a track it has since
      // unlisted from its catalog: real ID, but blank name/artist/album
      // and duration 0. Not meaningfully browsable, so skip it.
      if (!item.track.name) continue;

      existingIds.add(item.track.id); // guards against duplicates within the same batch

      insertSong.run({
        id: item.track.id,
        name: item.track.name,
        albumName: item.track.album.name,
        albumReleaseDate: item.track.album.release_date,
        albumType: item.track.album.album_type,
        isrc: item.track.external_ids?.isrc ?? null,
        durationMs: item.track.duration_ms,
        explicit: item.track.explicit ? 1 : 0,
        spotifyUrl: item.track.external_urls?.spotify ?? null,
      });

      // Spotify occasionally has an artist entry with a null name on an
      // otherwise-valid track (e.g. a withdrawn/unlisted contributor) —
      // drop those rather than let a null propagate into every place that
      // reads an artist's name.
      const trackArtists = item.track.artists.filter((a) => a.name);
      trackArtists.forEach((artist, position) => {
        upsertArtistStub.run(artist.id, artist.name);
        insertSongArtist.run(item.track.id, artist.id, position);
      });

      newSongs.push(rowToSong(selectSongs.get(item.track.id)));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return newSongs;
};

module.exports = {
  getAll,
  getById,
  mergeTracks,
};
