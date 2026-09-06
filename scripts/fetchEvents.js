require('dotenv').config();

const { runEventsSearch } = require('../sources/eventsSearch');

const main = async () => {
  const events = await runEventsSearch();
  console.log(`Matched and stored ${events.length} events:\n`);
  for (const e of events) {
    const artistNames = e.hits.map((a) => a.name).join(', ');
    const where = e.neighborhood ? `${e.venue} (${e.neighborhood})` : e.venue;
    console.log(`[${e.source}] ${artistNames} — ${e.dateLabel} @ ${where}`);
  }
};

// knex's pool keeps a handle open, which would otherwise leave the process hanging
// after main() resolves - explicit exit codes needed on both paths, like scripts/sync.js.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
