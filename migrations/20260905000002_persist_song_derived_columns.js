// Replaces the old song_details VIEW (which computed country/year/decade
// live, on every read, via COALESCE/substr/a custom SQL function) with
// real stored columns on songs, computed once here (and from now on, at
// write time in db/songs.js/db/artists.js) instead of recomputed on every
// query. See playlister_focus.md for the fuller reasoning.
//
// Guards every step so this is safe to run on:
// - a genuinely fresh install (20260905000001 already created these
//   columns and never created the view — everything below becomes a
//   harmless no-op)
// - the pre-existing local/droplet databases (20260905000001 was marked
//   applied without running, so these columns don't exist yet and the old
//   view does — this is the real migration for them)
const isrcCountry = require('../utils/isrcCountry');

exports.up = async function up(knex) {
  const hasYear = await knex.schema.hasColumn('songs', 'year');
  if (!hasYear) {
    await knex.schema.alterTable('songs', (table) => {
      table.integer('year');
      table.text('decade');
      table.text('country');
    });
  }

  // One JOIN to get every song's own fields plus its primary artist's
  // already-resolved country (if any) — everything needed to compute the
  // three derived columns, in one pass rather than one query per song.
  const rows = await knex('songs')
    .leftJoin('song_artists', function joinPrimaryArtist() {
      this.on('song_artists.song_id', '=', 'songs.id').andOn('song_artists.position', '=', 0);
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

exports.down = async function down(knex) {
  await knex.schema.alterTable('songs', (table) => {
    table.dropColumn('year');
    table.dropColumn('decade');
    table.dropColumn('country');
  });
  // Not recreating song_details here — it's gone for good as of this
  // change, not something rollback is expected to restore.
};
