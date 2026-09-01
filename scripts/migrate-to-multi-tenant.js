// One-time migration: converts the existing single-tenant playlister.db
// (one implicit user — whoever's token is in the singleton `tokens` row)
// into the multi-tenant schema — a real `users` row for that person
// (identified via their own stored token), and `tokens`/`playlists`
// re-keyed by user_id. Back up data/playlister.db before running this.
//
// Must rename the old-shaped tables out of the way BEFORE db/database.js is
// ever required in this process: that module's `CREATE TABLE IF NOT
// EXISTS` calls silently no-op against tables that already exist under the
// same name, regardless of whether the shape differs — SQLite doesn't diff
// schemas. So this script opens its own raw connection first (bypassing
// db/database.js entirely) to do the rename, and only then requires
// db/database.js, so its schema-creation runs fresh against the new names.
//
// Idempotent: safe to re-run if it fails partway through.
require('dotenv').config();
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '../data/playlister.db');

// The stored access token is very likely expired by the time this ever
// runs (1-hour lifetime, this is a deferred one-time operation) — refresh
// unconditionally rather than trying to check/guess staleness. Inlined
// rather than reusing sources/spotify.js's refreshAccessToken, since that
// persists via db/tokens.js keyed by a userId we don't have yet (that's
// exactly what this call is trying to determine).
async function refreshToken(refreshToken) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' +
        Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

function tableExists(raw, name) {
  return !!raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function hasUserIdColumn(raw, table) {
  return raw
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === 'user_id');
}

async function main() {
  const raw = new DatabaseSync(DB_PATH);

  // tokens_old existing is the real signal that a run got as far as
  // renaming but not as far as the final DROP TABLE — NOT whether `tokens`
  // already has the new shape. db/database.js's CREATE TABLE IF NOT EXISTS
  // runs (and creates a fresh, empty new-shaped `tokens`) the moment it's
  // first required, regardless of whether the data copy that follows ever
  // succeeded — an earlier version of this guard checked `tokens`'s shape
  // alone and could report "already migrated" against those empty tables
  // while the real data was still sitting untouched in tokens_old.
  const oldTableExists = tableExists(raw, 'tokens_old');

  if (!tableExists(raw, 'tokens') && !oldTableExists) {
    console.log('[migrate] no existing tokens table — nothing to migrate (fresh install).');
    raw.close();
    return;
  }

  if (!oldTableExists) {
    if (hasUserIdColumn(raw, 'tokens')) {
      console.log('[migrate] already migrated — nothing to do.');
      raw.close();
      return;
    }
    console.log('[migrate] renaming old tables out of the way...');
    raw.exec('ALTER TABLE tokens RENAME TO tokens_old');
    raw.exec('ALTER TABLE playlists RENAME TO playlists_old');
  } else {
    console.log('[migrate] resuming a previously interrupted run (old tables already renamed)...');
  }
  raw.close();

  // Loads fresh now — creates users/tokens/playlists in the new shape,
  // since the old-named ones are out of the way.
  const db = require('../db/database');

  const oldToken = db.prepare('SELECT * FROM tokens_old').get();
  if (!oldToken) {
    throw new Error('tokens_old has no row — nothing to identify a user from. Aborting before dropping anything.');
  }

  console.log('[migrate] refreshing token and resolving your Spotify identity...');
  const fresh = await refreshToken(oldToken.refresh_token);
  const profileRes = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${fresh.access_token}` },
  });
  if (!profileRes.ok) {
    throw new Error(`Spotify profile fetch failed: ${profileRes.status} ${await profileRes.text()}`);
  }
  const profile = await profileRes.json();
  const userId = profile.id;
  console.log(`[migrate] identified as ${profile.display_name ?? userId} (${userId})`);

  const oldPlaylists = db.prepare('SELECT * FROM playlists_old').all();
  const insertPlaylist = db.prepare(`
    INSERT INTO playlists (id, user_id, name, owner_name, public, collaborative, snapshot_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, user_id) DO NOTHING
  `);
  const OLD_LIKED_SONGS_ID = 'liked-songs';
  const newLikedSongsId = `liked-songs:${userId}`;

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO users (id, display_name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(
      userId,
      profile.display_name ?? null
    );

    db.prepare(
      `INSERT INTO tokens (user_id, access_token, refresh_token, expires_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING`
    ).run(userId, fresh.access_token, fresh.refresh_token, fresh.expires_at);

    for (const p of oldPlaylists) {
      const newId = p.id === OLD_LIKED_SONGS_ID ? newLikedSongsId : p.id;
      insertPlaylist.run(newId, userId, p.name, p.owner_name, p.public, p.collaborative, p.snapshot_id);
    }

    // playlist_tracks is global (keyed by playlist_id only, see
    // db/database.js) — the Liked Songs pseudo-playlist is the one entity
    // that isn't real shared Spotify data, so its rows need re-keying to
    // the new per-user id. Real playlists' rows are untouched — their
    // playlist_id doesn't change.
    db.prepare('UPDATE playlist_tracks SET playlist_id = ? WHERE playlist_id = ?').run(
      newLikedSongsId,
      OLD_LIKED_SONGS_ID
    );

    db.exec('DROP TABLE tokens_old');
    db.exec('DROP TABLE playlists_old');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(`[migrate] done — ${oldPlaylists.length} playlists migrated to user ${userId}.`);
}

main().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
