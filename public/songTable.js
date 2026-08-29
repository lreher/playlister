// Song list: fetching a page from /api/songs (using the current filter
// state from filters.js) and rendering it as a table + pagination toolbar.

const app = document.getElementById('app');
const LIMIT = 50;
let offset = 0;

async function loadPage() {
  app.textContent = 'Loading...';

  const params = new URLSearchParams({ limit: LIMIT, offset });
  if (genreFilter) params.set('genre', genreFilter);
  if (yearFilter) params.set('year', yearFilter);
  if (decadeFilter) params.set('decade', decadeFilter);
  if (countryFilter) params.set('country', countryFilter);
  if (albumTypeFilter) params.set('albumType', albumTypeFilter);
  if (artistFilter) params.set('artist', artistFilter);
  if (playlistFilter) params.set('playlist', playlistFilter);
  if (durationMin !== null) params.set('durationMin', durationMin);
  if (durationMax !== null) params.set('durationMax', durationMax);
  if (addedFrom) params.set('addedFrom', addedFrom);
  if (addedTo) params.set('addedTo', addedTo);
  if (popularityMin !== null) params.set('popularityMin', popularityMin);
  if (popularityMax !== null) params.set('popularityMax', popularityMax);

  const res = await fetch(`/api/songs?${params.toString()}`);

  if (res.status === 401) {
    app.innerHTML = '<div class="login-container"><a class="login-button" href="/login">Login with Spotify</a></div>';
    return;
  }

  if (!res.ok) {
    const { error } = await res.json();
    app.textContent = `Error: ${error}`;
    return;
  }

  const page = await res.json();
  render(page);
}

function render(page) {
  app.innerHTML = '';

  const table = document.createElement('table');
  table.className = 'songs-table';
  const headerRow = document.createElement('tr');
  for (const label of ['Name', 'Artist(s)', 'Album', 'Year', 'Added', 'Country', 'Genres']) {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  }
  table.appendChild(headerRow);

  for (const song of page.items) {
    const row = document.createElement('tr');
    const values = [
      song.name,
      song.artists,
      song.album,
      song.year ?? '—',
      new Date(song.addedAt).toLocaleDateString(),
      countryLabel(song.country),
      song.genres.length ? song.genres.join(', ') : '—',
    ];
    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = value;
      row.appendChild(td);
    }
    table.appendChild(row);
  }

  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + page.items.length, page.total);

  const status = document.createElement('p');
  status.className = 'status';
  status.textContent = `${from}-${to} of ${page.total}`;

  const prevButton = document.createElement('button');
  prevButton.className = 'page-button';
  prevButton.textContent = 'Previous';
  prevButton.disabled = page.offset === 0;
  prevButton.onclick = () => {
    offset = Math.max(0, page.offset - LIMIT);
    loadPage();
  };

  const nextButton = document.createElement('button');
  nextButton.className = 'page-button';
  nextButton.textContent = 'Next';
  nextButton.disabled = page.offset + page.items.length >= page.total;
  nextButton.onclick = () => {
    offset = page.offset + LIMIT;
    loadPage();
  };

  const createPlaylistButton = document.createElement('button');
  createPlaylistButton.className = 'page-button create-playlist-button';
  createPlaylistButton.textContent = 'Create Playlist';

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.appendChild(prevButton);
  toolbar.appendChild(nextButton);
  toolbar.appendChild(status);
  toolbar.appendChild(createPlaylistButton);

  app.appendChild(toolbar);
  app.appendChild(table);
}
