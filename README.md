# Playlister

Pulls your entire Spotify library — Liked Songs plus every playlist — into a local,
Spotify-agnostic SQLite database, enriched with country of origin, genre, and popularity.
Browse and filter it in a List tab, or explore it visually in a Dashboards tab.

## Setup

1. `npm install`
2. Create a Spotify app at [developer.spotify.com](https://developer.spotify.com/dashboard)
   and add `http://127.0.0.1:3000/callback` as a redirect URI.
3. Copy `.env.example` to `.env` and fill in your app's client ID/secret.

## Usage

```
npm start
```

Open `http://127.0.0.1:3000`, click **Log in with Spotify**, then run:

```
npm run sync
```

to pull your library and enrich it with country/genre/popularity data (takes a while the
first time — it's calling several external APIs). Re-run `npm run sync` any time to fetch
new songs and playlist changes.
