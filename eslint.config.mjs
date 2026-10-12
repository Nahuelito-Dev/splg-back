// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import jestPlugin from 'eslint-plugin-jest';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
    ...jestPlugin.configs['flat/recommended'],
    rules: {
      ...jestPlugin.configs['flat/recommended'].rules,
      'jest/no-focused-tests': 'error',
      'jest/no-disabled-tests': 'error',
      'jest/expect-expect': [
        'error',
        // cuentan como aserción el `.expect(...)` de supertest y `desempata`, que hace `expect` adentro
        { assertFunctionNames: ['expect', '**.expect', 'desempata'] },
      ],
      'jest/no-identical-title': 'error',
      'jest/valid-expect': 'error',
      'jest/no-conditional-expect': 'error',
      'jest/no-standalone-expect': 'error',
      'jest/no-done-callback': 'error',
      'jest/no-export': 'error',
      'jest/no-commented-out-tests': 'error',
    },
  },
);
