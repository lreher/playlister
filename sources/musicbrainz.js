const USER_AGENT = 'Playlister/1.0';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// MusicBrainz returns 503 when it's overloaded/rate-limiting, not just on
// hard failures — worth a few retries with backoff before giving up, unlike
// other statuses (4xx etc.) which won't fix themselves on retry.
//
// `onRetry`, if given, fires on *every* 503 seen, including one a later
// retry recovers from. That matters: under sustained load, individual
// requests mostly succeed after 1-2 retries, so counting only calls that
// fully exhaust their retries and fail (the caller's old approach) never
// sees how much distress is actually happening — every "successful" call
// still burned a 503 first.
async function fetchWithRetry(url, options, onRetry) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 503) return res;
    if (onRetry) onRetry();
    if (attempt >= MAX_RETRIES) return res;
    const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
    console.warn(`[musicbrainz] 503, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
  }
}

async function throwIfNotOk(res, label) {
  if (!res.ok) {
    const error = new Error(`${label} failed: ${res.status} ${await res.text()}`);
    error.status = res.status;
    throw error;
  }
}

function escapeLucene(name) {
  return name.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

// Batched Lucene OR search. Match accepted only on exact case-insensitive
// name + highest MusicBrainz relevance `score`, to avoid false-positive
// matches on similarly-named but unrelated artists.
async function resolveBatch(artists, onRetry) {
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
}

// The search index sometimes lacks `country` for an artist even when their
// full record has it (a MusicBrainz search-index quirk) — a direct lookup
// by ID recovers it.
async function lookupArtistCountry(mbid, onRetry) {
  const res = await fetchWithRetry(
    `https://musicbrainz.org/ws/2/artist/${mbid}?fmt=json`,
    { headers: { 'User-Agent': USER_AGENT } },
    onRetry
  );
  await throwIfNotOk(res, 'MusicBrainz lookup');

  const data = await res.json();
  return data.country ?? null;
}

module.exports = { resolveBatch, lookupArtistCountry };
