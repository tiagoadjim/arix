// Root ESLint flat config, shared by server/ and dashboard/.
//
// Minimal on purpose: typescript-eslint's non-type-checked "recommended"
// ruleset only. No `parserOptions.project` (that would need per-package
// tsconfig wiring and a type-checking pass — slower, and out of scope for a
// lint step CI treats as non-blocking). No React/Next plugins either; this
// just keeps obvious TS mistakes in check across both packages from one
// place.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'dashboard/next-env.d.ts',
      // Hand-vendored shadcn/ui primitives — generated component code, not
      // house style; don't lint it like hand-written app code.
      'dashboard/src/components/ui/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    linterOptions: {
      // Surfaces eslint-disable comments left over from before this config
      // existed (or after a rule changes) instead of letting them rot.
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // TypeScript already checks this, and more accurately (it understands
      // ambient/global types); the bare ESLint version false-positives on
      // Node/DOM globals across this repo without an extra `globals` setup.
      'no-undef': 'off',
      // This codebase's existing convention for intentionally-unused
      // parameters (e.g. Express's 4-arg error-handling middleware) is an
      // underscore prefix — respect it instead of forcing renames/disables.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // CLI entry points: legitimate stdout/stderr output, not app logging.
    files: ['server/src/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
