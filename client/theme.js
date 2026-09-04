// Hand-switchable visual themes, restored via `[data-theme="…"]` blocks in
// index.css. The choice is a per-browser convenience, so localStorage —
// wrapped in try/catch since it throws in some contexts (private windows,
// storage disabled).
const STORAGE_KEY = 'playlister-theme';

// What a visitor with no saved choice gets. NOTE this is separate from
// which palette the bare `:root` holds — that's 'studio' (see applyTheme),
// so index.html hard-codes data-theme="clean" to avoid a navy flash before
// this module runs.
const DEFAULT = 'clean';

// Toggle display order.
export const THEMES = [
  { id: 'clean', label: 'Clean' },
  { id: 'studio', label: 'Studio' },
  { id: 'classic', label: 'Classic' },
  { id: 'nicolas', label: 'Nicolas' },
];

export function getTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

// The 'studio' palette lives on the bare :root, so it's the *absence* of
// the attribute; every other theme sets an explicit data-theme value.
export function applyTheme(id) {
  if (id === 'studio') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
}

export function setTheme(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
  applyTheme(id);
}
