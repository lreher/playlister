// Reads a CSS custom property's computed value off the document root.
// Colors declared this way (in a stylesheet's :root — index.css, or a
// chart's own colors.css) get a real color
// swatch/picker in editors — JS just reads the resolved value at load time
// instead of duplicating the hex literal.
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
