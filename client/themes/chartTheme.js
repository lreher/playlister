// Reads the palette from index.css's :root vars — the single source of truth. A function,
// not a frozen object, so charts get the current values on each remount after a theme switch.
import { cssVar } from '../utils/cssVar';

export const getChartTheme = () => ({
    bg: cssVar('--bg'),
    bgElevated: cssVar('--bg-elevated'),
    text: cssVar('--text'),
    textMuted: cssVar('--text-muted'),
    accent: cssVar('--accent'),
    border: cssVar('--border'),
    emphasis: cssVar('--chart-emphasis'),
    gradFrom: cssVar('--grad-purple'),
    gradTo: cssVar('--grad-magenta'),
  });

// Vertical gradient between the two palette stops; flat in Classic since both stops match.
export const barGradient = (theme) => ({
    type: 'linear',
    x: 0,
    y: 1,
    x2: 0,
    y2: 0,
    colorStops: [
      { offset: 0, color: theme.gradFrom },
      { offset: 1, color: theme.gradTo },
    ],
  });

export const baseChartOption = (theme) => ({
    backgroundColor: 'transparent',
    textStyle: { color: theme.text, fontFamily: 'Roboto, Inter, sans-serif' },
    grid: { left: 50, right: 20, top: 20, bottom: 60 },
    tooltip: {
      // 'item' not 'axis' — 'axis' fires anywhere in the category's column, 'item' only on the bar itself.
      trigger: 'item',
      backgroundColor: theme.bgElevated,
      borderColor: theme.border,
      textStyle: { color: theme.text },
    },
  });
