// In-process, serialized background sync — no queue library. At this
// project's scale (Spotify Development Mode's 25-user cap, one systemd-
// managed process) a real job queue is more machinery than this warrants.
//
// TWO separate queues, not one: fast sync (a user's own songs/playlists,
// plus genres/popularity — all bounded to at most ~a minute or so) and
// enrichment (global artist *country* resolution — deliberately rate-
// limited against MusicBrainz/Wikidata, can run for hours against a
// brand-new user's never-before-seen artists). If these shared one queue,
// a second user's login would
// get stuck waiting behind the first user's slow enrichment pass — the
// whole point of splitting them is that logging in only ever waits on the
// fast queue. Each queue still serializes its own kind of work across
// users (protects the relevant shared rate limit — Spotify's app-level
// limit for the fast queue, MusicBrainz/Wikidata's for the enrichment
// queue — from two users' syncs overlapping).
const usersDb = require('../db/users');
const sync = require('../scripts/sync');

let fastQueue = Promise.resolve();
let enrichQueue = Promise.resolve();

function enqueueSync(userId) {
  console.log(`[sync] queued for user ${userId}`);
  fastQueue = fastQueue
    .then(() => {
      console.log(`[sync] now running for user ${userId}`);
      return sync.runFastSync(userId);
    })
    .then(() => {
      usersDb.setSyncStatus(userId, 'done');
      enqueueEnrichment();
    })
    .catch((err) => {
      // Previously silent — a fast-sync crash only ever showed up in the
      // database (sync_error), never in the process's own console output,
      // which made a real crash indistinguishable from "still working"
      // without SSHing in to query the DB by hand. Logged here now for the
      // same reason enqueueEnrichment already did below.
      console.error(`[sync] fast sync failed for user ${userId}:`, err.message);
      usersDb.setSyncStatus(userId, 'error', err.message);
    });
}

// Not user-scoped — enrichment writes to the global artists table, so it
// doesn't matter whose login triggered a given pass. Failures are just
// logged: by the time enrichment could fail, the triggering user's own
// sync_status is already 'done' and the frontend has stopped polling, so
// there's nothing left to report a failure *to* — the next user's login
// (or a manual `npm run sync <userId>`) naturally retries whatever's still
// unresolved.
function enqueueEnrichment() {
  enrichQueue = enrichQueue
    .then(() => sync.runEnrichment())
    .catch((err) => console.error('[enrichment] failed:', err.message));
}

// A systemd restart mid-sync would otherwise leave a user's sync_status
// stuck on 'syncing' forever, with the frontend polling against nothing —
// status lives in the DB (not memory) specifically so this can detect and
// clear that on the next boot. Only the fast phase's status is tracked
// this way; an interrupted enrichment pass needs no recovery step — it
// just resumes naturally next time any user's fast sync completes.
function recoverStuckSyncs() {
  for (const user of usersDb.getAll()) {
    if (user.syncStatus === 'syncing') {
      usersDb.setSyncStatus(user.id, 'error', 'Interrupted by a server restart — please log in again to retry.');
    }
  }
}

module.exports = { enqueueSync, recoverStuckSyncs };
