import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  // Node.js/server files (CommonJS)
  {
    files: ['server.js', 'server/**/*.js', 'api/**/*.js'], // add other Node entrypoints as needed
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script', // CommonJS
      globals: {
        ...globals.node,
      },
    },
    env: { node: true },
    rules: {
      // Optionally, you can add Node-specific rules here
    },
  },
  // Browser/React files
  {
    files: ['**/*.{js,jsx}'],
    ignores: ['server.js', 'server/**/*.js', 'api/**/*.js'], // don't double-lint Node files
    extends: [
      js.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
])
