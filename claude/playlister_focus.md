# Playlister — Project Focus & Living Reference

Personal local tool that pulls your **entire Spotify library** — Liked Songs plus every
playlist — into a rich, filterable, Spotify-agnostic local dataset (country of origin,
genre, popularity, decade, duration, playlist membership, etc.). Node.js, zero framework,
vanilla JS frontend, SQLite as the database. Git repo on GitHub (`lreher/playlister`).

Read this file first when picking this project back up — it has the decisions and
hard-won findings that aren't obvious from the code alone.

## Data layer: SQLite (replaced the flat-JSON `db/` design — Aug 2026)

**The JSON-file era is over.** `data/songs.json`/`artists.json`/`playlists.json`/
`tokens.json` are no longer read by the app at all — left on disk untouched (never
deleted) as a natural backup, but superseded. If you're reading old context describing
`db/db.js` (a generic JSON-file primitive), `utils/cache.js` (in-memory memoization), or
`db/*.js` methods built on those, that entire design is gone — this section replaces it.
The actual data now lives in **`data/playlister.db`**, a real SQLite database.

**Why, and the decisions made getting here** (all explicitly confirmed before building):
- **Driver: `node:sqlite`** (Node's built-in module), not `better-sqlite3`. Zero new
  dependencies — matches this project's "minimal, justified tooling" bar. Trade-off
  accepted knowingly: it's still flagged experimental in this Node version (prints an
  `ExperimentalWarning` on every process start) — the API surface could still change.
  Synchronous, like the JSON-era `db.js` was, so no ripple effect into async/await
  plumbing elsewhere.
- **Migration, not a fresh start**: `scripts/migrate-to-sqlite.js` (`npm run migrate`,
  one-time) reads the old JSON files and populates the new tables — preserves the
  country/genre/popularity enrichment (real API work, not something to casually discard).
  Idempotent (`ON CONFLICT DO NOTHING`/`INSERT OR IGNORE` throughout) and read-only
  against the JSON, so re-running it is always safe.
- **Filtering moved into real SQL**, not just a storage-format swap. `controllers/
  songs.js` used to load every song into a JS array and `.filter()` it; it now builds a
  parameterized `WHERE`/`GROUP BY`/`LIMIT ... OFFSET` query per request. This is the
  reason the schema below has a view + a registered SQL function, not just plain tables.

**Schema** (`db/database.js`, `CREATE TABLE IF NOT EXISTS` — safe to require multiple
times, e.g. from both the server and `scripts/sync.js`):
```
artists(id PK, name, country, popularity, followers, details_resolved)
artist_genres(artist_id, genre)                         -- many-valued
songs(id PK, name, album_name, album_release_date, album_type,
      added_at, isrc, duration_ms, explicit, spotify_url)
song_artists(song_id, artist_id, position)                -- position 0 = primary
playlists(id PK, name, owner_name, public, collaborative, snapshot_id)
playlist_tracks(playlist_id, song_id, added_at)
tokens(id=1, access_token, refresh_token, expires_at)        -- singleton row
```
- `details_resolved` (on `artists`) replaces the old JSON-era `'genres' in artist`
  existence check — a real SQL row always "has" every column (just possibly `NULL`), so
  there's no way to tell "never resolved" from "resolved to genuinely empty" without an
  explicit flag. Set to `1` whenever an `upsert()` patch includes `genres` or
  `popularity` (they only ever arrive together, from the one Spotify details pass).
- **No `PRAGMA foreign_keys`** — deliberately left off (SQLite's own default). Artist
  resolution is a separate, later pass from song ingestion, same relationship the JSON
  files had; a `song_artists` row can reference an artist not yet resolved, and every
  read is a `LEFT JOIN` that just produces `NULL` until it is.
- **`song_details` view** — computes what used to be read-time JS derivations
  (`songCountry`/`songYear`/`songDecade`) as real SQL, joining in the primary artist's
  `country`/`popularity`/`followers` and computing `year`/`decade` from
  `album_release_date` via `substr()`. `country` is
  `COALESCE(primary_artist.country, isrc_country(song.isrc))` — `isrc_country` is
  `utils/isrcCountry.js`'s existing pure function, registered as a real SQL function via
  `db.function('isrc_country', fn)` (proved working in isolation before relying on it:
  a registered function referenced inside a view, queried later — including through
  `COALESCE` returning `NULL` correctly — works fine on this Node version, using the
  2-argument form; a 3-arg `{ deterministic: true }` options form does **not** work here,
  throws `TypeError`). This means country/year/decade are always live-computed, matching
  the old semantics exactly — no denormalized copy on the song row to keep in sync
  whenever an artist's country gets resolved later.
- Genre and playlist filters are `EXISTS` subqueries in `controllers/songs.js`, not view
  columns — both are many-valued (a song can match on any of several artists' genres, or
  need checking against one specific playlist), which doesn't fit a flat view row.
- Artist display names (`"A, B, C"`) and a song's full genre set are per-row correlated
  subqueries using `GROUP_CONCAT` — proved two specific patterns work on this SQLite
  build before relying on them: `GROUP_CONCAT` respects the order of an `ORDER BY`'d
  subquery fed into it (needed so the primary artist stays first in the displayed list),
  and `GROUP_CONCAT(DISTINCT ...)` correctly dedupes (needed since genres repeat across
  a song's artists).

**Real bug caught by verification, not by inspection**: the first migration run crashed
with a `NOT NULL constraint failed: artists.name` — two orphaned entries in the old
`artists.json` (referenced by zero actual songs) had `name: null`, a leftover from before
`mapTrack` started filtering null-named track artists. Fixed by coalescing to `''` during
migration (matching a sibling entry that already legitimately had `""`) rather than
crashing or silently dropping the rows.

**`db/songs.js`, `db/artists.js`, `db/playlists.js`, `db/tokens.js`** — kept the exact
same exported function names/signatures as the JSON era (`getAll`/`getById`/
`mergeTracks`/`upsert`/`set`/`get`/`set`), now backed by prepared statements against
`db/database.js`'s connection instead of file reads. `mergeTracks` (in `db/songs.js`) now
also stub-creates a minimal `artists` row (`id`+`name` only) for every artist it sees on
a new song — this is new behavior versus the JSON era, and it's what let
`scripts/sync.js` drop its old `uniqueArtistsFromSongs()` helper entirely: every artist
already has a row by the time `resolveCountries()`/`resolveArtistDetails()` run, so the
roster is just `artistsDb.getAll()` directly, no separate derivation from songs needed.

**Query-building boundary**: `controllers/songs.js` builds and runs its own SQL directly
against `db/database.js`'s connection + the `song_details` view for `getSongs`/
`getFilterOptions`/`getStats` — this is deliberate, not a layering violation. Which query
param maps to which `WHERE` clause is business logic (always lived in `controllers/`,
just expressed as JS `.filter()` calls before); `db/songs.js` stays focused on what's
genuinely reusable data-access (`getById`, and the two write operations with real
business rules — dedup, whole-collection-replace).

**Verified thoroughly, not just spot-checked**: before migrating, ground-truth baseline
numbers were captured by requiring the *old* (pre-rewrite) `controllers/songs.js` +
`db/*.js` straight from git history and running them against the real JSON — not
re-derived by hand, the actual old logic. Every number matched post-migration:
totals, all seven filter-option list lengths + three ranges, all five stats aggregate
lengths, four different single-filter counts, one combined-filter count, and one full
song object compared field-by-field — then the same checks repeated a third time through
the live HTTP server. `data/playlister.db` and any future `.db-*` SQLite sidecar files
fall under the existing blanket `data/` gitignore entry, no `.gitignore` change needed.

Naming history worth knowing if it comes up again: the data-access layer went
`repositories/` (rejected, didn't describe what the files do) → `controllers/` (rejected
once it collided with the actual controller layer) → `store/` → **`db/`**, settling once
the JSON files themselves moved out into their own `data/` directory, freeing
`controllers/` for its real meaning (the `songQuery.js`-descended read-orchestration
layer).

## Quick start
```
npm install
npm run build        # bundles client/ into static/bundle.js (npm run watch to rebuild on save)
npm start             # serves http://127.0.0.1:3000, reads local JSON only, no Spotify calls
npm run sync           # fetches new songs + resolves country/genre/popularity data
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
  for everything in `static/` (via `routes/static.js`), `/login` + `/callback` (OAuth),
  and the three `/api/*` routes, which parse query params and call straight into
  `controllers/songs.js` — no filter/aggregation logic lives here. **Reads only local
  files** — no live Spotify calls except the OAuth routes and
  `getValidAccessToken()`'s refresh path; nothing auto-triggers a backfill on
  startup/login (see "sync" below). One file for now (not split per-domain like
  `routes/songs.js`) — route count didn't justify it yet; revisit if it grows.
- `routes/utils.js` — route-layer helpers shared across route *types*:
  `getQueryParams(req)`, `sendJson(res, data)`.
- `routes/static.js` — static-file serving, split out of `routes/utils.js` on purpose
  (a `utils.js` is for genuinely cross-cutting helpers, not a dumping ground for
  whatever got extracted — `serveStatic` is single-purpose, so it gets its own file).
  `STATIC_FILES` (`world.geo.json`, `bundle.js`, `bundle.css`) + a MIME-type map keyed by
  extension + `registerStaticRoutes(router)`. Separately, `APP_ROUTES` (`/`, `/dashboards`)
  each serve `index.html` — real server routes needed so a direct load/refresh of e.g.
  `/dashboards` works, not just clicking there from within the app; `App.jsx` reads
  `window.location.pathname` on mount to pick the initial tab, and calls
  `history.pushState` on every tab switch (plus a `popstate` listener for back/forward).
  Serves out of `static/`, not `public/` (see "Client architecture" below).
- `controllers/songs.js` — all the actual `/api/songs` (filter+sort+paginate),
  `/api/filters` (distinct option lists + ranges), and `/api/stats` (dashboard
  aggregates) logic, as plain functions `getSongs()`/`getFilterOptions()`/`getStats()`
  taking/returning plain objects — no HTTP concerns. Extracted from `index.js` when it
  grew past ~290 lines of routing mixed with business logic.
- `sources/spotify.js` — OAuth (Authorization Code flow), token read/write/refresh.
- `db/database.js` — the SQLite connection + schema, everything else in `db/` is built
  on it. See "Data layer: SQLite" above for the full rationale.
- `db/tokens.js` — the OAuth token singleton row, via `get()`/`set()`.
- `db/songs.js` — `getAll()`, `getById(id)`, `mergeTracks(items)` (the shared dedupe-
  and-append helper, called from `scripts/sync.js` for both Liked Songs and playlist
  tracks — also stub-creates a minimal `artists` row for any new artist it sees).
- `db/playlists.js` — `getAll()`, `getById(id)`, `set(playlists)` (a whole-collection
  replace — needed so deleted/unfollowed playlists can disappear, which a per-record
  upsert can't express), `LIKED_SONGS_ID`. See the dedicated Playlists section below.
- `db/artists.js` — `getAll()`, `getById(id)`, `getCountry`/`getGenres`/`getPopularity`/
  `getFollowers` (field-specific reads with per-field defaults), `upsert(id, patch)`
  (shallow-merges into one record, persisted immediately). No orchestration — the
  resolution cascade lives in `scripts/sync.js` now (see below).
- `sources/musicbrainz.js` — `resolveBatch()`, `lookupArtistCountry()`.
- `sources/wikidata.js` — `resolveWikidataBatch()`, `searchWikidataEntity()`,
  `lookupCountriesByQids()`.
- `utils/isrcCountry.js` — pure function, derives a country code from a track's ISRC
  prefix (no network call). Also registered as a real SQL function
  (`db/database.js`'s `isrc_country`) for the `song_details` view to use directly.
- `scripts/sync.js` — the `npm run sync` entry point, and the **only** place
  sync/orchestration logic lives (explicit design decision, folded from what was
  previously spread across `db/`'s predecessor modules): `syncSongs()`, `syncPlaylists()`,
  `resolveCountries()` (MB→Wikidata cascade), `resolveIsrcFallback()`,
  `resolveArtistDetails()` (Spotify genre/popularity), and `main()` sequencing all of
  them: sync liked songs → sync playlists (adds any playlist-only tracks) → resolve
  countries for every artist on record (already fully populated by this point via
  `mergeTracks`'s stub-creation, no separate roster-derivation step needed) → ISRC
  fallback → resolve genres/popularity/followers.
- `static/` — served, built output + static assets: `index.html` (hand-authored — just a
  `<div id="root">` + Google Fonts/ECharts CDN tags + `bundle.js`/`bundle.css`),
  `world.geo.json` (world country boundaries, ECharts' own test-data file, ~1MB),
  `bundle.js`/`bundle.css` (esbuild output, **gitignored** — build artifacts, not
  source; see "Client architecture" below for where the CSS source actually lives —
  `client/index.css` plus each chart's own colocated `colors.css`).
- `client/` — the SPA source. See "Client architecture" below.

## Client architecture (Preact + esbuild — replaced the vanilla `public/` setup)

The old `public/*.js` plain-`<script>` setup (six files sharing one global scope,
order-dependent) is **gone** — full SPA rewrite. Decisions made getting here, in order:

- **Framework**: Preact (~4kb, React-compatible hooks/component API) — "lightest possible
  React." Considered Svelte/Vue/React first; Preact won once a build step was accepted.
- **Build tool**: esbuild, not Vite — explicitly rejected Vite for being more machinery
  than needed here. No dedicated build script either — the whole build is one esbuild CLI
  invocation as an npm script (`jsx: automatic`, `jsx-import-source: preact`, no plugin
  needed for JSX).
- **One `package.json`** — no separate `client/package.json`. It's one app; `esbuild`/
  `preact` live alongside the backend's `dotenv`/`find-my-way`.
- **Dev workflow**: no second dev server/proxy. `npm run watch` rebuilds `static/bundle.js`
  on save; the existing Node backend serves it like any other static file. Manual browser
  refresh after a save, not live-reload — a deliberate trade-off (esbuild has no built-in
  HMR) accepted for this app's size.
- npm scripts: `npm start` (run the app), `npm run build` (one-shot minified bundle),
  `npm run watch` (rebuild on save).

**Directory shape** — `components/` holds only genuinely reusable primitives;
`pages/` holds page-specific composition; nothing in `components/` knows about songs,
artists, or "filters" as a domain:

```
client/
  App.jsx          # shell: tab state (list/dashboards), dispatches to pages/
  api.js            # fetch wrappers: getFilters(), getSongs(), getStats(), getWorldGeoJson()
  index.jsx          # entry: render(<App/>, #root)
  utils/format.js      # countryLabel, formatDuration, formatDateShort
  themes/
    globalTheme.js      # base palette, kept in sync by hand with style.css's :root
    chartTheme.js         # globalTheme + chart-only `emphasis` + baseChartOption()
  components/
    charts/               # generic echarts primitives, no domain knowledge
      BarChart/, WorldMap/
    filters/                # generic input primitives, no domain knowledge
      OptionsSelect/ (dropdown), OptionsSearch/ (datalist-backed free-text search,
      constrained to known values), RangeSlider/ (dual-handle native range inputs)
  pages/
    dashboards/               # everything dashboards-specific lives here
      index.jsx                 # fetches /api/stats once, renders the 5 charts below
      YearBarChart/, DecadeBarChart/, LikedBarChart/, PopularityBarChart/  # each: shapes
        its slice of stats into BarChart's categories/values + its onClickCategory
      CountryMap/                # shapes countryCounts into WorldMap's points via
        countryCoords.js (ISO code → [lon,lat], colocated here — CountryMap-only data,
        not a generic chart concern, so it doesn't live in components/charts/)
    songList/
      index.jsx                  # renders Filters + SongTable
      Filters/                    # filter row: fetches /api/filters, owns filter-state
        shape (EMPTY_FILTERS), composes the components/filters/ primitives
      SongTable/                   # paginated table, re-fetches on filters/offset change
```

**Patterns worth knowing**:
- **Controlled vs. uncontrolled inputs**: dropdowns are controlled (`value={filters.x}`)
  because a dashboard chart click can set them from outside — Preact just re-renders them
  to match, no manual DOM sync needed (the vanilla version needed exactly that hack).
  `OptionsSearch` and `RangeSlider` are deliberately uncontrolled (refs) — forcing a value
  prop onto free-typing text or a mid-drag range input would fight the native element.
  They reset via a `key={resetToken}` remount trick on "Reset filters" instead.
- **Dashboards mount lazily, once**: `App.jsx` only renders `<Dashboards/>` after the tab's
  been visited the first time, and never unmounts it after — matches the old lazy-load-
  once-then-cache behavior, avoids re-fetching `/api/stats` or re-initializing echarts
  instances on every tab switch.
- **One real theme default, not five accidental copies**: chart color used to be a
  `COLOR`/`EMPHASIS_COLOR` const duplicated identically in all five dashboard files —
  looked configurable but wasn't really, since nothing ever diverged. Now `BarChart`/
  `WorldMap` default `color`/`emphasisColor` from `themes/chartTheme.js`; a dashboard file
  only declares its own override when it actually wants to differ from the shared theme.

## Dashboards tab

Second client-side tab (no new routes/pages — pure JS show/hide, matches List). Charting
library: **Apache ECharts**, loaded via CDN in `index.html` — chosen over Plotly.js
because ECharts can be fully self-hosted (Plotly's bubble-map basemap fetches from
Plotly's own CDN at runtime by default). Independent of List's active filters — always
shows whole-library stats.

- Backend: `GET /api/stats` (`controllers/songs.js`'s `getStats()`) — pre-aggregates via
  SQL `GROUP BY` into `yearCounts`, `popularityCounts` (bucketed by 10s), `countryCounts`.
  Browser never has
  to pull all ~5000 song rows just to draw charts.
- Five charts (`client/pages/dashboards/`, lazy-loaded + cached on first tab switch — see
  "Client architecture" above): year/decade/liked-date/popularity histograms via the
  shared `BarChart` primitive, and a world map with a bubble per country via `WorldMap`
  (`scatter` series on `coordinateSystem: 'geo'`, positioned via `countryCoords.js`,
  radius **sqrt-scaled** to song count so bubble *area* — not radius — is proportional,
  which is what the eye actually perceives correctly).
- `world.geo.json` sourced from ECharts' own repo test data specifically so it's
  guaranteed compatible with their map renderer; `countryCoords.js` sourced from a public
  domain country-centroids GeoJSON dataset. Both are one-time static assets, not
  regenerated by any script.

## Data files (all gitignored — never commit, never delete without an explicit ask)

- `playlister.db` — the live SQLite database, **the actual source of truth now**. See
  "Data layer: SQLite" above for the full schema.
- `songs.json`, `artists.json`, `playlists.json`, `tokens.json` — the pre-SQLite era's
  files. **No longer read by the app at all** — left on disk untouched as the natural
  backup `scripts/migrate-to-sqlite.js` migrated from, not deleted. Kept for the same
  reason `artist-countries.json` was: real, hard-won API work, not something to discard
  casually.
- `artist-countries.json` — original pre-rename file, kept on disk untouched as a backup
  (the user explicitly asked to preserve this — it represents a lot of hard-won API work).
- `artists.json.backup-<timestamp>` — additional safety copy made before a risky edit.
- `artist-countries copy.json` — an unexplained stray file noticed mid-session; not
  created deliberately by the assistant; left untouched, flagged to the user.

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
- Playlist membership lives on the **playlist** (the `playlist_tracks` table), not the
  song — deliberately, so the `songs` table stays structurally untouched by this feature.

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
  roster from what's already stored locally instead of a second Spotify walk — originally
  a `songs.json` derivation step, now free: `db/songs.js`'s `mergeTracks` stub-creates
  every artist's row as songs come in, so `artistsDb.getAll()` already *is* the roster.

## Country-of-origin pipeline (in `scripts/sync.js`'s `resolveCountries()`, cascading, cheapest-first)

Spotify has no artist-location field at all — this entire pipeline is external enrichment.

1. **MusicBrainz batched search** — Lucene `OR` query, ~15 artists/request, `User-Agent:
   Playlister/1.0` header (required by MusicBrainz), ~1.1s between requests (their rate
   limit is ~1 req/sec). Match accepted only on exact case-insensitive name + highest
   `score`. Returns `country` (ISO alpha-2) directly on ~60% of artists.
2. **MusicBrainz fallback lookup** — for a match with no `country` in the search result
   (a known MusicBrainz search-index staleness quirk), a direct per-MBID lookup often
   recovers it.
   - **503 resilience** (`sources/musicbrainz.js` + `resolveCountries()`): a `503`
     specifically (MusicBrainz overloaded/rate-limiting, not a hard failure) gets retried
     up to 3x with exponential backoff (2s→4s→8s) inside `musicbrainz.js` before
     surfacing — other statuses (4xx etc.) fail immediately, retrying wouldn't fix those.
     `resolveCountries()`'s circuit breaker trips after **10 total 503s seen** across a
     run (search batches and fallback lookups share one breaker) — **cumulative, not
     consecutive call failures**. That distinction was a real bug caught live: under
     sustained load, almost every individual call recovers within 1-2 retries, so counting
     only calls that fully fail never trips at all — every "successful" call still burned
     a 503 first, invisible to a consecutive-failure counter. Fixed by having
     `musicbrainz.js` report *every* 503 it sees via an `onRetry` callback, recovered or
     not, so the breaker sees the true rate of distress. Once tripped, MusicBrainz stops
     getting called for the rest of that sync run; skipped artists already have a
     `{country: null}` cache entry via the existing backfill step, so they fall straight
     into the Wikidata cascade below instead of wasting requests. No cross-run state —
     next `npm run sync` retries MusicBrainz fresh for anything still unresolved.
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
- **`OptionsSelect`'s `valueOf` prop silently never used its default, crashing every
  select except the one (playlist) that passed a custom `valueOf` explicitly.** Root
  cause: `valueOf` is inherited from `Object.prototype` on every plain object, so
  `props.valueOf` is never `undefined` — `{ valueOf = (o) => o } = props` never actually
  falls back to the default, it silently binds `valueOf` to the real, native
  `Object.prototype.valueOf`. Calling that as a bare function (`valueOf(option)`, not
  `option.valueOf()`) throws `TypeError: Cannot convert undefined or null to object` —
  `Object.prototype.valueOf` does `ToObject(this)` internally, and a bare call in
  strict-mode/ESM code has `this === undefined`. Symptom was confusing: reported as
  "Dashboards is broken," but the crash was entirely inside the always-mounted List tab's
  `Filters` component — clicking the Dashboards tab just forced a re-render of the whole
  (unmemoized) `SongList` subtree too, and Preact aborts a whole render pass on a thrown
  error, so `Dashboards` itself never even got a chance to render. Fixed by renaming the
  prop to `keyOf` in `components/filters/OptionsSelect` and its one customized caller (the
  playlist select in `pages/songList/Filters`). Lesson for any future prop/parameter name:
  never name a destructured-default parameter after an `Object.prototype` member
  (`valueOf`, `toString`, `constructor`, `hasOwnProperty`, etc.) — the default silently
  never applies.

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

## Roadmap (declared, not yet started unless noted)

- **Client code cleanup** — **done**. Full Preact + esbuild SPA rewrite, see "Client
  architecture" above.
- **Move to SQLite** — **done**. See "Data layer: SQLite" above.
