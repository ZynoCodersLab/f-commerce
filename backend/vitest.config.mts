import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Database integration tests share one PostgreSQL test database, so test
    // files must not run concurrently.
    fileParallelism: false,
    // The catalog plan test seeds twenty thousand rows and runs EXPLAIN against
    // the real database, which can take over five seconds on a loaded machine.
    // Give the slow real database tests room instead of failing at the default.
    testTimeout: 15000,
    // A loaded machine can also stall a beforeAll or beforeEach that truncates
    // and reseeds the real database, so the hooks get the same headroom.
    hookTimeout: 30000,
    // Build output is never test input, and Vitest no longer ignores dist/ by
    // default. Keeping it excluded also stops stale artifacts from an older
    // build from breaking the run.
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
});
