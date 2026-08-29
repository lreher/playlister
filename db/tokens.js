const db = require('./db').setFile('../data/tokens.json');

// Not a collection — just the one current Spotify OAuth token set — so
// this doesn't fit the getAll/getById/upsert shape the other db/*.js files
// use. get()/set() directly matches what's actually stored: one object.
const get = () => db.read(null);
const set = (tokens) => db.write(tokens);

module.exports = { get, set };
