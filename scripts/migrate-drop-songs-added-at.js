// One-time, historical: drops the pre-multi-tenancy `songs.added_at` column (per-user
// added date now lives on playlist_tracks instead). Back up the database before running.
// Order matters: drops the view and index referencing the column before the column itself.
// Idempotent — a no-op if already run.
require('dotenv').config();
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '../data/playlister.db');

const main = () => {
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

  // Recreates song_details fresh, without the added_at column.
  require('../db/database');

  console.log('[migrate] done — songs.added_at removed, song_details rebuilt.');
};

main();
