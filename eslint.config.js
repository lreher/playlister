'use strict';

const noFunctionKeyword = [
  {
    selector: 'FunctionDeclaration',
    message: 'No function declarations — use a const arrow function.',
  },
  {
    selector: 'FunctionExpression',
    message: 'No function expressions — use an arrow function.',
  },
  {
    selector: 'ClassDeclaration',
    message: 'Classes are not allowed in this project.',
  },
  {
    selector: 'ClassExpression',
    message: 'Classes are not allowed in this project.',
  },
];

module.exports = [
  {
    ignores: ['node_modules/**', 'static/bundle.js', 'static/bundle.css', 'data/**'],
  },
  {
    files: ['**/*.js'],
    ignores: ['client/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-var': 'error',
      eqeqeq: 'error',
      'no-unused-vars': 'error',
      'no-restricted-syntax': ['error', ...noFunctionKeyword],
    },
  },
  {
    files: ['client/**/*.js', 'client/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        history: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-var': 'error',
      eqeqeq: 'error',
      'no-unused-vars': 'error',
      'no-restricted-syntax': ['error', ...noFunctionKeyword],
    },
  },
];
