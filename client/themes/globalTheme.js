// The app's base color palette — kept in sync with style.css's :root custom
// properties by hand. CSS can't import JS (or vice versa), so this is
// intentionally a second form of the same palette for the one rendering
// path that isn't plain DOM/CSS: anything drawn via JS (echarts) reads
// this; everything else reads the CSS custom properties directly.
export const globalTheme = {
  bg: '#121212',
  bgElevated: '#1a1a1a',
  text: '#ffffff',
  textMuted: '#b3b3b3',
  accent: '#1db954',
  border: '#282828',
};
