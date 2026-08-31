import { useEffect, useState } from 'preact/hooks';
import { EMPTY_FILTERS } from './pages/songList/Filters';
import { SongList } from './pages/songList';
import { Dashboards } from './pages/dashboards';
import { Events } from './pages/events';

const PATH_FOR_TAB = { list: '/', dashboards: '/dashboards', events: '/events' };
const TAB_FOR_PATH = { '/': 'list', '/dashboards': 'dashboards', '/events': 'events' };

const tabFromLocation = () => TAB_FOR_PATH[window.location.pathname] ?? 'list';

export function App() {
  const [tab, setTab] = useState(tabFromLocation);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [dashboardsVisited, setDashboardsVisited] = useState(() => tabFromLocation() === 'dashboards');

  function switchTab(next) {
    setTab(next);
    if (next === 'dashboards') setDashboardsVisited(true);
    const path = PATH_FOR_TAB[next];
    if (window.location.pathname !== path) history.pushState(null, '', path);
  }

  // Keeps the tab in sync with browser back/forward, since switchTab above
  // now makes tab state a real part of the URL.
  useEffect(() => {
    function handlePopState() {
      const next = tabFromLocation();
      setTab(next);
      if (next === 'dashboards') setDashboardsVisited(true);
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

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
        <button className={`tab-button ${tab === 'events' ? 'active' : ''}`} onClick={() => switchTab('events')}>
          Events
        </button>
      </div>

      <div style={{ display: tab === 'list' ? '' : 'none' }}>
        <SongList filters={filters} onChange={setFilters} onReset={() => setFilters(EMPTY_FILTERS)} />
      </div>

      <div style={{ display: tab === 'dashboards' ? '' : 'none' }}>
        {dashboardsVisited && <Dashboards onFilterClick={applyDashboardFilter} />}
      </div>

      <div style={{ display: tab === 'events' ? '' : 'none' }}>
        <Events />
      </div>
    </>
  );
}
