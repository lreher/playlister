const USER_AGENT = 'Playlister/1.0';
const LANG_VARIANTS = ['en', 'en-gb', 'en-ca', 'en-us', 'mul'];
const TYPE_QIDS = ['wd:Q5', 'wd:Q215380', 'wd:Q2088357']; // human, band, musical group

const stripDiacritics = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '');

const sparqlLiteral = (name) => {
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return LANG_VARIANTS.map((lang) => `"${escaped}"@${lang}`).join(' ');
};

const sparqlQuery = async (query) => {
  const res = await fetch('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ query }),
  });

  if (!res.ok) {
    throw new Error(`Wikidata query failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
};

// Batched exact-label match. Tags each name across several English variants (en, en-gb,
// mul, etc.) since some artists (e.g. Radiohead) have no plain `en` label at all.
const resolveWikidataBatch = async (artists) => {
  const values = artists.map((a) => sparqlLiteral(a.name)).join(' ');
  const typeFilter = TYPE_QIDS.join(', ');

  const data = await sparqlQuery(`
    SELECT ?name ?isoCode WHERE {
      VALUES ?name { ${values} }
      ?item rdfs:label ?name.
      ?item wdt:P31 ?instance.
      FILTER(?instance IN (${typeFilter}))
      OPTIONAL { ?item wdt:P27 ?country. }
      OPTIONAL { ?item wdt:P495 ?country. }
      OPTIONAL { ?country wdt:P297 ?isoCode. }
    }
  `);

  const countryByName = new Map();
  for (const row of data.results.bindings) {
    const name = row.name.value;
    if (!countryByName.has(name) && row.isoCode) {
      countryByName.set(name, row.isoCode.value);
    }
  }

  const results = {};
  for (const artist of artists) {
    results[artist.id] = { name: artist.name, country: countryByName.get(artist.name) ?? null };
  }

  return results;
};

// Fuzzy fallback for names the exact-label match misses due to accents (e.g. Spotify's
// unaccented "Nidia Gongora" vs Wikidata's "Nidia Góngora"). One name per request.
const searchWikidataEntity = async (name) => {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language: 'en',
    format: 'json',
    limit: '5',
  });

  const res = await fetch(`https://www.wikidata.org/w/api.php?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!res.ok) {
    throw new Error(`Wikidata search failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  // Prefer an accent/case-insensitive exact match over the top-ranked result — the top
  // hit is sometimes an unrelated concept with no real entity for the band at all.
  const normalized = stripDiacritics(name).toLowerCase();
  const exact = data.search.find((s) => stripDiacritics(s.label).toLowerCase() === normalized);
  return exact?.id ?? null;
};

// Batched by entity ID — sidesteps the accent problem entirely, it's an exact node match.
const lookupCountriesByQids = async (qids) => {
  const values = qids.map((id) => `wd:${id}`).join(' ');
  const data = await sparqlQuery(`
    SELECT ?item ?isoCode WHERE {
      VALUES ?item { ${values} }
      OPTIONAL { ?item wdt:P27 ?country. }
      OPTIONAL { ?item wdt:P495 ?country. }
      OPTIONAL { ?country wdt:P297 ?isoCode. }
    }
  `);

  const countryByQid = new Map();
  for (const row of data.results.bindings) {
    const qid = row.item.value.split('/').pop();
    if (!countryByQid.has(qid) && row.isoCode) {
      countryByQid.set(qid, row.isoCode.value);
    }
  }
  return countryByQid;
};

module.exports = { resolveWikidataBatch, searchWikidataEntity, lookupCountriesByQids };
