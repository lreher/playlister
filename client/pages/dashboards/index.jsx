// The Dashboards tab. Mounted lazily by App (only once the tab's been
// visited) and never unmounted after — stats are fetched once here and
// handed down; each chart owns its own rendering/config from there.
import { useEffect, useState } from 'preact/hooks';
import { getStats } from '../../api';
import { YearBarChart } from './YearBarChart';
import { DecadeBarChart } from './DecadeBarChart';
import { LikedBarChart } from './LikedBarChart';
import { PopularityBarChart } from './PopularityBarChart';
import { CountryMap } from './CountryMap';

export function Dashboards({ onFilterClick }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    getStats().then(setStats);
  }, []);

  if (!stats) return <div>Loading...</div>;

  return (
    <div id="dashboards">
      <YearBarChart data={stats.yearCounts} onSelect={onFilterClick} />
      <DecadeBarChart data={stats.decadeCounts} onSelect={onFilterClick} />
      <LikedBarChart data={stats.likedCounts} onSelect={onFilterClick} />
      <PopularityBarChart data={stats.popularityCounts} onSelect={onFilterClick} />
      <CountryMap data={stats.countryCounts} onSelect={onFilterClick} />
    </div>
  );
}
