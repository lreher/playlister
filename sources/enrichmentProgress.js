// In-memory only, deliberately not persisted — this answers "what is the
// country-resolution cascade doing right now," not a durable status. A
// process restart mid-pass losing this is fine and honest: there's nothing
// actively running until the next pass starts, unlike a user's own
// sync_status (db/users.js) which needed explicit recovery because a
// stuck-looking value there actively blocks someone waiting on it.
let current = null; // { phase, checked, total } | null

const setStep = (phase, checked, total) => {
  current = { phase, checked, total };
};

const clear = () => {
  current = null;
};

const getStep = () => current;

module.exports = { setStep, clear, getStep };
