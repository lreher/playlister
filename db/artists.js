const db = require('./index')();
const songsDb = require('./songs');

function rowToArtist(row, genres) {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    genres,
    popularity: row.popularity,
    followers: row.followers,
    detailsResolved: !!row.details_resolved,
  };
}

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

// Merges `patch` into the artist's stored record (creating it if it's
// new). A key present in `patch` overrides (even if the value is null —
// that's how "resolved, but genuinely no country found" gets recorded); a
// key absent from `patch` keeps whatever's already stored.
//
// When `patch.country` is a real (non-null) value, this also propagates it
// to every song where this artist is the primary artist (see
// songsDb.updatePrimaryArtistCountry) — those songs store their own
// country rather than live-joining it, so this is the one place that value
// needs to be kept in sync. A `patch.country` of null (resolution ran and
// found nothing) deliberately does NOT propagate — a song's existing
// ISRC-derived fallback (set at insert time) should never be blanked out
// by a "still unresolved" result.
const upsert = async (id, patch, knexInstance = db) => {
  await knexInstance.transaction(async (trx) => {
    const existing = await trx('artists').where({ id }).first();

    const record = {
      id,
      name: patch.name ?? existing?.name ?? null,
      country: 'country' in patch ? patch.country : (existing?.country ?? null),
      popularity: 'popularity' in patch ? patch.popularity : (existing?.popularity ?? null),
      followers: 'followers' in patch ? patch.followers : (existing?.followers ?? null),
      // Genres/popularity only ever arrive together, from the one details
      // backfill pass — either key showing up means that pass has run.
      details_resolved: 'genres' in patch || 'popularity' in patch ? 1 : (existing?.details_resolved ?? 0),
    };
    await trx('artists').insert(record).onConflict('id').merge(record);

    if ('genres' in patch) {
      await trx('artist_genres').where({ artist_id: id }).del();
      if (patch.genres.length > 0) {
        await trx('artist_genres').insert(patch.genres.map((genre) => ({ artist_id: id, genre })));
      }
    }

    if ('country' in patch && patch.country != null) {
      await songsDb.updatePrimaryArtistCountry(id, patch.country, trx);
    }
  });

  return getById(id, knexInstance);
};

// Computed live from the actual rows, not a separate persisted counter —
// enrichment progress is always exactly reconstructable from real
// resolved/unresolved counts. Global, same as the rest of enrichment — not
// scoped to any one user.
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
