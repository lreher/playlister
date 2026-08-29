// Filter state + the List tab's filter row (dropdowns, artist search,
// range sliders). Depends on createDualSlider (rangeSlider.js, must load
// first) and calls loadPage() (songTable.js) from its change handlers and
// resetButton — those are late-bound function calls, so songTable.js can
// load either before or after this file, as long as it's loaded before any
// handler actually fires (i.e. before the page finishes loading).

const filtersEl = document.getElementById('filters');

let genreFilter = '';
let yearFilter = '';
let decadeFilter = '';
let countryFilter = '';
let albumTypeFilter = '';
let artistFilter = '';
let playlistFilter = '';
let durationMin = null;
let durationMax = null;
let addedFrom = '';
let addedTo = '';
let popularityMin = null;
let popularityMax = null;

// Populated by loadFilters() once its controls exist; read by
// applyDashboardFilter() (tabs.js) so a dashboard-chart click can both set
// filter state and visually sync the matching dropdown.
let filterControls = {};

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

function countryLabel(code) {
  if (!code) return '—';
  try {
    return countryNames.of(code.toUpperCase());
  } catch {
    return code;
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDateShort(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function resetFilterState() {
  genreFilter = '';
  yearFilter = '';
  decadeFilter = '';
  countryFilter = '';
  albumTypeFilter = '';
  artistFilter = '';
  playlistFilter = '';
  durationMin = null;
  durationMax = null;
  addedFrom = '';
  addedTo = '';
  popularityMin = null;
  popularityMax = null;
  for (const select of filterControls.selects ?? []) select.value = '';
  for (const slider of filterControls.sliders ?? []) slider.reset();
}

async function loadFilters() {
  const res = await fetch('/api/filters');
  if (!res.ok) return;
  const {
    genres,
    years,
    decades,
    countries,
    albumTypes,
    artists,
    playlists,
    durationRange,
    addedRange,
    popularityRange,
  } = await res.json();

  const genreSelect = document.createElement('select');
  genreSelect.appendChild(new Option('All genres', ''));
  for (const genre of genres) genreSelect.appendChild(new Option(genre, genre));
  genreSelect.onchange = () => {
    genreFilter = genreSelect.value;
    offset = 0;
    loadPage();
  };

  const yearSelect = document.createElement('select');
  yearSelect.appendChild(new Option('All years', ''));
  for (const year of years) yearSelect.appendChild(new Option(year, year));
  yearSelect.onchange = () => {
    yearFilter = yearSelect.value;
    offset = 0;
    loadPage();
  };

  const decadeSelect = document.createElement('select');
  decadeSelect.appendChild(new Option('All decades', ''));
  for (const decade of decades) decadeSelect.appendChild(new Option(decade, decade));
  decadeSelect.onchange = () => {
    decadeFilter = decadeSelect.value;
    offset = 0;
    loadPage();
  };

  const countrySelect = document.createElement('select');
  countrySelect.appendChild(new Option('All countries', ''));
  for (const code of countries) countrySelect.appendChild(new Option(countryLabel(code), code));
  countrySelect.onchange = () => {
    countryFilter = countrySelect.value;
    offset = 0;
    loadPage();
  };

  const albumTypeSelect = document.createElement('select');
  albumTypeSelect.appendChild(new Option('All album types', ''));
  for (const type of albumTypes) albumTypeSelect.appendChild(new Option(type, type));
  albumTypeSelect.onchange = () => {
    albumTypeFilter = albumTypeSelect.value;
    offset = 0;
    loadPage();
  };

  const artistNames = new Set(artists);
  const artistDatalist = document.createElement('datalist');
  artistDatalist.id = 'artist-options';
  for (const artist of artists) artistDatalist.appendChild(new Option(artist));

  const artistSelect = document.createElement('input');
  artistSelect.type = 'text';
  artistSelect.placeholder = 'All artists';
  artistSelect.className = 'filter-search-input';
  artistSelect.setAttribute('list', 'artist-options');
  // Fires both when typing a full exact name and when picking a native
  // datalist suggestion. The backend filter is exact-match, so only apply
  // it once the typed value is empty (clear) or matches a known artist —
  // avoids firing a request per keystroke on a still-partial name.
  artistSelect.oninput = () => {
    const value = artistSelect.value;
    if (value === '' || artistNames.has(value)) {
      artistFilter = value;
      offset = 0;
      loadPage();
    }
  };

  const playlistSelect = document.createElement('select');
  playlistSelect.appendChild(new Option('All playlists', ''));
  for (const playlist of playlists) {
    playlistSelect.appendChild(new Option(`${playlist.name} (${playlist.trackCount})`, playlist.id));
  }
  playlistSelect.onchange = () => {
    playlistFilter = playlistSelect.value;
    offset = 0;
    loadPage();
  };

  const selects = [genreSelect, yearSelect, decadeSelect, countrySelect, albumTypeSelect, artistSelect, playlistSelect];
  const sliders = [];

  filterControls = {
    yearSelect,
    decadeSelect,
    countrySelect,
    albumTypeSelect,
    artistSelect,
    playlistSelect,
    selects,
    sliders,
  };

  const resetButton = document.createElement('button');
  resetButton.className = 'page-button reset-filters-button';
  resetButton.textContent = 'Reset filters';
  resetButton.onclick = () => {
    resetFilterState();
    offset = 0;
    loadPage();
  };

  const selectRow = document.createElement('div');
  selectRow.className = 'filter-row';
  selectRow.appendChild(genreSelect);
  selectRow.appendChild(yearSelect);
  selectRow.appendChild(decadeSelect);
  selectRow.appendChild(countrySelect);
  selectRow.appendChild(albumTypeSelect);
  selectRow.appendChild(artistSelect);
  selectRow.appendChild(artistDatalist);
  selectRow.appendChild(playlistSelect);
  selectRow.appendChild(resetButton);
  filtersEl.appendChild(selectRow);

  const sliderRow = document.createElement('div');
  sliderRow.className = 'filter-row';

  if (durationRange.min < durationRange.max) {
    const durationSlider = createDualSlider({
      title: 'Duration',
      min: durationRange.min,
      max: durationRange.max,
      step: 1000,
      formatValue: formatDuration,
      onCommit: (lo, hi) => {
        durationMin = lo;
        durationMax = hi;
        offset = 0;
        loadPage();
      },
    });
    sliderRow.appendChild(durationSlider);
    sliders.push(durationSlider);
  }

  if (addedRange.min && addedRange.max) {
    const addedMinMs = Date.parse(addedRange.min);
    const addedMaxMs = Date.parse(addedRange.max);
    const addedSlider = createDualSlider({
      title: 'Liked Date',
      min: addedMinMs,
      max: addedMaxMs,
      step: 86400000,
      formatValue: formatDateShort,
      onCommit: (lo, hi) => {
        addedFrom = lo === null ? '' : new Date(lo).toISOString();
        addedTo = hi === null ? '' : new Date(hi).toISOString();
        offset = 0;
        loadPage();
      },
    });
    sliderRow.appendChild(addedSlider);
    sliders.push(addedSlider);
  }

  if (popularityRange.min < popularityRange.max) {
    const popularitySlider = createDualSlider({
      title: 'Artist Popularity',
      min: popularityRange.min,
      max: popularityRange.max,
      step: 1,
      formatValue: (v) => v,
      onCommit: (lo, hi) => {
        popularityMin = lo;
        popularityMax = hi;
        offset = 0;
        loadPage();
      },
    });
    sliderRow.appendChild(popularitySlider);
    sliders.push(popularitySlider);
  }

  filtersEl.appendChild(sliderRow);
}
