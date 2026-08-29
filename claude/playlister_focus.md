# Playlister — Project Focus & Living Reference

Personal local tool that pulls your **entire Spotify library** — Liked Songs plus every
playlist — into a rich, filterable, Spotify-agnostic local dataset (country of origin,
genre, popularity, decade, duration, playlist membership, etc.). Node.js, zero framework,
vanilla JS frontend, flat JSON files as the database. No git repo.

Read this file first when picking this project back up — it has the decisions and
hard-won findings that aren't obvious from the code alone.

## Architecture reorg — complete, including a `db/` internal redesign

The file-layout reorg is **done and verified working end-to-end**. `lib/` and `store/`
no longer exist. If you're reading old context that mentions `lib/songStore.js`,
`lib/artistStore.js`, `lib/playlistStore.js`, `lib/sources/`, `lib/songs.js`,
`lib/songQuery.js`, `controllers/artists.js`/`controllers/playlists.js`, a top-level
`store/`, or `db/*.js` files built on `utils/cache.js`'s old `createCache(filename,
defaultValue)` API with `getById`/`has`/`upsert`/`save()` (an intermediate shape from
this session, since superseded), those are gone — use this section instead.

**Current layout** (verified end-to-end after the last redesign: server boots,
`/api/songs` → 6199 songs, `/api/filters` → 93 countries / 468 genres / 48 playlists /
4489 artists, `/api/stats` → 9 decades / 93 countries / 74 years, playlist-filter query →
204 songs for the tested playlist — all matching prior validated numbers; `db.js`'s
`read`/`write`/`upsert` and `utils/cache.js`'s memoization were also each proven in
isolation against scratch files, not just asserted):

- **`db/db.js`** — the one generic, low-level file primitive everything else is built
  on: `setFile(relativePath)` → `{ read(default), write(data), upsert(record) }`. Treats
  every data file as an array of records with an `id` field. No caching, no domain logic
  — every call touches disk directly, on purpose (explicit call: this is a personal,
  single-process toy app, not a system where write-batching for performance or
  crash-resilience is worth the complexity — "just write to disk, it's fine"). This is
  the piece Lucas hand-sketched the shape of and asked to be built out for real; it
  directly replaces having a bespoke `upsert` reimplemented per entity file (which is
  what the previous, superseded version of `db/artists.js` did).
- **`db/songs.js`, `db/artists.js`, `db/playlists.js`** — thin entity-specific wrappers
  combining `db/db.js` (disk I/O) with `utils/cache.js` (in-memory memoization so
  `getAll()` doesn't re-read disk every call). Each exposes `getAll()`/`getById(id)` plus
  whatever write shape actually fits that entity's real usage — **not** forced into one
  identical shape:
  - `songs.js`: `mergeTracks(items)` — dedupes a batch of raw Spotify track items,
    skips blank catalog-removed stubs, writes once via `db.write()` (a genuine batch
    operation, not a fit for per-record `db.upsert()`).
  - `artists.js`: `upsert(id, patch)` — shallow-merges into one artist's record via
    `db.upsert()`, immediately re-reads the file into the cache afterward so it always
    exactly mirrors disk. Also `getCountry`/`getGenres`/`getPopularity`/`getFollowers` —
    field-specific reads with per-field defaults (`null` for scalars, `[]` for the genres
    array) — proven load-bearing, not just style: swapping these for raw
    `getById(id)?.field` produces `undefined` for an artist that hasn't been
    genre-resolved yet, which corrupts `flatMap`-based genre aggregation with stray
    `null` entries in the dashboard/filter dropdown.
  - `playlists.js`: `set(playlists)` — whole-collection replace via `db.write()`, not a
    per-record upsert. Deliberate: a playlist sync run always recomputes every playlist's
    *current* state in one pass, including detecting deleted/unfollowed playlists that
    need to disappear — a per-record upsert can only add/update, never remove, so it
    can't express that. Also exports `LIKED_SONGS_ID`, a well-known key constant.
  - `artists.json`'s **on-disk shape was migrated** from an object keyed by artist ID
    (`{ [id]: {...} }`) to an array of records with an `id` field (`[{ id, ... }]`), to
    match `songs.json`/`playlists.json` and let `db/db.js`'s `upsert`/`read`/`write` work
    identically for all three — no special-cased object-shape handling. Migrated with a
    timestamped backup left at `data/artists.json.backup-pre-array-migration-<ts>`
    (4502 records, verified count-preserved before deleting nothing).
- **`utils/cache.js`** — reduced to a generic memoization primitive with zero file
  knowledge: `createCache()` returns a callable — no args reads the current value
  (`undefined` if nothing cached yet), called with a value stores and returns it. No
  filename, no defaultValue — that's `db/db.js`'s job now.
- **`data/`** — the JSON files: `songs.json`, `artists.json`, `playlists.json`,
  `tokens.json`. Sibling to `db/`, which holds only code. `db/db.js`'s `setFile()`
  resolves paths relative to itself (`db/`), so each entity file passes e.g.
  `'../data/songs.json'`.
- **`db/tokens.js`** — Spotify OAuth token storage, built on `db/db.js` like the other
  three, but **not** a collection — just one stored object (no `id`, no array), so it
  doesn't fit the `getAll`/`getById`/`upsert` shape. Exposes the minimal thing that
  actually matches: `get()`/`set(tokens)`. Replaces the old `auth/tokenStore.js`
  (removed entirely, along with the now-empty `auth/` directory) — `sources/spotify.js`
  calls `db/tokens.js` directly now. Verified live: `/api/songs` (which calls
  `getValidAccessToken()` on every request) still returned real data post-change, so the
  full token-read chain was exercised, not just asserted.
- **`controllers/songs.js`** — unchanged by this redesign, on purpose: it only calls
  `getAll`/`getById`/`getCountry`/`getGenres`/`getPopularity`/`getFollowers`, all of
  which kept the same names and signatures across the rewrite. That it needed zero
  changes is a decent signal the `db/` interface boundary is in the right place.
- **`scripts/sync.js`** — the *only* home for sync/orchestration logic, all folded into
  one file per Lucas's explicit instruction (not split into `syncSongs.js`/
  `syncPlaylists.js`/etc. — that earlier plan was superseded). Contains: `syncSongs()`,
  `syncPlaylists()` + raw-fetch helpers (playlist pagination, snapshot_id reconciliation,
  Liked-Songs pseudo-playlist seeding), `uniqueArtistsFromSongs()`, `resolveCountries()`
  (MusicBrainz→Wikidata cascade), `resolveIsrcFallback()`, `resolveArtistDetails()`
  (Spotify genre/popularity batch), and `main()` sequencing all of them. Updated for the
  new `db/artists.js` API: no more `.save()` (every `upsert()` persists immediately) or
  `.has()` (use `!!getById(id)` instead).
- **`sources/`** — raw external API calls, no orchestration/pagination-decision logic.
  `musicbrainz.js`, `wikidata.js` (self-contained), `spotify.js` (OAuth + token refresh;
  still has one unused raw-page helper, `getLikedSongsPage` — `scripts/sync.js` inlines
  its own `fetch` calls instead; a possible later cleanup, not currently planned).
Naming history worth knowing if it comes up again: the data-access layer went
`repositories/` (rejected, didn't describe what the files do) → `controllers/` (rejected
once it collided with the actual controller layer) → `store/` → **`db/`**, settling once
the JSON files themselves moved out into their own `data/` directory, freeing
`controllers/` for its real meaning (the `songQuery.js`-descended read-orchestration
layer). No further reorg work is open — any future refactor here is a fresh discussion.

## Quick start
```
npm install
npm start          # serves http://127.0.0.1:3000, reads local JSON only, no Spotify calls
npm run sync        # fetches new songs + resolves country/genre/popularity data
```
Must be logged in (via `/login` in the browser) before `npm run sync` will work — it
needs a valid Spotify token.

## Architecture

Current file layout is documented in full in the "Architecture reorg" section above —
this section covers what each piece *does*, not where it lives; see above for paths.

- `index.js` (top-level) — starts the server. Just `dotenv.config()` + `createServer()`
  from `server/` + `.listen()`. Deliberately this thin — Lucas's call, likes the pattern
  even though the file otherwise feels redundant.
- `server/index.js` — `createServer()`, an exportable factory: builds an `http.Server`
  wired to `routes/`'s router (dispatch wrapped in try/catch so one bad handler can't
  crash the whole process), but doesn't call `.listen()` itself — that's left to whoever
  calls it.
- `routes/index.js` — every route, built on a `find-my-way` router: static file serving
  for everything in `public/`, `/login` + `/callback` (OAuth), and the three `/api/*`
  routes, which parse query params and call straight into `controllers/songs.js` — no
  filter/aggregation logic lives here. **Reads only local files** — no live Spotify calls
  except the OAuth routes and `getValidAccessToken()`'s refresh path; nothing
  auto-triggers a backfill on startup/login (see "sync" below). One file for now (not
  split per-domain like `routes/songs.js`) — route count didn't justify it yet; revisit
  if it grows.
- `routes/utils.js` — the route-layer helpers used across `routes/index.js`:
  `getQueryParams(req)`, `sendJson(res, data)`, `serveStatic(filename, contentType)`.
- `controllers/songs.js` — all the actual `/api/songs` (filter+sort+paginate),
  `/api/filters` (distinct option lists + ranges), and `/api/stats` (dashboard
  aggregates) logic, as plain functions `getSongs()`/`getFilterOptions()`/`getStats()`
  taking/returning plain objects — no HTTP concerns. Extracted from `index.js` when it
  grew past ~290 lines of routing mixed with business logic.
- `sources/spotify.js` — OAuth (Authorization Code flow), token read/write/refresh.
- `db/tokens.js` — `data/tokens.json` (gitignored) read/write, via `get()`/`set()`.
- `db/songs.js` — pure access to `data/songs.json` (gitignored), the flat pool of every
  track seen from any source: `getAll()`, `getById(id)`, `mergeTracks(items)` (the
  shared dedupe-and-append helper, called from `scripts/sync.js` for both Liked Songs and
  playlist tracks; a batch write via `db/db.js`'s `write()`, not a per-record upsert).
- `db/playlists.js` — pure access to `data/playlists.json` (gitignored), all playlists +
  a "liked-songs" pseudo-playlist: `getAll()`, `getById(id)`, `set(playlists)` (a
  whole-collection replace — needed so deleted/unfollowed playlists can disappear, which
  a per-record upsert can't express), `LIKED_SONGS_ID`. See the dedicated Playlists
  section below.
- `db/artists.js` — pure access to `data/artists.json` (gitignored, an **array** of
  `{id, name, country, genres, popularity, followers}` records — not object-keyed by ID
  the way it used to be): `getAll()`, `getById(id)`, `getCountry`/`getGenres`/
  `getPopularity`/`getFollowers` (field-specific reads with per-field defaults),
  `upsert(id, patch)` (merges into one record, persists immediately). No orchestration —
  the resolution cascade lives in `scripts/sync.js` now (see below).
- `db/db.js` — the generic file primitive all three of the above are built on:
  `setFile(relativePath)` → `{ read, write, upsert }`. See "Architecture reorg" above for
  the full rationale.
- `sources/musicbrainz.js` — `resolveBatch()`, `lookupArtistCountry()`.
- `sources/wikidata.js` — `resolveWikidataBatch()`, `searchWikidataEntity()`,
  `lookupCountriesByQids()`.
- `utils/isrcCountry.js` — pure function, derives a country code from a track's ISRC
  prefix (no network call).
- `scripts/sync.js` — the `npm run sync` entry point, and the **only** place
  sync/orchestration logic lives (explicit design decision, folded from what was
  previously spread across `db/`'s predecessor modules): `syncSongs()`, `syncPlaylists()`,
  `uniqueArtistsFromSongs()`, `resolveCountries()` (MB→Wikidata cascade),
  `resolveIsrcFallback()`, `resolveArtistDetails()` (Spotify genre/popularity), and
  `main()` sequencing all of them: sync liked songs → sync playlists (adds any
  playlist-only tracks) → derive artist roster from local songs → resolve countries →
  ISRC fallback → resolve genres/popularity/followers.
- `public/` — vanilla DOM, no build step, no bundler — plain `<script src>` tags sharing
  one global scope (see "Frontend script split" below for load order and why that's
  safe). `index.html`, `style.css` (dark, Spotify-green accent, Inter font via Google
  Fonts), `countryCoords.js` (static ISO-code → [lon,lat] lookup, ~244 entries),
  `world.geo.json` (world country boundaries, ECharts' own test-data file, ~1MB).

## Frontend script split

`app.js` grew to ~490 lines mixing four concerns before being split (all still plain
`<script>` tags, no modules/bundler):

- `public/rangeSlider.js` — `createDualSlider()`, the hand-built dual-handle slider
  widget. No dependencies on anything else.
- `public/filters.js` — filter state variables, `filterControls` (registry of the
  built dropdown/slider DOM elements, read by `tabs.js`), formatting helpers
  (`countryLabel`, `formatDuration`, `formatDateShort`), `resetFilterState()`,
  `loadFilters()`.
- `public/songTable.js` — `LIMIT`, `offset`, `loadPage()`, `render()`.
- `public/tabs.js` — `switchTab()`, `applyDashboardFilter()` (the bridge a dashboard
  chart click uses to jump to List pre-filtered), and the tab-button click wiring.
- `public/app.js` — now just the two-line bootstrap (`loadFilters(); loadPage();`).
- `public/dashboards.js` — unchanged, still depends on `countryLabel` (filters.js) and
  `window.applyDashboardFilter` (tabs.js) being loaded first.

**Load order matters and is intentional**: `index.html` loads them
`rangeSlider.js → filters.js → songTable.js → tabs.js → countryCoords.js → app.js →
dashboards.js`. Classic (non-module) `<script>` tags on one page share a single global
scope, so a `let`/`function` declared in one file is visible in a later one — but only
functions bodies are late-bound (safe regardless of order, since they're not evaluated
until actually *called*). `app.js`'s bootstrap calls `loadFilters()`/`loadPage()`
immediately at the top level, so it's the one file that genuinely must load last among
the List-tab scripts. If you add a new cross-file top-level (not-inside-a-function)
reference, check it against this ordering — that's the one way this pattern can break.

## Dashboards tab

Second client-side tab (no new routes/pages — pure JS show/hide, matches List). Charting
library: **Apache ECharts**, loaded via CDN in `index.html` — chosen over Plotly.js
because ECharts can be fully self-hosted (Plotly's bubble-map basemap fetches from
Plotly's own CDN at runtime by default). Independent of List's active filters — always
shows whole-library stats.

- Backend: `GET /api/stats` (`index.js`) — pre-aggregates `songs.json` into
  `yearCounts`, `popularityCounts` (bucketed by 10s), `countryCounts`. Browser never has
  to pull all ~5000 song rows just to draw charts.
- Three charts (`public/dashboards.js`, lazy-loaded + cached on first tab switch):
  year histogram, popularity histogram, and a world map with a bubble per country
  (`scatter` series on `coordinateSystem: 'geo'`, positioned via `countryCoords.js`,
  radius **sqrt-scaled** to song count so bubble *area* — not radius — is proportional,
  which is what the eye actually perceives correctly).
- `world.geo.json` sourced from ECharts' own repo test data specifically so it's
  guaranteed compatible with their map renderer; `countryCoords.js` sourced from a public
  domain country-centroids GeoJSON dataset. Both are one-time static assets, not
  regenerated by any script.

## Data files (all gitignored — never commit, never delete without an explicit ask)

The three live data files below now live in **`data/`** (`data/songs.json`, etc.) —
sibling to `db/`, which holds only the access-function code, not the data itself. The
backup/legacy files listed after them (`artist-countries.json` and friends) are still at
the project root, untouched.

- `songs.json` — flat pool of **every track ever seen from any source** (Liked Songs +
  every playlist), deduped by Spotify track ID. Structurally unchanged by the playlists
  feature — playlist membership lives externally in `playlists.json`, not on the song.
  Per song: id, name, artists `[{id,name}]`, album `{name, releaseDate, albumType}`,
  addedAt (when first seen — liked-date if from Liked Songs), isrc, durationMs, explicit,
  spotifyUrl.
- `playlists.json` — array of `{id, name, ownerName, public, collaborative, snapshotId,
  tracks: [{id, addedAt}]}`. Includes a special `id: "liked-songs"` pseudo-playlist entry
  so Liked Songs shows up in the same Playlist filter dropdown as real playlists.
- `artists.json` — the **active** artist metadata cache (country/genres/popularity/followers).
- `artist-countries.json` — original pre-rename file, kept on disk untouched as a backup
  (the user explicitly asked to preserve this — it represents a lot of hard-won API work).
- `artists.json.backup-<timestamp>` — additional safety copy made before a risky edit.
- `artist-countries copy.json` — an unexplained stray file noticed mid-session; not
  created deliberately by the assistant; left untouched, flagged to the user.
- `tokens.json` — current Spotify OAuth session (access/refresh token + expiry), now in
  `data/` like the other three, read/written via `db/tokens.js`.

## Playlists (full library, not just Liked Songs)

`scripts/sync.js`'s `syncPlaylists()` syncs all of the user's playlists (owned + followed
+ collaborative), in the same `npm run sync` command as Liked Songs.

- Each playlist has a **`snapshot_id`** that changes whenever its contents change — used
  for correct incremental sync: unchanged since last sync → skipped entirely (no
  requests), changed/new → full track list re-fetched. Unlike Liked Songs' "stop at first
  known ID" trick, this correctly detects removals too, not just additions.
- Requires `playlist-read-private` + `playlist-read-collaborative` scopes (added to
  `sources/spotify.js`) — **this scope change mattered in practice, not just in theory**: the
  endpoint returned data even without the scope during initial testing (33 playlists,
  all public), but after re-authenticating with the proper scope it found **47** — 14
  private playlists had been silently invisible. Don't skip adding a scope just because
  something appears to work without it.
- **Real bug hit and fixed**: the "liked-songs" pseudo-playlist entry was first
  implemented as append-only from `syncSongs()`'s newly-discovered-this-run list. Since
  Liked Songs had already been fully synced in earlier sessions before this feature
  existed, the first run under the new code found 0 *new* songs and the pseudo-playlist
  silently ended up with **0 tracks** instead of the real ~5032. Fixed by detecting "this
  pseudo-playlist doesn't exist yet" and doing a one-time full walk of `/v1/me/tracks` to
  seed it correctly, before switching to incremental appends. Worth remembering: any
  "derive current membership from an incremental/append-only sync" design needs an
  explicit first-time full-seed path, or it silently starts from empty.
- Playlist membership lives on the **playlist** (`tracks: [{id, addedAt}]`), not the song —
  deliberately, so `songs.json` stays structurally untouched by this feature.

## Spotify API — hard-won findings

- **Two Spotify Developer apps are in play.** The current `.env` credentials are for the
  user's **older, pre-Nov-2024 app**, which is grandfathered with broader access. A newer
  app created fresh during this project has these confirmed **restrictions**:
  - `genres`, `popularity`, `followers` come back **empty/undefined** on Artist and Album
    objects.
  - **Every batch endpoint** (`/v1/artists?ids=`, `/v1/albums?ids=`, `/v1/tracks?ids=`)
    returns `403` — only single-item lookups work.
  - `/v1/audio-features/*` returns `403` **even on the old app** — this one's dead
    regardless of app age.
  - `/v1/artists/{id}/related-artists` and `/v1/recommendations` return `404` — fully
    removed from the API, not just access-gated.
  - The old app **does** support genres/popularity/followers and batch endpoints — this is
    what `runArtistDetailsBackfill` depends on.
- **Redirect URI must be the literal `127.0.0.1`**, not `localhost` — Spotify requires the
  loopback IP literal for local dev redirect URIs.
- **Rate limits are real and were hit multiple times.** Root cause was re-walking
  Spotify's full saved-tracks endpoint (~101 pages) on every server restart during
  development. Fixed by: (a) never auto-triggering full walks on startup/login, (b)
  `syncSongs()`'s incremental newest-first stop-early logic, (c) deriving the artist
  roster from local `songs.json` instead of a second Spotify walk.

## Country-of-origin pipeline (in `scripts/sync.js`'s `resolveCountries()`, cascading, cheapest-first)

Spotify has no artist-location field at all — this entire pipeline is external enrichment.

1. **MusicBrainz batched search** — Lucene `OR` query, ~15 artists/request, `User-Agent:
   Playlister/1.0` header (required by MusicBrainz), ~1.1s between requests (their rate
   limit is ~1 req/sec). Match accepted only on exact case-insensitive name + highest
   `score`. Returns `country` (ISO alpha-2) directly on ~60% of artists.
2. **MusicBrainz fallback lookup** — for a match with no `country` in the search result
   (a known MusicBrainz search-index staleness quirk), a direct per-MBID lookup often
   recovers it.
3. **Wikidata exact-match batch** — SPARQL `VALUES`-batched query (~50 artists/request),
   POST to `https://query.wikidata.org/sparql`. **Critical detail**: many real, notable
   artists (e.g. Radiohead) have **no plain `en` label** in Wikidata — matching only
   `"Name"@en` silently misses them. Fix: tag each name across `en, en-gb, en-ca, en-us,
   mul` in the `VALUES` clause (still fast/indexed). Language-agnostic `STR()` matching
   was tested and **times out** at Wikidata's scale — don't do that. Type-filtered to
   `wd:Q5` (human), `wd:Q215380` (band), `wd:Q2088357` (musical group) to avoid matching
   unrelated entities. Country via `P27` (citizenship) or `P495` (country of origin),
   resolved to ISO code via `P297`.
4. **Wikidata fuzzy search** — for names the exact-match batch still misses, e.g. due to
   accent/diacritic differences (Spotify's "Nidia Gongora" vs Wikidata's "Nidia Góngora"),
   falls back to `wbsearchentities` (Wikidata's own fuzzy/typo-tolerant search), one name
   per request (~1/sec — this endpoint doesn't support batching and threw "too many
   requests" when hit faster). Picks the entity whose label matches once accents/case are
   stripped, not just the top-ranked hit (top hit can be an unrelated concept). Found QIDs
   are then batch-looked-up for country by ID (`VALUES ?item { wd:Q1 wd:Q2 ... }` —
   ID-based matching sidesteps the accent problem entirely).
5. **ISRC fallback** (`lib/isrcCountry.js`) — first 2 letters of a track's ISRC are a
   country-of-registration code. Applied **per-song**, not per-artist (different songs by
   the same artist can have different ISRCs). Needs a `UK`→`GB` remap (ISRC-specific
   quirk) and validated via `Intl.DisplayNames` — note that `.of()` does **not** throw for
   junk codes like reserved `QM`-`QZ`, it just echoes them back, so validity is checked by
   comparing the returned label against the input code.

**Current coverage: ~3522/3823 artists resolved (92.1%)**. The remaining ~300 have
survived MusicBrainz + Wikidata exact + Wikidata fuzzy + ISRC — genuinely obscure/
independent artists absent from every free structured source tried. Went as far as
testing raw web search as a manual research option (works, e.g. found "Sunday Scaries" is
an LA duo with no Wikidata page at all) but that requires per-artist human/LLM judgment,
not a programmatic API call, so it was **not** automated — left as a manual option if ever
wanted.

**Decisions**: multi-artist songs use the **primary (first) artist's country**; genres use
the **union of all artists' genres** (genres are naturally multi-valued already, so this
is more complete than the country rule).

## Other design decisions made along the way

- Barebones philosophy: no framework, `find-my-way` router only, vanilla frontend JS.
- Dark theme, Spotify green (`#1db954`) accent, Inter font.
- Filters built: genre, decade (not individual year — 72 years was too many for a
  dropdown), country, album type, artist, plus **dual-handle range sliders** (hand-built,
  two overlaid native `<input type=range>`, no library) for duration, liked-date, and
  artist popularity. A slider dragged back to its full natural range reports "not
  filtering" rather than "filtering to the full range" — important because an active
  min/max filter on a nullable field (like popularity) would otherwise silently exclude
  every song with no value for it. "Reset filters" button clears everything at once.
- "Create Playlist" button exists in the UI toolbar (top-right, green) but is currently a
  **stub — does nothing**. Real playlist creation/export is a likely next step.
- Table columns: Name, Artist(s), Album, Year, Added, Country, Genres.

## Known bugs found & fixed (don't reintroduce)

- `find-my-way` does **not** parse query strings by default — needed manual `new
  URL(req.url, ...)` parsing.
- An uncaught exception in a route handler crashes the **entire** Node process — wrapped
  the whole request handler in try/catch.
- Binding without an explicit host defaults to IPv6-only (`::`), which failed to accept
  `127.0.0.1` connections in this WSL2 environment — bind explicitly to `'0.0.0.0'`.
- A MusicBrainz batch that failed outright (503) left its artists with **no cache entry at
  all**, which later crashed a phase that assumed every artist had one (`cache[id].country`
  on `undefined`) — fixed by backfilling missing entries as `{country: null}` after each
  batch pass.
- `Number(params.get(x)) || null` breaks for legitimately-zero values (0 is falsy) — use
  `params.has(x) ? Number(...) : null` instead.
- Spotify occasionally returns a fully-blank stub for a track it has unlisted from its
  catalog (real ID, empty name/artist/album, duration 0) — filtered out during snapshot
  build (`if (!item.track.name) continue`).

## Environment specifics

- WSL2 (Linux 5.15, Windows host). `127.0.0.1` browser access required an explicit
  `0.0.0.0` bind fix (see above) plus using `127.0.0.1` instead of `localhost` for the
  Spotify redirect URI.
- `.env` holds `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`
  (`http://127.0.0.1:3000/callback`), `PORT`. Currently pointed at the **old** app.

## Open items / natural next steps

- "Create Playlist" button is a no-op stub — wiring it up to actually build a Spotify
  playlist from the current filtered view is the obvious next feature (would need the
  `playlist-modify-private`/`playlist-modify-public` scope added to the OAuth flow).
- ~300 artists with no resolvable country from any automated source — options discussed:
  accept as the practical ceiling, manual override UI, or manual per-artist web research
  (not automatable cheaply).
- The stray `artist-countries copy.json` file's origin is still unexplained.
