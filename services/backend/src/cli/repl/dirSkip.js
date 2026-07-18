'use strict';

/**
 * dirSkip.js — 目录遍历跳过集（单一真源）。
 *
 * 被 repl/toolOutputRender._buildDirTree 与 repl/atPicker.listAtEntries 共用：
 * 列目录/构建目录树时跳过的依赖与产物目录。集中于此避免两处各持一份漂移。
 */

const DIR_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.nuxt',
  '.cache', '.tox', '.venv', 'venv', 'env', '.eggs', '*.egg-info', 'coverage',
  '.nyc_output', 'bower_components', '.svn', '.hg',
]);

module.exports = { DIR_SKIP };
