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
      // Enforce the classic Rules of Hooks. Pinned explicitly rather than
      // spreading `reactHooks.configs.recommended.rules` because v7 folded the
      // new React-Compiler rules (refs, set-state-in-effect, immutability,
      // globals) into `recommended` as errors. Adopting those is a separate
      // effort; keep the linter bump net-neutral and turn them on deliberately.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
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
