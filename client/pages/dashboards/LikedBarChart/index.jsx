import { BarChart } from '../../../components/charts/BarChart';
import { cssVar } from '../../../utils/cssVar';
import './colors.css';

function monthRange(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  return { from: from.toISOString(), to: to.toISOString() };
}

export function LikedBarChart({ data, onSelect }) {
  return (
    <div className="dashboard-chart">
      <h2>Songs Liked Over Time</h2>
      <BarChart
        categories={data.map((d) => d.month)}
        values={data.map((d) => d.count)}
        rotateLabels
        color={cssVar('--chart-liked-color')}
        emphasisColor={cssVar('--chart-liked-emphasis-color')}
        onClickCategory={(month) => {
          const { from, to } = monthRange(month);
          onSelect({ addedFrom: from, addedTo: to });
        }}
      />
    </div>
  );
}
