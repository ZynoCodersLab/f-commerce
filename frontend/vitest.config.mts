import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    // Interactive tests type into real forms and take several seconds on a
    // slower machine, so give them room instead of failing at the five second
    // default.
    testTimeout: 15000,
    // Keep the Vitest defaults, then drop the Playwright suite and the Next
    // build output so only source tests are collected.
    exclude: [...configDefaults.exclude, 'e2e/**', '.next/**'],
    setupFiles: './src/test-setup.ts',
  },
});
