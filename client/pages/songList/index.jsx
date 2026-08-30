// The List tab: filter row + paginated song table. Filter state itself is
// owned by App (a dashboard chart click needs to set it too), this page
// just renders it.
import { Filters } from './Filters';
import { SongTable } from './SongTable';

export function SongList({ filters, onChange, onReset }) {
  return (
    <>
      <div id="filters">
        <Filters filters={filters} onChange={onChange} onReset={onReset} />
      </div>
      <div id="app">
        <SongTable filters={filters} />
      </div>
    </>
  );
}
