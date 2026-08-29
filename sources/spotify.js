const tokens = require('../db/tokens');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const SCOPE = 'user-library-read playlist-read-private playlist-read-collaborative';

function getAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Spotify token exchange failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  tokens.set({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  tokens.set({
    access_token: data.access_token,
    // Spotify may omit refresh_token on refresh; keep the old one if so.
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + data.expires_in * 1000,
  });

  return data.access_token;
}

async function getValidAccessToken() {
  const current = tokens.get();
  if (!current) return null;

  if (Date.now() < current.expires_at) {
    return current.access_token;
  }

  return refreshAccessToken(current.refresh_token);
}

async function getLikedSongsPage(accessToken, { limit, offset }) {
  const params = new URLSearchParams({ limit, offset });
  const res = await fetch(`https://api.spotify.com/v1/me/tracks?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Spotify library fetch failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return {
    items: data.items.map((item) => ({
      id: item.track.id,
      name: item.track.name,
      artists: item.track.artists.map((a) => ({ id: a.id, name: a.name })),
      album: item.track.album.name,
      addedAt: item.added_at,
      isrc: item.track.external_ids?.isrc ?? null,
    })),
    total: data.total,
    limit: data.limit,
    offset: data.offset,
  };
}

module.exports = {
  getAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getValidAccessToken,
  getLikedSongsPage,
};
