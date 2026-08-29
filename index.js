require('dotenv').config();

const { createServer } = require('./server');

const PORT = process.env.PORT || 3000;

createServer().listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Run `npm run sync` any time to fetch new songs and refresh country/genre data.');
});
