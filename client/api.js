// Thin fetch wrappers around the backend's JSON API. No React/Preact
// knowledge here — components own their own loading/error state.

export async function getFilters() {
  const res = await fetch('/api/filters');
  if (!res.ok) throw new Error('Failed to load filters');
  return res.json();
}

export async function getStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error('Failed to load stats');
  return res.json();
}

// filters' keys are exactly the /api/songs query param names — only the
// ones actually set (non-'', non-null) get sent.
export async function getSongs({ limit, offset, filters }) {
  const params = new URLSearchParams({ limit, offset });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== '' && value !== null) params.set(key, value);
  }

  const res = await fetch(`/api/songs?${params.toString()}`);
  if (res.status === 401) return { unauthenticated: true };
  if (!res.ok) {
    const { error } = await res.json();
    throw new Error(error);
  }
  return res.json();
}

export async function getWorldGeoJson() {
  const res = await fetch('/world.geo.json');
  return res.json();
}
