import { BarChart } from '../../../components/charts/BarChart';

export function YearBarChart({ data, onSelect }) {
  return (
    <div className="dashboard-chart">
      <h2>Songs by Release Year</h2>
      <BarChart
        categories={data.map((d) => d.year)}
        values={data.map((d) => d.count)}
        rotateLabels
        onClickCategory={(year) => onSelect({ year })}
      />
    </div>
  );
}
