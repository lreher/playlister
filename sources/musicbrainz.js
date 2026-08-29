const USER_AGENT = 'Playlister/1.0';

function escapeLucene(name) {
  return name.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

// Batched Lucene OR search. Match accepted only on exact case-insensitive
// name + highest MusicBrainz relevance `score`, to avoid false-positive
// matches on similarly-named but unrelated artists.
async function resolveBatch(artists) {
  const query = artists.map((a) => `artist:"${escapeLucene(a.name)}"`).join(' OR ');
  const params = new URLSearchParams({ query, fmt: 'json', limit: '100' });

  const res = await fetch(`https://musicbrainz.org/ws/2/artist/?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!res.ok) {
    throw new Error(`MusicBrainz search failed: ${res.status} ${await res.text()}`);
  }

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
async function lookupArtistCountry(mbid) {
  const res = await fetch(`https://musicbrainz.org/ws/2/artist/${mbid}?fmt=json`, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!res.ok) {
    throw new Error(`MusicBrainz lookup failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.country ?? null;
}

module.exports = { resolveBatch, lookupArtistCountry };
