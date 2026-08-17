import { useSyncExternalStore } from 'preact/compat';

const STORAGE_KEY = 'luban-nav:theme';
export const THEMES = ['dark', 'light'];

const THEME_COLORS = {
  dark: '#071c2c',
  light: '#f4f6f8',
};

function detectInitialTheme() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (THEMES.includes(stored)) return stored;
  } catch {
    // localStorage may be unavailable
  }
  return 'dark';
}

let currentTheme = detectInitialTheme();
const listeners = new Set();

function applyDom(theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[theme] ?? THEME_COLORS.dark);
}

export function getTheme() {
  return currentTheme;
}

export function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  currentTheme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore persistence failures
  }
  applyDom(theme);
  listeners.forEach((listener) => listener());
}

export function toggleTheme() {
  setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

applyDom(currentTheme);

export function useTheme() {
  const theme = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    getTheme,
  );
  return { theme, setTheme, toggleTheme };
}
