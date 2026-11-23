export const THEME_STORAGE_KEY = 'f-commerce-theme';

/**
 * Runs synchronously in the document head before the first paint. It mirrors
 * getStoredTheme in theme.tsx: a saved choice wins, otherwise the system
 * preference decides, and light is the fallback.
 */
export const themeScript = `(function () {
  var stored = null;
  try {
    stored = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
  } catch (error) {
    stored = null;
  }
  var theme =
    stored === 'dark' || stored === 'light'
      ? stored
      : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.dataset.theme = theme;
})();`;
