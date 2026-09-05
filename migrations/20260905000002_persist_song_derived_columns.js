// Replaces the old song_details VIEW (computed live on every read) with real stored
// columns on songs. Safe on both a fresh install (no-ops) and a pre-existing database
// (does the real backfill).
const isrcCountry = require('../utils/isrcCountry');

exports.up = async (knex) => {
  const hasYear = await knex.schema.hasColumn('songs', 'year');
  if (!hasYear) {
    await knex.schema.alterTable('songs', (table) => {
      table.integer('year');
      table.text('decade');
      table.text('country');
    });
  }

  const rows = await knex('songs')
    .leftJoin('song_artists', (join) => {
      join.on('song_artists.song_id', '=', 'songs.id').andOn('song_artists.position', '=', 0);
    })
    .leftJoin('artists', 'artists.id', 'song_artists.artist_id')
    .select('songs.id as id', 'songs.album_release_date as albumReleaseDate', 'songs.isrc as isrc', 'artists.country as primaryArtistCountry');

  await knex.transaction(async (trx) => {
    for (const row of rows) {
      const year = row.albumReleaseDate?.length >= 4 ? Number(row.albumReleaseDate.slice(0, 4)) : null;
      const decade = row.albumReleaseDate?.length >= 3 ? `${row.albumReleaseDate.slice(0, 3)}0s` : null;
      const country = row.primaryArtistCountry ?? isrcCountry.countryFromIsrc(row.isrc) ?? null;
      await trx('songs').where({ id: row.id }).update({ year, decade, country });
    }
  });

  await knex.schema.dropViewIfExists('song_details');
};

exports.down = async (knex) => {
  await knex.schema.alterTable('songs', (table) => {
    table.dropColumn('year');
    table.dropColumn('decade');
    table.dropColumn('country');
  });
  // song_details is gone for good — rollback doesn't recreate it.
};
