const db = require('../db/index')();
const tokens = require('../db/tokens');
const users = require('../db/users');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const SCOPE =
  'user-library-read playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private';

const getAuthorizeUrl = (state) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
};

const basicAuthHeader = () => 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

const fetchProfile = async (accessToken) => {
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Spotify profile fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { id: data.id, displayName: data.display_name ?? null };
};

// Exchanges the OAuth code and resolves who logged in — Spotify's own identity is the
// login here, there's no separate account system.
const exchangeCodeForTokens = async (code, knexInstance = db) => {
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
  const profile = await fetchProfile(data.access_token);

  await users.upsert({ id: profile.id, displayName: profile.displayName }, knexInstance);
  await tokens.set(
    profile.id,
    {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    },
    knexInstance
  );

  return { userId: profile.id, displayName: profile.displayName };
};

const refreshAccessToken = async (userId, refreshToken, knexInstance = db) => {
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
  await tokens.set(
    userId,
    {
      access_token: data.access_token,
      // Spotify may omit refresh_token on refresh; keep the old one if so.
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + data.expires_in * 1000,
    },
    knexInstance
  );

  return data.access_token;
};

const getValidAccessToken = async (userId, knexInstance = db) => {
  const current = await tokens.get(userId, knexInstance);
  if (!current) return null;

  if (Date.now() < current.expires_at) {
    return current.access_token;
  }

  return refreshAccessToken(userId, current.refresh_token, knexInstance);
};

const getLikedSongsPage = async (accessToken, { limit, offset }) => {
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
};

// Spotify caps a single add-tracks call at 100 URIs.
const ADD_TRACKS_CHUNK_SIZE = 100;

const createPlaylist = async (accessToken, spotifyUserId, { name, isPublic }) => {
  const res = await fetch(`https://api.spotify.com/v1/users/${spotifyUserId}/playlists`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, public: isPublic }),
  });
  if (!res.ok) {
    throw new Error(`Spotify create-playlist failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    public: !!data.public,
    ownerName: data.owner?.display_name ?? null,
  };
};

// Chunked and posted sequentially so each chunk lands, in order, on top of the last.
const addTracksToPlaylist = async (accessToken, playlistId, trackIds) => {
  let snapshotId = null;
  for (let i = 0; i < trackIds.length; i += ADD_TRACKS_CHUNK_SIZE) {
    const chunk = trackIds.slice(i, i + ADD_TRACKS_CHUNK_SIZE);
    const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: chunk.map((id) => `spotify:track:${id}`) }),
    });
    if (!res.ok) {
      throw new Error(`Spotify add-tracks failed: ${res.status} ${await res.text()}`);
    }
    snapshotId = (await res.json()).snapshot_id;
  }
  return snapshotId;
};

module.exports = {
  getAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getValidAccessToken,
  getLikedSongsPage,
  createPlaylist,
  addTracksToPlaylist,
};
