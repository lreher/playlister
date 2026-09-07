// A 401 means not logged in — let it throw and App handles it at the top level.
const fetchJson = async (url) => {
  const res = await fetch(url);
  if (res.status === 401) {
    const err = new Error('not_authenticated');
    err.unauthenticated = true;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Request failed');
  }
  return res.json();
};

export const getMe = () => fetchJson('/api/me');

export const getSyncStatus = () => fetchJson('/api/sync-status');

export const requestSync = async () => {
  const res = await fetch('/api/sync', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to start sync');
  }
  return res.json();
};

export const getEnrichmentStatus = () => fetchJson('/api/enrichment-status');

export const wipeDatabase = async () => {
  const res = await fetch('/api/wipe-database', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to delete');
  }
  return res.json();
};

export const getFilters = () => fetchJson('/api/filters');

export const getStats = () => fetchJson('/api/stats');

// Only non-empty/non-null filter values get sent as query params.
export const getSongs = ({ limit, offset, filters }) => {
  const params = new URLSearchParams({ limit, offset });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== '' && value !== null) params.set(key, value);
  }
  return fetchJson(`/api/songs?${params.toString()}`);
};

export const getEvents = () => fetchJson('/api/events');

export const requestEventsSearch = async () => {
  const res = await fetch('/api/events/search', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to start search');
  }
  return res.json();
};

export const getEventsSearchStatus = () => fetchJson('/api/events/search-status');

export const createPlaylist = async ({ name, isPublic, songIds }) => {
  const res = await fetch('/api/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, isPublic, songIds }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to create playlist');
  }
  return res.json();
};

export const getWorldGeoJson = async () => {
  const res = await fetch('/world.geo.json');
  return res.json();
};
