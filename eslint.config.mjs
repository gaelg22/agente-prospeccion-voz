// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Permitir any explícito solo cuando se documenta
      '@typescript-eslint/no-explicit-any': 'warn',
      // No usar console — usar pino
      'no-console': ['error', { allow: ['error', 'warn'] }],
      // Promises siempre manejadas — excepto callbacks de Express (req,res,next)=>void
      // donde el async es el patrón idiomático y el error se propaga vía next().
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
      // No variables sin usar
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Siempre usar tipos explícitos en funciones públicas
      '@typescript-eslint/explicit-function-return-type': 'off',
      // No require() — todo es import/export
      '@typescript-eslint/no-require-imports': 'error',
    },
  },
  {
    // Los tests tienen reglas más relajadas
    files: ['**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'vitest.config.ts', 'src/**/__tests__/**'],
  },
);
