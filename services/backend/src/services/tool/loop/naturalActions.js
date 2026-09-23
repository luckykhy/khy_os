'use strict';

/**
 * loop/naturalActions.js — 自然语言动作 -> 规范工具名的字面量映射（纯数据叶子 · 零 require）。
 *
 * 从 toolUseLoopCore.js 逐字节抽出的 NATURAL_ACTION_TO_TOOL 常量。它的唯一消费者是核心里的
 * `toolNames.setToolNamesDeps({ NATURAL_ACTION_TO_TOOL })` 一次性注入（loop/toolNames.js 保持叶子、
 * 无 require 回核心 → 不成环）。全字面量、只读、从不 mutate。键可为中文/拼音/英文别名，值为规范工具名。
 */

module.exports = {
  // Search
  搜索: 'web_search',
  search: 'web_search',
  websearch: 'web_search',
  web_search: 'web_search',
  查找: 'search',

  // Market quote
  行情: 'quote',
  quote: 'quote',
  报价: 'quote',
  价格: 'quote',

  // Backtest
  回测: 'backtest',
  backtest: 'backtest',

  // Build / Test / Lint / Verify
  构建: 'build_project',
  build: 'build_project',
  编译: 'build_project',
  测试: 'run_tests',
  test: 'run_tests',
  lint: 'lint_code',
  检查: 'lint_code',
  代码检查: 'lint_code',
  验证: 'verify_artifact',
  verify: 'verify_artifact',
  交付验证: 'verify_artifact',

  // K-line / data fetch
  k线: 'data_fetch',
  K线: 'data_fetch',
  kline: 'data_fetch',
  k线查询: 'data_fetch',

  // Strategy list
  策略列表: 'strategy_list',
  strategylist: 'strategy_list',
  strategy_list: 'strategy_list',

  // File operations
  读取文件: 'read_file',
  读文件: 'read_file',
  readfile: 'read_file',
  read_file: 'read_file',
  写入文件: 'write_file',
  writefile: 'write_file',
  write_file: 'write_file',
  创建项目: 'scaffoldFiles',
  项目脚手架: 'scaffoldFiles',
  脚手架: 'scaffoldFiles',
  目录结构: 'scaffoldFiles',
  批量创建: 'scaffoldFiles',
  并行写入: 'scaffoldFiles',
  scaffold: 'scaffoldFiles',
  scaffold_files: 'scaffoldFiles',
  project_scaffold: 'scaffoldFiles',

  // Shell
  命令: 'shell_command',
  shell: 'shell_command',
  bash: 'shell_command',
  shellcommand: 'shell_command',
  shell_command: 'shell_command',

  // App launch
  打开应用: 'open_app',
  启动应用: 'open_app',
  打开程序: 'open_app',
  openapp: 'open_app',
  open_app: 'open_app',
  应用: 'open_app',
  浏览器: 'open_app',

  // Git
  git状态: 'git_status',
  gitstatus: 'git_status',
  git_status: 'git_status',
  git差异: 'git_diff',
  gitdiff: 'git_diff',
  git_diff: 'git_diff',

  // Glob file search
  文件搜索: 'glob',
  glob: 'glob',
  find: 'glob',
  find_files: 'glob',

  // Grep content search
  内容搜索: 'grep',
  grep: 'grep',
  rg: 'grep',
  search_content: 'grep',

  // Edit file (precise replacement)
  编辑: 'editFile',
  edit: 'editFile',
  修改文件: 'editFile',
  edit_file: 'editFile',
  replace: 'editFile',

  // Image -> Web restore
  网页还原: 'image2web',
  图转网页: 'image2web',
  截图还原: 'image2web',
  截图转网页: 'image2web',
  image2web: 'image2web',
  image_to_web: 'image2web',
  screenshot_to_html: 'image2web',
};
