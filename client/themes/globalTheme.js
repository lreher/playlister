// The app's base color palette, read straight from index.css's :root custom
// properties — single source of truth. Anything drawn via JS (echarts)
// reads this; everything else reads the CSS custom properties directly.
import { cssVar } from '../utils/cssVar';

export const globalTheme = {
  bg: cssVar('--bg'),
  bgElevated: cssVar('--bg-elevated'),
  text: cssVar('--text'),
  textMuted: cssVar('--text-muted'),
  accent: cssVar('--accent'),
  border: cssVar('--border'),
};
