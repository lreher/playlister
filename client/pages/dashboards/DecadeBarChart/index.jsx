import { BarChart } from '../../../components/charts/BarChart';

export function DecadeBarChart({ data, onSelect }) {
  return (
    <div className="dashboard-chart">
      <h2>Songs by Decade</h2>
      <BarChart
        categories={data.map((d) => d.decade)}
        values={data.map((d) => d.count)}
        onClickCategory={(decade) => onSelect({ decade })}
      />
    </div>
  );
}
