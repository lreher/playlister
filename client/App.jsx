import { useState } from 'preact/hooks';
import { EMPTY_FILTERS } from './pages/songList/Filters';
import { SongList } from './pages/songList';
import { Dashboards } from './pages/dashboards';

export function App() {
  const [tab, setTab] = useState('list');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [dashboardsVisited, setDashboardsVisited] = useState(false);

  function switchTab(next) {
    setTab(next);
    if (next === 'dashboards') setDashboardsVisited(true);
  }

  // Called from a dashboard chart click (year bar, decade bar, popularity
  // bucket, liked-date bar, country bubble). Clicking a chart element means
  // "show me exactly this," not "also narrow whatever was already
  // filtered" — replaces the whole filter set rather than merging into it.
  function applyDashboardFilter(updates) {
    setFilters({ ...EMPTY_FILTERS, ...updates });
    switchTab('list');
  }

  return (
    <>
      <h1>playlister</h1>
      <div id="tabs">
        <button className={`tab-button ${tab === 'list' ? 'active' : ''}`} onClick={() => switchTab('list')}>
          List
        </button>
        <button
          className={`tab-button ${tab === 'dashboards' ? 'active' : ''}`}
          onClick={() => switchTab('dashboards')}
        >
          Dashboards
        </button>
      </div>

      <div style={{ display: tab === 'list' ? '' : 'none' }}>
        <SongList filters={filters} onChange={setFilters} onReset={() => setFilters(EMPTY_FILTERS)} />
      </div>

      <div style={{ display: tab === 'dashboards' ? '' : 'none' }}>
        {dashboardsVisited && <Dashboards onFilterClick={applyDashboardFilter} />}
      </div>
    </>
  );
}
