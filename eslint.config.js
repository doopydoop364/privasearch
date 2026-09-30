import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', 'var/**', 'eslint.config.js'] },
  js.configs.recommended, ...tseslint.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly' } } },
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-unused-vars': 'error', '@typescript-eslint/no-explicit-any': 'error' } },
);
