// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import spellcheck from 'eslint-plugin-spellcheck';

export default defineConfig([
  {
    files: ['**/*.ts'],
    ignores: ['**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        parser: tsParser,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
      sonarjs: sonarjs,
      unicorn: unicorn,
      spellcheck: spellcheck,
    },
    extends: [
      eslint.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      // --- errcheck, staticcheck, unused & ineffassign equivalents ---
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': ['error'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-constant-binary-expression': 'error',

      // --- govet (shadowing & logic) ---
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',

      // --- revive: strict code metrics ---
      complexity: ['error', 3], // cyclomatic complexity limit: 3
      'sonarjs/cognitive-complexity': ['error', 7], // cognitive complexity limit: 7
      'max-lines': ['error', { max: 100, skipComments: true, skipBlankLines: true }], // file length limit: 100
      'max-lines-per-function': ['error', { max: 10, skipComments: true, skipBlankLines: true }], // function length limit: 10
      'max-params': ['error', 4], // argument limit: 4

      // --- revive: style & conventions ---
      'no-magic-numbers': 'off',
      '@typescript-eslint/no-magic-numbers': [
        'warn',
        {
          ignore: [0, 1, 2],
          ignoreArrayIndexes: true,
          enforceConst: true,
        },
      ],
      'no-empty': 'error',
      'no-else-return': 'error',
      'import/no-duplicates': 'error',

      // --- modernize & naming rules ---
      'unicorn/filename-case': [
        'error',
        {
          case: 'snakeCase', // Matches ^[_a-z][_a-z0-9]*\.go$ pattern
        },
      ],
      'unicorn/prefer-node-protocol': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
    },
  },
]);
