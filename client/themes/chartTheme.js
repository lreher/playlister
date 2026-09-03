// Chart-specific theming, built on the app's global palette. `emphasis` (a
// chart's hover/click color) and the gradient stops aren't used by any DOM
// element, so they're not in globalTheme's set — but they're still declared
// in index.css's :root (--chart-emphasis, --grad-*) purely so they get a
// color picker, same as the rest.
import { globalTheme } from './globalTheme';
import { cssVar } from '../utils/cssVar';

export const chartTheme = {
  ...globalTheme,
  emphasis: cssVar('--chart-emphasis'),
  gradPurple: cssVar('--grad-purple'),
  gradMagenta: cssVar('--grad-magenta'),
  gradOrange: cssVar('--grad-orange'),
};

// The signature bar fill: a vertical purple->magenta wash (bottom to top),
// matching the reference dashboard this app was restyled from. Plain object
// form, no echarts.graphic constructor needed.
export const barGradient = {
  type: 'linear',
  x: 0,
  y: 1,
  x2: 0,
  y2: 0,
  colorStops: [
    { offset: 0, color: chartTheme.gradPurple },
    { offset: 1, color: chartTheme.gradMagenta },
  ],
};

export function baseChartOption() {
  return {
    backgroundColor: 'transparent',
    textStyle: { color: chartTheme.text, fontFamily: 'Roboto, Inter, sans-serif' },
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
