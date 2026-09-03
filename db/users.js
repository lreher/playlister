const db = require('./database');

const selectUser = db.prepare('SELECT * FROM users WHERE id = ?');
const upsertRow = db.prepare(`
  INSERT INTO users (id, display_name) VALUES (@id, @displayName)
  ON CONFLICT(id) DO UPDATE SET display_name = @displayName
`);
// Setting status also clears progress: progress only means anything while
// mid-sync (between a 'syncing' status and the 'done'/'error' that ends
// it), and this is the one place both transitions happen — no separate
// "clear progress" call needed anywhere else.
const updateSyncStatus = db.prepare(`
  UPDATE users SET sync_status = ?, sync_error = ?,
    sync_progress_phase = NULL, sync_progress_current = NULL, sync_progress_total = NULL
  WHERE id = ?
`);
// The 'done' transition additionally stamps last_synced_at — this is the
// single point where a sync is known to have completed, so it's where
// "when did this user last sync" gets recorded (drives login-sync
// staleness and the frontend's block-vs-background decision).
const updateSyncStatusDone = db.prepare(`
  UPDATE users SET sync_status = 'done', sync_error = NULL,
    sync_progress_phase = NULL, sync_progress_current = NULL, sync_progress_total = NULL,
    last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id = ?
`);
const updateSyncProgress = db.prepare(
  'UPDATE users SET sync_progress_phase = ?, sync_progress_current = ?, sync_progress_total = ? WHERE id = ?'
);

function rowToUser(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    syncProgress:
      row.sync_progress_phase == null
        ? null
        : { phase: row.sync_progress_phase, current: row.sync_progress_current, total: row.sync_progress_total },
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}

const getById = (id) => {
  const row = selectUser.get(id);
  return row ? rowToUser(row) : null;
};

const getAll = () => db.prepare('SELECT * FROM users').all().map(rowToUser);

// Leaves sync_status/created_at alone — this only ever runs at login, when
// we've just re-confirmed who the user is, not anything about their sync.
const upsert = ({ id, displayName }) => {
  upsertRow.run({ id, displayName: displayName ?? null });
  return getById(id);
};

const setSyncStatus = (id, status, error = null) => {
  if (status === 'done') updateSyncStatusDone.run(id);
  else updateSyncStatus.run(status, error, id);
};

// `total` is nullable — a phase can report "in progress, count unknown
// yet" (e.g. songs, before the first page tells us the real total).
const setSyncProgress = (id, phase, current, total) => {
  updateSyncProgress.run(phase, current, total, id);
};

const getSyncStatus = (id) => {
  const user = getById(id);
  return user
    ? {
        status: user.syncStatus,
        error: user.syncError,
        progress: user.syncProgress,
        lastSyncedAt: user.lastSyncedAt,
      }
    : null;
};

module.exports = { getById, getAll, upsert, setSyncStatus, setSyncProgress, getSyncStatus };
