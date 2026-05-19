// Root ESLint flat config. Governs every workspace EXCEPT
// `packages/app/` (which keeps its own React-specific config at
// packages/app/eslint.config.js) and the generated/test
// scaffolding (dist, node_modules, fragments/example).
//
// The rule set is intentionally conservative for the first landing:
// - typescript-eslint `recommended` (no `any`, no unused vars, etc.)
// - no-console for server packages (warn — the structured logger
//   replaces these incrementally; honoring the existing
//   `eslint-disable-next-line no-console` directives so we don't get
//   re-noised when they're added intentionally)
// - eqeqeq + prefer-const
// - no-empty (allowing catch on purpose — we have many fire-and-forget
//   sites)
//
// Type-aware rules (no-floating-promises, no-misused-promises) are NOT
// enabled yet: turning them on requires every TS file (including
// integration test files) to live inside a tsconfig project, and the
// scattershot test-only files would all need to be added. That's a
// separate cleanup. The structured logger conversion is similarly
// deferred.
//
// To run: `npx eslint .` from the repo root (or `npm run lint`).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.nx/**',
      'packages/desktop/**',
      'packages/app/**', // app keeps its own config
      'packages/app-scaffold/fragments/example/**',
    ],
  },
  {
    files: ['packages/**/*.ts', 'packages/**/*.tsx', 'packages/**/*.mts', 'packages/**/*.cts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    linterOptions: {
      // The codebase has many "// eslint-disable-next-line no-console"
      // directives that pre-date this root config. Don't fail on
      // unused directives — they document operator-visible logging
      // that's intentionally exempted from a future no-console rule.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // The `no-explicit-any` rule is enabled by the recommended set;
      // soften to a warning for now so the long-tail doesn't gate this
      // landing. Promote to error once the cleanup catches up.
      '@typescript-eslint/no-explicit-any': 'warn',
      // File-size guardrail. Warn at 1000 lines so the next monolith
      // gets attention before it grows past saving (api/src/app.ts is
      // the last known offender; see Phase 4 of the cleanup plan).
      // Promote to 'error' once the route dispatcher has been split.
      'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['packages/server/**/*.ts', 'packages/server/**/*.tsx'],
    rules: {
      // Structured logger (pino) lands as a follow-up. Until then,
      // every console.* in server source carries an explicit
      // disable directive on the line above so the call site is auditable.
      'no-console': 'warn',
    },
  },
  {
    // Test files relax a couple of rules that get in the way of
    // pragmatic test code (expressive any-cast, _ unused captures).
    files: ['packages/**/test/**', 'packages/**/*.test.ts', 'packages/**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'off',
      // Test files are allowed to grow longer — they accrete fixtures
      // and assertions across many test cases.  Splitting them is
      // valuable but never urgent the way a 1600-line route dispatcher
      // is.
      'max-lines': 'off',
    },
  },
);
