import path from 'node:path';
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import frontendConfig from './frontend/eslint.config.mjs';

export default defineConfig([
  globalIgnores(['**/node_modules/**', '**/.next/**', '**/dist/**', '**/coverage/**']),
  {
    ignores: ['frontend/**'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
  },
  {
    files: ['backend/**/*.ts', 'packages/contracts/**/*.ts'],
    // Standalone tool configs are outside their workspace tsconfig program.
    ignores: ['backend/*.config.ts', 'packages/contracts/*.config.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
  {
    // Delegate frontend files to the Next.js workspace config when ESLint runs
    // from the repo root (for example `npx eslint frontend`), and point Next
    // rules at the frontend directory.
    basePath: 'frontend',
    extends: [frontendConfig],
    settings: {
      next: {
        rootDir: path.join(import.meta.dirname, 'frontend'),
      },
    },
  },
]);
