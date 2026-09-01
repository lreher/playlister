const db = require('./database');

const selectUser = db.prepare('SELECT * FROM users WHERE id = ?');
const upsertRow = db.prepare(`
  INSERT INTO users (id, display_name) VALUES (@id, @displayName)
  ON CONFLICT(id) DO UPDATE SET display_name = @displayName
`);
const updateSyncStatus = db.prepare('UPDATE users SET sync_status = ?, sync_error = ? WHERE id = ?');

function rowToUser(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
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
  updateSyncStatus.run(status, error, id);
};

const getSyncStatus = (id) => {
  const user = getById(id);
  return user ? { status: user.syncStatus, error: user.syncError } : null;
};

module.exports = { getById, getAll, upsert, setSyncStatus, getSyncStatus };
