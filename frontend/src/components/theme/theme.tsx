'use client';

import { Moon, Sun } from 'lucide-react';
import { createContext, useContext, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { THEME_STORAGE_KEY } from './theme-script';

type Theme = 'light' | 'dark';

// The theme attribute must land before paint, but `useLayoutEffect` warns when
// a component renders on the server. There is no document there, so fall back
// to `useEffect` for that pass.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light';

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;

  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function subscribeToTheme(onChange: () => void) {
  const mediaQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

  window.addEventListener('f-commerce-theme-change', onChange);
  window.addEventListener('storage', onChange);
  mediaQuery?.addEventListener?.('change', onChange);
  return () => {
    window.removeEventListener('f-commerce-theme-change', onChange);
    window.removeEventListener('storage', onChange);
    mediaQuery?.removeEventListener?.('change', onChange);
  };
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error('useTheme must be used within ThemeBoundary');
  }

  return context;
}

export function ThemeBoundary({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribeToTheme, getStoredTheme, () => 'light' as Theme);

  useIsomorphicLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    window.dispatchEvent(new Event('f-commerce-theme-change'));
  };

  return (
    <ThemeContext.Provider
      value={{
        theme,
        toggleTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border bg-surface text-ink transition-colors hover:border-sky focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky"
      aria-label={isDark ? 'Use light theme' : 'Use dark theme'}
      onClick={toggleTheme}
    >
      {isDark ? <Sun aria-hidden="true" size={18} /> : <Moon aria-hidden="true" size={18} />}
    </button>
  );
}
