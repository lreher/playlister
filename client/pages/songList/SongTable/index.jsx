// Re-fetches on filters, page offset, or dataVersion (a sync just finished) changes.
import { useEffect, useState } from 'preact/hooks';
import { getSongs } from '../../../api';
import { countryLabel } from '../../../utils/format';
import { Pagination } from '../../../components/Pagination';

const LIMIT = 50;
const COLUMNS = ['Name', 'Artist(s)', 'Album', 'Year', 'Added', 'Country', 'Genres'];
const CARD_VISIBLE_GENRES = 3;

export const SongTable = ({ filters, dataVersion, controls, selectedIds, onSelectSongs, filtersToggle, filtersPanel }) => {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  // Set the moment a row's mouse goes down, cleared on mouseup anywhere — drives whether
  // dragging over other rows selects or deselects them, and whether to suppress text selection.
  const [dragMode, setDragMode] = useState(null);

  // A filter change resets to page one; runs before the fetch effect on the same render.
  useEffect(() => {
    setOffset(0);
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    setPage(null);
    setError(null);
    getSongs({ limit: LIMIT, offset, filters })
      .then((result) => !cancelled && setPage(result))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [filters, offset, dataVersion]);

  // mouseup can land outside the table (drag past its edge) — a window listener still catches it.
  useEffect(() => {
    if (!dragMode) return;
    const stopDragging = () => setDragMode(null);
    window.addEventListener('mouseup', stopDragging);
    return () => window.removeEventListener('mouseup', stopDragging);
  }, [dragMode]);

  // Starting row decides the drag's mode: dragging off a selected row deselects, off an
  // unselected row selects — same as a spreadsheet's click-drag selection.
  const handleRowMouseDown = (song, event) => {
    event.preventDefault();
    const mode = selectedIds.has(song.id) ? 'deselect' : 'select';
    setDragMode(mode);
    onSelectSongs([song], mode === 'select');
  };

  const handleRowMouseEnter = (song) => {
    if (!dragMode) return;
    onSelectSongs([song], dragMode === 'select');
  };

  // Toolbar stays mounted through loading/error; only the table body + pagination need a loaded page.
  const from = page && (page.total === 0 ? 0 : page.offset + 1);
  const to = page && Math.min(page.offset + page.items.length, page.total);

  // Drives the button's pressed look and lets a second click deselect the page instead of
  // re-selecting an already-fully-selected one.
  const allPageSelected = !!page && page.items.length > 0 && page.items.every((song) => selectedIds.has(song.id));

  return (
    <>
      <div className="toolbar">
        {filtersToggle}
        <div className="pagination-inline">
          <button
            className="page-button"
            disabled={!page || page.offset === 0}
            onClick={() => page && setOffset(Math.max(0, page.offset - LIMIT))}
          >
            Previous
          </button>
          <button
            className="page-button"
            disabled={!page || page.offset + page.items.length >= page.total}
            onClick={() => page && setOffset(page.offset + LIMIT)}
          >
            Next
          </button>
          <p className="status">
            {error ? 'Could not load songs' : page ? `${from}-${to} of ${page.total}` : 'Loading…'}
          </p>
        </div>
        {controls}
        <button
          className={`page-button filled select-all-button ${allPageSelected ? 'active' : ''}`}
          disabled={!page || page.items.length === 0}
          onClick={() => page && onSelectSongs(page.items, !allPageSelected)}
        >
          Select All
        </button>
      </div>
      <div className="filters-panel-mobile">{filtersPanel}</div>
      {error && <div className="table-message">Error: {error}</div>}
      {!error && !page && <div className="table-message">Loading…</div>}
      {page && (
        <div className="data-table-wrap">
          <table className={`data-table songs-table ${dragMode ? 'dragging' : ''}`}>
            <tr>
              {COLUMNS.map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
            {page.items.map((song) => (
              <tr
                key={song.id}
                className={selectedIds.has(song.id) ? 'selected' : ''}
                onMouseDown={(event) => handleRowMouseDown(song, event)}
                onMouseEnter={() => handleRowMouseEnter(song)}
              >
                <td>{song.name}</td>
                <td>{song.artists}</td>
                <td>{song.album}</td>
                <td>{song.year ?? '—'}</td>
                <td>{new Date(song.addedAt).toLocaleDateString()}</td>
                <td>{countryLabel(song.country)}</td>
                <td className="genres-cell" onMouseDown={(event) => event.stopPropagation()}>
                  <span>{song.genres.length ? song.genres.join(', ') : '—'}</span>
                </td>
              </tr>
            ))}
          </table>
        </div>
      )}
      {page && (
        <div className="card-list">
          {page.items.map((song) => (
            <div
              key={song.id}
              className={`mobile-card selectable ${selectedIds.has(song.id) ? 'selected' : ''}`}
              onMouseDown={(event) => handleRowMouseDown(song, event)}
              onMouseEnter={() => handleRowMouseEnter(song)}
            >
              <div className="card-top">
                <div className="card-title">{song.name}</div>
                <div className="card-meta">{song.year ?? '—'}</div>
              </div>
              <div className="card-subtitle">{song.artists}</div>
              <div className="card-subtitle">
                {song.album} · {new Date(song.addedAt).toLocaleDateString()} · {countryLabel(song.country)}
              </div>
              {song.genres.length > 0 && (
                <div className="card-chips">
                  {song.genres.slice(0, CARD_VISIBLE_GENRES).map((g) => (
                    <span key={g} className="genre-chip flat">
                      {g}
                    </span>
                  ))}
                  {song.genres.length > CARD_VISIBLE_GENRES && (
                    <span className="card-meta">+{song.genres.length - CARD_VISIBLE_GENRES} more</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="table-footer">
        {page && (
          <Pagination offset={page.offset} limit={LIMIT} total={page.total} onOffsetChange={setOffset} />
        )}
      </div>
    </>
  );
};
