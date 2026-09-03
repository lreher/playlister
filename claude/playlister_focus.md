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
      isrc, duration_ms, explicit, spotify_url)   -- added_at dropped Sep 2026, see "Per-user 'Added' date"
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
  `client/index.css` plus `CountryMap`'s colocated `colors.css`).
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
  Taken further in the Sep 2026 restyle (see "Visual restyle" below): the four bar charts
  now pass *no* color at all — they all use `chartTheme.barGradient` (a purple→magenta
  vertical gradient), and their per-chart `colors.css` files were deleted. Only
  `CountryMap` still keeps its own `colors.css` (the map bubble is genuinely its own
  thing).

## Visual restyle — navy + neon-gradient dashboard look (Sep 2026)

Lucas handed over a PNG of a Looker-Studio / GA4-style dark dashboard and asked for that
look. A vibe pass, not an architectural one (see musings.md) — first cut built and
iterated on from feedback rather than planned upfront.

- **Palette lives entirely in `client/index.css`'s `:root`** — the restyle is mostly new
  values there. `--bg` deep navy `#16223f`, `--bg-elevated` `#1e2b4c` (card surface),
  `--border` `#2c3d63`, `--text` `#eef1f9`, `--text-muted` `#8a99bf`, `--accent` magenta
  `#e0389d` (replaced Spotify green as the single accent), plus three gradient stops
  `--grad-purple` / `--grad-magenta` / `--grad-orange`. `globalTheme.js` / `chartTheme.js`
  read these at load time exactly as before — no change to that plumbing.
- **Cards**: `.chart-container`, `#app` (the List panel), and `#filters` share one
  card treatment (elevated bg + hairline border + soft shadow + radius). `#app` gained
  padding so the toolbar/table/pagination sit inside one panel; `.chart-container` did
  **not** get padding (echarts.init sizes the canvas to clientWidth/Height including
  padding — inner spacing comes from the chart's own `grid` config instead). `SongTable`
  now wraps its `<table>` in `.songs-table-wrap` (`overflow-x: auto`).
- **Charts**: `chartTheme.js` exports `barGradient` (a plain `{type:'linear',…}` object,
  vertical purple→magenta). `BarChart`'s default `color` is now that gradient;
  `emphasisColor` defaults to orange (`--chart-emphasis`). The four bar-chart components
  dropped their `color`/`emphasisColor` props + `colors.css` imports (4 files deleted) —
  they all look the same in the reference, so per-chart hues were pointless divergence.
- **Font**: Roboto (added to `static/index.html`), Inter kept as the fallback.
- Accent-driven bits (buttons, tabs, pagination active state, login button, sync progress
  bar) use the magenta accent or the full gradient; the old `color: #000000` (readable on
  green) became `--accent-contrast` (`#ffffff`).

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
  requests), changed/new → full track list re-fetched, detecting removals too. Liked
  Songs has no `snapshot_id`, so it's treated as a permanently-"changed" playlist:
  full-walked and whole-replaced every sync (see "Per-user 'Added' date", Sep 2026 — the
  old "stop at first known ID" incremental trick is gone).
- Requires `playlist-read-private` + `playlist-read-collaborative` scopes (added to
  `sources/spotify.js`) — **this scope change mattered in practice, not just in theory**: the
  endpoint returned data even without the scope during initial testing (33 playlists,
  all public), but after re-authenticating with the proper scope it found **47** — 14
  private playlists had been silently invisible. Don't skip adding a scope just because
  something appears to work without it.
- **Real bug hit and fixed** (history — the append-only design it describes is gone as of
  Sep 2026, replaced by the unconditional full-walk above): the "liked-songs"
  pseudo-playlist entry was first implemented as append-only from `syncSongs()`'s
  newly-discovered-this-run list. Since Liked Songs had already been fully synced in
  earlier sessions before this feature existed, the first run under the new code found 0
  *new* songs and the pseudo-playlist silently ended up with **0 tracks** instead of the
  real ~5032. That got patched with a one-time full-seed path — which then had its own
  follow-on bugs (per-user-vs-global "new", the `liked-songs-seed` stall) until the whole
  append-only approach was dropped for a plain whole-replace. Worth remembering: any
  "derive current membership from an incremental/append-only sync" design needs an
  explicit first-time full-seed path, or it silently starts from empty — or just
  full-reconcile every time if the walk is affordable, which it turned out to be here.
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

> **Superseded (Sep 3 2026)**: the per-user stop-early is gone entirely — `syncSongs` now
> full-walks Liked Songs every sync (see "Per-user 'Added' date"). The class of bug above
> (membership derived from an incremental walk against a shared cache) is what motivated
> dropping it.

**Background sync**: no queue library — 25-user Development-Mode cap, one
systemd-managed process, a real job queue would be more machinery than this warrants.
Triggered server-side from `/callback` (originally on *every* login — now conditional,
see "Login sync is conditional" below) — `sync_status` lives on the
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

## Multi-tenancy: bugs caught in production, post-deploy (Aug 31 2026)

Real second-user experiment: backed up and wiped the droplet's live DB entirely (both
the droplet and locally), had Lucas log in fresh as a genuine cold-start "new user" (his
real account, zero prior data) to exercise the whole pipeline end to end.

- **`playlist_tracks` INSERT crash on a playlist containing the same track twice.**
  `db/playlists.js`'s `insertTrack` was a plain `INSERT`, not `INSERT OR IGNORE`, against
  `playlist_tracks`' `(playlist_id, song_id)` primary key. A real Spotify playlist can
  legitimately contain the same track more than once (no error on Spotify's end) — the
  first time this got exercised was this cold-start experiment, since it force-refetched
  all 47 real playlists at once instead of the usual snapshot_id-skip that had let most
  of them go untouched for a long time. Crashed the whole `playlistsDb.set()` transaction,
  rolling back to **zero playlists synced** even though songs had already committed
  separately (global table) — which is exactly why the symptom looked like "sync isn't
  working, no songs" (visibility scoping correctly found nothing, since nothing was
  linked through any playlist). Fixed: `INSERT OR IGNORE` — schema only tracks
  membership, not multiplicity, so a repeat should just no-op. Verified against the real
  duplicate by re-running a full sync locally against Lucas's real 47 playlists after the
  fix — completed clean.
- **The failure was invisible in server logs — a real gap, not just this one incident.**
  `sources/syncQueue.js`'s fast-sync `.catch()` wrote the error to `sync_status`/
  `sync_error` on the `users` row but never logged anything to the console. Diagnosing
  the crash required SSHing in and querying the database by hand rather than just reading
  `journalctl` — direct server-state inspection is still preferable to guessing (see
  musings.md's Instrumentation-over-deduction note), but it shouldn't have to be the
  *only* way to see a crash happened at all. Fixed: `console.error` on fast-sync failure,
  plus a `console.log` right when a queued sync actually starts running (not just when
  it's requested) — makes "is anything actually happening" directly checkable via logs
  instead of a database query.
- **Sync progress now reported, not just a static "please wait."** Lucas's explicit ask
  after seeing a blank loading screen with no way to tell if it was working: a
  `sync_progress_phase`/`current`/`total` set of columns on `users` (nullable — only
  meaningful mid-sync, cleared whenever `setSyncStatus` runs), updated during
  `syncSongs`'s pagination (against Spotify's own `total` liked-songs count) and
  `syncPlaylists`'s per-playlist loop (against the fetched playlist count). Exposed
  through the existing `/api/sync-status` response as a nested `progress` object — no new
  route needed. `App.jsx`'s loading screen shows a phase label + "current/total (pct%)" +
  a small CSS progress bar once a real total is known (no bar/percent for the songs phase
  before its first page comes back and reveals the total, to avoid a misleading 0%).
- **Additive schema change, self-migrating inline rather than a whole new migration
  script.** The `sync_progress_*` columns needed adding to an already-live `users` table
  (both local and droplet) — `CREATE TABLE IF NOT EXISTS` alone wouldn't touch it (same
  no-op-on-existing-table behavior documented under the multi-tenancy migration above).
  Small enough (nullable, purely additive) not to warrant a dedicated migration script
  like the multi-tenant one did: `db/database.js` just checks `PRAGMA table_info(users)`
  and runs `ALTER TABLE ... ADD COLUMN` for whatever's missing, every time it's required —
  safe, idempotent, self-healing on both fresh installs and the two already-live databases.

## Multi-tenancy: two more bugs found via the real second-user run (Aug 31 2026)

- **Genres/popularity were gated behind country resolution for no real reason.**
  `runEnrichment` ran `resolveCountries` (rate-limited against MusicBrainz/Wikidata,
  hours on a cold cache) before `resolveArtistDetails` (Spotify's own batch endpoint —
  thousands of artists in well under a minute). Fully independent operations, so there
  was no reason for the fast one to sit at zero the whole time the slow one worked
  through a large backlog. **Caught by Lucas actually looking at the result**, not
  something review would have flagged — swapped the order.
- **Sync-progress polling looked "stuck at 100%," fixed by a page refresh.** Verified via
  direct server inspection (not guesswork) that the backend had genuinely already
  finished (`sync_status: 'done'`) by the time this was reported — the frontend's
  `setTimeout`-chained poll loop just never got back to it. Leading theory: browser tabs
  throttle `setTimeout` hard once backgrounded/minimized — the loop doesn't die, it just
  slows to a crawl, which looks identical to "stuck" until something re-triggers a fresh
  check (a reload, in this case). Fixed with a `visibilitychange` listener in `App.jsx`
  that immediately re-polls the moment the tab becomes visible again, rather than relying
  on whatever's left of a throttled timer — a reasonable robustness improvement
  regardless of whether backgrounding was the exact cause here.

## "Stuck at 47/47" — the real cause, found by reading real timestamps, not guessing

After the genres/popularity phase became blocking (see above), Lucas kept hitting a
loading screen frozen at "Fetching your playlists — 47/47 (100%)" for a long stretch
before it ever moved to the genres/popularity step. Two earlier fixes (a
`visibilitychange` re-poll, `Cache-Control: no-store` on the API responses) had already
shipped for a similar-looking symptom and didn't resolve this one — a reminder that
"looks like the same bug" isn't proof it *is* the same bug.

Root cause, found by pulling exact timestamps from `journalctl` on two separate real
syncs (not reasoned about, actually read): the main playlist loop finishes and reports
47/47 quickly, but `syncPlaylists()` isn't done yet — a first-ever sync still has to seed
the Liked-Songs pseudo-playlist via `fetchAllLikedTrackIds()`, a full sequential
pagination walk over a user's entire Liked Songs (thousands of tracks). That walk had
**zero progress reporting** — both real syncs showed it running silently for 35-40+
seconds (`02:17:50` → `02:18:25`, then `02:25:39` → `02:26:15` on a retry) with the UI
sitting at a stale 100% the whole time, not because anything was actually stuck.

Fixed by giving that walk its own tracked phase, `liked-songs-seed`, reporting real
incremental progress against Spotify's own total (same pattern as `syncSongs`). Verified
locally by forcibly re-triggering the first-sync branch (deleting the Liked-Songs
pseudo-playlist) and confirming progress moves continuously — 0 → 850 → 1700 → ... → 5045
— between the `songs` and `details` phases, with no gap left unaccounted for. This phase
only ever fires once per user (first sync only); a returning user's re-sync never hits
this code path at all.

> **Superseded (Sep 3 2026)** by "Per-user 'Added' date" below: `syncSongs` now always
> full-walks Liked Songs, so the separate `fetchAllLikedTrackIds` seed path and its
> `liked-songs-seed` phase are gone — that walk is now just part of the `songs` phase,
> every sync.

## Per-user "Added" date — Liked Songs is now a real reconciled playlist (Sep 3 2026)

**Bug, hit live on the deployed app by real second/third users** (not synthetic testing):
everyone's List order, added-date range filter, and the "liked over time" dashboard chart
were keyed off **Lucas's** like dates, not their own. Root cause: `songs.added_at` was a
single global column, written once by `mergeTracks` when a track first entered the DB for
*anyone* and never updated — a leftover from the single-tenant era when "when was this
added" had one answer. Every read in `controllers/songs.js` (`getSongs`'s sort, the
`addedFrom`/`addedTo` filter, `getFilterOptions`'s `addedRange`, `getStats`'s
`likedCounts`) read that global column.

**The per-user date already existed in the DB** — `playlist_tracks.added_at`, scoped per
user through `playlists` (each user's Liked Songs under `playlist_id =
liked-songs:<userId>`, seeded with their own dates on first sync). So this was a
read-layer bug, *not* missing data — and explicitly **not** a reason to duplicate song
rows per user (the shared `songs`/`artists` cache is still the right call — see
"Multi-tenancy" above; the only user-specific field in play was `added_at`, already on
the membership layer).

**What changed:**
- **`songs.added_at` dropped entirely** (schema + `song_details` view + `idx_songs_added_at`).
  One-time migration `scripts/migrate-drop-songs-added-at.js` (`npm run migrate-drop-added-at`),
  idempotent via a `PRAGMA table_info` guard: drops view → index → column, then lets
  `db/database.js` recreate the view. `mergeTracks` no longer writes the column; it
  ignores each item's `added_at` (a per-user fact, recorded on `playlist_tracks` by the
  caller).
- **`controllers/songs.js` derives "Added" per-user**: `MIN(added_at)` across the calling
  user's own `playlist_tracks` rows for that song — the earliest date it entered *any* of
  their playlists (their Liked Songs among them). Two correlated forms: `USER_ADDED_AT_SUBQUERY`
  (attached to a `song_details` row for `getSongs`' sort + range filter, one `?` = userId)
  and `USER_ADDED_AT_ROWS` (a standalone one-row-per-song source for `addedRange` /
  `likedCounts`, where membership *is* the FROM clause so no `visibleToUser` needed).
  `visibleToUser` itself was left untouched — it's the verified security boundary, and
  the new subqueries scope redundantly on top of it rather than replacing it.
- **Liked Songs is now reconciled like a snapshot-less playlist.** `syncSongs` always
  full-walks `/v1/me/tracks` (no more per-user incremental stop-early), feeds every item
  to `mergeTracks` (populates the shared `songs` cache, dedupes cheaply), and returns the
  full `[{id, addedAt}]` list. `syncPlaylists` whole-replaces the pseudo-playlist from
  that list — same path as any real playlist with no `snapshot_id` match. **Deleted**:
  `fetchAllLikedTrackIds`, `getUserLikedSongIds`, the first-sync seed branch, the
  append-only branch, the `liked-songs-seed` progress phase. This also fixes a latent
  bug: a song you newly like that another user already synced used to be dropped from
  your Liked Songs, because membership was derived from what `mergeTracks` found
  *globally* new, not what was new *to you*.

**Tradeoff accepted:** every sync now re-walks ~100 pages of Liked Songs instead of
stopping early. That was a real rate-limit problem once — but back when a full walk fired
on every *server restart* during development. Sync is per-login now (25-user cap), so a
full walk per sync is fine. Easy follow-up if it ever bites: only full-walk when the last
sync was more than N hours ago.

**Verified** (local, `data/playlister.db` backed up first): Lucas's own numbers unchanged
post-migration (6218 songs, all filter-option lengths/ranges, all stats lengths identical;
`likedCounts` last month shifted 107→106, the one intentional correctness change — a song
whose earliest membership month differs from whoever's date was on the old global row).
Ordering stayed monotonic-descending with zero null dates. A synthetic second user sharing
3 songs with Lucas confirmed: their List order is by *their* dates, `MIN` across playlists
picks the earliest (a song liked in 2023 but in a playlist since 2020 sorts at 2020),
`addedRange`/`likedCounts` are their own history, Lucas's `total` stays 6218, and the
`?playlist=` cross-tenant check still returns 0. Also isolated-tested `syncSongs`'
pagination + stub filtering, and confirmed via the live HTTP server with a signed session
cookie.

**Deployed to the droplet (Sep 3 2026)** — `deploy.sh` ran `migrate-drop-added-at`
cleanly (`songs.added_at removed, song_details rebuilt`) after taking a DB backup. `npm
install` on that droplet is genuinely slow (~4 min) — the first deploy attempt was killed
prematurely thinking it had hung; it hadn't. Deployed bundle verified byte-identical to
local, `/api/*` still 401s without a session, `/login` still 302s. The authed API and a
real sync weren't verifiable remotely (no prod session) — left for a real login + the
still-open two-account test.

## Login sync is conditional; manual Sync button (Sep 3 2026)

Every login used to trigger a full blocking sync (`/callback` unconditionally set
`sync_status='syncing'` + enqueued, frontend blocked until `done`). Harmless when the
`songs` phase stopped early (~seconds for a returning user); wasteful once it became a
full Liked-Songs walk (see above). Lucas: "why do I need to fetch my songs and do the
whole sync every time I log in?"

**Now:**
- New `users.last_synced_at` (nullable, additive — self-heals via the same `PRAGMA
  table_info` + `ALTER` block as `sync_progress_*`; a one-shot backfill sets it to *now*
  for existing `sync_status='done'` users so the first post-deploy login doesn't
  re-sync everyone at once). `db/users.js`'s `setSyncStatus(id, 'done')` stamps it — the
  single point a sync is known complete.
- `routes/index.js`'s `enqueueSyncIfNeeded(userId, {force})`: sync on login only if never
  synced, `sync_status='error'`, or `last_synced_at` older than `SYNC_STALE_MS` (24h).
  Skips if already `'syncing'`. A returning user with a fresh library goes straight to the
  app.
- New `POST /api/sync` (`force: true`) — the manual **Sync** button (header, next to
  Delete; the old removed stub is now real). Still no-ops if a sync is already running.
- `App.jsx`: blocks (the "building your library" screen) **only** on a genuine first sync
  (`lastSyncedAt` null). Otherwise shows the app immediately; a running sync (stale
  refresh from `/callback`, or the button) surfaces as a header "Syncing…" indicator via
  a `syncing` flag, and on completion bumps a `dataVersion` counter. `dataVersion` is
  threaded as a prop into `SongList` → `Filters`/`SongTable` (added to their fetch-effect
  deps — a surgical re-fetch that keeps the uncontrolled filter inputs intact) and as
  `key={dataVersion}` on `<Dashboards>` (a full remount is fine there and avoids auditing
  each ECharts wrapper's update path). The sync-status poll effect now covers both the
  blocking first-build and the non-blocking background/manual case.

**Verified locally**: new user → blocking sync; fresh returning user → no sync; user
stale by 3 days → background sync enqueued on login; errored user → re-sync; `POST
/api/sync` while syncing → no double-run (concurrent POSTs tested); `last_synced_at`
stamps on completion and the backfill runs once. Full HTTP flow (mount → Sync button →
poll → done) exercised against the real server with a stubbed sync layer.

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
  deriving the artist roster from what's already stored locally instead of a second
  Spotify walk — originally a `songs.json` derivation step, now free: `db/songs.js`'s
  `mergeTracks` stub-creates every artist's row as songs come in, so `artistsDb.getAll()`
  already *is* the roster. (`syncSongs` also had a newest-first stop-early walk for a
  while — dropped Sep 2026, see "Per-user 'Added' date"; safe now that (a) killed the
  per-restart trigger and sync is per-login.)

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
- Dark theme. **Restyled Sep 2026** (see "Visual restyle" below) — was Spotify green
  (`#1db954`) + near-black + Inter; now deep navy (`#16223f`) + a magenta accent
  (`#e0389d`) + a purple→magenta→orange chart gradient + Roboto, to match a
  Looker-Studio-style reference dashboard Lucas handed over.
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
  the droplet: `git pull` → `npm install` → timestamped `data/playlister.db` backup (last
  5 kept) → idempotent schema migrations (currently just `npm run migrate-drop-added-at`,
  each self-guards) → `npm run build` → `systemctl restart playlister` → Cloudflare cache
  purge. Migrations run before the restart so the schema matches the code coming up.
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
`deploy.sh` change didn't work. **This bites the Sep 2026 `migrate-drop-added-at` rollout
specifically**: the first `npm run deploy` runs the old (migration-free) `deploy.sh`
against the new code, which drops `songs.added_at` from its `INSERT` — so a sync would
hit a `NOT NULL` crash in the gap. Run `npm run migrate-drop-added-at` by hand over SSH
(after backing up `data/playlister.db`) right after that first deploy, before anyone
syncs; every deploy after that one runs it automatically.

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

(Status as of Sep 3 2026.)

- **Per-user "Added" date fix — deployed and live** (Sep 3). See "Per-user 'Added' date"
  above. Still wants a real login by Lucas to confirm the authed path end to end.
- **Conditional login sync + Sync button — built and locally verified, NOT yet deployed.**
  Ships in the normal `git push` → `npm run deploy` (the `last_synced_at` column
  self-heals + backfills on boot, no manual migration step). See "Login sync is
  conditional" above.
- **Multi-tenancy is deployed and live**, and real second/third users have now logged in
  on the deployed app (that's how the "Added" date bug surfaced). Cross-tenant isolation
  held for real identities. Still worth a deliberate side-by-side two-account pass on the
  new sync/read code.
- **The Delete button wipes the entire database (every user's data) and is deliberately
  open to any logged-in session right now**, not gated to one admin — Lucas's explicit
  call, made knowingly ("yes I understand how dumb that sounds"). Worth revisiting once
  real other users are actually using this day to day, not just Lucas testing solo.
- The **Sync button is now real** (`POST /api/sync`, header) — was a removed stub. A
  library >24h stale also re-syncs automatically (in the background) on next login;
  `npm run sync <userId>` (droplet SSH) still works for maintenance.
- "Create Playlist" button is still a no-op stub — wiring it up to actually build a
  Spotify playlist from the current filtered view is the obvious next feature (needs
  `playlist-modify-private`/`playlist-modify-public` added to the OAuth scope). Now that
  tokens are per-user, this would write to *any* logged-in user's own account, not just
  Lucas's.
- ~300-350 artists (of ~4500) have no resolvable country from any automated source —
  accepted as the practical ceiling; the enrichment status UI now reflects this honestly
  (only shows while a step is actively running, never a stalled-looking percentage).
  Options discussed for going further: manual override UI, or manual per-artist web
  research (not automatable cheaply). Not started.
- The stray `artist-countries copy.json` file's origin is still unexplained.
- **Events tab has no real content yet** — still a deliberate TBD stub. What it should
  actually show has never been discussed.
- **Browser-side caching gap on static assets** — `routes/static.js`'s responses still
  send no `Cache-Control` header at all (distinct from the dynamic-API gap fixed this
  session — every JSON response now sends `Cache-Control: no-store`, see the
  Multi-tenancy sections above). Not yet touched.

## Roadmap (declared, not yet started unless noted)

- **Client code cleanup** — **done**. Full Preact + esbuild SPA rewrite, see "Client
  architecture" above.
- **Move to SQLite** — **done**. See "Data layer: SQLite" above.
- **Deploy it** — **done, live** at `playlister.lucasreher.com`. See "Deployment" above.
- **Multi-tenancy** — **done, live**, shipped and iterated on heavily in one long session
  (Aug 31 2026). See the "Multi-tenancy" sections above for the architecture, the real
  bugs found and fixed, and what's still open (a real second-account test chief among it).
- **Per-user "Added" date** — **done, deployed** (Sep 3 2026). Liked Songs is now a
  fully-reconciled snapshot-less playlist; `songs.added_at` dropped; reads derive "Added"
  per-user from `playlist_tracks`. See "Per-user 'Added' date" above.
- **Conditional login sync + Sync button** — **built, verified locally, not yet deployed**
  (Sep 3 2026). Login only blocks on a genuine first sync; returning users go straight in;
  manual Sync button + a 24h-stale auto-refresh. See "Login sync is conditional" above.
