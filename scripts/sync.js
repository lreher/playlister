require('dotenv').config();

const spotify = require('../sources/spotify');
const musicbrainz = require('../sources/musicbrainz');
const wikidata = require('../sources/wikidata');
const isrcCountry = require('../utils/isrcCountry');
const songsDb = require('../db/songs');
const artistsDb = require('../db/artists');
const playlistsDb = require('../db/playlists');

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

// Spotify's saved-tracks endpoint returns items newest-first, so this can
// stop paginating the moment it hits a track already stored — everything
// after that point is already known. On first run (empty db) this naturally
// walks the entire library.
//
// Known limitation: only detects additions, not removals — if you unlike a
// song it stays stored until manually cleaned up.
async function syncSongs(accessToken) {
  const existingIds = new Set(songsDb.getAll().map((s) => s.id));
  const rawNewItems = [];
  let url = 'https://api.spotify.com/v1/me/tracks?limit=50';
  let reachedKnown = false;

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

    url = reachedKnown ? null : data.next;
  }

  const newSongs = songsDb.mergeTracks(rawNewItems);
  console.log(`[songs] sync complete: ${newSongs.length} new songs (${songsDb.getAll().length} total)`);
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

async function fetchAllLikedTrackIds(accessToken) {
  const tracks = [];
  let url = 'https://api.spotify.com/v1/me/tracks?limit=50';

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Spotify library fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    for (const item of data.items) {
      if (item.track?.id) tracks.push({ id: item.track.id, addedAt: item.added_at });
    }
    url = data.next;
  }

  return tracks;
}

// Syncs every playlist the user owns or follows, plus a "liked-songs"
// pseudo-playlist entry (so Liked Songs shows up in the same Playlist
// filter as real playlists). Real playlists are reconciled via
// `snapshot_id`: unchanged since last sync -> skipped entirely (no
// requests spent), changed or new -> full track list re-fetched and any
// new tracks merged into songs. Playlists no longer returned by Spotify
// (deleted/unfollowed) are removed from storage too.
//
// `newLikedSongs` is whatever syncSongs() just discovered this run — the
// liked-songs pseudo-playlist is updated append-only from that (same
// "detects additions, not removals" limitation as songs storage itself),
// unlike real playlists which get correct full reconciliation.
async function syncPlaylists(accessToken, newLikedSongs) {
  const existing = playlistsDb.getAll();
  const existingById = new Map(existing.map((p) => [p.id, p]));

  const remotePlaylists = await fetchAllPlaylists(accessToken);
  console.log(`[playlists] found ${remotePlaylists.length} playlists`);

  const updated = [];
  let changedCount = 0;

  for (const remote of remotePlaylists) {
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

  let likedSongs = existingById.get(playlistsDb.LIKED_SONGS_ID);

  if (!likedSongs) {
    // First time this feature has run: songs storage may already hold
    // liked songs synced before playlists existed, and syncSongs()'s
    // incremental check only reports *newly*-discovered ones. Seed the
    // pseudo-playlist with a one-time full walk so it starts accurate,
    // rather than silently starting from zero.
    console.log('[playlists] seeding Liked Songs pseudo-playlist (one-time full walk)');
    likedSongs = {
      id: playlistsDb.LIKED_SONGS_ID,
      name: 'Liked Songs',
      ownerName: null,
      public: false,
      collaborative: false,
      snapshotId: null,
      tracks: await fetchAllLikedTrackIds(accessToken),
    };
  } else if (newLikedSongs.length > 0) {
    likedSongs.tracks = [
      ...newLikedSongs.map((s) => ({ id: s.id, addedAt: s.addedAt })),
      ...likedSongs.tracks,
    ];
  }
  updated.unshift(likedSongs);

  playlistsDb.set(updated);
  console.log(`[playlists] sync complete: ${changedCount}/${remotePlaylists.length} playlists refreshed`);
}

// ---------------------------------------------------------------------------
// Artist country resolution (MusicBrainz -> Wikidata -> ISRC), cheapest and
// most-accurate source first
// ---------------------------------------------------------------------------

// Derives the unique artist roster from the local song snapshot — no
// Spotify call needed, since songs already carry every artist on every
// track. Replaces walking Spotify's saved-tracks endpoint a second time
// just to discover artist IDs.
function uniqueArtistsFromSongs(allSongs) {
  const artists = new Map();
  for (const song of allSongs) {
    for (const artist of song.artists) {
      artists.set(artist.id, { id: artist.id, name: artist.name });
    }
  }
  return [...artists.values()];
}

// MusicBrainz batched search -> MusicBrainz per-artist fallback lookup
// (recovers a search-index quirk) -> Wikidata batched exact-label match ->
// Wikidata fuzzy search (recovers accent/diacritic mismatches). `artistList`
// is the full roster (e.g. from uniqueArtistsFromSongs) — only ones never
// seen before, or previously left unresolved, actually get queried;
// anything already resolved is skipped, so this is cheap to re-run on
// every sync.
async function resolveCountries(artistList) {
  const toResolve = artistList.filter((a) => {
    const entry = artistsDb.getById(a.id);
    return !entry || entry.country === null;
  });

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

  // A batch that failed outright (e.g. a MusicBrainz 503) never populated
  // cache entries for its artists — backfill them as unresolved so every
  // artist in toResolve is guaranteed a cache entry before later phases
  // assume one exists.
  for (const artist of toResolve) {
    if (!artistsDb.getById(artist.id)) {
      artistsDb.upsert(artist.id, { name: artist.name, country: null });
    }
  }

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
// since songs already carry each track's ISRC.
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
// 2024 app — see playlister_focus.md)
// ---------------------------------------------------------------------------

// One-time pass, batched 50 artist IDs/request via Spotify's own artist
// endpoint. Only fetches artists missing any of these fields, so re-running
// (e.g. after adding a new field here later) only costs requests for
// artists that actually need it.
async function resolveArtistDetails(accessToken) {
  const toResolve = artistsDb
    .getAll()
    .filter((a) => !('genres' in a) || !('popularity' in a))
    .map((a) => a.id);

  if (toResolve.length === 0) {
    console.log('[artists] all cached artists already have genres/popularity/followers');
    return;
  }

  console.log(`[artists] resolving details for ${toResolve.length} artists`);
  let resolved = 0;

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

async function main() {
  const accessToken = await spotify.getValidAccessToken();
  if (!accessToken) {
    console.error('Not logged in — start the server (npm start) and log in via /login first.');
    process.exit(1);
  }

  console.log('== Syncing liked songs ==');
  const newLikedSongs = await syncSongs(accessToken);

  console.log('== Syncing playlists ==');
  await syncPlaylists(accessToken, newLikedSongs);

  const artistRoster = uniqueArtistsFromSongs(songsDb.getAll());

  console.log('== Resolving artist countries ==');
  await resolveCountries(artistRoster);
  resolveIsrcFallback();

  console.log('== Resolving artist genres/popularity ==');
  await resolveArtistDetails(accessToken);

  console.log('== Sync complete ==');
}

main().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
