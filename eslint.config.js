import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/',
      'dist-webcli/',
      'dist-webcli-dev/',
      'dist-localmd/',
      'dist-localmd-dev/',
      'node_modules/',
      // Adapter files imported from xiaohongshu-operator (which mirrors opencli upstream)
      // — kept byte-identical so re-sync is just a cp. Don't lint them here.
      'src/tools/**/*.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        chrome: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'off',
    },
  },
];
