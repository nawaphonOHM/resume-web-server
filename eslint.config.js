// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    ignores: ['dist/**'],
  },
  {
    files: ['**/*.ts', '**/*.test.ts'],
    // Enable typed linting via the typescript-eslint Project Service.
    // This is slower than untyped linting; see https://typescript-eslint.io/getting-started/typed-linting
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    extends: [
      eslint.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', name: 'test', package: 'node:test' },
            { from: 'package', name: 'it', package: 'node:test' },
            { from: 'package', name: 'describe', package: 'node:test' },
            { from: 'package', name: 'suite', package: 'node:test' },
          ],
        },
      ],
    },
  },
]);
