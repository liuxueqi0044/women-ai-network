// Root flat ESLint config shared by all packages and apps.
// Located at the repo root; `eslint .` from the root (or any subdirectory,
// where ESLint walks up to find this file) uses these settings.
import tseslint from 'typescript-eslint';
import nextVitals from '@next/eslint-plugin-next';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
      '**/next-env.d.ts',
    ],
  },
  tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Register the Next.js plugin in an UNscoped block: `next build` detects
  // the plugin via `eslint.calculateConfigForFile(<config file>)`, and a
  // `files:`-scoped block never applies to the config file itself — which
  // would keep the "Next.js plugin was not detected" build warning alive.
  // Plugins alone add no rules, so this is safe globally.
  {
    plugins: { '@next/next': nextVitals },
  },
  // Next.js app rules: the official plugin pinned to the app's Next version.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      ...nextVitals.configs.recommended.rules,
      ...nextVitals.configs['core-web-vitals'].rules,
      // Pages Router-only and deprecated in Next 15; this app is App Router,
      // so the rule only emits a "Pages directory cannot be found" warning.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
);
