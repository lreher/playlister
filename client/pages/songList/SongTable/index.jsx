// The List tab's paginated song table. Re-fetches whenever `filters`
// (owned by App) or the local page offset changes — and when `dataVersion`
// bumps (a sync just finished, so the underlying library changed).
import { useEffect, useState } from 'preact/hooks';
import { getSongs } from '../../../api';
import { countryLabel } from '../../../utils/format';
import { Pagination } from '../../../components/Pagination';

const LIMIT = 50;
const COLUMNS = ['Name', 'Artist(s)', 'Album', 'Year', 'Added', 'Country', 'Genres'];

export function SongTable({ filters, dataVersion }) {
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

  if (error) return <div>Error: {error}</div>;
  if (!page) return <div>Loading...</div>;

  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + page.items.length, page.total);

  return (
    <>
      <div className="toolbar">
        <button
          className="page-button"
          disabled={page.offset === 0}
          onClick={() => setOffset(Math.max(0, page.offset - LIMIT))}
        >
          Previous
        </button>
        <button
          className="page-button"
          disabled={page.offset + page.items.length >= page.total}
          onClick={() => setOffset(page.offset + LIMIT)}
        >
          Next
        </button>
        <p className="status">
          {from}-{to} of {page.total}
        </p>
        {/* Stub — real playlist creation/export is a likely next step. */}
        <button className="page-button create-playlist-button">Create Playlist</button>
      </div>
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
      <Pagination offset={page.offset} limit={LIMIT} total={page.total} onOffsetChange={setOffset} />
    </>
  );
}
