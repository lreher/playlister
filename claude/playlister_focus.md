# Playlister — Project Focus & Living Reference

Personal tool that pulls your **entire Spotify library** — Liked Songs plus every
playlist — into a rich, filterable, Spotify-agnostic dataset (country of origin, genre,
popularity, decade, duration, playlist membership, etc.). Node.js, zero framework,
Preact frontend (no build-heavy bundler, esbuild only), SQLite as the database. Git repo
on GitHub (`lreher/playlister`), deployed and live at `playlister.lucasreher.com`
(DigitalOcean droplet + Cloudflare Tunnel — see "Deployment"), still fully runnable
locally too (`npm start`).

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

- `index.js` (top-level) — starts the server. Just `dotenv.config()` + `createServer()`
  from `server/` + `.listen()`. Deliberately this thin — Lucas's call, likes the pattern
  even though the file otherwise feels redundant.
- `server/index.js` — `createServer()`, an exportable factory: builds an `http.Server`
  wired to `routes/`'s router (dispatch wrapped in try/catch so one bad handler can't
  crash the whole process), but doesn't call `.listen()` itself — that's left to whoever
  calls it.
- `routes/index.js` — every route, built on a `find-my-way` router: static file serving
  for everything in `static/` (via `routes/static.js`), `/login` + `/callback` (OAuth,
  **only registered when `ENABLE_LOGIN=true`** — see "Deployment" below for why), and
  the three `/api/*` routes, which parse query params and call straight into
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

## List tab pagination

`client/components/Pagination/index.jsx` — a third tier alongside `components/charts/`
and `components/filters/`: a genuinely generic primitive, not tied to songs. Truncated
page-number bar (`1 … 61 62 63 … 125`) rendered below the table, separate from the
existing Previous/Next buttons in the toolbar above (both coexist, not a replacement).
Works directly off `offset`/`limit`/`total` — the exact shape `SongTable` already
tracked — so the caller never has to convert to/from a page-number concept.

- **Fixed-width sliding window, not a shrinking one.** The window of visible page numbers
  around the current page is always exactly `siblingCount * 2 + 1` wide, sliding toward
  whichever edge it's near instead of just clamping and getting visibly narrower there —
  Lucas caught the shrinking version as a real bug ("I want the size to always be
  fixed no matter location"), not a style preference. Proved the fix with an isolated
  test sweeping every page position from 1 to 125 before trusting it.
  `siblingCount` itself is computed from available width (see next point), not passed
  in — `buildPageList(current, pageCount, siblingCount)` is the pure, testable piece;
  `computeSiblingCount()`/`useAvailableSiblingCount()` are the width-measuring wrapper
  around it.
- **Width-driven, not a fixed sibling count.** Targets 80% of the *content column's*
  width specifically (`Math.min(window.innerWidth, 1400)`, matching `#app`'s own
  max-width) rather than the raw viewport — otherwise on a wide monitor the pagination
  bar could end up visibly wider than the table sitting right above it. Recomputes on
  window resize. Uses an approximate fixed px-per-button estimate rather than real DOM
  measurement (a `ResizeObserver` + actual `getBoundingClientRect()` would be more
  precise) — deliberately not built that precisely; being off by one button is not a bug
  worth the extra machinery here.
- The current page renders via `.pagination-page.active:disabled` — deliberately *more*
  specific than the existing `.page-button:disabled` rule (`disabled` is how "this page
  is already selected" is expressed, but it should read as "you are here," not "this is
  unavailable," which is what plain `:disabled` styling means everywhere else in the app).

## Events tab

Third tab alongside List/Dashboards — `client/pages/events/index.jsx`, a deliberate stub
("just an empty page with a big TBD in the middle," Lucas's own words) added specifically
to be a real, visible test case for `npm run deploy` the first time that pipeline existed
— see the caching incident under Deployment above, which is exactly what this rollout
surfaced. No real feature defined yet; see Open items below.

The "TBD" text has a CSS-only animation (`client/pages/events/style.css`) — went through
several rounds before landing: a colored `text-shadow` glow (too much, wrong color
entirely — reverted to the original muted grey) → a smooth `filter: brightness()` pulse
→ a dense multi-stop "neon flicker" (too fast/jarring) → today's version: a *slow* (9s),
smooth (`ease-in-out`), *unevenly*-timed wander between full brightness and 0.7, using
irregularly-spaced keyframe stops rather than a perfect sine wave to read as organic
rather than mechanical, with no true randomness (CSS keyframes can't do that) needed to
sell the effect. Several fast rounds on a purely aesthetic call like this is normal and
expected — cheap to try, cheap to redo, not worth over-clarifying upfront the way an
architectural decision would be.

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

## Multi-tenancy (Aug 2026 — built, not yet deployed)

Converted from single-tenant (one global dataset, Lucas's own) to multi-tenant: any
visitor connects their own Spotify account and gets their own private library/
dashboards, fully separate from everyone else's. Decided after several rounds (see
musings.md's decision-making pattern) — genuinely "anyone can use this," not just
write-access to Lucas's data. Login is now required for **everyone**, including Lucas —
the old "no auth for v1, anyone can view" stance (see Deployment below) is superseded.
Staying in **Spotify Development Mode** (25-user manual allowlist in the Spotify
Developer Dashboard) — no Extended Quota Mode review, no privacy policy needed for this.

**Core design insight**: `artists`/`artist_genres`/`songs`/`song_artists` stay fully
global/shared across every user — this is the expensive, hard-won enrichment cache
(country/genre/popularity resolution), and it's per-*artist* truth, not per-user, so
duplicating it per user would be both wasteful and pointless. Only the
membership/identity layer is scoped: a song belongs to a user if it's in one of *their*
playlists (owned, followed, or their own Liked Songs). `playlist_tracks` itself also
stays global (keyed by `playlist_id` only) — a real playlist's track list is the same
objective content no matter who's looking at it, same reasoning as artists/songs. The
one exception is the Liked Songs pseudo-playlist, which isn't a real shared Spotify
entity — its id is now `` `liked-songs:${userId}` `` (was a single global constant) so
two users' liked-songs content can never collide in the shared `playlist_tracks` table.

**Schema** (`db/database.js`): new `users(id, display_name, sync_status, sync_error,
created_at)`. `tokens` changed from a singleton (`id=1`) to `user_id`-keyed. `playlists`
gained a **composite `(id, user_id)` primary key**, not just a bolted-on column — a real
Spotify playlist can be followed by more than one Playlister user (e.g. two people both
follow the same collaborative playlist); a single-column `id` PK would let the second
user's sync silently steal that row's ownership from the first. `PRAGMA journal_mode =
WAL` also turned on — background per-user syncs are now a routine concurrent event
(someone syncing while someone else browses), unlike before when the only writer was
ever a single foreground CLI script.

**Sessions** (`sources/session.js`, new): hand-rolled, not a new dependency — Playlister
is both sole writer and sole reader of exactly one cookie whose value it fully controls,
which is what makes the usual cookie-parsing fiddliness not really apply here. Signed
with `crypto.createHmac('sha256', SESSION_SECRET)` (new `.env` var), verified via
`crypto.timingSafeEqual`. Spotify OAuth **is** the login — no separate password/email
system, since every visitor already completes Spotify's own consent screen. Also added
an OAuth `state` param (`/login` mints it into its own short-lived cookie, `/callback`
verifies it matches) — cheap CSRF protection now that login is the sole gate into the
whole app.

**`controllers/songs.js`** — every query now goes through a mandatory
`visibleToUser(songIdColumn)` EXISTS-join through `playlist_tracks`/`playlists` scoped
to the calling user, applied unconditionally (not just when an explicit filter is set).
This turned out to be the single largest piece of surgery in the whole change:
`getFilterOptions`/`getStats` needed the *same* scoping as `getSongs`, not just the song
rows — otherwise a user's genre/artist/country dropdowns and dashboard stats would leak
other users' library composition even with individual songs hidden. The existing
`?playlist=` filter also needed to start joining through `playlists.user_id`, not just a
bare `playlist_tracks.playlist_id` check — once the same real `playlist_id` can
legitimately belong to more than one user's `playlists` row, an unscoped check is a
cross-tenant leak vector. **Verified directly, not just reasoned about**: seeded a
synthetic second user sharing one song with Lucas's real 6214-song library and confirmed
`/api/songs`/`/api/filters`/`/api/stats` each correctly showed only that one song for
the second user (and Lucas's own `total` stayed unaffected at 6214), including
confirming the `?playlist=` cross-tenant leak scenario specifically returns 0.

**Real bug caught mid-implementation, not by inspection**: `scripts/sync.js`'s
`syncSongs()` had a "stop paginating once I hit an already-known song ID" optimization
that checked the **global** `songs` table — correct in a single-tenant world, silently
wrong once `songs` became a shared cache. A brand-new user's own liked-songs walk would
stop the moment it hit any track ID some *other* user had already synced, even though
that user had synced nothing yet — and since the Liked-Songs seeding path
(`fetchAllLikedTrackIds`) writes `playlist_tracks` rows without calling `mergeTracks`,
those skipped songs would end up with membership rows pointing at `song_id`s missing
from `songs` entirely: invisible in `song_details`, no error, just a silently smaller
library than the user actually has. Fixed by scoping the stop-early check to *this
user's own* Liked-Songs membership (`getUserLikedSongIds(userId)`) instead of the global
table — correctly walks a brand-new user's full history on first sync (their own scope
starts empty) while still skipping redundant work on later re-syncs.

**Background sync**: no queue library — 25-user Development-Mode cap, one
systemd-managed process, a real job queue would be more machinery than this warrants.
Triggered server-side right after `/callback`, not manually — `sync_status` lives on the
`users` row (not in memory) specifically so a systemd restart mid-sync doesn't leave a
user's frontend polling forever against nothing; `server/index.js` calls
`syncQueue.recoverStuckSyncs()` once at boot to flip any interrupted `'syncing'` user to
`'error'`. `npm run sync` still exists for Lucas's own manual/maintenance use but now
takes a required `<spotifyUserId>` argument (prints known users if omitted).

**Split into two independent queues (`sources/syncQueue.js`), not one** — added after
Lucas flagged that a brand-new user shouldn't have to wait through country resolution
before seeing their own library. `scripts/sync.js`'s `runFullSync` split into
`runFastSync(userId)` (songs/playlists/ISRC fallback — bounded by Spotify pagination
speed alone, no artificial delay anywhere in it) and `runEnrichment(accessToken)`
(country + genre/popularity resolution — deliberately rate-limited against MusicBrainz/
Wikidata, can run for minutes against a brand-new user's never-before-seen artists).
`sync_status` flips to `'done'` — unblocking the UI — the moment `runFastSync` finishes;
`runEnrichment` is enqueued right after but never touches `sync_status` again, so songs
just show up with blank country/genre until it catches up (already-tolerated: nullable
fields, no error state needed). Two *separate* module-level promise-chain queues, not
one shared one: if enrichment stayed on the same queue as fast sync, a second user's
login would get stuck waiting behind the first user's slow enrichment pass — the whole
point of the split only holds if login latency is decoupled from enrichment latency.
Each queue still serializes its own kind of work across users, protecting the relevant
shared rate limit (Spotify's app-level limit for the fast queue, MusicBrainz/Wikidata's
for the enrichment queue) from two users' work overlapping. `runFullSync` still exists,
running both phases back-to-back synchronously, for the manual CLI path where waiting is
expected. **Verified live**: enqueued a real sync for Lucas's own (already-synced) user
and confirmed via direct polling that `sync_status` flipped to `'done'` in ~3.5s, with
the log showing `resolveCountries` only starting to run *after* that flip — the fast
path genuinely doesn't wait on enrichment.

**Migration for the pre-existing single-tenant data**
(`scripts/migrate-to-multi-tenant.js`, `npm run migrate-multi-tenant`): renames the
old-shaped `tokens`/`playlists` tables out of the way *before* `db/database.js` is ever
required in that process (its `CREATE TABLE IF NOT EXISTS` calls silently no-op against
tables that already exist under the same name, regardless of shape — SQLite doesn't diff
schemas), then re-creates them fresh in the new shape and copies the data across,
re-keying the Liked-Songs pseudo-playlist. **Two real bugs caught by actually running it
against a backed-up copy of the real local database**, not just by review:
- The script originally used the stored `access_token` directly to call `GET /v1/me` —
  failed immediately with a 401, since access tokens expire after an hour and this is a
  deferred one-time operation almost guaranteed to run against a stale one. Fixed by
  unconditionally refreshing via the stored `refresh_token` first.
- The idempotency/resume guard originally checked whether `tokens` had a `user_id`
  column to decide "already migrated" — but `db/database.js`'s schema-creation runs (and
  creates a fresh, *empty* new-shaped `tokens`) the moment it's first required in the
  process, regardless of whether the data-copy step that follows ever succeeds. After
  the 401 above crashed the first run partway through, a naive re-run reported "already
  migrated" against those empty tables while the real data was still sitting untouched in
  `tokens_old`. Fixed by keying the guard on whether `tokens_old` still exists (the real
  signal the final `DROP TABLE` step never completed), not on `tokens`'s shape.

Run and verified against Lucas's own real local data (backed up first): 6214 songs, 48
playlists, all correctly attached to his real Spotify user id, Liked Songs correctly
re-keyed, re-run correctly reports "already migrated" and no-ops. **Not yet run against
the droplet's live database** — needs the same treatment (backup, run once by hand over
SSH, verify) before this ships, per the Deployment section's migration-first pattern.

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
5. **ISRC fallback** (`utils/isrcCountry.js`) — first 2 letters of a track's ISRC are a
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
  (`http://127.0.0.1:3000/callback`), `PORT`, `ENABLE_LOGIN` (`true` locally — see
  "Deployment" below). Currently pointed at the **old** app.

## Deployment (Aug 2026 — live)

Decided, not yet built (except where marked done): a **DigitalOcean droplet** (real
persistent disk — the whole point of the SQLite migration was a real file on disk, which
rules out most serverless/PaaS platforms that wipe local disk on every redeploy) exposed
via **Cloudflare Tunnel** (free; no inbound port opened on the droplet at all, automatic
TLS, hides the origin IP). Cloudflare itself was considered and rejected *as the host* —
their compute products (Workers, Pages Functions) are serverless/edge, no persistent
local filesystem, wrong shape for a long-running `http.createServer` process writing to a
local SQLite file. It's still useful, just for the tunnel/TLS layer, not compute.

**Superseded by the Multi-tenancy section above (Aug 2026).** The original v1 call —
no auth needed, song library/dashboard data can be public since it's read-only and
there's only one global dataset — held as long as that was true. It no longer is: every
route now requires a real per-user session, including for Lucas's own data. Left below
for the historical reasoning (still relevant to why `ENABLE_LOGIN` existed at all before
real sessions did).

~~Explicit call: no auth for v1.~~ Lucas doesn't care about the song library/dashboard
data itself being public — anyone with the URL can view it. The one thing that *does*
need guarding is anything that could **mutate** state with no per-visitor session to
scope it to (this app has exactly one global dataset, one global stored token — no
multi-tenancy at all).

- **Superseded (Aug 2026)**: `ENABLE_LOGIN` is gone entirely — `/login`/`/callback` are
  now always-registered core routes with real per-user sessions behind them (see the
  Multi-tenancy section above), which is a strictly stronger fix for the same underlying
  problem this flag existed to solve (a stranger clobbering shared state with no session
  to scope their action to). Original reasoning kept below for context.

  ~~**Done**: `/login`/`/callback` gated behind `ENABLE_LOGIN`~~ (unset/false by default,
  `routes/index.js`) — without it, those two routes aren't registered at all, not
  hidden/403'd. Reasoning: `/callback` calls `exchangeCodeForTokens()`, which overwrites
  the single stored token row unconditionally; with no per-visitor session, anyone who
  visited `/login` and completed their *own* Spotify consent would silently clobber the
  real stored token — no data leak (nothing of Lucas's gets exposed), but a real
  "stranger can break my own sync" problem. Audited the rest of the surface at the same
  time: the three `/api/*` routes only ever read the local DB (no live Spotify call
  involved), so nothing else needed gating. Verified both states live: unset → `/login`
  and `/callback` both 404; `ENABLE_LOGIN=true` → `/login` correctly 302s to Spotify's
  authorize URL. `.env.example` and the real `.env` both updated
  (`ENABLE_LOGIN=true` locally, since `/login` is still needed for day-to-day local dev).
- **Done**: droplet provisioned by Lucas (DigitalOcean, Ubuntu 24.04 LTS,
  `159.223.125.80` — this IP will change if the droplet's ever recreated, don't treat it
  as permanent). SSH access confirmed key-based only — `PasswordAuthentication no` is set
  twice over via DigitalOcean's own cloud-init config, so no brute-forceable password
  auth despite `PermitRootLogin yes` in the base sshd_config. Node 22.23.2 installed via
  NodeSource (Ubuntu 24.04's own apt repo lags well behind what `node:sqlite` needs).
  Repo cloned (it's public on GitHub, so a plain `git clone` needs no deploy key/token at
  all), `npm install` + `npm run build` both run clean on the droplet. The **already-
  fully-synced** `data/playlister.db` copied up via `scp` rather than re-running the sync
  pipeline (real API-call cost already paid once locally — no reason to pay it twice).
  `.env` written directly via `scp` of a local temp file (not typed inline over SSH, to
  keep secrets out of remote shell history) — same Spotify credentials as local,
  `SPOTIFY_REDIRECT_URI` now `https://playlister.lucasreher.com/callback` (updated once
  the tunnel gave a real domain — see below), `ENABLE_LOGIN` deliberately absent. Running
  as a `systemd` service (`playlister.service`
  — `/etc/systemd/system/playlister.service`, `WorkingDirectory=/root/playlister`,
  `ExecStart=/usr/bin/node index.js`, `Restart=on-failure`), enabled so it survives a
  reboot. Verified against the same baseline as every prior change on this project
  (6214 songs, 93 countries, 468 genres, 48 playlists, 4497 artists) both directly via
  SSH+curl and — critically — from an entirely separate machine hitting the droplet's
  public IP, not just its loopback (see the firewall finding right below for why that
  distinction mattered).
- **Real gap caught by Lucas, not found proactively**: right after getting the app
  running, it was described as "only reachable on the droplet's own network" — an
  assumption, never actually tested. Lucas pushed back ("this is super unsafe no?") and
  it turned out to be wrong: `ufw` was inactive, so port 3000 was open to the entire
  public internet with no TLS, alongside SSH. Confirmed by literally `curl`ing the
  droplet's public IP from a separate machine (not `curl 127.0.0.1` over the same SSH
  session that proves nothing about external reachability) — got a real `200`. Fixed:
  `ufw allow OpenSSH` + `ufw default deny incoming` + `ufw enable`, then re-verified from
  outside that port 3000 is now unreachable while SSH and the systemd service both still
  work. This is also the reason port 3000 was never opened for Cloudflare Tunnel either —
  the tunnel daemon connects *outbound* from the droplet to Cloudflare's edge, so no
  inbound firewall rule for the app is ever needed once it's set up; only the tunnel path
  will be able to reach it.
- **Done — live**: `playlister.lucasreher.com` (Lucas's existing domain, already on
  Cloudflare). Originally asked for as a *path* — `lucasreher.com/playlister/*` — but that
  would have needed real code changes throughout the app (every asset reference, API
  fetch, and the client-side router are all root-absolute, e.g. `/bundle.js`, `/api/songs`,
  with no path-prefix concept anywhere), since nothing currently serves the domain root.
  A subdomain needed zero app changes — just its own independent tunnel hostname — so
  that's what got built instead, once the tradeoff was on the table.
  `cloudflared` installed via Cloudflare's own apt repo; `cloudflared tunnel login`
  authenticated via a browser URL Lucas opened himself (the command has to run somewhere
  with terminal output to print that URL — backgrounding it silently the first time hid
  the URL entirely and wasted a round-trip — fixed by using the harness's real
  background-command mode instead, which surfaces partial output on demand). Named
  tunnel `playlister`
  created, `/root/.cloudflared/config.yml` (→ `/etc/cloudflared/config.yml` once
  `cloudflared service install` ran) routes `playlister.lucasreher.com` →
  `http://localhost:3000` with a catch-all 404 for anything else, DNS CNAME added via
  `cloudflared tunnel route dns`, running as its own `systemd` service (`cloudflared`,
  enabled). Verified from outside: the real public URL serves the app over HTTPS with the
  same baseline numbers as ever, `/login` still correctly 404s through the tunnel, and
  direct `:3000` access is still blocked — the tunnel is genuinely the only path in.
  `SPOTIFY_REDIRECT_URI` updated to `https://playlister.lucasreher.com/callback` in the
  droplet's `.env`.
- **Not started**: adding that same redirect URI in the Spotify Developer Dashboard
  (needed before `ENABLE_LOGIN` is ever flipped on for real), and a one-time
  `ENABLE_LOGIN=true` flip on the droplet to (re-)authenticate if the copied token's gone
  stale by then — should be rare after that, since `getValidAccessToken()`'s existing
  auto-refresh keeps future unattended `npm run sync` runs working without it.

### Publishing changes

`npm run deploy` (local) — the only piece that actually SSHes in; everything else runs
remotely. Chosen over two alternatives on purpose:
- **Not** a second `git remote` + post-receive hook (`git push production main`) —
  that pattern needs a bare repo living only on the droplet, which can silently drift
  from what's on GitHub if you ever push to one and forget the other. GitHub's `main`
  stays the unambiguous single source of truth this way instead.
- **Not** GitHub Actions auto-deploy-on-push — more machinery (a CI service, secrets
  management) than this project has reached for anywhere else for an equivalent
  convenience (same reasoning as `node:sqlite` over `better-sqlite3`, or DigitalOcean
  over a PaaS).

Two pieces:
- `scripts/deploy.sh` — git-tracked, so it exists locally too, but only ever *runs* on
  the droplet: `git pull && npm install && npm run build && systemctl restart playlister`.
- `~/.ssh/config` (local machine only, not git-tracked) has a `playlister-prod` host
  alias for `159.223.125.80` — keeps the droplet's IP out of the committed repo
  entirely (it's also not permanent, see above), and out of `package.json`'s `deploy`
  script, which just runs `ssh playlister-prod 'bash playlister/scripts/deploy.sh'`.

One-time bootstrap needed the first time this existed: `scripts/deploy.sh` has to
already be on the droplet before `npm run deploy` can invoke it (it's what `git pull`s
itself into place on every run after that) — so the very first rollout of this mechanism
needed one manual `git pull` on the droplet. Same self-modifying-script gotcha shows up
on every future change *to `deploy.sh` itself*: bash has already read/buffered the script
by the time `git pull` (line 1 of the script) rewrites it on disk, so that first run
still executes the *old* logic — a second `npm run deploy` right after is what actually
exercises the new version. Not a bug, just worth remembering before assuming a
`deploy.sh` change didn't work.

**Real staleness incident, caught by Lucas**: the first real test of this pipeline (adding
the Events tab) deployed cleanly by every server-side check, but Lucas reported the tab
just wasn't there. Turned out to be **two separate caches stacked on top of each other**:
Cloudflare's edge caches static-by-extension files (`.js`/`.css`) for 4 hours by default
when the origin gives no cache-control guidance (which ours didn't — never an issue
before because nothing had ever changed post-deploy until this point), *and* individual
browsers cache the same way once they've loaded a page. Diagnosed properly, not
guessed at: `curl`'d `bundle.js` from the public domain and compared its MD5 against the
droplet's own file — byte-identical, plus `cf-cache-status: HIT` with a multi-hundred-
second `age` on the *stale* response, proving the origin was correct and Cloudflare's
edge was the problem. **Fix**: `scripts/deploy.sh` now purges Cloudflare's entire cache
as its last step, via `POST /zones/{zone}/purge_cache` using a scoped API token (Cache
Purge only, this zone only — not the global key) stored in the droplet's `.env` as
`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ZONE_ID`, best-effort (a purge failure logs but doesn't
fail the whole deploy, since the app itself is already correctly updated by that point
regardless). Purging fixes Cloudflare's edge; it **can't** reach into a browser that
already cached an old file on an earlier visit — that still needed a manual hard refresh
once. A proper `Cache-Control` header on `routes/static.js`'s static responses would
close that remaining gap (stops browsers from caching in the first place, doesn't just
clean up after) — considered, not yet built, deliberately deferred once purge-on-deploy
covered the actual failure mode. Worth doing if this bites again.

**Also worth knowing**: squashing already-pushed commits (`git reset --soft` + recommit +
`git push --force-with-lease`) rewrites history that the droplet's own clone still
points at the old version of — the droplet's `git pull` would otherwise choke on
diverged history. Fixed with `git fetch && git reset --hard origin/main` on the droplet
right after force-pushing locally. Anywhere else this repo ever gets cloned to would need
the same treatment after a history rewrite — the droplet just happens to be the only
other clone that currently exists.

## Open items / natural next steps

- **Multi-tenancy is built and locally verified, not yet deployed.** Still needed before
  it's live: allowlist a second real Spotify account in the Spotify Developer Dashboard
  and do one real two-account OAuth test in an actual browser (everything so far was
  verified via a synthetic DB-seeded second user + a manually-minted session cookie, not
  a real second Spotify login); back up the droplet's `data/playlister.db` and run
  `npm run migrate-multi-tenant` there by hand over SSH, same as was done locally, before
  the next `npm run deploy`.
- "Create Playlist" button is a no-op stub — wiring it up to actually build a Spotify
  playlist from the current filtered view is the obvious next feature (would need the
  `playlist-modify-private`/`playlist-modify-public` scope added to the OAuth flow). Now
  that tokens are per-user, this could write to *any* logged-in user's own account, not
  just Lucas's.
- ~300 artists with no resolvable country from any automated source — options discussed:
  accept as the practical ceiling, manual override UI, or manual per-artist web research
  (not automatable cheaply).
- The stray `artist-countries copy.json` file's origin is still unexplained.
- **Events tab has no real content yet** — currently a deliberate stub (see "Events tab"
  above). What it should actually show has never been discussed.
- **Browser-side caching gap** — `routes/static.js`'s static responses still send no
  `Cache-Control` header at all. `npm run deploy` purging Cloudflare's edge cache covers
  the failure mode that actually bit us; a visitor's own browser caching a file from
  *before* their most recent visit is a real, narrower remaining gap (see "Deployment").
- Add `https://playlister.lucasreher.com/callback` as a redirect URI in the Spotify
  Developer Dashboard — not done yet, only matters once `ENABLE_LOGIN` needs flipping on
  on the droplet for a real (re-)authentication.

## Roadmap (declared, not yet started unless noted)

- **Client code cleanup** — **done**. Full Preact + esbuild SPA rewrite, see "Client
  architecture" above.
- **Move to SQLite** — **done**. See "Data layer: SQLite" above.
- **Deploy it** — **done, live** at `playlister.lucasreher.com`. See "Deployment" above.
