import { BarChart } from '../../../components/charts/BarChart';
import { chartTheme } from '../../../themes/chartTheme';
import { heatColor } from './style';

export function YearBarChart({ data, onSelect }) {
  const maxCount = Math.max(...data.map((d) => d.count));

  return (
    <div className="dashboard-chart">
      <h2>Songs by Release Year</h2>
      <BarChart
        categories={data.map((d) => d.year)}
        values={data.map((d) => d.count)}
        rotateLabels
        // Delete this prop to go back to the shared theme color.
        color={(params) => heatColor(params.value, maxCount, chartTheme.accent)}
        onClickCategory={(year) => onSelect({ year })}
      />
    </div>
  );
}
