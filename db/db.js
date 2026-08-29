const fs = require('fs');
const path = require('path');

// Generic JSON-file-backed collection: an array of records, each with an
// `id` field. No caching, no domain logic — every call touches disk
// directly. songs.js/artists.js/playlists.js each call setFile() once for
// their own data file and build their entity-specific methods on top.
const setFile = (relativePath) => {
  const filePath = path.join(__dirname, relativePath);

  const read = (defaultValue) =>
    fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : defaultValue;

  const write = (data) => {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return data;
  };

  // Merges one record into the collection by `id` (creating it if it's
  // new), and writes the whole collection back to disk.
  const upsert = (record) => {
    const data = read([]);
    const index = data.findIndex((r) => r.id === record.id);
    if (index === -1) {
      data.push(record);
    } else {
      data[index] = { ...data[index], ...record };
    }
    write(data);
    return record;
  };

  return { read, write, upsert };
};

module.exports = { setFile };
