// Chart-specific theming, built on the app's global palette. `emphasis` (a
// chart's hover/click color) has no CSS equivalent — it's chart-only, so it
// lives here rather than in globalTheme.
import { globalTheme } from './globalTheme';

export const chartTheme = {
  ...globalTheme,
  emphasis: '#f5a623',
};

export function baseChartOption() {
  return {
    backgroundColor: 'transparent',
    textStyle: { color: chartTheme.text, fontFamily: 'Inter, sans-serif' },
    grid: { left: 50, right: 20, top: 20, bottom: 60 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: chartTheme.bgElevated,
      borderColor: chartTheme.border,
      textStyle: { color: chartTheme.text },
    },
  };
}
