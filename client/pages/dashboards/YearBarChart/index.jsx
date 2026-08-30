import { BarChart } from '../../../components/charts/BarChart';
import { cssVar } from '../../../utils/cssVar';
import './colors.css';

export function YearBarChart({ data, onSelect }) {
  return (
    <div className="dashboard-chart">
      <h2>Songs by Release Year</h2>
      <BarChart
        categories={data.map((d) => d.year)}
        values={data.map((d) => d.count)}
        rotateLabels
        color={cssVar('--chart-year-color')}
        emphasisColor={cssVar('--chart-year-emphasis-color')}
        onClickCategory={(year) => onSelect({ year })}
      />
    </div>
  );
}
