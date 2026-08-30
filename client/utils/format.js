// Display-formatting helpers shared across components. Separate from
// api.js on purpose — these are pure functions, no fetching involved.

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function countryLabel(code) {
  if (!code) return '—';
  try {
    return countryNames.of(code.toUpperCase());
  } catch {
    return code;
  }
}

export function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatDateShort(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}
