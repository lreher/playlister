import { WorldMap } from '../../../components/charts/WorldMap';
import { cssVar } from '../../../utils/cssVar';
import { countryLabel } from '../../../utils/format';
import { COUNTRY_COORDS } from './countryCoords';
import './colors.css';

export function CountryMap({ data, onSelect }) {
  const points = data
    .filter((d) => COUNTRY_COORDS[d.code])
    .map((d) => ({
      name: countryLabel(d.code),
      value: [...COUNTRY_COORDS[d.code], d.count],
      code: d.code,
    }));

  return (
    <div className="dashboard-chart">
      <h2>Songs by Country</h2>
      <WorldMap
        points={points}
        color={cssVar('--chart-country-color')}
        emphasisColor={cssVar('--chart-country-emphasis-color')}
        formatTooltip={(p) => `${p.name}: ${p.value[2]} song${p.value[2] === 1 ? '' : 's'}`}
        onPointClick={(point) => onSelect({ country: point.code })}
      />
    </div>
  );
}
