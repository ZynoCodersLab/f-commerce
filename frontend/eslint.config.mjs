import { createRequire } from 'node:module';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// ESLint resolves `react-hooks/*` by name from this config's own plugins, so the
// plugin has to be registered here. A hoisted copy reproduces the flat config.
const require = createRequire(import.meta.url);
const reactHooksPlugin = require('eslint-plugin-react-hooks');

const reactHooksConfig = Array.isArray(reactHooksPlugin.configs.flat.recommended)
  ? reactHooksPlugin.configs.flat.recommended
  : reactHooksPlugin.configs.flat['recommended-latest'];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...(Array.isArray(reactHooksConfig) ? reactHooksConfig : [reactHooksConfig]),
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
