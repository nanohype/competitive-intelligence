import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // src/vendor/ holds byte-identical copies of @nanohype/runtime modules,
  // linted at their source of truth — local lint fixes there would be drift.
  { ignores: ['dist/', 'src/vendor/'] },
);
