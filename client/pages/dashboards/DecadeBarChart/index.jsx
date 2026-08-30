import { BarChart } from '../../../components/charts/BarChart';
import { cssVar } from '../../../utils/cssVar';
import './colors.css';

export function DecadeBarChart({ data, onSelect }) {
  return (
    <div className="dashboard-chart">
      <h2>Songs by Decade</h2>
      <BarChart
        categories={data.map((d) => d.decade)}
        values={data.map((d) => d.count)}
        color={cssVar('--chart-decade-color')}
        emphasisColor={cssVar('--chart-decade-emphasis-color')}
        onClickCategory={(decade) => onSelect({ decade })}
      />
    </div>
  );
}
