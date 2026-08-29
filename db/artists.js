const cache = require('../utils/cache').createCache();
const db = require('./db').setFile('../data/artists.json');

const getAll = () => cache() ?? cache(db.read([]));

const getById = (id) => getAll().find((a) => a.id === id) ?? null;

const getCountry = (id) => getById(id)?.country ?? null;
const getGenres = (id) => getById(id)?.genres ?? [];
const getPopularity = (id) => getById(id)?.popularity ?? null;
const getFollowers = (id) => getById(id)?.followers ?? null;

// Merges `patch` into the artist's stored record (creating it if it's
// new), writes it to disk immediately via db.upsert(), then refreshes the
// in-memory cache straight from disk so it always matches what's stored.
const upsert = (id, patch) => {
  const record = { id, ...getById(id), ...patch };
  db.upsert(record);
  cache(db.read([]));
  return record;
};

module.exports = {
  getAll,
  getById,
  getCountry,
  getGenres,
  getPopularity,
  getFollowers,
  upsert,
};
