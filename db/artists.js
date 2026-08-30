const db = require('./database');

const selectArtist = db.prepare('SELECT * FROM artists WHERE id = ?');
const selectGenres = db.prepare('SELECT genre FROM artist_genres WHERE artist_id = ?');
const upsertRow = db.prepare(`
  INSERT INTO artists (id, name, country, popularity, followers, details_resolved)
  VALUES (@id, @name, @country, @popularity, @followers, @detailsResolved)
  ON CONFLICT(id) DO UPDATE SET
    name = @name, country = @country, popularity = @popularity,
    followers = @followers, details_resolved = @detailsResolved
`);
const deleteGenres = db.prepare('DELETE FROM artist_genres WHERE artist_id = ?');
const insertGenre = db.prepare('INSERT OR IGNORE INTO artist_genres (artist_id, genre) VALUES (?, ?)');

function rowToArtist(row) {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    genres: selectGenres.all(row.id).map((g) => g.genre),
    popularity: row.popularity,
    followers: row.followers,
    detailsResolved: !!row.details_resolved,
  };
}

const getAll = () => db.prepare('SELECT * FROM artists').all().map(rowToArtist);

const getById = (id) => {
  const row = selectArtist.get(id);
  return row ? rowToArtist(row) : null;
};

const getCountry = (id) => getById(id)?.country ?? null;
const getGenres = (id) => getById(id)?.genres ?? [];
const getPopularity = (id) => getById(id)?.popularity ?? null;
const getFollowers = (id) => getById(id)?.followers ?? null;

// Merges `patch` into the artist's stored record (creating it if it's
// new). A key present in `patch` overrides (even if the value is null —
// that's how "resolved, but genuinely no country found" gets recorded); a
// key absent from `patch` keeps whatever's already stored. Same shallow-
// merge semantics as the old `{ id, ...getById(id), ...patch }`, just
// expressed against SQL columns instead of a JS spread.
const upsert = (id, patch) => {
  const existing = selectArtist.get(id) ?? {};

  const record = {
    id,
    name: patch.name ?? existing.name ?? null,
    country: 'country' in patch ? patch.country : (existing.country ?? null),
    popularity: 'popularity' in patch ? patch.popularity : (existing.popularity ?? null),
    followers: 'followers' in patch ? patch.followers : (existing.followers ?? null),
    // Genres/popularity only ever arrive together, from the one details
    // backfill pass — either key showing up means that pass has run.
    detailsResolved: 'genres' in patch || 'popularity' in patch ? 1 : (existing.details_resolved ?? 0),
  };
  upsertRow.run(record);

  if ('genres' in patch) {
    deleteGenres.run(id);
    for (const genre of patch.genres) insertGenre.run(id, genre);
  }

  return getById(id);
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
