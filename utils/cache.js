// Generic lazy memoization: call with no args to read the current value
// (undefined if nothing's been cached yet), call with a value to store it
// and return it. No file/domain knowledge — db/db.js owns actual disk I/O;
// this just avoids re-reading disk on every getAll() within one process.
const createCache = () => {
  let value;
  return (newValue) => {
    if (newValue !== undefined) value = newValue;
    return value;
  };
};

module.exports = { createCache };
