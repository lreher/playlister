// The List tab's filter row. Composes the input primitives from
// components/filters/ with the actual filter definitions — panel-level
// concerns (fetching options, filter state shape, the reset mechanism) live
// here; each primitive owns its own input behavior.
import { useEffect, useState } from 'preact/hooks';
import { getFilters } from '../../../api';
import { countryLabel, formatDuration, formatDateShort } from '../../../utils/format';
import { OptionsSelect } from '../../../components/filters/OptionsSelect';
import { OptionsSearch } from '../../../components/filters/OptionsSearch';
import { RangeSlider } from '../../../components/filters/RangeSlider';

export const EMPTY_FILTERS = {
  genre: '',
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

export function Filters({ filters, onChange, onReset }) {
  const [options, setOptions] = useState(null);
  // Bumped on "Reset filters" — remounts the uncontrolled primitives
  // (OptionsSearch, RangeSlider) so they snap back to their defaults.
  const [resetToken, setResetToken] = useState(0);

  useEffect(() => {
    getFilters().then(setOptions);
  }, []);

  function set(key) {
    return (value) => onChange({ ...filters, [key]: value });
  }

  function setRange(minKey, maxKey) {
    return (lo, hi) => onChange({ ...filters, [minKey]: lo, [maxKey]: hi });
  }

  function handleReset() {
    onReset();
    setResetToken((t) => t + 1);
  }

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
        <OptionsSelect value={filters.genre} onChange={set('genre')} allLabel="All genres" options={genres} />
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
          valueOf={(p) => p.id}
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
            // Bespoke, not setRange: values need converting from epoch ms to
            // ISO strings (or '' when cleared) before they're valid filters.
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
}
