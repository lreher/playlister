// The List tab: filter row + paginated song table. Filter state itself is
// owned by App (a dashboard chart click needs to set it too), this page
// just renders it. `dataVersion` bumps when a sync finishes — threaded into
// both children so they re-fetch against the freshly-updated library
// without a full remount (which would drop the uncontrolled filter inputs).
import { Filters } from './Filters';
import { SongTable } from './SongTable';

export function SongList({ filters, onChange, onReset, dataVersion }) {
  return (
    <>
      <div id="filters">
        <Filters filters={filters} onChange={onChange} onReset={onReset} dataVersion={dataVersion} />
      </div>
      <div id="app">
        <SongTable filters={filters} dataVersion={dataVersion} />
      </div>
    </>
  );
}
