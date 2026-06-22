import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config({
  extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
  ignores: ['dist/', 'node_modules/'],
  rules: {
    'no-constant-condition': ['warn', { checkLoops: false }],
    'prefer-const': 'warn',
    'no-control-regex': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-multiple-empty-lines': ['warn', { max: 1, maxEOF: 0, maxBOF: 0 }],
    'lines-between-class-members': ['warn', 'always', { exceptAfterSingleLine: true }],
    'padding-line-between-statements': [
      'warn',
      { blankLine: 'always', prev: 'import', next: '*' },
      { blankLine: 'any', prev: 'import', next: 'import' },
    ],
    'keyword-spacing': ['warn', { before: true, after: true }],
    'space-infix-ops': 'warn',
    'space-before-blocks': 'warn',
    'brace-style': ['warn', '1tbs', { allowSingleLine: false }],
    '@typescript-eslint/member-ordering': [
      'warn',
      {
        default: [
          'public-static-field',
          'protected-static-field',
          'private-static-field',
          'public-field',
          'protected-field',
          'private-field',
          'constructor',
          'public-static-method',
          'protected-static-method',
          'private-static-method',
          'public-method',
          'protected-method',
          'private-method',
        ],
      },
    ],
  },
});
