// The List tab's paginated song table. Re-fetches whenever `filters`
// (owned by App) or the local page offset changes — and when `dataVersion`
// bumps (a sync just finished, so the underlying library changed).
import { useEffect, useState } from 'preact/hooks';
import { getSongs } from '../../../api';
import { countryLabel } from '../../../utils/format';
import { Pagination } from '../../../components/Pagination';

const LIMIT = 50;
const COLUMNS = ['Name', 'Artist(s)', 'Album', 'Year', 'Added', 'Country', 'Genres'];

export function SongTable({ filters, dataVersion, controls }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);

  // A filter change means "start over" — always jump back to the first
  // page. Runs before the fetch effect below on the same render pass.
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

  // Toolbar (and the library-actions `controls` in it) stays mounted
  // through loading/error — only the table body + pagination depend on a
  // loaded page.
  const from = page && (page.total === 0 ? 0 : page.offset + 1);
  const to = page && Math.min(page.offset + page.items.length, page.total);

  return (
    <>
      <div className="toolbar">
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
        {/* Stub — real playlist creation/export is a likely next step. */}
        <button className="page-button filled create-playlist-button">Create Playlist</button>
      </div>
      {error && <div className="table-message">Error: {error}</div>}
      {!error && !page && <div className="table-message">Loading…</div>}
      {page && (
        <div className="songs-table-wrap">
          <table className="songs-table">
            <tr>
              {COLUMNS.map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
            {page.items.map((song) => (
              <tr key={song.id}>
                <td>{song.name}</td>
                <td>{song.artists}</td>
                <td>{song.album}</td>
                <td>{song.year ?? '—'}</td>
                <td>{new Date(song.addedAt).toLocaleDateString()}</td>
                <td>{countryLabel(song.country)}</td>
                <td>{song.genres.length ? song.genres.join(', ') : '—'}</td>
              </tr>
            ))}
          </table>
        </div>
      )}
      <div className="table-footer">
        {page && (
          <Pagination offset={page.offset} limit={LIMIT} total={page.total} onOffsetChange={setOffset} />
        )}
        {controls}
      </div>
    </>
  );
}
