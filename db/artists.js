const db = require('./index')();
const songsDb = require('./songs');

const rowToArtist = (row, genres) => ({
    id: row.id,
    name: row.name,
    country: row.country,
    genres,
    popularity: row.popularity,
    followers: row.followers,
    detailsResolved: !!row.details_resolved,
  });

const getAll = async (knexInstance = db) => {
  const rows = await knexInstance('artists').select('*');
  const genreRows = await knexInstance('artist_genres').select('artist_id', 'genre');
  const genresByArtist = new Map();
  for (const row of genreRows) {
    if (!genresByArtist.has(row.artist_id)) genresByArtist.set(row.artist_id, []);
    genresByArtist.get(row.artist_id).push(row.genre);
  }
  return rows.map((row) => rowToArtist(row, genresByArtist.get(row.id) ?? []));
};

const getById = async (id, knexInstance = db) => {
  const row = await knexInstance('artists').where({ id }).first();
  if (!row) return null;
  const genres = await knexInstance('artist_genres').where({ artist_id: id }).pluck('genre');
  return rowToArtist(row, genres);
};

const getCountry = async (id, knexInstance = db) => (await getById(id, knexInstance))?.country ?? null;
const getGenres = async (id, knexInstance = db) => (await getById(id, knexInstance))?.genres ?? [];
const getPopularity = async (id, knexInstance = db) => (await getById(id, knexInstance))?.popularity ?? null;
const getFollowers = async (id, knexInstance = db) => (await getById(id, knexInstance))?.followers ?? null;

// Merges patch into the artist's record. A key present in patch overrides (even if
// null — that's how "resolved to nothing" is recorded); a key absent keeps the old value.
// A real (non-null) country also propagates to that artist's songs; a null one doesn't,
// so it can never blank out a song's existing ISRC-derived fallback.
const upsert = async (id, patch, knexInstance = db) => {
  await knexInstance.transaction(async (trx) => {
    const existing = await trx('artists').where({ id }).first();

    const record = {
      id,
      name: patch.name ?? existing?.name ?? null,
      country: 'country' in patch ? patch.country : (existing?.country ?? null),
      popularity: 'popularity' in patch ? patch.popularity : (existing?.popularity ?? null),
      followers: 'followers' in patch ? patch.followers : (existing?.followers ?? null),
      // genres/popularity arrive together — either key means that backfill pass has run.
      details_resolved: 'genres' in patch || 'popularity' in patch ? 1 : (existing?.details_resolved ?? 0),
    };
    await trx('artists').insert(record).onConflict('id').merge(record);

    if ('genres' in patch) {
      await trx('artist_genres').where({ artist_id: id }).del();
      if (patch.genres.length > 0) {
        await trx('artist_genres').insert(patch.genres.map((genre) => ({ artist_id: id, genre })));
      }
    }

    if ('country' in patch && patch.country !== null && patch.country !== undefined) {
      await songsDb.updatePrimaryArtistCountry(id, patch.country, trx);
    }
  });

  return getById(id, knexInstance);
};

// Computed live from actual rows rather than a persisted counter. Global, not per-user.
const getEnrichmentStatus = async (knexInstance = db) => {
  const total = (await knexInstance('artists').count('* as c').first()).c;
  const countriesResolved = (await knexInstance('artists').whereNotNull('country').count('* as c').first()).c;
  const detailsResolved = (await knexInstance('artists').where({ details_resolved: 1 }).count('* as c').first()).c;
  return {
    countries: { resolved: countriesResolved, total },
    details: { resolved: detailsResolved, total },
  };
};

module.exports = {
  getAll,
  getById,
  getCountry,
  getGenres,
  getPopularity,
  getFollowers,
  upsert,
  getEnrichmentStatus,
};
