const USER_AGENT = 'Playlister/1.0';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 503 means MusicBrainz is overloaded, not a hard failure — worth retrying with backoff.
// onRetry fires on every 503 seen, even ones a later retry recovers from, since the
// caller (scripts/sync.js) needs the raw count to notice sustained trouble.
const fetchWithRetry = async (url, options, onRetry) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 503) return res;
    if (onRetry) onRetry();
    if (attempt >= MAX_RETRIES) return res;
    const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
    console.warn(`[musicbrainz] 503, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
  }
};

const throwIfNotOk = async (res, label) => {
  if (!res.ok) {
    const error = new Error(`${label} failed: ${res.status} ${await res.text()}`);
    error.status = res.status;
    throw error;
  }
};

const escapeLucene = (name) => name.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');

// Batched Lucene OR search. Only accepts an exact case-insensitive name match with the
// highest score, to avoid matching a similarly-named but unrelated artist.
const resolveBatch = async (artists, onRetry) => {
  const query = artists.map((a) => `artist:"${escapeLucene(a.name)}"`).join(' OR ');
  const params = new URLSearchParams({ query, fmt: 'json', limit: '100' });

  const res = await fetchWithRetry(
    `https://musicbrainz.org/ws/2/artist/?${params.toString()}`,
    { headers: { 'User-Agent': USER_AGENT } },
    onRetry
  );
  await throwIfNotOk(res, 'MusicBrainz search');

  const data = await res.json();
  const results = {};

  for (const artist of artists) {
    const matches = data.artists.filter(
      (candidate) => candidate.name.toLowerCase() === artist.name.toLowerCase()
    );
    matches.sort((a, b) => b.score - a.score);
    const best = matches[0];
    results[artist.id] = { name: artist.name, country: best?.country ?? null, mbid: best?.id ?? null };
  }

  return results;
};

// The search index sometimes lacks country even when the full record has it — a direct
// lookup by ID recovers it.
const lookupArtistCountry = async (mbid, onRetry) => {
  const res = await fetchWithRetry(
    `https://musicbrainz.org/ws/2/artist/${mbid}?fmt=json`,
    { headers: { 'User-Agent': USER_AGENT } },
    onRetry
  );
  await throwIfNotOk(res, 'MusicBrainz lookup');

  const data = await res.json();
  return data.country ?? null;
};

module.exports = { resolveBatch, lookupArtistCountry };
