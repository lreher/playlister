// Filter state is owned by App (a chart click sets it too) — this just renders it.
// dataVersion re-fetches children without a remount, which would drop their uncontrolled inputs.
import { useEffect, useState } from 'preact/hooks';
import { Filters, FILTERS_COLLAPSED_KEY, loadStoredFiltersCollapsed } from './Filters';
import { SongTable } from './SongTable';

// The collapse toggle is rendered twice — once above the filter rows (desktop) and once
// inline in SongTable's toolbar (mobile, merged into one row with pagination/Select All)
// — CSS shows only one per viewport, same show/hide-by-media-query pattern the
// table/card-list split already uses. Both share this one piece of state.
export const SongList = ({ filters, onChange, onReset, dataVersion, controls, selectedIds, onSelectSongs }) => {
  const [filtersCollapsed, setFiltersCollapsed] = useState(loadStoredFiltersCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_COLLAPSED_KEY, String(filtersCollapsed));
    } catch {
      // best-effort persistence — a private-browsing tab just won't remember it
    }
  }, [filtersCollapsed]);

  const filtersToggle = (
    <button className="filters-header" onClick={() => setFiltersCollapsed((c) => !c)}>
      <span>Filters</span>
      <span className="filters-toggle">{filtersCollapsed ? '▸' : '▾'}</span>
    </button>
  );

  // Rendered once per viewport (desktop: above the table; mobile: inside SongTable's
  // toolbar area, right below the toggle that opens it) — two Filters instances, each
  // hidden by CSS in the other viewport, so expanding on mobile never opens content
  // above the button you just pressed. See client/index.css's mobile block.
  const filtersRows = (collapsed) => (
    <Filters filters={filters} onChange={onChange} onReset={onReset} dataVersion={dataVersion} collapsed={collapsed} />
  );

  return (
    <>
      <div id="filters">
        {filtersToggle}
        {filtersRows(filtersCollapsed)}
      </div>
      <div id="app">
        <SongTable
          filters={filters}
          dataVersion={dataVersion}
          controls={controls}
          selectedIds={selectedIds}
          onSelectSongs={onSelectSongs}
          filtersToggle={<span className="filters-toggle-mobile">{filtersToggle}</span>}
          filtersPanel={filtersRows(filtersCollapsed)}
        />
      </div>
    </>
  );
};
