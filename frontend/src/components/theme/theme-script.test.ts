import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY, themeScript } from './theme-script';

function runThemeScript() {
  new Function(themeScript)();
}

describe('themeScript', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('applies the stored theme', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    runThemeScript();

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('uses the system preference when no theme is stored', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

    runThemeScript();

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('defaults to light when there is no stored or system preference', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));

    runThemeScript();

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('keeps a stored light theme when the system prefers dark', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

    runThemeScript();

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('falls back to the system preference when reading storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

    runThemeScript();

    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
