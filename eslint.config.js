import js from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['build/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root config files and unit tests live outside tsconfig include
          allowDefaultProject: ['*.js', '*.ts', 'tests/unit/*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { unicorn: eslintPluginUnicorn },
    rules: {
      // MCP stdio transport: stdout carries the JSON-RPC protocol, so only
      // stderr logging is acceptable. Kept as a warning until the remaining
      // console.log calls are migrated (issue #1).
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      'no-else-return': 'warn',
      'array-callback-return': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'unicorn/prefer-node-protocol': 'error',
      // Decreased severity (same approach as the reference setup): the
      // existing API client relies on any-typed responses. To be hardened
      // in a dedicated typing pass.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-invalid-void-type': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    // Tests rely on any-typed mocks and raw mock.calls access
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  // Must stay last: turns off stylistic rules that conflict with Prettier
  eslintPluginPrettierRecommended,
);
