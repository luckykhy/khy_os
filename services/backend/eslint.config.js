/**
 * ESLint flat config（ESLint >= 9 的默认配置格式）。
 *
 * 为什么存在：本目录原先只有 .eslintrc.json，而 devDependencies 声明的是
 * eslint ^9 —— ESLint 9 默认不再读取 .eslintrc.*，导致 `npm run lint` 直接以
 * "couldn't find an eslint.config.js" 退出码 2 失败。受影响的不只是本地：
 * .github/workflows/build-executables.yml 的 Lint 步骤在每次 v* tag 推送时
 * 都会因此失败。本文件是从 .eslintrc.json 逐条平移而来，规则集刻意保持不变，
 * 以免「修配置」顺带改变代码判定结果。
 *
 * 与 .eslintrc.json 的对应关系：
 *   env.node + env.es2022      → languageOptions.globals / ecmaVersion
 *   extends: eslint:recommended → js.configs.recommended
 *   extends: prettier           → eslint-config-prettier（必须放在最后，用于关闭
 *                                 与 Prettier 冲突的格式类规则）
 *   plugins: [import]           → plugins: { import: importPlugin }
 *   rules                       → 原样保留，未增删任何一条
 *
 * 迁移完成后可以删除 .eslintrc.json；此处暂时保留它，便于对照与回滚。
 */

'use strict';

const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const importPlugin = require('eslint-plugin-import');
const globals = require('globals');

module.exports = [
  // 不参与检查的目录。flat config 已废弃 .eslintignore，忽略项必须写在这里。
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      'build/**',
      '**/__pycache__/**',
      // CLI 代码生成模板与测试夹具是「故意不合规」的样板文件，不应参与检查。
      'src/data/cliAnythingTemplates/**',
      'tests/fixtures/**',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
      'no-multiple-empty-lines': ['warn', { max: 2, maxBOF: 0, maxEOF: 1 }],
      'padding-line-between-statements': [
        'warn',
        { blankLine: 'always', prev: 'function', next: 'function' },
        { blankLine: 'always', prev: 'export', next: 'function' },
        { blankLine: 'always', prev: 'function', next: 'export' },
      ],
      'no-var': 'warn',
      'prefer-const': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: 'warn',
      curly: 'warn',
    },
  },

  // 测试文件额外放开 Jest / node:test 的全局量。
  {
    files: ['tests/**/*.js', '**/*.test.js', 'scripts/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },

  // 必须是最后一项：关闭所有与 Prettier 冲突的格式化规则。
  prettier,
];
