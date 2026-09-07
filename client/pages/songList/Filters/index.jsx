// Panel-level concerns (fetching options, filter shape, reset) live here; each
// components/filters/ primitive owns its own input behavior.
import { useEffect, useState } from 'preact/hooks';
import { getFilters } from '../../../api';
import { countryLabel, formatDuration, formatDateShort } from '../../../utils/format';
import { OptionsSelect } from '../../../components/filters/OptionsSelect';
import { OptionsSearch } from '../../../components/filters/OptionsSearch';
import { RangeSlider } from '../../../components/filters/RangeSlider';

export const EMPTY_FILTERS = {
  genres: [],
  year: '',
  decade: '',
  country: '',
  albumType: '',
  artist: '',
  playlist: '',
  durationMin: null,
  durationMax: null,
  addedFrom: '',
  addedTo: '',
  popularityMin: null,
  popularityMax: null,
};

export const Filters = ({ filters, onChange, onReset, dataVersion }) => {
  const [options, setOptions] = useState(null);
  // Bumped on reset to remount the uncontrolled primitives back to their defaults.
  const [resetToken, setResetToken] = useState(0);
  // Bumped after each genre added, to remount just the genre search input and clear it
  // for the next one — same uncontrolled-remount trick reset uses, scoped to one input.
  const [genreInputToken, setGenreInputToken] = useState(0);

  // Re-fetches when a sync finishes so option lists/ranges reflect the updated library.
  useEffect(() => {
    getFilters().then(setOptions);
  }, [dataVersion]);

  const set = (key) => (value) => onChange({ ...filters, [key]: value });

  const setRange = (minKey, maxKey) => (lo, hi) => onChange({ ...filters, [minKey]: lo, [maxKey]: hi });

  const addGenre = (genre) => {
    if (!genre || filters.genres.includes(genre)) return;
    onChange({ ...filters, genres: [...filters.genres, genre] });
    setGenreInputToken((t) => t + 1);
  };

  const removeGenre = (genre) => onChange({ ...filters, genres: filters.genres.filter((g) => g !== genre) });

  const handleReset = () => {
    onReset();
    setResetToken((t) => t + 1);
  };

  if (!options) return null;

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
  } = options;

  return (
    <>
      <div className="filter-row">
        <div className="genre-filter">
          <OptionsSearch
            options={genres.filter((g) => !filters.genres.includes(g))}
            placeholder="Add genre"
            onChange={addGenre}
            resetKey={`genre-${resetToken}-${genreInputToken}`}
          />
          {filters.genres.length > 0 && (
            <div className="genre-chips">
              {filters.genres.map((g) => (
                <button key={g} className="genre-chip" onClick={() => removeGenre(g)} title={`Remove ${g}`}>
                  {g} ×
                </button>
              ))}
            </div>
          )}
        </div>
        <OptionsSelect value={filters.year} onChange={set('year')} allLabel="All years" options={years} />
        <OptionsSelect value={filters.decade} onChange={set('decade')} allLabel="All decades" options={decades} />
        <OptionsSelect
          value={filters.country}
          onChange={set('country')}
          allLabel="All countries"
          options={countries}
          labelOf={countryLabel}
        />
        <OptionsSelect
          value={filters.albumType}
          onChange={set('albumType')}
          allLabel="All album types"
          options={albumTypes}
        />
        <OptionsSearch
          options={artists}
          placeholder="All artists"
          onChange={set('artist')}
          resetKey={`artist-${resetToken}`}
        />
        <OptionsSelect
          value={filters.playlist}
          onChange={set('playlist')}
          allLabel="All playlists"
          options={playlists}
          keyOf={(p) => p.id}
          labelOf={(p) => `${p.name} (${p.trackCount})`}
        />
        <button className="page-button reset-filters-button" onClick={handleReset}>
          Reset filters
        </button>
      </div>

      <div className="filter-row">
        {durationRange.min < durationRange.max && (
          <RangeSlider
            key={`duration-${resetToken}`}
            title="Duration"
            min={durationRange.min}
            max={durationRange.max}
            step={1000}
            formatValue={formatDuration}
            onCommit={setRange('durationMin', 'durationMax')}
          />
        )}
        {addedRange.min && addedRange.max && (
          <RangeSlider
            key={`added-${resetToken}`}
            title="Liked Date"
            min={Date.parse(addedRange.min)}
            max={Date.parse(addedRange.max)}
            step={86400000}
            formatValue={formatDateShort}
            // Bespoke, not setRange — values need converting between epoch ms and ISO strings.
            onCommit={(lo, hi) =>
              onChange({
                ...filters,
                addedFrom: lo === null ? '' : new Date(lo).toISOString(),
                addedTo: hi === null ? '' : new Date(hi).toISOString(),
              })
            }
          />
        )}
        {popularityRange.min < popularityRange.max && (
          <RangeSlider
            key={`popularity-${resetToken}`}
            title="Artist Popularity"
            min={popularityRange.min}
            max={popularityRange.max}
            step={1}
            formatValue={(v) => v}
            onCommit={setRange('popularityMin', 'popularityMax')}
          />
        )}
      </div>
    </>
  );
};
