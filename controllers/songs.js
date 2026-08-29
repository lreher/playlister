const songs = require('../db/songs');
const artists = require('../db/artists');
const isrcCountry = require('../utils/isrcCountry');
const playlists = require('../db/playlists');

function songGenres(song) {
  return [...new Set(song.artists.flatMap((a) => artists.getGenres(a.id)))];
}

function songYear(song) {
  return song.album.releaseDate ? song.album.releaseDate.slice(0, 4) : null;
}

function songCountry(song) {
  return artists.getCountry(song.artists[0]?.id) ?? isrcCountry.countryFromIsrc(song.isrc);
}

function songDecade(song) {
  const year = songYear(song);
  return year ? `${year.slice(0, 3)}0s` : null;
}

function enrichSong(song) {
  return {
    id: song.id,
    name: song.name,
    artists: song.artists.map((a) => a.name).join(', '),
    album: song.album.name,
    addedAt: song.addedAt,
    country: songCountry(song),
    genres: songGenres(song),
    year: songYear(song),
    decade: songDecade(song),
    explicit: song.explicit,
    durationMs: song.durationMs,
    albumType: song.album.albumType,
    spotifyUrl: song.spotifyUrl,
    artistPopularity: artists.getPopularity(song.artists[0]?.id),
    artistFollowers: artists.getFollowers(song.artists[0]?.id),
    _artistNames: song.artists.map((a) => a.name),
  };
}

// Filters, sorts (newest-added first), and paginates the local song
// snapshot. All fields optional/nullable — omit a filter to not apply it.
function getSongs({
  limit = 50,
  offset = 0,
  genre,
  year,
  decade,
  country,
  albumType,
  artist,
  playlist,
  durationMin,
  durationMax,
  addedFrom,
  addedTo,
  popularityMin,
  popularityMax,
} = {}) {
  let filtered = songs.getAll().map(enrichSong);

  if (genre) {
    filtered = filtered.filter((s) => s.genres.some((g) => g.toLowerCase() === genre.toLowerCase()));
  }
  if (year) {
    filtered = filtered.filter((s) => s.year === year);
  }
  if (decade) {
    filtered = filtered.filter((s) => s.decade === decade);
  }
  if (country) {
    filtered = filtered.filter((s) => s.country === country.toUpperCase());
  }
  if (albumType) {
    filtered = filtered.filter((s) => s.albumType === albumType);
  }
  if (artist) {
    filtered = filtered.filter((s) => s._artistNames.some((name) => name.toLowerCase() === artist.toLowerCase()));
  }
  if (playlist) {
    const playlistEntry = playlists.getById(playlist);
    const trackIds = new Set(playlistEntry ? playlistEntry.tracks.map((t) => t.id) : []);
    filtered = filtered.filter((s) => trackIds.has(s.id));
  }
  if (durationMin != null) {
    filtered = filtered.filter((s) => s.durationMs >= durationMin);
  }
  if (durationMax != null) {
    filtered = filtered.filter((s) => s.durationMs <= durationMax);
  }
  if (addedFrom) {
    filtered = filtered.filter((s) => s.addedAt >= addedFrom);
  }
  if (addedTo) {
    filtered = filtered.filter((s) => s.addedAt <= addedTo);
  }
  if (popularityMin != null) {
    filtered = filtered.filter((s) => s.artistPopularity !== null && s.artistPopularity >= popularityMin);
  }
  if (popularityMax != null) {
    filtered = filtered.filter((s) => s.artistPopularity !== null && s.artistPopularity <= popularityMax);
  }

  filtered = filtered.map(({ _artistNames, ...song }) => song);
  filtered.sort((a, b) => b.addedAt.localeCompare(a.addedAt));

  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit);

  return { items, total, limit, offset };
}

// Distinct filter option lists + ranges, for populating the List tab's
// dropdowns/sliders.
function getFilterOptions() {
  const allSongs = songs.getAll();
  const genreSet = new Set();
  const yearSet = new Set();
  const decadeSet = new Set();
  const countrySet = new Set();
  const albumTypeSet = new Set();
  const artistSet = new Set();
  let durationMin = Infinity;
  let durationMax = -Infinity;
  let addedMin = null;
  let addedMax = null;
  let popularityMin = Infinity;
  let popularityMax = -Infinity;

  for (const song of allSongs) {
    for (const genre of songGenres(song)) genreSet.add(genre);
    const year = songYear(song);
    if (year) yearSet.add(year);
    const decade = songDecade(song);
    if (decade) decadeSet.add(decade);
    const country = songCountry(song);
    if (country) countrySet.add(country);
    if (song.album.albumType) albumTypeSet.add(song.album.albumType);
    for (const artist of song.artists) artistSet.add(artist.name);

    if (song.durationMs < durationMin) durationMin = song.durationMs;
    if (song.durationMs > durationMax) durationMax = song.durationMs;
    if (!addedMin || song.addedAt < addedMin) addedMin = song.addedAt;
    if (!addedMax || song.addedAt > addedMax) addedMax = song.addedAt;

    const popularity = artists.getPopularity(song.artists[0]?.id);
    if (popularity !== null) {
      if (popularity < popularityMin) popularityMin = popularity;
      if (popularity > popularityMax) popularityMax = popularity;
    }
  }

  return {
    genres: [...genreSet].sort(),
    years: [...yearSet].sort().reverse(),
    decades: [...decadeSet].sort().reverse(),
    countries: [...countrySet].sort(),
    albumTypes: [...albumTypeSet].sort(),
    artists: [...artistSet].sort(),
    durationRange: { min: durationMin, max: durationMax },
    addedRange: { min: addedMin, max: addedMax },
    popularityRange: { min: popularityMin, max: popularityMax },
    playlists: playlists.getAll().map((p) => ({ id: p.id, name: p.name, trackCount: p.tracks.length })),
  };
}

// Pre-aggregated counts for the Dashboards tab's charts.
function getStats() {
  const allSongs = songs.getAll();
  const yearCounts = new Map();
  const decadeCounts = new Map();
  const popularityCounts = new Map();
  const countryCounts = new Map();
  const likedCounts = new Map();

  for (const song of allSongs) {
    const year = songYear(song);
    if (year) yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);

    const decade = songDecade(song);
    if (decade) decadeCounts.set(decade, (decadeCounts.get(decade) ?? 0) + 1);

    const popularity = artists.getPopularity(song.artists[0]?.id);
    if (popularity !== null) {
      const bucket = `${Math.floor(popularity / 10) * 10}-${Math.floor(popularity / 10) * 10 + 9}`;
      popularityCounts.set(bucket, (popularityCounts.get(bucket) ?? 0) + 1);
    }

    const country = songCountry(song);
    if (country) countryCounts.set(country, (countryCounts.get(country) ?? 0) + 1);

    const likedMonth = song.addedAt.slice(0, 7);
    likedCounts.set(likedMonth, (likedCounts.get(likedMonth) ?? 0) + 1);
  }

  return {
    yearCounts: [...yearCounts.entries()]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => a.year.localeCompare(b.year)),
    decadeCounts: [...decadeCounts.entries()]
      .map(([decade, count]) => ({ decade, count }))
      .sort((a, b) => a.decade.localeCompare(b.decade)),
    popularityCounts: [...popularityCounts.entries()]
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => Number(a.bucket.split('-')[0]) - Number(b.bucket.split('-')[0])),
    countryCounts: [...countryCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    likedCounts: [...likedCounts.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}

module.exports = { getSongs, getFilterOptions, getStats };
