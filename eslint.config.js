import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dev-dist',
      'coverage',
      'node_modules',
      // Deno Edge Function entrypoints target the Deno runtime (URL imports,
      // the `Deno` global) and are type-checked/deployed by the Supabase CLI,
      // not the app's tsconfig. The shared logic under _shared/ IS linted.
      'supabase/functions/*/index.ts',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Enforce the classic Rules of Hooks. The v7 React-Compiler `refs` rule
      // is still off pending a deliberate pass over its ~62 existing product-code
      // violations; the other three are adopted below.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Adopted incrementally: globals/immutability had only test-file
      // violations; set-state-in-effect's genuine reset-on-change cases were
      // moved into render, and its legitimate async/layout-effect cases carry
      // scoped disables.
      'react-hooks/globals': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/set-state-in-effect': 'error',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
