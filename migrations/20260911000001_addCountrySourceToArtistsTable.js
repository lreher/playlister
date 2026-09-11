exports.up = async (knex) => {
  await knex.schema.alterTable('artists', (table) => {
    table.text('country_source'); // 'musicbrainz' | 'wikidata' | 'isrc' | null
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('artists', (table) => {
    table.dropColumn('country_source');
  });
};
