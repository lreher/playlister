// Two cached connections ('app' for requests, 'sync' for the long-running sync job) so
// a slow sync never contends with a live request for the same pooled connection slot.
const knexfile = require('../knexfile');

const connections = {};

const getDb = (role = 'app') => {
  if (!connections[role]) {
    connections[role] = require('knex')(knexfile);
  }
  return connections[role];
};

module.exports = getDb;
