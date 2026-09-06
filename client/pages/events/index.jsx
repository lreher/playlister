import { useEffect, useState } from 'preact/hooks';
import { getEvents, requestEventsSearch, getEventsSearchStatus } from '../../api';
import { Pagination } from '../../components/Pagination';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LIMIT = 50;
const SEARCH_POLL_MS = 1000;

// Formats the "YYYY-MM-DD" string directly rather than via `new Date(...)`, which parses
// a plain date string as UTC midnight and can render as the previous day in other timezones.
const formatDate = (isoDate) => {
  const [year, month, day] = isoDate.split('-');
  return `${day} ${MONTHS[Number(month) - 1]} ${year}`;
};

export const Events = () => {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0);
  const [searchStatus, setSearchStatus] = useState(null);

  const loadEvents = () => getEvents().then(setEvents).catch((err) => setError(err.message));

  useEffect(() => {
    loadEvents();
  }, []);

  // Global job, not per-user — same "poll while running" shape as App.jsx's sync/enrichment
  // polls, just scoped to this page since nothing outside Events cares while it's in flight.
  useEffect(() => {
    const running = searchStatus?.status === 'running';
    if (!running) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getEventsSearchStatus().then((result) => {
        if (cancelled) return;
        setSearchStatus(result);
        if (result.status === 'done') {
          setOffset(0);
          loadEvents();
        }
      });
    }, SEARCH_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchStatus]);

  const handleRunSearch = () => {
    requestEventsSearch().then(setSearchStatus).catch((err) => setSearchStatus({ status: 'error', message: err.message }));
  };

  // No server pagination here - the whole (already user-filtered, future-only) list is
  // small enough to fetch once and page through client-side, like Dashboards' one fetch.
  const total = events?.length ?? 0;
  const pageItems = events ? events.slice(offset, offset + LIMIT) : [];
  const from = events && (total === 0 ? 0 : offset + 1);
  const to = events && Math.min(offset + pageItems.length, total);
  const searching = searchStatus?.status === 'running';

  return (
    <div id="events">
      <div className="toolbar">
        <button
          className="page-button"
          disabled={!events || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - LIMIT))}
        >
          Previous
        </button>
        <button
          className="page-button"
          disabled={!events || offset + pageItems.length >= total}
          onClick={() => setOffset(offset + LIMIT)}
        >
          Next
        </button>
        <p className="status">
          {error ? 'Could not load events' : events ? `${from}-${to} of ${total}` : 'Loading…'}
        </p>
        {searchStatus && (
          <span className={`sync-status-text ${searchStatus.status === 'error' ? 'failed' : ''}`}>
            {searchStatus.message}
          </span>
        )}
        <button className="page-button filled search-button" onClick={handleRunSearch} disabled={searching}>
          {searching ? 'Searching…' : 'Run Search'}
        </button>
      </div>
      {error && <div className="table-message">Could not load events</div>}
      {!error && !events && <div className="table-message">Loading…</div>}
      {!error && events?.length === 0 && <div className="table-message">No matching events found yet.</div>}
      {!error && events?.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Artist</th>
                <th>Date</th>
                <th>Venue</th>
                <th>City</th>
                <th>Songs</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((event) => (
                <tr key={event.id}>
                  <td>{event.artists.map((a) => <div key={a.id}>{a.name}</div>)}</td>
                  <td>{formatDate(event.date)}</td>
                  <td>{event.venue}{event.neighborhood ? ` (${event.neighborhood})` : ''}</td>
                  <td>{event.city}</td>
                  <td>{event.artists.map((a) => <div key={a.id}>{a.songCount}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-footer">
        {events?.length > 0 && <Pagination offset={offset} limit={LIMIT} total={total} onOffsetChange={setOffset} />}
      </div>
    </div>
  );
};
