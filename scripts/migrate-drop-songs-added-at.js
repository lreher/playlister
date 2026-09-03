// One-time migration: drops the now-meaningless `songs.added_at` column.
//
// `added_at` was a leftover from the single-tenant era, when there was only
// one person's library so "when it was added" had a single answer. Under
// multi-tenancy the songs row is a shared cache across every user, so that
// column could only ever hold whoever synced the track first — every other
// user saw that person's date in their List order, date filter, and
// "liked over time" chart. The real per-user date lives on playlist_tracks
// (scoped per user through playlists); controllers/songs.js now derives
// "added" from there. This just removes the dead column.
//
// Back up data/playlister.db before running this.
//
// Opens a raw connection first (bypassing db/database.js): its CREATE VIEW
// IF NOT EXISTS would no-op against the still-existing old song_details,
// and DROP COLUMN fails while a view or index still references the column.
// Order matters — view, then index, then column, then let db/database.js
// recreate the view in its new (added_at-free) shape.
//
// Idempotent: re-running after success is a no-op (the column is gone).
require('dotenv').config();
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '../data/playlister.db');

function main() {
  const raw = new DatabaseSync(DB_PATH);

  const hasColumn = raw
    .prepare('PRAGMA table_info(songs)')
    .all()
    .some((c) => c.name === 'added_at');

  if (!hasColumn) {
    console.log('[migrate] songs.added_at already dropped — nothing to do.');
    raw.close();
    return;
  }

  console.log('[migrate] dropping song_details view, idx_songs_added_at, and songs.added_at...');
  raw.exec('DROP VIEW IF EXISTS song_details');
  raw.exec('DROP INDEX IF EXISTS idx_songs_added_at');
  raw.exec('ALTER TABLE songs DROP COLUMN added_at');
  raw.close();

  // Recreates song_details fresh from db/database.js's (updated) definition,
  // without the added_at column.
  require('../db/database');

  console.log('[migrate] done — songs.added_at removed, song_details rebuilt.');
}

main();
