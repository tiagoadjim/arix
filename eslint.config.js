// Root ESLint flat config, shared by server/ and dashboard/. TypeScript is
// linted without a second type-aware compiler pass (the dedicated `typecheck`
// script owns that), while dashboard files additionally get React, Hooks and
// Next.js Core Web Vitals rules. CI runs this config with --max-warnings=0.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const dashboardRoot = fileURLToPath(new URL('./dashboard/', import.meta.url));

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
    // Register Next globally so Next 15's build-time ESLint detector sees the
    // plugin when it probes eslint.config.js itself. Rules remain scoped to
    // dashboard files below.
    plugins: {
      '@next/next': nextPlugin,
    },
    linterOptions: {
      // Surfaces eslint-disable comments left over from before this config
      // existed (or after a rule changes) instead of letting them rot.
      reportUnusedDisableDirectives: 'error',
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
    files: ['dashboard/**/*.{js,jsx,ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
        jsxPragma: null,
      },
    },
    settings: {
      react: { version: 'detect' },
      // Absolute so both `pnpm lint` (repo cwd) and `next build` (dashboard
      // cwd) resolve the App Router directory consistently.
      next: { rootDir: dashboardRoot },
    },
    rules: {
      ...reactPlugin.configs.flat.recommended.rules,
      ...reactPlugin.configs.flat['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // TypeScript owns component prop validation; runtime PropTypes would be
      // redundant and are not used by this codebase.
      'react/prop-types': 'off',
      // Warnings are CI failures too, so keep Hooks diagnostics explicit.
      'react-hooks/exhaustive-deps': 'error',
      // Most dashboard images are authenticated receipt media, QR data URLs,
      // or remote WooCommerce assets. They cannot safely use Next's optimizer
      // without broadening its remote-pattern/auth configuration.
      '@next/next/no-img-element': 'off',
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
