import { BarChart } from '../../../components/charts/BarChart';
import { cssVar } from '../../../utils/cssVar';
import './colors.css';

export function PopularityBarChart({ data, onSelect }) {
  return (
    <div className="dashboard-chart">
      <h2>Songs by Artist Popularity</h2>
      <BarChart
        categories={data.map((d) => d.bucket)}
        values={data.map((d) => d.count)}
        color={cssVar('--chart-popularity-color')}
        emphasisColor={cssVar('--chart-popularity-emphasis-color')}
        onClickCategory={(bucket) => {
          const [popularityMin, popularityMax] = bucket.split('-').map(Number);
          onSelect({ popularityMin, popularityMax });
        }}
      />
    </div>
  );
}
