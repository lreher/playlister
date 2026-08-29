const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

// ISRC uses "UK" for the United Kingdom instead of ISO 3166-1's "GB".
const ISRC_REMAP = { UK: 'GB' };

function countryFromIsrc(isrc) {
  if (!isrc || isrc.length < 2) return null;

  const prefix = ISRC_REMAP[isrc.slice(0, 2).toUpperCase()] ?? isrc.slice(0, 2).toUpperCase();

  // Intl.DisplayNames doesn't throw for reserved/unassigned codes (e.g. the
  // ISRC-reserved QM-QZ range) — it just echoes the code back, or returns a
  // generic label for "ZZ". A resolved *real* name differs from the input.
  const label = countryNames.of(prefix);
  if (label === prefix || prefix === 'ZZ') return null;
  return prefix;
}

module.exports = { countryFromIsrc };
