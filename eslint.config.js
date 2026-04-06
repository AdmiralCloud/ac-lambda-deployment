const globals = require('globals')
const js = require('@eslint/js')

module.exports = [
  {
    files: ['index.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.es2022,
        ...globals.node
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      // --- code quality ---
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-useless-escape': 'off',
      'no-var': 'error',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'eqeqeq': 'error',
      'curly': ['error', 'multi-line'],
      // --- formatting ---
      'space-before-function-paren': ['error', { anonymous: 'never', named: 'never', asyncArrow: 'never' }],
      'no-extra-semi': 'off',
      'object-curly-spacing': ['error', 'always'],
      'brace-style': ['error', 'stroustrup', { allowSingleLine: true }],
      'block-spacing': 'error'
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.mocha,
        expect: 'readonly',
        assert: 'readonly',
        should: 'readonly'
      }
    }
  }
]