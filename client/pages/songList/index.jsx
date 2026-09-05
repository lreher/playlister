// Filter state is owned by App (a chart click sets it too) — this just renders it.
// dataVersion re-fetches children without a remount, which would drop their uncontrolled inputs.
import { Filters } from './Filters';
import { SongTable } from './SongTable';

export const SongList = ({ filters, onChange, onReset, dataVersion, controls }) => <>
      <div id="filters">
        <Filters filters={filters} onChange={onChange} onReset={onReset} dataVersion={dataVersion} />
      </div>
      <div id="app">
        <SongTable filters={filters} dataVersion={dataVersion} controls={controls} />
      </div>
    </>;
