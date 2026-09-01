require('dotenv').config();

const spotify = require('../sources/spotify');
const musicbrainz = require('../sources/musicbrainz');
const wikidata = require('../sources/wikidata');
const isrcCountry = require('../utils/isrcCountry');
const songsDb = require('../db/songs');
const artistsDb = require('../db/artists');
const playlistsDb = require('../db/playlists');
const usersDb = require('../db/users');

const MB_BATCH_SIZE = 15;
const MB_REQUEST_DELAY_MS = 1100;
const MB_CIRCUIT_BREAKER_THRESHOLD = 10;
const WIKIDATA_BATCH_SIZE = 50;
const WIKIDATA_REQUEST_DELAY_MS = 500;
const WIKIDATA_FUZZY_DELAY_MS = 1000;
const WIKIDATA_QID_BATCH_SIZE = 50;
const GENRE_BATCH_SIZE = 50;
const GENRE_REQUEST_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Trips after `threshold` total 503s seen across a resolveCountries() run —
// cumulative, not consecutive-failures. That distinction matters: under
// sustained load, musicbrainz.js's own per-request retry usually recovers
// within 1-2 tries, so almost every *call* still "succeeds" even while
// nearly every *request* is bouncing off a 503 first. Counting only calls
// that fully fail never sees that — this counts every 503 sighting
// (musicbrainz.js's onRetry fires on each one, recovered or not), so
// sustained distress trips it even when no single call outright fails.
function createCircuitBreaker(threshold) {
  let count503s = 0;
  let tripped = false;
  return {
    get tripped() {
      return tripped;
    },
    recordRetry() {
      if (++count503s >= threshold) tripped = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Liked Songs
// ---------------------------------------------------------------------------

// This user's own already-recorded Liked Songs, from their pseudo-playlist —
// NOT a global lookup. `songs` itself is a shared cache across every user,
// so "does this song ID exist anywhere" is no longer the right question:
// syncSongs()'s incremental stop-early check must be scoped to what *this*
// user has already synced, or a brand-new user's walk could stop the moment
// it hits some other user's already-cached song, silently truncating their
// own history (see syncSongs' comment below).
function getUserLikedSongIds(userId) {
  const likedSongs = playlistsDb.getById(userId, playlistsDb.likedSongsId(userId));
  return new Set(likedSongs ? likedSongs.tracks.map((t) => t.id) : []);
}

// Spotify's saved-tracks endpoint returns items newest-first, so this can
// stop paginating the moment it hits a track this *user* already has
// recorded — everything after that point is already known to them. Scoped
// to the user's own Liked-Songs membership rather than the global `songs`
// table: `songs` is a shared cache now, so a song being globally known
// (synced by some other user) says nothing about whether *this* user has
// walked past it yet. On a user's first-ever sync their own scope starts
// empty, so this naturally walks their entire library, same as the old
// single-tenant behavior did on a first run.
async function syncSongs(accessToken, userId) {
  const existingIds = getUserLikedSongIds(userId);
  const rawNewItems = [];
  let url = 'https://api.spotify.com/v1/me/tracks?limit=50';
  let reachedKnown = false;

  usersDb.setSyncProgress(userId, 'songs', 0, null);

  while (url && !reachedKnown) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Spotify library fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    for (const item of data.items) {
      if (existingIds.has(item.track.id)) {
        reachedKnown = true;
        break;
      }
      rawNewItems.push(item);
    }
    // data.total is this user's whole Liked Songs count, not just what's
    // new — the honest denominator for a brand-new user (existingIds
    // starts empty, so "new" and "total" mean the same thing); a returning
    // user's bar just moves fast and finishes early, which is accurate.
    usersDb.setSyncProgress(userId, 'songs', rawNewItems.length, data.total);

    url = reachedKnown ? null : data.next;
  }

  const newSongs = songsDb.mergeTracks(rawNewItems);
  console.log(`[songs] sync complete: ${newSongs.length} new songs for this user`);
  return newSongs;
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

async function fetchAllPlaylists(accessToken) {
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
}

async function fetchPlaylistTracks(accessToken, playlistId) {
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
}

// Only ever runs once per user (the first-sync seed) — but on a large
// library this walk alone was silently taking 30-40+ seconds with zero
// progress reporting, which is exactly what "stuck at 47/47 for a long
// time" was: the main playlist loop's progress had already hit 100%, and
// nothing updated again until this entire unreported walk finished. Proven
// with real timestamps from server logs, not guessed — see
// playlister_focus.md.
async function fetchAllLikedTrackIds(accessToken, userId) {
  const tracks = [];
  let url = 'https://api.spotify.com/v1/me/tracks?limit=50';

  usersDb.setSyncProgress(userId, 'liked-songs-seed', 0, null);

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Spotify library fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    for (const item of data.items) {
      if (item.track?.id) tracks.push({ id: item.track.id, addedAt: item.added_at });
    }
    usersDb.setSyncProgress(userId, 'liked-songs-seed', tracks.length, data.total);
    url = data.next;
  }

  return tracks;
}

// Syncs every playlist this user owns or follows, plus a "liked-songs"
// pseudo-playlist entry (so Liked Songs shows up in the same Playlist
// filter as real playlists). Real playlists are reconciled via
// `snapshot_id`: unchanged since last sync -> skipped entirely (no
// requests), changed or new -> full track list re-fetched and any new
// tracks merged into songs. Playlists no longer returned by Spotify
// (deleted/unfollowed) are removed from this user's own list only — see
// db/playlists.js's set() for why that's scoped per-user, not a blanket
// wipe.
//
// `newLikedSongs` is whatever syncSongs() just discovered this run — the
// liked-songs pseudo-playlist is updated append-only from that (same
// "detects additions, not removals" limitation as songs storage itself),
// unlike real playlists which get correct full reconciliation.
async function syncPlaylists(userId, accessToken, newLikedSongs) {
  const existing = playlistsDb.getAll(userId);
  const existingById = new Map(existing.map((p) => [p.id, p]));

  const remotePlaylists = await fetchAllPlaylists(accessToken);
  console.log(`[playlists] found ${remotePlaylists.length} playlists`);

  const updated = [];
  let changedCount = 0;

  for (const [index, remote] of remotePlaylists.entries()) {
    usersDb.setSyncProgress(userId, 'playlists', index, remotePlaylists.length);
    const current = existingById.get(remote.id);

    if (current && current.snapshotId === remote.snapshot_id) {
      updated.push(current);
      continue;
    }

    changedCount++;
    const items = await fetchPlaylistTracks(accessToken, remote.id);
    songsDb.mergeTracks(items);

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
  usersDb.setSyncProgress(userId, 'playlists', remotePlaylists.length, remotePlaylists.length);

  const likedSongsId = playlistsDb.likedSongsId(userId);
  let likedSongs = existingById.get(likedSongsId);

  if (!likedSongs) {
    // First time this user has synced: their liked songs may span more
    // history than syncSongs()'s incremental walk just reported. Seed the
    // pseudo-playlist with a one-time full walk so it starts accurate,
    // rather than silently starting from zero.
    console.log('[playlists] seeding Liked Songs pseudo-playlist (one-time full walk)');
    likedSongs = {
      id: likedSongsId,
      name: 'Liked Songs',
      ownerName: null,
      public: false,
      collaborative: false,
      snapshotId: null,
      tracks: await fetchAllLikedTrackIds(accessToken, userId),
    };
  } else if (newLikedSongs.length > 0) {
    likedSongs.tracks = [
      ...newLikedSongs.map((s) => ({ id: s.id, addedAt: s.addedAt })),
      ...likedSongs.tracks,
    ];
  }
  updated.unshift(likedSongs);

  playlistsDb.set(userId, updated);
  console.log(`[playlists] sync complete: ${changedCount}/${remotePlaylists.length} playlists refreshed`);
}

// ---------------------------------------------------------------------------
// Artist country resolution (MusicBrainz -> Wikidata -> ISRC), cheapest and
// most-accurate source first. Fully global — shared across every user, no
// userId involved at all.
// ---------------------------------------------------------------------------

// MusicBrainz batched search -> MusicBrainz per-artist fallback lookup
// (recovers a search-index quirk) -> Wikidata batched exact-label match ->
// Wikidata fuzzy search (recovers accent/diacritic mismatches). `artistList`
// is the full roster (artistsDb.getAll() — every artist has a row by the
// time this runs, since db/songs.js's mergeTracks stub-creates one for
// each artist as songs come in) — only ones previously left unresolved
// actually get queried; anything already resolved (by any user's prior
// sync) is skipped, so this is cheap to re-run every time.
async function resolveCountries(artistList) {
  const toResolve = artistList.filter((a) => a.country === null);

  if (toResolve.length === 0) {
    console.log(`[artists] nothing to resolve (${artistList.length} artists cached)`);
    return;
  }

  console.log(`[artists] resolving ${toResolve.length}/${artistList.length} artists`);

  const needsFallback = [];
  let searched = 0;
  const breaker = createCircuitBreaker(MB_CIRCUIT_BREAKER_THRESHOLD);

  for (let i = 0; i < toResolve.length; i += MB_BATCH_SIZE) {
    if (breaker.tripped) {
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
        artistsDb.upsert(id, { name: result.name, country: result.country });
        if (result.mbid && result.country === null) {
          needsFallback.push({ id, mbid: result.mbid });
        }
      }
      searched += batch.length;
      console.log(`[artists] searched ${searched}/${toResolve.length} artists`);
    } catch (err) {
      console.error(`[artists] batch failed: ${err.message}`);
    }

    await sleep(MB_REQUEST_DELAY_MS);
  }

  // No "backfill a missing cache entry" step needed here (unlike the old
  // JSON-era code) — every artist in toResolve already has a row by
  // construction, since it came from artistsDb.getAll() in the first
  // place. A failed MusicBrainz batch just leaves that row's country at
  // whatever it already was (still null), nothing to reconcile.

  if (needsFallback.length > 0 && breaker.tripped) {
    console.warn(`[artists] MusicBrainz unavailable — skipping ${needsFallback.length} fallback lookups`);
  } else if (needsFallback.length > 0) {
    console.log(`[artists] following up on ${needsFallback.length} artists missing country data`);
    let recovered = 0;

    for (const { id, mbid } of needsFallback) {
      if (breaker.tripped) {
        console.warn(
          `[artists] MusicBrainz unavailable (${MB_CIRCUIT_BREAKER_THRESHOLD} total 503s) — ` +
            `stopping fallback lookups early`
        );
        break;
      }

      try {
        const country = await musicbrainz.lookupArtistCountry(mbid, breaker.recordRetry);
        if (country) {
          artistsDb.upsert(id, { country });
          recovered++;
        }
      } catch (err) {
        console.error(`[artists] fallback lookup failed: ${err.message}`);
      }
      await sleep(MB_REQUEST_DELAY_MS);
    }

    console.log(`[artists] recovered ${recovered}/${needsFallback.length} via fallback lookup`);
  }

  const stillNull = toResolve.filter((a) => artistsDb.getById(a.id).country === null);

  if (stillNull.length > 0) {
    console.log(`[artists] trying Wikidata for ${stillNull.length} remaining artists`);
    let wikidataResolved = 0;

    for (let i = 0; i < stillNull.length; i += WIKIDATA_BATCH_SIZE) {
      const batch = stillNull.slice(i, i + WIKIDATA_BATCH_SIZE);
      try {
        const results = await wikidata.resolveWikidataBatch(batch);
        for (const [id, result] of Object.entries(results)) {
          if (result.country) {
            artistsDb.upsert(id, { country: result.country });
            wikidataResolved++;
          }
        }
      } catch (err) {
        console.error(`[artists] Wikidata batch failed: ${err.message}`);
      }

      await sleep(WIKIDATA_REQUEST_DELAY_MS);
    }

    console.log(`[artists] recovered ${wikidataResolved}/${stillNull.length} via Wikidata`);

    const stillNullAfterWikidata = stillNull.filter((a) => artistsDb.getById(a.id).country === null);

    if (stillNullAfterWikidata.length > 0) {
      console.log(
        `[artists] trying Wikidata fuzzy search for ${stillNullAfterWikidata.length} remaining artists`
      );

      const qidById = {};
      for (const artist of stillNullAfterWikidata) {
        try {
          const qid = await wikidata.searchWikidataEntity(artist.name);
          if (qid) qidById[artist.id] = qid;
        } catch (err) {
          console.error(`[artists] Wikidata fuzzy search failed: ${err.message}`);
        }
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
            if (country && artistsDb.getById(id).country === null) {
              artistsDb.upsert(id, { country });
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
}

// For any artist still unresolved, scans every one of their tracks already
// stored (not just whichever one happens to be on the page you're
// viewing) for a resolvable ISRC country. Purely local — no Spotify call —
// since songs already carry each track's ISRC. Global, same as the rest of
// artist resolution.
function resolveIsrcFallback() {
  let recovered = 0;

  for (const song of songsDb.getAll()) {
    const primary = song.artists[0];
    const entry = primary && artistsDb.getById(primary.id);
    if (entry && entry.country === null) {
      const country = isrcCountry.countryFromIsrc(song.isrc);
      if (country) {
        artistsDb.upsert(primary.id, { country });
        recovered++;
      }
    }
  }

  console.log(`[artists] recovered ${recovered} artists via ISRC fallback`);
}

// ---------------------------------------------------------------------------
// Spotify genres/popularity/followers (requires the grandfathered pre-Nov-
// 2024 app — see playlister_focus.md). Global, same as the rest of artist
// resolution — any user's access token works equally well here, since this
// restriction is gated by which Spotify app is used, not which user's token
// calls it.
// ---------------------------------------------------------------------------

// One-time pass, batched 50 artist IDs/request via Spotify's own artist
// endpoint. Only fetches artists missing any of these fields, so re-running
// (e.g. after adding a new field here later) only costs requests for
// artists that actually need it. `userId` is optional (only the blocking
// call from runFastSync needs to report progress; the manual CLI path
// doesn't) — when given, reports into the same sync_progress_* columns
// syncSongs/syncPlaylists already use.
async function resolveArtistDetails(accessToken, userId) {
  const toResolve = artistsDb
    .getAll()
    .filter((a) => !a.detailsResolved)
    .map((a) => a.id);

  if (toResolve.length === 0) {
    console.log('[artists] all cached artists already have genres/popularity/followers');
    return;
  }

  console.log(`[artists] resolving details for ${toResolve.length} artists`);
  let resolved = 0;
  if (userId) usersDb.setSyncProgress(userId, 'details', 0, toResolve.length);

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
        if (artist && artistsDb.getById(artist.id)) {
          artistsDb.upsert(artist.id, {
            genres: artist.genres ?? [],
            popularity: artist.popularity ?? null,
            followers: artist.followers?.total ?? null,
          });
        }
      }
      resolved += batch.length;
      if (userId) usersDb.setSyncProgress(userId, 'details', resolved, toResolve.length);
      console.log(`[artists] resolved ${resolved}/${toResolve.length} artists`);
    } catch (err) {
      console.error(`[artists] batch failed: ${err.message}`);
    }

    await sleep(GENRE_REQUEST_DELAY_MS);
  }

  console.log('[artists] details backfill complete');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Split from enrichment on purpose: this half is bounded by Spotify
// pagination speed alone (no artificial delay anywhere in it), while
// resolveCountries below is deliberately rate-limited against an external
// service outside our control (MusicBrainz/Wikidata) and can run for hours
// against a brand-new user's never-before-seen artists — that one stays in
// the background (runEnrichment). Genres/popularity (resolveArtistDetails)
// used to live there too, but Lucas wanted it to actually be *done* by the
// time the app becomes usable rather than filling in gradually afterward —
// reasonable, since Spotify's own batch endpoint resolves thousands of
// artists in well under a minute, a small addition to the wait. Returns
// the access token so the caller can hand it to runEnrichment without a
// second token lookup.
async function runFastSync(userId) {
  const accessToken = await spotify.getValidAccessToken(userId);
  if (!accessToken) {
    throw new Error(`No valid Spotify token for user ${userId}`);
  }

  console.log(`== Syncing liked songs (user ${userId}) ==`);
  const newLikedSongs = await syncSongs(accessToken, userId);

  console.log('== Syncing playlists ==');
  await syncPlaylists(userId, accessToken, newLikedSongs);

  // Local only, no network — cheap enough to run inline here rather than
  // deferring it to the slow phase.
  resolveIsrcFallback();

  console.log('== Resolving artist genres/popularity ==');
  await resolveArtistDetails(accessToken, userId);

  return accessToken;
}

// The slow half — global artist country resolution, not scoped to any one
// user's login. No access token needed at all — MusicBrainz/Wikidata don't
// use Spotify auth.
async function runEnrichment() {
  console.log('== Resolving artist countries ==');
  // Every artist already has a row by this point — db/songs.js's
  // mergeTracks stub-creates one for each artist as songs come in, so the
  // full roster is just whatever's in the (global) table.
  await resolveCountries(artistsDb.getAll());

  console.log('== Enrichment complete ==');
}

// Runs both phases back-to-back, synchronously — used by the manual CLI
// entry point below, where waiting for the whole thing is expected. The
// server-triggered path (sources/syncQueue.js) calls runFastSync and
// runEnrichment separately instead, on two independent queues.
async function runFullSync(userId) {
  await runFastSync(userId);
  await runEnrichment();
  console.log('== Sync complete ==');
}

if (require.main === module) {
  const userId = process.argv[2];
  if (!userId) {
    const known = usersDb.getAll();
    console.error('Usage: node scripts/sync.js <spotifyUserId>');
    if (known.length > 0) {
      console.error('Known users:');
      known.forEach((u) => console.error(`  ${u.id}${u.displayName ? ` (${u.displayName})` : ''}`));
    } else {
      console.error('No users have logged in yet.');
    }
    process.exit(1);
  }

  runFullSync(userId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Sync failed:', err.message);
      process.exit(1);
    });
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
