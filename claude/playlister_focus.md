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

## Linting

`npm run lint` (ESLint, flat config in `eslint.config.js`). **No preset/recommended
rulesets** — Lucas's explicit call, only enable rules he's specifically asked for:
`no-var`, `eqeqeq` (strict everywhere, including `== null` — no exception carved in;
existing `!= null` checks were rewritten to explicit `!== null && !== undefined`),
`no-unused-vars`, and a `no-restricted-syntax` ban on the `function` keyword and
`class` — **arrow functions only, no classes at all**, anywhere in the codebase. No
plugins, no pre-commit hook — `npm run lint` is run by hand.

**Real constraints this rule bumps into, worth knowing before "just add a function"**:
- A knex `.whereExists()`/`.whereNotExists()`/`.leftJoin()` callback that uses `this`
  (knex binds the sub-query builder or `JoinClause` to `this`) can't be arrow-converted
  naively — arrow functions don't rebind `this`, so a mechanical swap silently breaks
  the query. Fix used throughout `controllers/songs.js` and the migrations: pass a
  fully-built sub-query object directly (`knexInstance('table').select(...)...`)
  instead of a callback, or use knex's `.leftJoin(table, (join) => ...)` form — confirmed
  from knex's own source that `join` is passed as a real argument too, not just via
  `this`.
- Object/class **getters and setters can't be written as arrow functions at all** — a
  JS syntax restriction, not a style choice. `scripts/sync.js`'s `createCircuitBreaker`
  used to expose `get tripped()`; renamed to a plain arrow method `isTripped()` instead
  (call sites: `breaker.isTripped()`, not `breaker.tripped`).

**Bulk-conversion technique** (worth reusing for future large mechanical refactors):
ESLint core has no fixer for "function → arrow" — only a satellite plugin
(`eslint-plugin-prefer-arrow-functions`) does, and it correctly skips anything using
`this`/`arguments`/`super`. Rather than leave a single-purpose plugin as a permanent
dependency, it was installed, run once with `--fix` via a temporary config file, then
immediately uninstalled — `package.json` never carries it.

## Comment style

Comments were trimmed hard across the whole codebase (commit `91480ce`) — Lucas's
explicit direction after finding them "taking up the whole page." Standard: default to
no comment; when one's needed, one plain-language line stating the single non-obvious
fact (a hidden constraint, a real bug lesson, a counterintuitive choice) — not restated
code, not multi-paragraph rationale, and *not* jargon-compressed shorthand either (an
overly-terse first attempt was rejected as unreadable without the deleted context).
Comments protecting a real previously-hit bug or security risk (cross-tenant scoping,
the `valueOf`/`keyOf` Object.prototype trap, the duplicate-track `ON CONFLICT IGNORE`
note, etc.) were kept, just compressed to 1-2 lines instead of removed. Apply this
standard to any new comment written going forward, not just the historical cleanup.

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
`knex_migrations` table, `npm run migrate`). **One migration per table**, named
`<timestamp>_create<Table>Table.js` (Lucas's explicit call, Sep 5 2026 — a migration's
filename should say what schema it creates, not bundle several tables behind a generic
`initial_schema` name). Junction tables (`artist_genres`, `song_artists`,
`playlist_tracks`) each get their own file too, not bundled into the table they're
attached to. `year`/`decade`/`country` are created directly in `createSongsTable`
(not a separate `addSongDerivedColumns` migration, even though that means a pre-knex
songs table on the droplet won't get them via bootstrap-marking — Lucas's explicit call,
droplet/existing-data consequences are a deliberately deferred problem, not this
migration's shape to solve):
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
`scripts/bootstrap-knex-migrations.js` (idempotent, one-time) marks all 8
`createXTable` migrations as already-applied without running them, so their plain
`CREATE TABLE`s don't fail against tables that already exist. A genuinely fresh install
never needs this script. **Known gap, left unhandled on purpose**: `createSongsTable`
now also creates `year`/`decade`/`country`, so bootstrap-marking it means a pre-knex
`songs` table (no such columns) never gets them — Lucas's explicit call when this was
raised (Sep 5 2026): fold the columns into `createSongsTable` regardless, and treat
whatever that does to the droplet's existing data as a separate problem to solve at
actual deploy time, not a reason to keep migration files split. **This has now been run
against the droplet — see "Droplet migration (Sep 5 2026)" below for exactly what was
done and what's still in flight.**

Local dev's db was nuked and rebuilt fresh against the new migration files twice over
(Sep 5 2026, still-developing/nothing-to-lose call) rather than surgically renaming
rows in `knex_migrations` — old db backed up to
`data/backups/playlister.db.pre-migration-split-<timestamp>` first regardless.

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
      SongTable/                   # paginated table, re-fetches on filters/offset change;
        row click toggles selection (App.jsx owns the actual state)
    playlist/
      index.jsx                  # selected-songs table + Create Playlist button/modal;
        purely presentational — no fetch of its own, see "Playlist tab"
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

Third tab. Was a deliberate empty "TBD" stub (added as a real test case for the first
`npm run deploy` run — see the Cloudflare caching gotcha under Deployment); now a real
feature, built Sep 5-6 2026: **finds real upcoming São Paulo/Rio de Janeiro/Belo
Horizonte concerts for artists actually in your own synced library**, matched and
filtered per-user like everything else in this app.

**Why this shape, not a ticketing API**: mainstream concert APIs (Ticketmaster, Songkick,
Bandsintown) either don't meaningfully cover Brazil or are dead ends for this use case —
see "Sources ruled out" below. The only sources that actually catch what Lucas wants
(small venues, tribute nights, not just arena tours) are two real, freely-fetchable
sources with no official API at all.

**Sources actually used**:
- **Polvo Manco** — a public Google Sheets spreadsheet
  (`1AIoSqsiZXkvLVte5mBdrZzMFJGXczAby8TN4QtnSHQo`), fetched via its plain CSV export URL
  (`.../export?format=csv&gid=<tab>`), no auth/API needed. **Critical, hard-won finding**:
  this is a **nationwide** spreadsheet — **25 separate tabs, one per Brazilian state** —
  discovered only after Lucas manually spotted a real Rio de Janeiro date (The Cat
  Empire, Circo Voador) that never showed up in the app. The pipeline had only ever
  fetched `gid=0` (São Paulo); RJ is `gid=638829625`, MG is `gid=1591065224`. All three
  are pulled now (`sources/eventsSearch.js`'s `POLVO_MANCO_GIDS`); the other 22 state
  tabs exist and are deliberately not pulled (Lucas's scope: "only those 2" beyond SP).
  Each tab is already fully scoped to its own state's cities — no city-name filtering
  needed once you're reading the right tab (an earlier hardcoded São-Paulo-city-name
  allowlist was built, then thrown away once this was understood). Sheet's own columns:
  `EVENTO, DATA, LOCAL, HORA, VALOR (R$), CIDADE, INGRESSOS` — a leading disclaimer row
  precedes the real header, so the header is located by content (`=== 'EVENTO'`), not by
  row index.
- **Ao Vivo** (`aovivo.substack.com`) — an independent weekly newsletter, exactly the
  small-venue/indie-show long tail ticketing platforms miss (Casa Natura Musical, Bar
  Templo, Sesc units, etc.). **Its RSS feed is a dead end for content** — `content:encoded`
  is truncated to a teaser paragraph + "Read more" link, not the real 100+-event weekly
  list; the feed is only used to find the latest `"Ao vivo: shows de ..."` post's real URL
  (other feed titles like `"🎫 Shows no Sesc..."` are one-off announcements, filtered out
  by title regex), then that page's actual HTML is fetched for the real content. Its
  format is a single regex away from structured (`EVENT_RE` in `eventsSearch.js`): `Artist
  -- Weekday, às Time 📍 Venue -- Neighborhood 🎼 Genre 🔗 Mais informações [📝 Note]`.
  Dates are **not stated per-event** — only a "🕶 D/M, weekday" header line precedes each
  day's block (glued onto that day's first artist name, stripped via `stripDayHeader`) —
  so the actual date is tracked as running state through the regex matches, combined with
  the post's own RSS `pubDate` for the year (the post text itself never states one).

**Sources ruled out, confirmed by direct testing, not assumption**:
- **Bandsintown**'s old "just pass any `app_id`" REST API is genuinely dead now — a real
  request got an AWS API-Gateway `"explicit deny in an identity-based policy"`, not a
  missing-key error. Docs/blog posts describing it as still-open are stale.
- **Songkick** actively blocks plain scripted requests (`406`, even with full
  browser-shaped headers) despite its pages being server-rendered — real bot protection,
  not a quick scrape target.
- **Shows do Sesc SP** newsletter (the obvious "official Sesc programming" source) has
  been paused indefinitely since Sept 2025 (curator moved abroad) — confirmed via its own
  RSS `pubDate`, not just a stale-looking site.
- **Sympla** (Brazil's dominant ticketing platform) — confirmed feasible but **not yet
  built**: real event data sits directly in server-rendered HTML (no headless browser
  needed), just behind obfuscated/hashed CSS-module class names, no `schema.org` markup.

**Matching** (`sources/eventsSearch.js`): every event's raw artist-name field is matched
against artist names, case/accent/whitespace-insensitive (`normalizeName`). Multi-artist
fields are genuinely messy and need real splitting, not just `,`: `"A + B"`, `"A & B"`,
`"A, B e C"` (Portuguese "and"), `"Festival Name | A, B"` (prefix), `"A, B @ Subtitle"`
(suffix) — all handled by `splitPerformers`. **Known accepted gap**: short/common names
(`BK`, `Beck`, `mgk`) can false-positive-match against an unrelated same-named entry —
Lucas's explicit call to leave these shown as-is, no confidence flag, rather than hide or
mark them.

**Architecture — global cache + per-user visibility, same pattern as songs/artists**:
matching runs against **every known artist** (`artistsDb.getAllNames()`), not scoped to
one user — mirrors how country/genre resolution already works over the whole artist
table. Results persist globally (`events` + `event_artists` tables); "your events"
is a read-time filter (`db/events.js`'s `getForUser`) joining through
`event_artists → song_artists → playlist_tracks → playlists` scoped to the requesting
`userId` — the exact same shape as `controllers/songs.js`'s `visibleToUser`. This means
one ingestion run serves every user; no per-user re-fetching needed.

**Schema**: `events` is the **first table with a surrogate id** (`increments('id')`) —
every other table so far keys off a real external id (Spotify's) or a natural composite
key; these sources (Polvo Manco, Ao Vivo) give none. De-dupe key across re-fetches is
`(source, raw_artist, date, venue)` via `onConflict().merge()`. Columns: `source,
raw_artist, date, date_label, venue, city, neighborhood, time, genre, ticket_url`.
`event_artists(event_id, artist_id)` is the join table. `date` is a real resolved
`YYYY-MM-DD` (see date-handling below), `date_label` keeps the original human string for
display. `GET /api/events` additionally filters to `date >= today` server-side — past
events are never returned, not just hidden client-side.

**Date handling, both sources needed real parsing, not just storing raw strings**:
Polvo Manco's `DATA` field is sometimes multi-day (`"05, 06 e 07/09/2026"` — only the
*last* day carries the full date, earlier days share its month/year) — resolved to the
*start* date for correct cross-source sorting (`parsePolvoMancoDate`). Ao Vivo has no
per-event date at all (see Sources above) — resolved from running day-header state +
the post's RSS year.

**"Run Search" button — live-updating, same pattern as Sync/enrichment status**:
`sources/eventsSearch.js` (the fetch/match/persist logic, used by both the button and the
CLI) + `sources/eventsSearchProgress.js` (in-memory status, identical shape to
`enrichmentProgress.js`) + `POST /api/events/search` (fire-and-forget `enqueue()`,
no-ops if already running) + `GET /api/events/search-status` (polled every 1s by the
client while running) + `scripts/fetchEvents.js` (now a thin CLI wrapper around the same
`runEventsSearch()`). Client refetches + resets to page one automatically once the poll
sees `status: 'done'`.

**UI**: table columns Artist → Date → Venue → City → Songs (a **"Songs" column showing
how many songs by that artist are already in your library** — reuses the same
`playlist_tracks`-scoped counting as everything else); multiple matched artists per event
stack vertically within their cell rather than comma-joining. Client-side pagination
(50/page, the shared `Pagination` component) — no server pagination, the whole
(already user-filtered, future-only) list is small enough to fetch once, same reasoning
as Dashboards' single fetch.

**CSS, a real gap found by "why does this look terrible"**: the app's whole visual
identity (centered card, theme-aware panel background/border/shadow, Clean theme's
frosted-glass effect, sticky table headers) was wired to the literal `#app` id and a
`songs-table` class — nothing a new page inherits automatically. Fixed by promoting the
table styling to a shared `.data-table`/`.data-table-wrap` class (Songs keeps a
`songs-table` modifier for one column-specific rule) and adding `#events` everywhere
`#app` gets panel treatment, including the Clean-theme override block.

**Real bugs hit building this, worth knowing before touching this again**:
- A script using `db/index.js`'s knex connection **hangs forever after finishing** —
  knex's pool keeps a handle open, so the event loop never empties. Needed explicit
  `process.exit(0)`/`process.exit(1)`, same as `scripts/sync.js` already does. Caught by
  noticing an old "successful" run's process was still alive minutes later.
- **A real near-miss, not just a bug**: copying a backup `.db` file directly over
  `data/playlister.db` while stale `-wal`/`-shm` sidecar files from a *different*
  db state still sat next to it caused SQLite to replay the old WAL onto the new file on
  next open — silently merging two unrelated database states (`"table events already
  exists"` was the tell). Fix: always `rm` the `-wal`/`-shm` files alongside the `.db`
  file itself before swapping in a different database file this way, not just the main
  file.

**Local dev db note (leave for next session to know)**: `data/playlister.db` currently
holds real data restored from `data/backups/playlister.db.pre-migration-split-20260905-200003`
(not the empty post-migration-split state it was left in earlier) so the Events feature
had something real to test against. Its `events`/`event_artists` tables and `events.city`
column were added by hand via raw SQL (`better-sqlite3` `db.exec()`), **not through
`knex migrate`** — that backup predates the per-table migration split entirely, so a real
`npm run migrate` run against it would conflict. The actual migration files
(`20260905000009_createEventsTable.js`, `20260905000010_createEventArtistsTable.js`) are
correct and complete for a real fresh install or the droplet's next deploy; only this
specific local file is in a hand-patched, off-the-books state. Don't assume
`knex_migrations` reflects reality on this file specifically.

## Playlist tab

Second tab, right after List (built Sep 7 2026). Lets you hand-pick songs out of your
library and push them to Spotify as a real new playlist — the old toolbar "Create
Playlist" button (a permanent no-op stub since it was first added) is now real.

**Selection, not checkboxes**: a song row in List's `SongTable` is itself the control —
click to select (toggles a `.selected` class, styled as a slightly darker/grayer row,
`client/index.css`'s `.songs-table tr.selected td`), click again to deselect. This was a
deliberate correction mid-build (an initial checkbox-column design was explicitly
rejected) — the row *is* the affordance, no separate UI element.

**State lives in `App.jsx`, not the Playlist page**: `selectedSongs`, an object keyed by
song id holding the full row object already on hand from List's fetch (no second
API call needed to populate the Playlist tab). Persisted to `localStorage`
(`playlister:selectedSongs`) so an accidental refresh doesn't lose it — survives tab
switches and List filter/page changes within a session by construction, since it's lifted
above both. The Playlist tab button shows a live `(n)` count.

**Playlist page itself is intentionally minimal** — a second explicit correction
mid-build (an initial version had an inline name field + public/private checkbox + button
row baked into the page; rejected). Final shape:
- Toolbar holds **only** the "Create Playlist" button, right-aligned via the existing
  `.create-playlist-button { margin-left: auto }` rule — same placement as Events' "Run
  Search" button, disabled when nothing's selected.
- Below it, the selected songs as a plain table (Name/Artist(s)/Album/Year); clicking a
  row here removes it (same click-to-toggle idiom as List, just one-directional).
- Clicking Create Playlist opens a native `<dialog>` modal (`.playlist-modal`,
  `showModal()`/`.close()` via a ref — no modal library) asking only for a title. No
  public/private choice in the UI at all — playlists are created **always private**
  (`isPublic: false` hardcoded in the request); a public/private toggle was proposed and
  then explicitly dropped as unneeded complexity for a personal-use tool.

**Backend**: `POST /api/playlists` (`routes/index.js`) → `controllers/playlists.js`'s
`createPlaylistFromSongs()` → `sources/spotify.js`'s new `createPlaylist()` (real Spotify
write, `POST /v1/users/{id}/playlists`) + `addTracksToPlaylist()` (`POST
/v1/playlists/{id}/tracks`, chunked at Spotify's 100-track-per-request cap) → on success,
written straight into the local `playlists`/`playlist_tracks` tables via a new
`db/playlists.js` `create()` (single-playlist insert, extracted from `set()`'s per-row
upsert logic) so the new playlist shows up immediately — `set()` itself is a
whole-collection replace and would be needlessly expensive (re-reads and re-writes every
other playlist's full track list) to reuse for adding just one. `routes/utils.js` gained
`readJsonBody(req)` — the first route in this app that needs a POST body at all.

**Scope change, real consequence**: `SCOPE` in `sources/spotify.js` now includes
`playlist-modify-public playlist-modify-private`, needed for the write calls above. Every
already-logged-in user's stored token predates this — **their first Create Playlist
attempt will fail until they log out and back in** to re-consent. Confirmed as an
accepted trade-off, not a bug to design around.

**Deployed Sep 7 2026** — no schema change was needed (playlists/playlist_tracks already
existed), so no migration ran for this one specifically. Existing users still need to
re-login once to pick up the new write scopes (see above) — not yet confirmed against a
real user's re-login on the droplet, just the code-level trade-off.

**Undo/Clear (Sep 7 2026)**: a toolbar in the same left-hand spot List's Previous/Next
occupy — `Undo` (restores the most recently removed song(s)) and `Clear` (empties the
whole selection in one action, itself undoable). Both are driven by one `undoStack` in
`App.jsx`: an array of *batches*, oldest first, where a single-row removal is a one-song
batch and Clear is a whole-selection batch — Undo always pops and restores one whole
batch, so undoing a Clear brings everything back in one click, not one song at a time.
Each batch entry is `{ song, index }` — the song's position (via `Object.entries` order)
at the moment it was removed — and Undo splices each one back into that exact index
(clamped to the current length), not just onto the top or bottom. Verified directly with
a Node script simulating both the single-removal and whole-Clear cases against the
splice logic, not just read through. Not persisted to `localStorage` (unlike the
selection itself) — a session-only safety net, deliberately cleared once a playlist is
actually created, since a fresh selection afterward shouldn't be able to resurrect old
removals.

## List tab: bulk selection, drag-select, and multi-genre search (Sep 7 2026)

- **Select All** — toolbar button next to Previous/Next/status, selects every song on the
  current page (explicitly scoped to the page, not every filtered result across pages —
  Lucas's call when asked, to avoid a surprise multi-thousand-song selection). Shows a
  "pressed" state (`.select-all-button.active`: darker fill + inset shadow) while every
  row on the page is already selected, and clicking again in that state deselects the
  page instead of re-selecting it.
- **Drag-select** — `mousedown` on a row starts a drag; whether that starting row was
  already selected decides if the drag selects or deselects as the mouse moves over other
  rows (spreadsheet-style click-drag). Ends on `mouseup` anywhere in the window, not just
  over the table, since a drag can end past its edge.
- **Genres hover-to-copy** — a truncated Genres cell pops its full text out on hover
  (`.genres-cell:hover span`, right-anchored so it stays inside the table's width instead
  of triggering horizontal scroll) as real selectable/copyable DOM text, not a native
  `title` tooltip (which can't be selected with the mouse). Its `onMouseDown` calls
  `stopPropagation()` so trying to drag-select the genre text doesn't also trigger the
  row's own drag-select handler.
- **Both single-song selection and drag-select now go through one bulk callback**,
  `onSelectSongs(songs, selected)` in `App.jsx` — replaced the old single-song
  `onToggleSong`, so a 50-row drag or Select All is one state update, not fifty.
- **Genre filter is now multi-select**, using the same `OptionsSearch` free-text/datalist
  component Artist already used (type to search, matches become removable chips;
  already-selected genres drop out of the suggestions). Selected genres are OR'd together
  server-side (`controllers/songs.js`'s `buildFilteredQuery`, `whereIn('ag.genre',
  genres)` instead of a single `andWhere` equality) — a song matches if it has *any* of
  the selected genres, confirmed by Lucas as the wanted semantics. Sent over HTTP as
  repeated `genres=` query params (`client/api.js`), read back via `params.getAll('genres')`
  (`routes/index.js`).
  - **Known gap surfaced by this, not yet resolved**: genre matching is exact-string, not
    substring — and Spotify's genre tags are already fully separate strings per
    subgenre/locale, not a hierarchy. Real example that caught this: Fishmans (country
    `JP`) has genres `dream pop`, `j-rock`, `japanese indie`, `neo-psychedelic`,
    `shibuya-kei` — selecting the `indie` chip does **not** match `japanese indie`
    (confirmed directly against the real local library: 20 distinct `*indie*` genre
    strings exist, e.g. `indie pop`, `german indie`, `japanese indie`, all separate).
    Lucas ran into this expecting Fishmans to show under a Japan-country + indie-genre
    filter. Asked whether genre matching should become substring-based (so `indie` would
    catch `japanese indie`, `indie rock`, etc., at the cost of being broader than the
    chip literally says) or stay exact-match (more precise, but requires adding every
    genre-family variant as its own chip) — **not yet answered, conversation moved on to
    an unrelated bug (Dashboards loading layout) before circling back.** Pick this back up
    before doing more genre-filter work.

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
- **A multi-row SQLite insert with `.onConflict().ignore()` fails past ~500 rows** —
  knex compiles that combination on the SQLite dialect as a `UNION ALL` of one `SELECT`
  per row, and SQLite's default compound-SELECT term limit is 500 (`too many terms in
  compound SELECT`). Hit for real re-syncing a user with 5000+ Liked Songs into
  `playlist_tracks` (`db/playlists.js`'s `set()`) — fixed by chunking the insert
  (`TRACK_INSERT_CHUNK_SIZE = 400`), commit `c1e906c`. Watch for the same shape anywhere
  else a `.insert(array).onConflict(...).ignore()/.merge()` call's row count isn't
  provably small.

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

### Droplet migration (Sep 5 2026) — in progress, resume here

The droplet had **6 real users** (not just Lucas — `80qi4nge4ypb6rn1t3kczlr2g`
Miguel, `1231542486` Lucas Reher, `12155651261` Iago Pomponet,
`sftu9tfk2kjtsh1mhel53tz3e` Nicolas, `augustocamaral` augusto, `1258042336` Jon Lu),
32283 songs, 15877 artists, 390 playlists, still on pre-knex commit `5c52ac9` when this
started — confirmed by directly querying the live db before touching anything, not
assumed. This was **not** a "nuke it, nothing to lose" situation like local dev; the
`artists` table alone represents hours of rate-limited MusicBrainz/Wikidata resolution
that would be genuinely expensive to redo.

**What was done, so it isn't redone or misunderstood as already-finished:**
1. `systemctl stop playlister`, WAL-checkpointed, then backed up
   (`data/playlister.db.manual-backup-20260905-231645` and
   `data/playlister.db.pre-table-surgery-20260905-232016`) — **keep these, don't delete
   without asking**, they're the only pre-migration snapshot of real multi-user data.
2. A one-time script (`/tmp/bootstrap-partial.js` on the droplet, not committed —
   same idea as `scripts/bootstrap-knex-migrations.js` but a **partial** baseline)
   marked only `createUsersTable`/`createArtistsTable`/`createArtistGenresTable`/
   `createTokensTable` as already-applied (those 4 tables' data is preserved,
   untouched), then dropped `songs`/`song_artists`/`playlists`/`playlist_tracks`
   outright — chosen over trying to ALTER the old pre-knex versions of those 4 tables
   in place, since they're fully repopulatable from Spotify + the intact `artists` cache.
3. `npm run migrate` then ran for real, recreating those 4 tables fresh under the new
   per-table migrations (`songs` now has `year`/`decade`/`country` from creation).
   `npm run build` + `systemctl start playlister` brought the app back up — **with those
   4 tables empty** until each user is re-synced.
4. Repopulating uses the app's own code, not a hand-written backfill: `node
   scripts/sync.js <userId>` per user does a real full sync from Spotify (fast — the
   rate-limited part is artist resolution, and `resolveCountries`/`resolveArtistDetails`
   both already skip anything with `country`/`details_resolved` already set, so they
   effectively no-op here). Doesn't need any user to log back in — `getValidAccessToken`
   reads each user's stored `refresh_token` and hits Spotify server-to-server.
5. Running this for Lucas (`1231542486`) surfaced a real bug (see "Known bugs" below,
   `db/playlists.js`'s chunked insert fix, commit `c1e906c`) — fixed, pushed, pulled and
   restarted on the droplet before retrying.

**Update (Sep 5-6 2026 session)**: Lucas's re-sync **finished successfully** — confirmed
via `pgrep`/log tail, not assumed: it survived the `/clear` that ended the previous
session (still running under its own detached SSH-spawned process), hit normal Wikidata
rate-limiting on the stragglers (`recovered 59/3413 via Wikidata fuzzy search`), and
exited with code 0 (`== Enrichment complete ==` / `== Sync complete ==`). His songs
(6232)/playlists (48)/playlist_tracks match his pre-migration numbers. Don't re-run it.

**Not yet done — pick up here:**
- Run `node scripts/sync.js <userId>` for the remaining 5 users listed above (Miguel,
  Iago, Nicolas, augusto, Jon Lu) — untouched since the migration, still on empty tables.
- Sanity-check final counts against the pre-migration snapshot (32283 songs / 15877
  artists / 390 playlists) — expect some drift from real Spotify changes since, not an
  error.
- Any of the 5 other users who visited the site while their tables were empty
  (between step 3 and their own re-sync) would have seen a blank library — not
  something to fix in data, just be aware if asked about it.

## Status / open items (as of Sep 7 2026)

**Done and deployed:**
- Multi-tenancy — real per-user sessions, per-user "Added" dates, conditional login sync
  + manual Sync button.
- Preact + esbuild client rewrite.
- 4-way visual theme switcher (Clean default / Studio / Classic / Nicolas).
- ESLint added (no preset rules, arrow-functions-only + no-var/eqeqeq/no-unused-vars),
  whole codebase converted to comply, and a codebase-wide comment-trim pass — see
  "Linting" and "Comment style" above. Commit `91480ce`.
- **Events tab** — São Paulo/Rio/BH concert discovery (Polvo Manco + Ao Vivo sources).
  Deployed Sep 7 2026 (commit `6425ff2`'s deploy). **Surprising find while deploying**:
  `npm run migrate` reported "Already up to date" for the `events`/`event_artists`
  tables — meaning they'd already been applied to the droplet at some earlier point not
  reflected in this doc's prior text (which said "never deployed" as of Sep 5-6). Not
  investigated further (not urgent — a no-op migration is harmless either way), but worth
  knowing the "never deployed" claim below was stale before today, in case that matters
  for reasoning about droplet state elsewhere.
- **Playlist tab** — click-to-select in List, review/remove/Undo/Clear in a new Playlist
  tab, real (always-private) Spotify playlist creation via a modal. Deployed Sep 7 2026.
  Existing users (everyone but a freshly-logging-in one) still need to re-login once to
  pick up the new write scopes before Create Playlist works for them — not yet confirmed
  against a real user hitting this on the droplet.
- **List tab: Select All, drag-select, multi-genre filter, genre hover-to-copy** (Sep 7
  2026) — see "List tab: bulk selection, drag-select, and multi-genre search" above for
  full detail, including the still-open genre exact-match-vs-substring question.

**In progress — droplet migration**: the knex query-layer rewrite is deployed to the
droplet, schema migrated, service back up, Lucas's own data fully re-synced and
confirmed. Not finished: 5 of 6 real users still need `node scripts/sync.js <userId>` run
to repopulate their songs/playlists under the new schema. Full detail, exact commands,
and user-id list to resume with: **"Droplet migration (Sep 5 2026)" under Deployment,
above** — read that before doing anything else here.

**Open / not started:**
- **Genre matching: exact-string vs. substring — asked, not yet answered.** Selecting the
  `indie` genre chip doesn't match `japanese indie` (a separate exact tag, not a
  substring relationship) — surfaced via a real Fishmans example. Lucas was asked
  whether genre filtering should become substring-based instead of exact-match; the
  conversation moved to an unrelated bug (Dashboards loading layout) before answering.
  Pick this back up before doing more genre-filter work — see "List tab" above for the
  full writeup and the concrete data behind it.
- ~300-350 of ~4500 artists have no resolvable country from any automated source —
  accepted as the practical ceiling. Going further would need a manual-override UI or
  manual per-artist research; not started.
- Static assets (`routes/static.js`) still send no `Cache-Control` header — browsers can
  cache a stale bundle after a deploy even after Cloudflare's own cache is purged. This
  bit for real this session: a genre-filter fix looked broken in the browser purely from
  a stale cached `bundle.js`, resolved by a hard refresh — see the "Verification" note
  added to musings.md.
- The stray `artist-countries copy.json` file's origin is unexplained.
- The Delete button wipes the entire database (every user's data) and isn't gated to one
  admin — Lucas's explicit, knowing call ("yes I understand how dumb that sounds").
  Worth revisiting once other users are actually using this day-to-day, not just Lucas
  testing solo.
- Cross-tenant isolation is verified for real identities, but a deliberate side-by-side
  two-account pass is still worth doing.
