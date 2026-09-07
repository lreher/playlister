// Songs here come straight from List's selection state (App.jsx) — no fetch of our own.
import { useRef, useState } from 'preact/hooks';
import { createPlaylist } from '../../api';

const COLUMNS = ['Name', 'Artist(s)', 'Album', 'Year'];

export const Playlist = ({ songs, onRemove, onClear, canUndo, undoTitle, onUndo, onCreated }) => {
  const dialogRef = useRef(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const openModal = () => {
    setError(null);
    setName('');
    dialogRef.current?.showModal();
  };

  const handleCreate = (e) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    createPlaylist({ name: name.trim(), isPublic: false, songIds: songs.map((s) => s.id) })
      .then(() => {
        setCreating(false);
        dialogRef.current?.close();
        onCreated();
      })
      .catch((err) => {
        setCreating(false);
        setError(err.message);
      });
  };

  return (
    <div id="playlist">
      <div className="toolbar">
        <button className="page-button" disabled={!canUndo} onClick={onUndo} title={undoTitle}>
          Undo
        </button>
        <button className="page-button" disabled={songs.length === 0} onClick={onClear}>
          Clear
        </button>
        <button
          className="page-button filled create-playlist-button"
          onClick={openModal}
          disabled={songs.length === 0}
        >
          Create Playlist
        </button>
      </div>

      {songs.length === 0 ? (
        <div className="table-message">No songs selected — click songs in the List tab to add them here.</div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table songs-table">
            <tr>
              {COLUMNS.map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
            {songs.map((song) => (
              <tr key={song.id} onClick={() => onRemove(song.id)} title="Click to remove">
                <td>{song.name}</td>
                <td>{song.artists}</td>
                <td>{song.album}</td>
                <td>{song.year ?? '—'}</td>
              </tr>
            ))}
          </table>
        </div>
      )}

      <dialog ref={dialogRef} className="playlist-modal">
        <form onSubmit={handleCreate}>
          <h2>Name your playlist</h2>
          <input
            className="filter-search-input"
            type="text"
            placeholder="Playlist name"
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          {error && (
            <p className="sync-status-text failed" title={error}>
              Failed to create playlist
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="page-button" onClick={() => dialogRef.current?.close()} disabled={creating}>
              Cancel
            </button>
            <button type="submit" className="page-button filled" disabled={creating || !name.trim()}>
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
};
