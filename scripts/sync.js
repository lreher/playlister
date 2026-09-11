require('dotenv').config();

const spotify = require('../sources/spotify');
const musicbrainz = require('../sources/musicbrainz');
const wikidata = require('../sources/wikidata');
const isrcCountry = require('../utils/isrcCountry');
const songsDb = require('../db/songs');
const artistsDb = require('../db/artists');
const playlistsDb = require('../db/playlists');
const usersDb = require('../db/users');
const syncDb = require('../db/index')('sync');
const enrichmentProgress = require('../sources/enrichmentProgress');

const MB_BATCH_SIZE = 15;
const MB_REQUEST_DELAY_MS = 1100;
const MB_CIRCUIT_BREAKER_THRESHOLD = 10;
const WIKIDATA_BATCH_SIZE = 50;
const WIKIDATA_REQUEST_DELAY_MS = 500;
const WIKIDATA_FUZZY_DELAY_MS = 1000;
const WIKIDATA_QID_BATCH_SIZE = 50;
const GENRE_BATCH_SIZE = 50;
const GENRE_REQUEST_DELAY_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gives up on MusicBrainz for the rest of this run once enough 503s pile up — counts
// every 503 seen, since most calls still succeed after a retry or two.
const createCircuitBreaker = (threshold) => {
  let count503s = 0;
  let tripped = false;
  return {
    isTripped: () => tripped,
    recordRetry: () => {
      if (++count503s >= threshold) tripped = true;
    },
  };
};

// ---------------------------------------------------------------------------
// Liked Songs
// ---------------------------------------------------------------------------

// Full walk every time, no incremental stop-early — needed to catch unlikes
// and to record each user's own added date.
const syncSongs = async (accessToken, userId, knexInstance = syncDb) => {
  const items = [];
  let url = 'https://api.spotify.com/v1/me/tracks?limit=50';

  await usersDb.setSyncProgress(userId, 'songs', 0, null, knexInstance);

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Spotify library fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    items.push(...data.items);
    await usersDb.setSyncProgress(userId, 'songs', items.length, data.total, knexInstance);
    url = data.next;
  }

  await songsDb.mergeTracks(items, knexInstance);

  // Skip Spotify's blank unlisted-track stubs — mergeTracks skips them too, so this keeps the two in sync.
  const likedList = items
    .filter((item) => item.track?.id && item.track?.name)
    .map((item) => ({ id: item.track.id, addedAt: item.added_at }));

  console.log(`[songs] sync complete: ${likedList.length} liked songs for this user`);
  return likedList;
};

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

const fetchAllPlaylists = async (accessToken) => {
  const playlists = [];
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50';

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Spotify playlists fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    playlists.push(...data.items);
    url = data.next;
  }

  return playlists;
};

const fetchPlaylistTracks = async (accessToken, playlistId) => {
  const items = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50`;

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Spotify playlist tracks fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    // Local files and removed/unavailable tracks come back with track: null.
    items.push(...data.items.filter((item) => item.track && item.track.id));
    url = data.next;
  }

  return items;
};

// Reconciles playlists via snapshot_id (unchanged -> skipped, no requests) and
// adds Liked Songs as a pseudo-playlist so it shows up in the same filter.
const syncPlaylists = async (userId, accessToken, likedList, knexInstance = syncDb) => {
  const existing = await playlistsDb.getAll(userId, knexInstance);
  const existingById = new Map(existing.map((p) => [p.id, p]));

  const remotePlaylists = await fetchAllPlaylists(accessToken);
  console.log(`[playlists] found ${remotePlaylists.length} playlists`);

  const updated = [];
  let changedCount = 0;

  for (const [index, remote] of remotePlaylists.entries()) {
    await usersDb.setSyncProgress(userId, 'playlists', index, remotePlaylists.length, knexInstance);
    const current = existingById.get(remote.id);

    if (current && current.snapshotId === remote.snapshot_id) {
      updated.push(current);
      continue;
    }

    changedCount++;
    const items = await fetchPlaylistTracks(accessToken, remote.id);
    await songsDb.mergeTracks(items, knexInstance);

    updated.push({
      id: remote.id,
      name: remote.name,
      ownerName: remote.owner?.display_name ?? null,
      public: remote.public,
      collaborative: remote.collaborative,
      snapshotId: remote.snapshot_id,
      tracks: items.map((item) => ({ id: item.track.id, addedAt: item.added_at })),
    });
  }
  await usersDb.setSyncProgress(userId, 'playlists', remotePlaylists.length, remotePlaylists.length, knexInstance);

  updated.unshift({
    id: playlistsDb.likedSongsId(userId),
    name: 'Liked Songs',
    ownerName: null,
    public: false,
    collaborative: false,
    snapshotId: null,
    tracks: likedList,
  });

  await playlistsDb.set(userId, updated, knexInstance);
  console.log(`[playlists] sync complete: ${changedCount}/${remotePlaylists.length} playlists refreshed`);
};

// ---------------------------------------------------------------------------
// Artist country resolution: MusicBrainz -> Wikidata -> ISRC, cheapest first.
// Global — shared across every user, no userId involved.
// ---------------------------------------------------------------------------

// Skips artists already resolved, so safe to re-run every sync.
// True until a real MusicBrainz/Wikidata match lands — an ISRC guess (or an untagged
// legacy value from before country_source existed) still counts as worth retrying.
const isUnconfirmed = (a) => a.countrySource !== 'musicbrainz' && a.countrySource !== 'wikidata';

const resolveCountries = async (artistList, knexInstance = syncDb) => {
  const existingById = new Map(artistList.map((a) => [a.id, a]));
  const toResolve = artistList.filter(isUnconfirmed);

  if (toResolve.length === 0) {
    console.log(`[artists] nothing to resolve (${artistList.length} artists cached)`);
    enrichmentProgress.clear();
    return;
  }

  console.log(`[artists] resolving ${toResolve.length}/${artistList.length} artists`);

  const needsFallback = [];
  let searched = 0;
  const breaker = createCircuitBreaker(MB_CIRCUIT_BREAKER_THRESHOLD);

  for (let i = 0; i < toResolve.length; i += MB_BATCH_SIZE) {
    if (breaker.isTripped()) {
      console.warn(
        `[artists] MusicBrainz unavailable (${MB_CIRCUIT_BREAKER_THRESHOLD} total 503s) — ` +
          `skipping remaining ${toResolve.length - i} artists straight to Wikidata`
      );
      break;
    }

    const batch = toResolve.slice(i, i + MB_BATCH_SIZE);
    try {
      const results = await musicbrainz.resolveBatch(batch, breaker.recordRetry);
      for (const [id, result] of Object.entries(results)) {
        // A retried artist may already carry an ISRC guess — a null search result here
        // means "no country in this match," not "actually unresolved," so don't blank it
        // out. Only a brand-new stub (no prior country at all) is safe to write null to.
        if (result.country !== null || existingById.get(id)?.country === null) {
          await artistsDb.upsert(
            id,
            { name: result.name, country: result.country, countrySource: result.country ? 'musicbrainz' : null },
            knexInstance
          );
        } else {
          await artistsDb.upsert(id, { name: result.name }, knexInstance);
        }
        if (result.mbid && result.country === null) {
          needsFallback.push({ id, mbid: result.mbid });
        }
      }
      searched += batch.length;
      console.log(`[artists] searched ${searched}/${toResolve.length} artists`);
    } catch (err) {
      console.error(`[artists] batch failed: ${err.message}`);
    }

    enrichmentProgress.setStep('musicbrainz-search', searched, toResolve.length);
    await sleep(MB_REQUEST_DELAY_MS);
  }

  if (needsFallback.length > 0 && breaker.isTripped()) {
    console.warn(`[artists] MusicBrainz unavailable — skipping ${needsFallback.length} fallback lookups`);
  } else if (needsFallback.length > 0) {
    console.log(`[artists] following up on ${needsFallback.length} artists missing country data`);
    let recovered = 0;
    let fallbackChecked = 0;

    for (const { id, mbid } of needsFallback) {
      if (breaker.isTripped()) {
        console.warn(
          `[artists] MusicBrainz unavailable (${MB_CIRCUIT_BREAKER_THRESHOLD} total 503s) — ` +
            `stopping fallback lookups early`
        );
        break;
      }

      try {
        const country = await musicbrainz.lookupArtistCountry(mbid, breaker.recordRetry);
        if (country) {
          await artistsDb.upsert(id, { country, countrySource: 'musicbrainz' }, knexInstance);
          recovered++;
        }
      } catch (err) {
        console.error(`[artists] fallback lookup failed: ${err.message}`);
      }
      fallbackChecked++;
      enrichmentProgress.setStep('musicbrainz-fallback', fallbackChecked, needsFallback.length);
      await sleep(MB_REQUEST_DELAY_MS);
    }

    console.log(`[artists] recovered ${recovered}/${needsFallback.length} via fallback lookup`);
  }

  // filter's callback can't await, so resolve everything first, then filter.
  const afterMusicbrainz = await Promise.all(toResolve.map((a) => artistsDb.getById(a.id, knexInstance)));
  const stillNull = toResolve.filter((a, i) => isUnconfirmed(afterMusicbrainz[i]));

  if (stillNull.length > 0) {
    console.log(`[artists] trying Wikidata for ${stillNull.length} remaining artists`);
    let wikidataResolved = 0;
    let wikidataChecked = 0;

    for (let i = 0; i < stillNull.length; i += WIKIDATA_BATCH_SIZE) {
      const batch = stillNull.slice(i, i + WIKIDATA_BATCH_SIZE);
      try {
        const results = await wikidata.resolveWikidataBatch(batch);
        for (const [id, result] of Object.entries(results)) {
          if (result.country) {
            await artistsDb.upsert(id, { country: result.country, countrySource: 'wikidata' }, knexInstance);
            wikidataResolved++;
          }
        }
      } catch (err) {
        console.error(`[artists] Wikidata batch failed: ${err.message}`);
      }

      wikidataChecked += batch.length;
      enrichmentProgress.setStep('wikidata-exact', wikidataChecked, stillNull.length);
      await sleep(WIKIDATA_REQUEST_DELAY_MS);
    }

    console.log(`[artists] recovered ${wikidataResolved}/${stillNull.length} via Wikidata`);

    const afterWikidata = await Promise.all(stillNull.map((a) => artistsDb.getById(a.id, knexInstance)));
    const stillNullAfterWikidata = stillNull.filter((a, i) => isUnconfirmed(afterWikidata[i]));

    if (stillNullAfterWikidata.length > 0) {
      console.log(
        `[artists] trying Wikidata fuzzy search for ${stillNullAfterWikidata.length} remaining artists`
      );

      const qidById = {};
      let fuzzyChecked = 0;
      for (const artist of stillNullAfterWikidata) {
        try {
          const qid = await wikidata.searchWikidataEntity(artist.name);
          if (qid) qidById[artist.id] = qid;
        } catch (err) {
          console.error(`[artists] Wikidata fuzzy search failed: ${err.message}`);
        }
        fuzzyChecked++;
        enrichmentProgress.setStep('wikidata-fuzzy', fuzzyChecked, stillNullAfterWikidata.length);
        await sleep(WIKIDATA_FUZZY_DELAY_MS);
      }

      const qids = [...new Set(Object.values(qidById))];
      let fuzzyResolved = 0;

      for (let i = 0; i < qids.length; i += WIKIDATA_QID_BATCH_SIZE) {
        const batch = qids.slice(i, i + WIKIDATA_QID_BATCH_SIZE);
        try {
          const countryByQid = await wikidata.lookupCountriesByQids(batch);
          for (const [id, qid] of Object.entries(qidById)) {
            const country = countryByQid.get(qid);
            if (country && isUnconfirmed(await artistsDb.getById(id, knexInstance))) {
              await artistsDb.upsert(id, { country, countrySource: 'wikidata' }, knexInstance);
              fuzzyResolved++;
            }
          }
        } catch (err) {
          console.error(`[artists] Wikidata QID batch failed: ${err.message}`);
        }
        await sleep(WIKIDATA_REQUEST_DELAY_MS);
      }

      console.log(
        `[artists] recovered ${fuzzyResolved}/${stillNullAfterWikidata.length} via Wikidata fuzzy search`
      );
    }
  }

  console.log('[artists] backfill complete');
  // Some artists never resolve at all, so clear this rather than let it sit below 100% forever.
  enrichmentProgress.clear();
};

// Local-only fallback: checks stored track ISRCs for any artist still missing a country.
const resolveIsrcFallback = async (knexInstance = syncDb) => {
  let recovered = 0;

  for (const song of await songsDb.getAll(knexInstance)) {
    const primary = song.artists[0];
    const entry = primary && (await artistsDb.getById(primary.id, knexInstance));
    if (entry && entry.country === null) {
      const country = isrcCountry.countryFromIsrc(song.isrc);
      if (country) {
        await artistsDb.upsert(primary.id, { country, countrySource: 'isrc' }, knexInstance);
        recovered++;
      }
    }
  }

  console.log(`[artists] recovered ${recovered} artists via ISRC fallback`);
};

// ---------------------------------------------------------------------------
// Spotify genres/popularity/followers — needs the older grandfathered app
// (see playlister_focus.md). Global, not per-user.
// ---------------------------------------------------------------------------

// Only fetches artists missing these fields. userId is optional — only used to report progress.
const resolveArtistDetails = async (accessToken, userId, knexInstance = syncDb) => {
  const allArtists = await artistsDb.getAll(knexInstance);
  const toResolve = allArtists.filter((a) => !a.detailsResolved).map((a) => a.id);

  if (toResolve.length === 0) {
    console.log('[artists] all cached artists already have genres/popularity/followers');
    return;
  }

  console.log(`[artists] resolving details for ${toResolve.length} artists`);
  let resolved = 0;
  if (userId) await usersDb.setSyncProgress(userId, 'details', 0, toResolve.length, knexInstance);

  for (let i = 0; i < toResolve.length; i += GENRE_BATCH_SIZE) {
    const batch = toResolve.slice(i, i + GENRE_BATCH_SIZE);
    try {
      const params = new URLSearchParams({ ids: batch.join(',') });
      const res = await fetch(`https://api.spotify.com/v1/artists?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        throw new Error(`Spotify artists batch failed: ${res.status} ${await res.text()}`);
      }

      const resData = await res.json();
      for (const artist of resData.artists) {
        if (artist && (await artistsDb.getById(artist.id, knexInstance))) {
          await artistsDb.upsert(
            artist.id,
            {
              genres: artist.genres ?? [],
              popularity: artist.popularity ?? null,
              followers: artist.followers?.total ?? null,
            },
            knexInstance
          );
        }
      }
      resolved += batch.length;
      if (userId) await usersDb.setSyncProgress(userId, 'details', resolved, toResolve.length, knexInstance);
      console.log(`[artists] resolved ${resolved}/${toResolve.length} artists`);
    } catch (err) {
      console.error(`[artists] batch failed: ${err.message}`);
    }

    await sleep(GENRE_REQUEST_DELAY_MS);
  }

  console.log('[artists] details backfill complete');
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Bounded only by Spotify's pagination speed — country resolution (slow,
// rate-limited by MusicBrainz/Wikidata) runs separately in runEnrichment.
const runFastSync = async (userId, knexInstance = syncDb) => {
  const accessToken = await spotify.getValidAccessToken(userId, knexInstance);
  if (!accessToken) {
    throw new Error(`No valid Spotify token for user ${userId}`);
  }

  console.log(`== Syncing liked songs (user ${userId}) ==`);
  const likedList = await syncSongs(accessToken, userId, knexInstance);

  console.log('== Syncing playlists ==');
  await syncPlaylists(userId, accessToken, likedList, knexInstance);

  await resolveIsrcFallback(knexInstance);

  console.log('== Resolving artist genres/popularity ==');
  await resolveArtistDetails(accessToken, userId, knexInstance);

  return accessToken;
};

// The slow half — global country resolution, not tied to one user's login.
const runEnrichment = async (knexInstance = syncDb) => {
  console.log('== Resolving artist countries ==');
  await resolveCountries(await artistsDb.getAll(knexInstance), knexInstance);

  console.log('== Enrichment complete ==');
};

// Used by the manual CLI below; sources/syncQueue.js runs the two phases separately instead.
const runFullSync = async (userId, knexInstance = syncDb) => {
  await runFastSync(userId, knexInstance);
  await runEnrichment(knexInstance);
  console.log('== Sync complete ==');
};

if (require.main === module) {
  const userId = process.argv[2];
  if (!userId) {
    usersDb
      .getAll()
      .then((known) => {
        console.error('Usage: node scripts/sync.js <spotifyUserId>');
        if (known.length > 0) {
          console.error('Known users:');
          known.forEach((u) => console.error(`  ${u.id}${u.displayName ? ` (${u.displayName})` : ''}`));
        } else {
          console.error('No users have logged in yet.');
        }
      })
      .finally(() => process.exit(1));
  } else {
    runFullSync(userId)
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('Sync failed:', err.message);
        process.exit(1);
      });
  }
}

module.exports = {
  runFullSync,
  runFastSync,
  runEnrichment,
  syncSongs,
  syncPlaylists,
  resolveCountries,
  resolveIsrcFallback,
  resolveArtistDetails,
};
