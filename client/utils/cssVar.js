// Reads a CSS custom property's resolved value, so colors stay defined once in :root instead of duplicated in JS.
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
