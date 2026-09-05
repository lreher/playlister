// Deletes the live database entirely. Backs up first without asking — playlister.db is
// treated as precious, hard-won data (see playlister_focus.md).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'playlister.db');
const SUFFIXES = ['', '-wal', '-shm']; // main file + WAL sidecars

const wipeDatabase = () => {
  if (fs.existsSync(DB_PATH)) {
    const backupDir = path.join(DATA_DIR, `pre-delete-backup-${Date.now()}`);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const suffix of SUFFIXES) {
      const src = DB_PATH + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
    }
  }

  for (const suffix of SUFFIXES) {
    const target = DB_PATH + suffix;
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
};

module.exports = { wipeDatabase };
