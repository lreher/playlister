// In-memory only, not persisted — a restart losing this is fine, unlike sync_status,
// since nothing is actively blocked waiting on it.
let current = null; // { phase, checked, total } | null

const setStep = (phase, checked, total) => {
  current = { phase, checked, total };
};

const clear = () => {
  current = null;
};

const getStep = () => current;

module.exports = { setStep, clear, getStep };
