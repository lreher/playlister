// One-time, historical: converts the old single-tenant database into the multi-tenant
// schema (a real users row, tokens/playlists re-keyed by user_id). Back up the database
// before running. Renames old tables before requiring db/database.js, since its CREATE
// TABLE IF NOT EXISTS would otherwise no-op against tables with the old shape.
// Idempotent — safe to re-run if it fails partway through.
require('dotenv').config();
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '../data/playlister.db');

// Refreshes unconditionally (the stored token is likely long expired by now). Inlined
// rather than sources/spotify.js's version, since that needs a userId we don't have yet.
const refreshToken = async (refreshToken) => {
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
};

const tableExists = (raw, name) => !!raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);

const hasUserIdColumn = (raw, table) => raw
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === 'user_id');

const main = async () => {
  const raw = new DatabaseSync(DB_PATH);

  // tokens_old existing means a prior run got as far as renaming but not the final DROP —
  // checking tokens' own shape isn't enough, since requiring db/database.js recreates an
  // empty new-shaped `tokens` regardless of whether the data copy ever ran.
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

    // Liked Songs is the one playlist that needs re-keying to the new per-user id;
    // real playlists' playlist_id doesn't change.
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
};

main().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
