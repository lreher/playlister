// Chart-specific theming, built on the app's global palette. `emphasis` (a
// chart's hover/click color) isn't used by any DOM element, so it's not in
// globalTheme's set — but it's still declared in index.css's :root
// (--chart-emphasis) purely so it gets a color picker, same as the rest.
import { globalTheme } from './globalTheme';
import { cssVar } from '../utils/cssVar';

export const chartTheme = {
  ...globalTheme,
  emphasis: cssVar('--chart-emphasis'),
};

export function baseChartOption() {
  return {
    backgroundColor: 'transparent',
    textStyle: { color: chartTheme.text, fontFamily: 'Inter, sans-serif' },
    grid: { left: 50, right: 20, top: 20, bottom: 60 },
    tooltip: {
      // 'item', not 'axis' — 'axis' pops the tooltip up anywhere in a
      // category's column, even off the bar itself; 'item' only fires
      // hovering the bar's actual rendered shape. Shared by every bar
      // chart via BarChart, same "only real data triggers hover feedback"
      // rule as WorldMap's geo.silent.
      trigger: 'item',
      backgroundColor: chartTheme.bgElevated,
      borderColor: chartTheme.border,
      textStyle: { color: chartTheme.text },
    },
  };
}
