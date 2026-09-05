const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

export const countryLabel = (code) => {
  if (!code) return '—';
  try {
    return countryNames.of(code.toUpperCase());
  } catch {
    return code;
  }
};

export const formatDuration = (ms) => {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

export const formatDateShort = (epochMs) => new Date(epochMs).toISOString().slice(0, 10);
