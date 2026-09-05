// Persisted to localStorage, wrapped in try/catch since it throws in some contexts
// (private windows, storage disabled).
const STORAGE_KEY = 'playlister-theme';

// The bare :root palette is 'studio' (see applyTheme), so index.html hardcodes
// data-theme="clean" to avoid a flash before this default applies.
const DEFAULT = 'clean';

// Toggle display order.
export const THEMES = [
  { id: 'clean', label: 'Clean' },
  { id: 'studio', label: 'Studio' },
  { id: 'classic', label: 'Classic' },
  { id: 'nicolas', label: 'Nicolas' },
];

export const getTheme = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
  } catch {
    /* ignore */
  }
  return DEFAULT;
};

// 'studio' is the *absence* of data-theme (its palette lives on bare :root); every other id sets it.
export const applyTheme = (id) => {
  if (id === 'studio') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
};

export const setTheme = (id) => {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
  applyTheme(id);
};
