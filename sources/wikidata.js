const USER_AGENT = 'Playlister/1.0';
const LANG_VARIANTS = ['en', 'en-gb', 'en-ca', 'en-us', 'mul'];
const TYPE_QIDS = ['wd:Q5', 'wd:Q215380', 'wd:Q2088357']; // human, band, musical group

function stripDiacritics(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function sparqlLiteral(name) {
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return LANG_VARIANTS.map((lang) => `"${escaped}"@${lang}`).join(' ');
}

async function sparqlQuery(query) {
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
}

// Batched exact-label match via SPARQL VALUES. Requires the name to match
// Wikidata's label byte-for-byte, including accents — tagging each name
// across several English variants (en, en-gb, en-ca, en-us, mul) in the
// VALUES clause is what catches artists (e.g. Radiohead) that have no
// plain `en` label at all, while staying a fast indexed lookup. Type-
// filtered to human/band/musical-group to avoid matching unrelated
// entities (books, films, etc.) with the same name.
async function resolveWikidataBatch(artists) {
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
}

// The batched exact-label match above requires a byte-for-byte match — it
// silently misses artists like "Nidia Gongora" (Spotify, no accent) whose
// actual Wikidata label is "Nidia Góngora". wbsearchentities is Wikidata's
// own fuzzy/typo-and-accent-tolerant search, but only takes one name per
// request, so it's used only as a follow-up for the small remainder the
// batched pass couldn't find — same "second pass for stragglers" shape as
// the MusicBrainz fallback lookup.
async function searchWikidataEntity(name) {
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
  // Prefer a match that's exact once accents/case are ignored, over just the
  // top-ranked result — the top hit is sometimes an unrelated concept (e.g.
  // "Sunday Scaries" the anxiety-about-Mondays concept outranking results
  // when the band itself has no Wikidata entity at all).
  const normalized = stripDiacritics(name).toLowerCase();
  const exact = data.search.find((s) => stripDiacritics(s.label).toLowerCase() === normalized);
  return exact?.id ?? null;
}

// Batched by entity ID rather than label — sidesteps the accent-matching
// problem entirely, since it's an exact node match, not a text match.
async function lookupCountriesByQids(qids) {
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
}

module.exports = { resolveWikidataBatch, searchWikidataEntity, lookupCountriesByQids };
