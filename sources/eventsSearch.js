const artistsDb = require('../db/artists');
const eventsDb = require('../db/events');
const syncDb = require('../db/index')('sync');
const eventsSearchProgress = require('./eventsSearchProgress');

// The sheet is nationwide - one tab (gid) per Brazilian state, each already scoped to
// that state's own cities. Only São Paulo (default gid=0), Rio de Janeiro, and Minas
// Gerais are pulled, per Lucas's request ("only those 2" states beyond SP).
const POLVO_MANCO_SHEET_ID = '1AIoSqsiZXkvLVte5mBdrZzMFJGXczAby8TN4QtnSHQo';
const POLVO_MANCO_GIDS = { saoPaulo: '0', rioDeJaneiro: '638829625', minasGerais: '1591065224' };
const polvoMancoCsvUrl = (gid) => `https://docs.google.com/spreadsheets/d/${POLVO_MANCO_SHEET_ID}/export?format=csv&gid=${gid}`;
const AOVIVO_FEED_URL = 'https://aovivo.substack.com/feed';
const WEEKDAY = 'segunda|terça|quarta|quinta|sexta|sábado|domingo';

const stripDiacritics = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const normalizeName = (s) => stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Event artist fields are messy: "A + B + C" / "A & B" / "A, B e C" combos, sometimes with a
// "Festival Name | " prefix or a " @ Subtitle" suffix glued onto the adjacent artist name.
const splitPerformers = (raw) => {
  let s = raw;
  if (s.includes('|')) s = s.split('|').pop();
  s = s.split(/\s+@\s+/)[0];
  return s.split(/\s*[+&]\s*|,\s*|\s+e\s+/i).map((p) => p.trim()).filter(Boolean);
};

const matchLibrary = (eventArtistField, libraryByNorm) => {
  const hits = [];
  for (const performer of splitPerformers(eventArtistField)) {
    const norm = normalizeName(performer);
    if (libraryByNorm.has(norm)) hits.push(libraryByNorm.get(norm));
  }
  return hits;
};

const parseCsvLine = (line) => {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
};

// Polvo Manco dates are messy: "05/09/2026" but also "05, 06 e 07/09/2026" (only the last
// day carries the full date; earlier days share its month/year) - take the first day listed
// paired with the month/year off the last full date, so a multi-day event sorts by its start.
const parsePolvoMancoDate = (raw) => {
  const fullDates = [...raw.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)];
  if (fullDates.length === 0) return null;
  const [, , month, year] = fullDates[fullDates.length - 1];
  const firstDay = raw.match(/\d{1,2}/)[0];
  return `${year}-${month.padStart(2, '0')}-${firstDay.padStart(2, '0')}`;
};

const parseCsv = (text) => {
  const rows = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    cur += ch;
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === '\n' && !inQuotes) { rows.push(cur); cur = ''; }
  }
  if (cur.trim()) rows.push(cur);
  return rows.map(parseCsvLine);
};

// Skips the sheet's own leading disclaimer rows and locates the real header by content.
// Each state tab is already scoped to that state's own cities - no city-name filtering
// needed, unlike the old single-tab approach that only ever saw São Paulo's tab at all.
const fetchPolvoMancoTab = async (gid, libraryByNorm) => {
  const res = await fetch(polvoMancoCsvUrl(gid));
  const rows = parseCsv(await res.text());

  const headerRowIdx = rows.findIndex((r) => r.some((c) => c.trim().toUpperCase() === 'EVENTO'));
  const header = rows[headerRowIdx];
  const data = rows.slice(headerRowIdx + 1).filter((r) => r.some((c) => c.trim()));

  const eventoIdx = header.findIndex((h) => h.trim().toUpperCase() === 'EVENTO');
  const dataIdx = header.findIndex((h) => h.trim().toUpperCase() === 'DATA');
  const localIdx = header.findIndex((h) => h.trim().toUpperCase() === 'LOCAL');
  const cidadeIdx = header.findIndex((h) => h.trim().toUpperCase() === 'CIDADE');
  const ingressosIdx = header.findIndex((h) => h.trim().toUpperCase().startsWith('INGRESSOS'));

  return data
    .map((r) => ({
      source: 'polvo-manco',
      rawArtist: r[eventoIdx],
      date: parsePolvoMancoDate(r[dataIdx]),
      dateLabel: r[dataIdx],
      venue: r[localIdx],
      city: (r[cidadeIdx] || '').trim(),
      ticketUrl: (r[ingressosIdx] || '').trim(),
      hits: matchLibrary(r[eventoIdx], libraryByNorm),
    }))
    .filter((e) => e.hits.length > 0 && e.date !== null);
};

const fetchPolvoManco = async (libraryByNorm) => {
  const tabs = await Promise.all(
    Object.values(POLVO_MANCO_GIDS).map((gid) => fetchPolvoMancoTab(gid, libraryByNorm))
  );
  return tabs.flat();
};

// Day-header lines ("🏃🏻‍♀️ 1/9, terça") glue onto the next artist name - strip that prefix,
// but first pull the D/M date out of it, since it's the only place this post states one.
const DAY_HEADER_RE = /(\d{1,2})\/(\d{1,2}),\s*(?:segunda|terça|quarta|quinta|sexta|sábado|domingo)/iu;
const stripDayHeader = (s) => s.replace(/^.*?\d{1,2}\/\d{1,2},\s*\S+\s+/u, '').trim();

const NOTE = `Grátis|Esgotado|Lançamento de disco|(?:${WEEKDAY})(?:\\s*(?:e|a)\\s*(?:${WEEKDAY}))?(?:\\s*\\(\\d{1,2}\\/\\d{1,2}\\))?(?:;\\s*lançamento de disco)?`;
const EVENT_RE = new RegExp(
  `([^🕶🎼📍🔗📝\\n]+?)\\s*--\\s*(${WEEKDAY})[^,🎼📍🔗📝]*,\\s*às\\s*([\\d:h]+)(?:\\s*\\(abertura\\))?\\s*📍\\s*([^🎼📍🔗📝]+?)\\s*--\\s*([^🎼📍🔗📝]+?)\\s*🎼\\s*([^🎼📍🔗📝]+?)\\s*🔗\\s*Mais informações\\s*(?:📝\\s*(${NOTE}))?`,
  'giu'
);

// Only the latest "Ao vivo: shows de ..." post is the actual weekly agenda - other
// feed entries are one-off announcements (e.g. "Shows no Sesc para comprar hoje").
const fetchAoVivo = async (libraryByNorm) => {
  const feedRes = await fetch(AOVIVO_FEED_URL);
  const xml = await feedRes.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

  const weeklyItem = items.find((item) => /^ao vivo:\s*shows de/i.test(
    item.match(/<title>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/title>/)?.[1] ?? ''
  ));
  if (!weeklyItem) return [];

  const weeklyLink = weeklyItem.match(/<link>([\s\S]*?)<\/link>/)?.[1];
  // The post has no year anywhere in its own text - only its RSS pubDate does.
  const postYear = new Date(weeklyItem.match(/<pubDate>([\s\S]*?)<\/pubDate>/)[1]).getFullYear();

  const pageHtml = await (await fetch(weeklyLink)).text();
  const bodyMatch = pageHtml.match(/<div class="available-content"[\s\S]*?>([\s\S]*)<\/article>/);
  const text = (bodyMatch?.[1] ?? '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

  // Only the first event under each day header carries a "D/M, weekday" prefix - later
  // events in the same day-block rely on that same date, so it's tracked as running state.
  let currentDate = null;
  const events = [];
  for (const m of text.matchAll(EVENT_RE)) {
    const headerMatch = m[1].match(DAY_HEADER_RE);
    if (headerMatch) {
      const [, day, month] = headerMatch;
      currentDate = `${postYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    const rawArtist = stripDayHeader(m[1]);
    const hits = matchLibrary(rawArtist, libraryByNorm);
    if (hits.length === 0) continue;
    events.push({
      source: 'ao-vivo',
      rawArtist,
      date: currentDate,
      dateLabel: `${currentDate} ${m[3].trim()}`,
      time: m[3].trim(),
      venue: m[4].trim(),
      // Ao Vivo is a São Paulo-only newsletter by design - no per-event city field exists.
      city: 'São Paulo',
      neighborhood: m[5].trim(),
      genre: m[6].trim(),
      hits,
    });
  }
  return events;
};

// Matches against every known artist (like scripts/sync.js's country/genre resolution),
// not one user's library - events are shared data, filtered per-user at read time
// (db/events.js's getForUser) the same way songs/playlists already are. Used both by the
// CLI script and the Events tab's "Run Search" button (via enqueue() below).
const runEventsSearch = async (knexInstance = syncDb) => {
  eventsSearchProgress.setStatus('running', 'Fetching Polvo Manco and Ao Vivo');
  const allArtists = await artistsDb.getAllNames(knexInstance);
  const libraryByNorm = new Map(allArtists.map((a) => [normalizeName(a.name), a]));

  const [polvoEvents, aoVivoEvents] = await Promise.all([
    fetchPolvoManco(libraryByNorm),
    fetchAoVivo(libraryByNorm),
  ]);

  eventsSearchProgress.setStatus('running', 'Storing matched events');
  const allEvents = [...polvoEvents, ...aoVivoEvents].sort((a, b) => a.date.localeCompare(b.date));
  await eventsDb.upsertMany(allEvents, knexInstance);

  eventsSearchProgress.setStatus('done', `Found ${allEvents.length} events`);
  return allEvents;
};

let running = false;

// Fire-and-forget kickoff for the HTTP route - no-ops if a search is already in flight,
// same shape as syncQueue's guard against a second Sync click piling on the first.
const enqueue = () => {
  if (running) return;
  running = true;
  runEventsSearch()
    .catch((err) => {
      console.error('[events-search] failed:', err.message);
      eventsSearchProgress.setStatus('error', err.message);
    })
    .finally(() => {
      running = false;
    });
};

module.exports = { runEventsSearch, enqueue };
