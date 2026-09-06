// In-memory only, same shape/rationale as enrichmentProgress — a restart losing this
// mid-run is fine, nothing is persisted or blocked waiting on it.
let current = { status: 'idle', message: null };

const setStatus = (status, message = null) => {
  current = { status, message };
};

const getStatus = () => current;

module.exports = { setStatus, getStatus };
