# Playlister — Project Focus & Living Reference

Personal tool that pulls your **entire Spotify library** — Liked Songs plus every
playlist — into a rich, filterable, Spotify-agnostic dataset (country of origin, genre,
popularity, decade, duration, playlist membership, etc.). Node.js, zero framework,
Preact frontend (esbuild only, no heavy bundler), SQLite via knex as the database. Git
repo on GitHub (`lreher/playlister`), deployed and live at `playlister.lucasreher.com`
(DigitalOcean droplet + Cloudflare Tunnel — see "Deployment"), still fully runnable
locally too (`npm start`).

Read this file first when picking this project back up — it has the decisions and
hard-won findings that aren't obvious from the code alone.

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
  for everything in `static/` (via `routes/static.js`), `/login` + `/callback` (OAuth),
  and the three `/api/*` routes, which parse query params and call straight into
  `controllers/songs.js` — no filter/aggregation logic lives here. **Reads only local
  files** — no live Spotify calls except the OAuth routes and
  `getValidAccessToken()`'s refresh path; nothing auto-triggers a backfill on
  startup/login. One file for now (not split per-domain) — route count didn't justify
  it yet; revisit if it grows.
- `routes/utils.js` — route-layer helpers shared across route *types*:
  `getQueryParams(req)`, `sendJson(res, data)`.
- `routes/static.js` — static-file serving, split out of `routes/utils.js` on purpose
  (a `utils.js` is for genuinely cross-cutting helpers, not a dumping ground for
  whatever got extracted). `STATIC_FILES` (`world.geo.json`, `bundle.js`, `bundle.css`)
  + a MIME-type map keyed by extension + `registerStaticRoutes(router)`. Separately,
  `APP_ROUTES` (`/`, `/dashboards`) each serve `index.html` — real server routes needed
  so a direct load/refresh of e.g. `/dashboards` works, not just clicking there from
  within the app; `App.jsx` reads `window.location.pathname` on mount to pick the
  initial tab, and calls `history.pushState` on every tab switch (plus a `popstate`
  listener for back/forward). Serves out of `static/`, not `public/`.
- `controllers/songs.js` — all the actual `/api/songs` (filter+sort+paginate),
  `/api/filters` (distinct option lists + ranges), and `/api/stats` (dashboard
  aggregates) logic, as plain functions `getSongs()`/`getFilterOptions()`/`getStats()`
  taking/returning plain objects — no HTTP concerns.
- `sources/spotify.js` — OAuth (Authorization Code flow), token read/write/refresh.
- `db/index.js` — exports `getDb(role)`, the app's two lazily-created, cached knex
  connections (`'app'`, the default; `'sync'`). See "Data layer & query layer" below.
- `db/tokens.js` — the OAuth token row, via `get()`/`set()`, keyed by `user_id`.
- `db/songs.js` — `getAll()`, `getById(id)`, `mergeTracks(items)` (the shared dedupe-
  and-append helper, called from `scripts/sync.js` for both Liked Songs and playlist
  tracks — also stub-creates a minimal `artists` row for any new artist it sees).
- `db/playlists.js` — `getAll()`, `getById(id)`, `set(playlists)` (a whole-collection
  replace — needed so deleted/unfollowed playlists can disappear, which a per-record
  upsert can't express), `LIKED_SONGS_ID`.
- `db/artists.js` — `getAll()`, `getById(id)`, `getCountry`/`getGenres`/`getPopularity`/
  `getFollowers` (field-specific reads with per-field defaults), `upsert(id, patch)`
  (shallow-merges into one record, persisted immediately). No orchestration — the
  resolution cascade lives in `scripts/sync.js`.
- `sources/musicbrainz.js` — `resolveBatch()`, `lookupArtistCountry()`.
- `sources/wikidata.js` — `resolveWikidataBatch()`, `searchWikidataEntity()`,
  `lookupCountriesByQids()`.
- `utils/isrcCountry.js` — pure function, derives a country code from a track's ISRC
  prefix (no network call).
- `scripts/sync.js` — the `npm run sync` entry point, and the **only** place
  sync/orchestration logic lives: `syncSongs()`, `syncPlaylists()`,
  `resolveCountries()` (MB→Wikidata cascade), `resolveIsrcFallback()`,
  `resolveArtistDetails()` (Spotify genre/popularity), and `main()` sequencing all of
  them: sync liked songs → sync playlists → resolve countries → ISRC fallback → resolve
  genres/popularity/followers.
- `static/` — served, built output + static assets: `index.html` (hand-authored),
  `world.geo.json` (world country boundaries, ECharts' own test-data file, ~1MB),
  `bundle.js`/`bundle.css` (esbuild output, **gitignored**).
- `client/` — the SPA source. See "Client architecture" below.

## Data layer & query layer: knex + SQLite

Real SQLite database at **`data/playlister.db`**, all access through **knex** — no
hand-built SQL strings anywhere in the app (rebuilt from raw SQL to knex Sep 5 2026).
Fully async throughout.

**Connections** (`db/index.js`'s `getDb(role)`, `'app'` default / `'sync'`) — kept
separate so a long-running sync (minutes on first sync, hours during country
enrichment) never contends with a live request for the app connection's pooled slot.
Both capped `{min: 1, max: 1}` — `better-sqlite3` is synchronous, so a bigger pool buys
no real concurrency; SQLite's own WAL mode is what lets the two connections read/write
the same file concurrently. Every `db/*.js` function takes the connection as an
explicit trailing argument (default: app connection), not a hidden global — matches
this project's "explicit over implicit" preference (see musings.md).

**Schema** (real knex migrations under `migrations/`, tracked via knex's own
`knex_migrations` table, `npm run migrate`):
```
users(id, display_name, sync_status, sync_error,
      sync_progress_phase, sync_progress_current, sync_progress_total,
      last_synced_at, created_at)
tokens(user_id, access_token, refresh_token, expires_at)
artists(id PK, name, country, popularity, followers, details_resolved)
artist_genres(artist_id, genre)                                    -- many-valued
songs(id PK, name, album_name, album_release_date, album_type, isrc,
      duration_ms, explicit, spotify_url, year, decade, country)
song_artists(song_id, artist_id, position)                        -- position 0 = primary
playlists(id, user_id, name, owner_name, public, collaborative, snapshot_id)  -- composite (id,user_id) PK
playlist_tracks(playlist_id, song_id, added_at)
```
- `year`/`decade`/`country` are **real columns on `songs`**, computed once in JS at
  insert time (`db/songs.js`'s `mergeTracks`) rather than recomputed on every read via a
  view (the pre-knex design). `country` specifically gets re-derived and rewritten to
  every affected song whenever the underlying artist's country resolves later
  (`db/artists.js`'s `upsert` → `songsDb.updatePrimaryArtistCountry`) — deliberately
  never overwritten by a null "still unresolved" result, so an existing ISRC-derived
  fallback never gets blanked out.
- `details_resolved` on `artists` distinguishes "never resolved" from "resolved to
  genuinely empty" — a plain SQL row can't otherwise tell those apart (every column
  "exists," just possibly `NULL`).
- **No `PRAGMA foreign_keys`** — artist resolution is a separate, later pass from song
  ingestion; a `song_artists` row can reference an unresolved artist, every read is a
  `LEFT JOIN`.
- Genre/artist filtering is **exact-match, not case-insensitive** — knex has no
  `LOWER()` builder method, and the filter dropdowns are sourced from the same table, so
  the user always picks an already-correctly-cased value anyway.
- Artist display names and full genre sets (display-only) are two batched
  `.whereIn(songIds)` queries + JS-side grouping (`loadDisplayFields` in
  `controllers/songs.js`), bounded to the current page (~50 rows) — no full-table cost.
- Older one-off scripts (`scripts/migrate-to-sqlite.js`,
  `scripts/migrate-to-multi-tenant.js`, `scripts/migrate-drop-songs-added-at.js`) are
  left on disk as historical record, not wired to any npm script anymore.

**Bootstrapping onto a database that predates knex migrations**:
`scripts/bootstrap-knex-migrations.js` (idempotent, one-time) marks the baseline
migration as already-applied without running it, so its plain `CREATE TABLE`s don't
fail against tables that already exist — every migration after the baseline then runs
for real. A genuinely fresh install never needs this script. **Run and verified against
local** (6218 songs, all backfilled, old view confirmed gone). **Not yet run against the
droplet** — see Status below, this blocks the next deploy.

**Decisions worth knowing if revisited**:
- knex over Drizzle/Kysely: knex/Kysely's SQLite dialects both require `sqlite3` or
  `better-sqlite3` (no `node:sqlite` support, open upstream issue); Drizzle has an
  official `node:sqlite` driver and would have kept the zero-native-dependency property.
  Chosen anyway, knowingly accepting the driver swap.
- Full async, not knex-as-SQL-generator-only: knex's execution is Promise-based
  regardless of driver, but `better-sqlite3` (like `node:sqlite`) is synchronous under
  the hood — so this bought async *syntax*, not real concurrency the way a driver with
  actual non-blocking I/O (`sqlite3`, via libuv's thread pool, at a real per-query cost)
  would. Chosen for convenience/driver popularity, not a performance win this driver
  can't deliver — worth being precise about if async's value here is ever questioned.

**Real bugs found by direct verification, not review** (worth checking for a repeat):
- `better-sqlite3@13.0.3`'s prebuilt binary segfaults immediately on load under WSL2 —
  confirmed by `require()`-ing the raw `.node` file in isolation. Downgraded to
  `12.11.1`, resolved cleanly.
- `likedCounts` summed to 6219 against a real total of 6218 — a per-user "added" rows
  query was missing a `JOIN songs` guard against orphaned `playlist_tracks` rows
  (membership pointing at a `song_id` no longer in `songs`, residue of an
  interrupted/older sync).
- Every route handler is async now, but `server/index.js` dispatched via a plain
  synchronous `try/catch` — doesn't catch a rejected promise, silently turning a failure
  into a hung request instead of a 500. Fixed by wrapping dispatch in
  `Promise.resolve().then(...).catch(...)`.

Verified against the real local library (6218 songs): all baseline counts/filters/stats
matched, cross-tenant isolation held, full authenticated HTTP path exercised end to end.

## Client architecture (Preact + esbuild)

Full SPA, no plain-`<script>` global-scope setup.

- **Framework**: Preact (~4kb, React-compatible hooks/component API) — "lightest
  possible React," chosen once a build step was accepted.
- **Build tool**: esbuild, not Vite — rejected Vite as more machinery than needed. One
  esbuild CLI invocation as an npm script (`jsx: automatic`, `jsx-import-source: preact`).
- **One `package.json`** — no separate `client/package.json`.
- **Dev workflow**: no second dev server/proxy. `npm run watch` rebuilds
  `static/bundle.js` on save; manual browser refresh, not live-reload (esbuild has no
  built-in HMR) — accepted trade-off for this app's size.

**Directory shape** — `components/` holds only genuinely reusable primitives;
`pages/` holds page-specific composition; nothing in `components/` knows about songs,
artists, or "filters" as a domain:

```
client/
  App.jsx          # shell: tab state (list/dashboards), theme state, dispatches to pages/
  api.js            # fetch wrappers: getFilters(), getSongs(), getStats(), getWorldGeoJson()
  index.jsx          # entry: applyTheme(getTheme()) then render(<App/>, #root)
  theme.js            # the 4-way theme switcher — see "Visual themes"
  utils/format.js      # countryLabel, formatDuration, formatDateShort
  themes/
    chartTheme.js         # getChartTheme() (reads :root vars fresh), barGradient(), baseChartOption()
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
        countryCoords.js (ISO code → [lon,lat], colocated here — CountryMap-only data)
    songList/
      index.jsx                  # renders Filters + SongTable
      Filters/                    # filter row: fetches /api/filters, owns filter-state
        shape (EMPTY_FILTERS), composes the components/filters/ primitives
      SongTable/                   # paginated table, re-fetches on filters/offset change
```

**Patterns worth knowing**:
- **Controlled vs. uncontrolled inputs**: dropdowns are controlled (`value={filters.x}`)
  because a dashboard chart click can set them from outside. `OptionsSearch` and
  `RangeSlider` are deliberately uncontrolled (refs) — forcing a value prop onto
  free-typing text or a mid-drag range input would fight the native element. They reset
  via a `key={resetToken}` remount trick on "Reset filters."
- **Dashboards mount lazily, once**: `App.jsx` only renders `<Dashboards/>` after the
  tab's been visited the first time, and never unmounts it after — avoids re-fetching
  `/api/stats` or re-initializing echarts instances on every tab switch.
- **One real theme default, not five accidental copies**: the four bar charts pass *no*
  colour at all — they all use `chartTheme.barGradient(theme)` — and only `CountryMap`
  keeps its own `colors.css` (the map bubble is genuinely its own thing).

## Visual themes — a 4-way switcher

CSS + one tiny JS module, no backend involvement, persisted to `localStorage`.

- **Clean** (default) — light. Soft pale gradient background behind frosted translucent
  cards. Indigo accent, system font. `color-scheme: light`.
- **Studio** — navy + neon-gradient dashboard look, magenta accent, Roboto. This is the
  **bare `:root`** (see below).
- **Classic** — the original: near-black, Spotify green, no card borders/shadows.
- **Nicolas** — a deliberate joke theme: mint background, Comic Sans, hot-pink accent,
  clashing neon everywhere.

`client/theme.js` — `THEMES` (id + label, order = toggle order), `getTheme()`/
`setTheme()`/`applyTheme()`. **`applyTheme` special-cases `'studio'` as the *absence* of
the `data-theme` attribute** (its palette is the bare `:root`); every other theme sets
`<html data-theme="…">`. `static/index.html` hard-codes `data-theme="clean"` so a cold
load paints Clean with no flash before the bundle runs.

`client/index.css`'s bare `:root` holds a set of theme-varying tokens (`--panel-bg`,
`--accent-fill`, `--chart-*`, etc.); each theme block overrides just those, plus a
handful of theme-scoped decorative rules where a var can't reach. `chartTheme.js` reads
these CSS vars **fresh on every call** (`getChartTheme()`), and a theme switch remounts
`<Dashboards key={`${dataVersion}:${theme}`}>` to recolour the charts — CSS-only
surfaces recolour instantly, no remount needed.

Layout: the theme toggle lives in the tab bar; Sync/Delete/Create-Playlist moved into a
`.table-footer` below the table (List tab only, `1fr auto 1fr` grid — spacer | centred
pagination | right-aligned controls). Renders through loading/error too, so Delete stays
reachable if the table fails.

**Two real CSS bugs worth remembering:**
- A `:hover` rule losing to another rule at equal specificity — fixed by matching the
  other rule's `:not(:disabled)` qualifier purely to win by source order.
- Two overlaid `<input type=range>` (dual-handle slider) each render their own
  `::-webkit-slider-runnable-track` — the top one's track painted over the bottom
  thumb, invisible in dark themes but glaring in light ones. Fix: make the second
  input's track `background: transparent`.

## Dashboards tab

Second client-side tab (pure JS show/hide, no new routes). Charting library: **Apache
ECharts**, loaded via CDN — chosen over Plotly.js because ECharts can be fully
self-hosted (Plotly's bubble-map basemap fetches from Plotly's own CDN at runtime by
default). Independent of List's active filters — always shows whole-library stats.

- Backend: `GET /api/stats` pre-aggregates via SQL `GROUP BY` into `yearCounts`,
  `popularityCounts` (bucketed by 10s), `countryCounts` — the browser never has to pull
  all ~5000 song rows just to draw charts.
- Five charts: year/decade/liked-date/popularity histograms via the shared `BarChart`
  primitive, and a world map with a bubble per country via `WorldMap` (radius
  **sqrt-scaled** to song count so bubble *area*, not radius, is proportional — what the
  eye actually perceives correctly).
- `world.geo.json` sourced from ECharts' own repo test data specifically so it's
  guaranteed compatible with their map renderer; `countryCoords.js` sourced from a
  public domain country-centroids dataset. Both one-time static assets, never
  regenerated by a script.

## List tab pagination

`client/components/Pagination/index.jsx` — a genuinely generic primitive, not tied to
songs. Truncated page-number bar (`1 … 61 62 63 … 125`) below the table, alongside the
existing Previous/Next buttons above (both coexist). Works directly off
`offset`/`limit`/`total` — the shape `SongTable` already tracked.

- **Fixed-width sliding window, not a shrinking one** — the visible window of page
  numbers slides toward whichever edge it's near instead of clamping and visibly
  narrowing there. Caught by Lucas as a real bug ("I want the size to always be fixed no
  matter location"), not a style preference — verified with an isolated test sweeping
  every page position from 1 to 125.
- **Width-driven sibling count**, targeting 80% of the content column's width (not the
  raw viewport) so pagination never ends up visibly wider than the table above it.
  Recomputes on resize, using an approximate px-per-button estimate rather than a real
  `ResizeObserver` measurement — deliberately not built that precisely.
- The current page renders via `.pagination-page.active:disabled`, more specific than
  the general `.page-button:disabled` rule — `disabled` here means "you are here," not
  "unavailable."

## Events tab

Third tab, `client/pages/events/index.jsx` — a deliberate empty stub ("just an empty
page with a big TBD in the middle," Lucas's words), added specifically as a real test
case for the first `npm run deploy` run (see the Cloudflare caching gotcha under
Deployment). No real feature defined yet — see Status below.

## Data files (all gitignored — never commit, never delete without an explicit ask)

- `playlister.db` — the live SQLite database, the actual source of truth. See "Data
  layer & query layer" above for the schema.
- `songs.json`, `artists.json`, `playlists.json`, `tokens.json` — pre-SQLite era files.
  No longer read by the app at all — left on disk untouched as a natural backup, not
  deleted. Real, hard-won API enrichment work, not something to discard casually.
- `artist-countries.json` — original pre-rename file, kept on disk untouched as a
  backup at the user's explicit request.
- `artists.json.backup-<timestamp>` — additional safety copy made before a risky edit.
- `artist-countries copy.json` — an unexplained stray file noticed mid-session; not
  created deliberately by the assistant; left untouched, flagged to the user.

## Playlists (full library, not just Liked Songs)

`scripts/sync.js`'s `syncPlaylists()` syncs every playlist (owned + followed +
collaborative), in the same `npm run sync` command as Liked Songs. Each playlist has a
**`snapshot_id`** that changes whenever its contents change — unchanged since last sync
is skipped entirely, changed/new gets a full re-fetch (detecting removals too). Liked
Songs has no `snapshot_id`, so it's always treated as changed: full-walked and
whole-replaced every sync. Requires `playlist-read-private` +
`playlist-read-collaborative` scopes. Membership lives on the **playlist**
(`playlist_tracks`), not the song, so the `songs` table stays untouched by this feature.

**Lessons worth remembering:**
- Adding those two scopes changed the playlist count from 33 (public only) to **47** —
  14 private playlists had been silently invisible with no error. Don't assume a request
  that "appears to work" means a scope isn't needed.
- Any "derive current membership from an incremental/append-only sync" design needs an
  explicit first-time full-seed path, or it silently starts from empty — or just
  full-reconcile every time if the walk is affordable (it turned out to be, here).

## Multi-tenancy

Any visitor connects their own Spotify account and gets their own private
library/dashboards, fully separate from everyone else's. Login is required for
**everyone**, including Lucas. Staying in **Spotify Development Mode** (25-user manual
allowlist) — no Extended Quota Mode review or privacy policy needed at this scale.

**Core design**: `artists`/`artist_genres`/`songs`/`song_artists` stay fully
global/shared across every user — this is the expensive, hard-won enrichment cache
(country/genre/popularity resolution), per-*artist* truth, not per-user. Only the
membership/identity layer is scoped: a song belongs to a user if it's in one of *their*
playlists (owned, followed, or their own Liked Songs). `playlist_tracks` itself also
stays global. The Liked Songs pseudo-playlist's id is `` `liked-songs:${userId}` `` (not
a single global constant) so two users' liked-songs content can never collide.

**Schema**: `users(id, display_name, sync_status, sync_error, sync_progress_*,
last_synced_at, created_at)`. `tokens` is `user_id`-keyed, not a singleton. `playlists`
has a **composite `(id, user_id)` primary key** — a real Spotify playlist can be
followed by more than one Playlister user, and a single-column PK would let the second
user's sync steal ownership from the first. `PRAGMA journal_mode = WAL` on — concurrent
per-user syncs are now routine, not a single foreground CLI writer.

**Sessions** (`sources/session.js`) — hand-rolled, not a new dependency: Playlister is
both sole writer and sole reader of exactly one cookie it fully controls. Signed with
`crypto.createHmac('sha256', SESSION_SECRET)`, verified via `crypto.timingSafeEqual`.
Spotify OAuth **is** the login — no separate password/email system. An OAuth `state`
param provides CSRF protection.

**`controllers/songs.js`** — every query goes through a mandatory `visibleToUser`
scoping, applied unconditionally. This has to cover `getFilterOptions`/`getStats` too,
not just `getSongs` — otherwise a user's genre/artist/country dropdowns and dashboard
stats would leak other users' library composition even with individual songs hidden.
Verified directly: a synthetic second user sharing one song with the real 6214-song
library correctly saw only that song via every route, cross-tenant `?playlist=` checks
correctly returned 0.

**Background sync**: no queue library — 25-user cap doesn't warrant one. One
systemd-managed process; `sync_status`/`sync_progress_*` live on the `users` row (not in
memory) so a restart mid-sync doesn't strand a user's poll loop — `recoverStuckSyncs()`
runs once at boot. Split into **two independent queues** (`sources/syncQueue.js`):
`runFastSync(userId)` (songs/playlists — bounded only by Spotify pagination speed) and
`runEnrichment(accessToken)` (country/genre resolution — rate-limited, can run minutes
to hours). `sync_status` flips to `'done'` — unblocking the UI — the moment
`runFastSync` finishes; enrichment runs after without touching it, so songs show up with
blank country/genre until it catches up. Two *separate* queues, not one, so a second
user's login never gets stuck waiting behind the first user's slow enrichment pass.

**Login sync is conditional, not automatic every time** — `enqueueSyncIfNeeded(userId,
{force})` only syncs on login if never synced, in error, or `last_synced_at` older than
24h (`SYNC_STALE_MS`); a returning user with a fresh library goes straight to the app. A
manual **Sync** button (`POST /api/sync`, `force: true`) is always available and no-ops
if a sync is already running. `App.jsx` blocks (the "building your library" screen)
**only** on a genuine first sync; otherwise a running sync surfaces as a background
"Syncing…" indicator.

**Liked Songs is a fully reconciled playlist, not an incremental append** — `syncSongs`
always full-walks `/v1/me/tracks` every sync (no per-user stop-early), and "Added" date
for sort/filter/stats is derived **per-user** as `MIN(added_at)` across the calling
user's own `playlist_tracks` rows, not a single global `songs.added_at` column (that
column is gone — it used to be written once by whoever's sync first saw a track, which
meant every other user's List order, date filters, and "liked over time" chart were
silently keyed off that first user's dates, not their own). Trade-off accepted: every
sync now re-walks the full Liked Songs list instead of stopping early — fine now that
sync is per-login (25-user cap) rather than firing on every server restart.

**Real lessons from getting here** (worth remembering elsewhere):
- An "incremental sync using a global/shared table as the stop-early signal" breaks the
  moment that table becomes a shared cache across users — a new user's walk can stop
  early because *someone else* already synced that track ID, not because they have.
  Scope any such check to the calling user's own membership, never a shared table.
- A DB write inside a transaction that can partially fail (e.g. a duplicate-track
  `INSERT` without `OR IGNORE` against a table where real duplicates are legal) can roll
  back an entire unrelated-looking write — a real Spotify playlist can legitimately
  contain the same track twice, which crashed a whole `playlistsDb.set()` and silently
  produced "zero playlists synced," even though songs had already committed separately.
- A caught error that only writes to a DB status column and never logs to the console is
  invisible without directly querying the database — always also log on a failure path,
  even when the error is already captured elsewhere.
- A migration's idempotency check should key on the actual completion signal (e.g. an
  old renamed table still existing), not a side effect that happens unconditionally
  early regardless of success (like schema auto-creation running before a data copy).

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
  - The old app **does** support genres/popularity/followers and batch endpoints — this
    is what `runArtistDetailsBackfill` depends on.
- **Redirect URI must be the literal `127.0.0.1`**, not `localhost` — Spotify requires
  the loopback IP literal for local dev redirect URIs.
- **Rate limits are real and were hit multiple times.** Root cause was re-walking
  Spotify's full saved-tracks endpoint (~101 pages) on every server restart during
  development. Fixed by: (a) never auto-triggering full walks on startup/login, (b)
  deriving the artist roster from what's already stored locally (`mergeTracks`
  stub-creates every artist's row as songs come in, so `artistsDb.getAll()` already *is*
  the roster) instead of a second Spotify walk.

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
     up to 3x with exponential backoff (2s→4s→8s) — other statuses (4xx etc.) fail
     immediately. `resolveCountries()`'s circuit breaker trips after **10 total 503s
     seen** across a run — **cumulative, not consecutive call failures** (a real bug
     caught live: under sustained load, almost every call recovers within 1-2 retries,
     so counting only fully-failed calls never trips at all). Fixed by having
     `musicbrainz.js` report *every* 503 it sees via an `onRetry` callback, recovered or
     not. Once tripped, MusicBrainz stops getting called for the rest of that run;
     skipped artists fall straight into the Wikidata cascade below. No cross-run state —
     next sync retries MusicBrainz fresh for anything still unresolved.
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
   per request (~1/sec — this endpoint doesn't support batching). Picks the entity whose
   label matches once accents/case are stripped, not just the top-ranked hit. Found QIDs
   are then batch-looked-up for country by ID (sidesteps the accent problem entirely).
5. **ISRC fallback** (`utils/isrcCountry.js`) — first 2 letters of a track's ISRC are a
   country-of-registration code. Applied **per-song**, not per-artist (different songs by
   the same artist can have different ISRCs). Needs a `UK`→`GB` remap and validated via
   `Intl.DisplayNames` — note that `.of()` does **not** throw for junk codes like reserved
   `QM`-`QZ`, it just echoes them back, so validity is checked by comparing the returned
   label against the input code.

**Current coverage: ~3522/3823 artists resolved (92.1%)**. The remaining ~300 have
survived MusicBrainz + Wikidata exact + Wikidata fuzzy + ISRC — genuinely obscure/
independent artists absent from every free structured source tried. Raw web search
works as a manual research fallback but requires per-artist human/LLM judgment, not a
programmatic API call — not automated.

**Decisions**: multi-artist songs use the **primary (first) artist's country**; genres
use the **union of all artists' genres** (genres are naturally multi-valued already).

## Other design decisions made along the way

- Barebones philosophy: no framework, `find-my-way` router only, vanilla frontend JS.
- **Four hand-switchable themes** (see "Visual themes"): Clean (light, the default) ·
  Studio (navy + neon) · Classic (the original) · Nicolas (a Comic Sans joke). Toggle in
  the tab bar, persisted to `localStorage`.
- Filters: genre, decade (not individual year — 72 years was too many for a dropdown),
  country, album type, artist, plus **dual-handle range sliders** (hand-built, no
  library) for duration, liked-date, and artist popularity. A slider dragged back to its
  full natural range reports "not filtering" rather than "filtering to the full range" —
  important because an active min/max filter on a nullable field (like popularity) would
  otherwise silently exclude every song with no value for it.
- "Create Playlist" button exists in the UI toolbar but is currently a **stub — does
  nothing**. See Status below.
- Table columns: Name, Artist(s), Album, Year, Added, Country, Genres.

## Known bugs found & fixed (don't reintroduce)

- `find-my-way` does **not** parse query strings by default — needed manual `new
  URL(req.url, ...)` parsing.
- An uncaught exception in a route handler crashes the **entire** Node process — wrapped
  the whole request handler in try/catch.
- Binding without an explicit host defaults to IPv6-only (`::`), which failed to accept
  `127.0.0.1` connections in this WSL2 environment — bind explicitly to `'0.0.0.0'`.
- A MusicBrainz batch that failed outright (503) left its artists with **no cache entry
  at all**, which later crashed a phase that assumed every artist had one — fixed by
  backfilling missing entries as `{country: null}` after each batch pass.
- `Number(params.get(x)) || null` breaks for legitimately-zero values (0 is falsy) — use
  `params.has(x) ? Number(...) : null` instead.
- Spotify occasionally returns a fully-blank stub for a track it has unlisted from its
  catalog (real ID, empty name/artist/album, duration 0) — filtered out during snapshot
  build (`if (!item.track.name) continue`).
- **Never name a destructured prop/param (with a default value) after an
  `Object.prototype` member** — `valueOf`, `toString`, `constructor`,
  `hasOwnProperty`, etc. `props.valueOf` is *never* `undefined` (inherited via the
  prototype chain), so `{ valueOf = (o) => o } = props` silently binds `valueOf` to the
  real native method instead of the default — calling it as a bare function throws
  `TypeError: Cannot convert undefined or null to object`. A real bug found exactly this
  way (`OptionsSelect`'s `valueOf` prop) — renamed to `keyOf`. Also worth noting: the
  crash surfaced as "Dashboards is broken" because clicking that tab re-rendered the
  whole (unmemoized) List-tab subtree too, and Preact aborts a whole render pass on a
  thrown error — where a bug is *reported* and where it *lives* are often different.

## Environment specifics

- WSL2 (Linux 5.15, Windows host). `127.0.0.1` browser access required an explicit
  `0.0.0.0` bind fix (see above) plus using `127.0.0.1` instead of `localhost` for the
  Spotify redirect URI.
- `.env` holds `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`
  (`http://127.0.0.1:3000/callback`), `PORT`. Currently pointed at the **old** app.

## Deployment

Live at `playlister.lucasreher.com`. **DigitalOcean droplet** (a real persistent disk —
rules out most serverless/PaaS platforms that wipe local disk on every redeploy) exposed
via **Cloudflare Tunnel** (free, no inbound port opened, automatic TLS, hides the origin
IP). Cloudflare itself was considered and rejected *as the host* — Workers/Pages
Functions are serverless/edge with no persistent local filesystem, wrong shape for a
long-running `http.createServer` process writing to a local SQLite file.

- Droplet: Ubuntu 24.04, `159.223.125.80` (**will change if the droplet is ever
  recreated** — don't treat it as permanent). SSH key-based only. Node 22 via NodeSource
  (Ubuntu's own apt repo lags behind what this project needs). Runs as a systemd service
  (`playlister.service`, `Restart=on-failure`, enabled across reboots).
- **Firewall**: `ufw` enabled (`allow OpenSSH` + `default deny incoming`) — was
  initially inactive, leaving port 3000 open to the entire public internet with no TLS.
  Caught by Lucas pushing back on an unverified "only reachable on the droplet's own
  network" assumption. **Always verify external reachability by curling the public IP
  from a separate machine** — `curl 127.0.0.1` over the same SSH session proves nothing
  about outside access. No inbound rule is needed for the app itself — the tunnel daemon
  connects *outbound* from the droplet to Cloudflare's edge.
- Domain routing is **subdomain-based, not a path prefix** — every asset/API reference
  in the app is root-absolute (`/bundle.js`, `/api/songs`), so serving under a subpath
  instead would need real code changes throughout; a subdomain needed zero app changes.
- Auth: every route requires a real per-user session now (see "Multi-tenancy" above) —
  no standalone login-gating flag left in the code.

### Publishing changes

`npm run deploy` (local) — the only piece that actually SSHes in; everything else runs
remotely (`~/.ssh/config`'s `playlister-prod` host alias keeps the droplet's IP out of
the committed repo). Chosen over a second git remote + post-receive hook (drift risk
between two copies of `main`) or GitHub Actions auto-deploy (more CI machinery than this
project has reached for anywhere else).

`scripts/deploy.sh` (git-tracked, only ever *runs* on the droplet): `git pull` → `npm
install` → timestamped `data/playlister.db` backup (last 5 kept) → `npm run migrate`
(knex, tracked via `knex_migrations`) → `npm run build` → `systemctl restart playlister`
→ Cloudflare cache purge. Migrations run before the restart so the schema matches the
code coming up.

**Gotchas worth remembering:**
- `deploy.sh` rewrites itself via `git pull` as its own first line — bash has already
  buffered the old script by the time that runs, so a change *to `deploy.sh` itself*
  only takes effect on the **second** `npm run deploy` after it's pushed. Not a bug,
  just don't assume such a change did nothing after one run.
- Cloudflare's edge caches static assets (`.js`/`.css`) for 4h when the origin gives no
  cache-control guidance, and browsers cache the same way — `deploy.sh` purges
  Cloudflare's cache as its last step (scoped API token, best-effort), but that can't
  reach a browser that already cached an old file from an earlier visit. A
  `Cache-Control` header on `routes/static.js`'s responses would close that remaining
  gap — considered, not yet built.
- Force-pushing (e.g. after squashing commits) leaves the droplet's clone pointing at
  diverged history — needs `git fetch && git reset --hard origin/main` on the droplet
  right after, or its `git pull` chokes.

## Status / open items (as of Sep 5 2026)

**Done and deployed:**
- Multi-tenancy — real per-user sessions, per-user "Added" dates, conditional login sync
  + manual Sync button.
- Preact + esbuild client rewrite.
- 4-way visual theme switcher (Clean default / Studio / Classic / Nicolas).

**Done locally, blocking next deploy:** the knex query-layer rewrite (see "Data layer &
query layer" above) is done and verified locally but not yet on the droplet — `node
scripts/bootstrap-knex-migrations.js` must run once by hand over SSH on the droplet
before its next `npm run deploy`, or that deploy's `npm run migrate` step fails trying
to `CREATE TABLE` against a database that already has the pre-knex schema.

**Open / not started:**
- "Create Playlist" is a no-op stub — needs `playlist-modify-private`/
  `playlist-modify-public` OAuth scope + real Spotify write; now per-logged-in-user
  rather than just Lucas's account.
- ~300-350 of ~4500 artists have no resolvable country from any automated source —
  accepted as the practical ceiling. Going further would need a manual-override UI or
  manual per-artist research; not started.
- Events tab is a deliberate empty stub — no real content has been discussed yet.
- Static assets (`routes/static.js`) still send no `Cache-Control` header — browsers can
  cache a stale bundle after a deploy even after Cloudflare's own cache is purged.
- The stray `artist-countries copy.json` file's origin is unexplained.
- The Delete button wipes the entire database (every user's data) and isn't gated to one
  admin — Lucas's explicit, knowing call ("yes I understand how dumb that sounds").
  Worth revisiting once other users are actually using this day-to-day, not just Lucas
  testing solo.
- Cross-tenant isolation is verified for real identities, but a deliberate side-by-side
  two-account pass is still worth doing.
