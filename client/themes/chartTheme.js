// Chart theming, read from index.css's :root custom properties — the single
// source of truth for the palette. Everything drawn via JS (echarts) reads
// this; everything else reads the CSS custom properties directly.
//
// Deliberately a *function*, not a frozen object: the theme can switch at
// runtime (client/theme.js toggles a [data-theme] attribute), and charts
// re-read on remount. `--chart-emphasis` and the `--grad-*` stops aren't
// used by any DOM element, but they're declared in :root anyway so they get
// a color picker, same as the rest.
import { cssVar } from '../utils/cssVar';

export function getChartTheme() {
  return {
    bg: cssVar('--bg'),
    bgElevated: cssVar('--bg-elevated'),
    text: cssVar('--text'),
    textMuted: cssVar('--text-muted'),
    accent: cssVar('--accent'),
    border: cssVar('--border'),
    emphasis: cssVar('--chart-emphasis'),
    gradFrom: cssVar('--grad-purple'),
    gradTo: cssVar('--grad-magenta'),
  };
}

// The signature bar fill: a vertical gradient (bottom to top) between the
// palette's two gradient stops. In the classic theme both stops are the
// same green, so this renders as a flat fill. Plain object form — no
// echarts.graphic constructor needed.
export function barGradient(theme) {
  return {
    type: 'linear',
    x: 0,
    y: 1,
    x2: 0,
    y2: 0,
    colorStops: [
      { offset: 0, color: theme.gradFrom },
      { offset: 1, color: theme.gradTo },
    ],
  };
}

export function baseChartOption(theme) {
  return {
    backgroundColor: 'transparent',
    textStyle: { color: theme.text, fontFamily: 'Roboto, Inter, sans-serif' },
    grid: { left: 50, right: 20, top: 20, bottom: 60 },
    tooltip: {
      // 'item', not 'axis' — 'axis' pops the tooltip up anywhere in a
      // category's column, even off the bar itself; 'item' only fires
      // hovering the bar's actual rendered shape. Shared by every bar
      // chart via BarChart, same "only real data triggers hover feedback"
      // rule as WorldMap's geo.silent.
      trigger: 'item',
      backgroundColor: theme.bgElevated,
      borderColor: theme.border,
      textStyle: { color: theme.text },
    },
  };
}
