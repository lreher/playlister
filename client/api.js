// Thin fetch wrappers around the backend's JSON API. No React/Preact
// knowledge here — components own their own loading/error state.

// Every /api/* route requires a session now — a 401 means "not logged in,"
// which App owns at the top level (shows the Connect Spotify screen), so
// every caller here can just let it throw rather than each handling it
// separately.
async function fetchJson(url) {
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
}

export function getMe() {
  return fetchJson('/api/me');
}

export function getSyncStatus() {
  return fetchJson('/api/sync-status');
}

export function getFilters() {
  return fetchJson('/api/filters');
}

export function getStats() {
  return fetchJson('/api/stats');
}

// filters' keys are exactly the /api/songs query param names — only the
// ones actually set (non-'', non-null) get sent.
export function getSongs({ limit, offset, filters }) {
  const params = new URLSearchParams({ limit, offset });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== '' && value !== null) params.set(key, value);
  }
  return fetchJson(`/api/songs?${params.toString()}`);
}

export async function getWorldGeoJson() {
  const res = await fetch('/world.geo.json');
  return res.json();
}
