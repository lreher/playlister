// This chart's own color logic — interpolates from the shared theme color
// up to red (./colors.css's --chart-year-hot) as a bar's value climbs
// toward this chart's own max. Not shared/promoted to a primitive since
// it's this one chart's own look, not a generic capability.
import './colors.css';
import { cssVar } from '../../../utils/cssVar';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function interpolateColor(t, from, to) {
  const r = Math.round(from.r + (to.r - from.r) * t);
  const g = Math.round(from.g + (to.g - from.g) * t);
  const b = Math.round(from.b + (to.b - from.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

const HOT_COLOR = hexToRgb(cssVar('--chart-year-hot'));

export function heatColor(value, max, baseColorHex) {
  return interpolateColor(value / max, hexToRgb(baseColorHex), HOT_COLOR);
}
