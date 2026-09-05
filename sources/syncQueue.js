// In-process, serialized background sync — no queue library, 25-user cap doesn't
// warrant one. Two separate queues (fast sync vs. slow country enrichment) so a second
// user's login never gets stuck waiting behind the first user's hours-long enrichment.
const usersDb = require('../db/users');
const syncDb = require('../db/index')('sync');
const sync = require('../scripts/sync');

let fastQueue = Promise.resolve();
let enrichQueue = Promise.resolve();

const enqueueSync = (userId) => {
  console.log(`[sync] queued for user ${userId}`);
  fastQueue = fastQueue
    .then(() => {
      console.log(`[sync] now running for user ${userId}`);
      return sync.runFastSync(userId, syncDb);
    })
    .then(async () => {
      await usersDb.setSyncStatus(userId, 'done', null, syncDb);
      enqueueEnrichment();
    })
    .catch(async (err) => {
      console.error(`[sync] fast sync failed for user ${userId}:`, err.message);
      await usersDb.setSyncStatus(userId, 'error', err.message, syncDb);
    });
};

// Not user-scoped (writes to the global artists table). Failures are only logged —
// by the time one could fail, the triggering user's sync_status is already 'done' and
// nothing is still polling; the next login naturally retries whatever's unresolved.
const enqueueEnrichment = () => {
  enrichQueue = enrichQueue
    .then(() => sync.runEnrichment(syncDb))
    .catch((err) => console.error('[enrichment] failed:', err.message));
};

// Clears any sync_status left stuck on 'syncing' by a server restart mid-sync. Runs once
// at boot; enrichment needs no equivalent recovery, it just resumes on the next fast sync.
const recoverStuckSyncs = async () => {
  for (const user of await usersDb.getAll()) {
    if (user.syncStatus === 'syncing') {
      await usersDb.setSyncStatus(user.id, 'error', 'Interrupted by a server restart — please log in again to retry.');
    }
  }
};

module.exports = { enqueueSync, recoverStuckSyncs };
