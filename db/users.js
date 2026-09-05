const db = require('./index')();

const rowToUser = (row) => ({
    id: row.id,
    displayName: row.display_name,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    syncProgress:
      row.sync_progress_phase === null || row.sync_progress_phase === undefined
        ? null
        : { phase: row.sync_progress_phase, current: row.sync_progress_current, total: row.sync_progress_total },
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  });

const getById = async (id, knexInstance = db) => {
  const row = await knexInstance('users').where({ id }).first();
  return row ? rowToUser(row) : null;
};

const getAll = async (knexInstance = db) => {
  const rows = await knexInstance('users').select('*');
  return rows.map(rowToUser);
};

// Runs at login only — leaves sync_status/created_at alone.
const upsert = async ({ id, displayName }, knexInstance = db) => {
  const existing = await knexInstance('users').where({ id }).first('id');
  if (existing) {
    await knexInstance('users').where({ id }).update({ display_name: displayName ?? null });
  } else {
    await knexInstance('users').insert({
      id,
      display_name: displayName ?? null,
      created_at: new Date().toISOString(),
    });
  }
  return getById(id, knexInstance);
};

// Also clears progress (only meaningful mid-sync) and stamps last_synced_at on 'done'.
const setSyncStatus = async (id, status, error = null, knexInstance = db) => {
  const patch = {
    sync_status: status,
    sync_error: error,
    sync_progress_phase: null,
    sync_progress_current: null,
    sync_progress_total: null,
  };
  if (status === 'done') patch.last_synced_at = new Date().toISOString();
  await knexInstance('users').where({ id }).update(patch);
};

// total is nullable — a phase can be "in progress, count unknown yet."
const setSyncProgress = async (id, phase, current, total, knexInstance = db) => {
  await knexInstance('users')
    .where({ id })
    .update({ sync_progress_phase: phase, sync_progress_current: current, sync_progress_total: total });
};

const getSyncStatus = async (id, knexInstance = db) => {
  const user = await getById(id, knexInstance);
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
