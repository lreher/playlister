exports.up = async (knex) => {
  await knex.schema.createTable('users', (table) => {
    table.text('id').primary(); // Spotify user id, from GET /v1/me
    table.text('display_name');
    table.text('sync_status').notNullable().defaultTo('idle'); // idle|syncing|done|error
    table.text('sync_error');
    table.text('sync_progress_phase'); // 'songs' | 'playlists' | 'details', NULL unless syncing
    table.integer('sync_progress_current');
    table.integer('sync_progress_total');
    table.text('last_synced_at'); // NULL = never synced
    table.text('created_at').notNullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('users');
};
