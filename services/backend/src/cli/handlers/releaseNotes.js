'use strict';

/**
 * releaseNotes.js — `/release-notes` 命令薄壳:显示本地 CHANGELOG.md 的结构化发布说明。
 *
 * 对齐 Claude Code 的 /release-notes(CC 从远端 CHANGELOG_URL 拉取 → 解析 → 渲染)。
 * khy **离线优先**,不引入任何网络/host 硬编码 —— 改读仓库内**本地** CHANGELOG.md。
 * 真正的「背后逻辑」(Markdown → 版本/亮点结构)在纯叶子 changelogParse.js;本薄壳只做 IO:
 * 定位并读取 CHANGELOG.md(__dirname 相对仓库根,与 docs.js 同款;env 可覆盖路径),
 * 把全文交给叶子解析,再格式化输出。fail-soft:文件缺失/读失败 → 友好提示,绝不抛。
 *
 * 门控 KHY_RELEASE_NOTES 默认开;关 → 命令不接管(字节回退到「无此命令」的历史世界)。
 *
 * 用法:
 *   /release-notes            → 最新一个版本的发布说明
 *   /release-notes 3          → 最近 3 个版本
 *   /release-notes 0.1.136    → 指定版本
 */

const fs = require('fs');
const path = require('path');
const { printInfo, printError, printWarn } = require('../formatters');
const { parseChangelog, selectReleaseNotes } = require('../../services/changelog/changelogParse');

const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _enabled(env = process.env) {
  const raw = env && env.KHY_RELEASE_NOTES;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 定位 CHANGELOG.md。优先 env KHY_CHANGELOG_PATH(无硬编码绝对路径),
 * 否则按 __dirname 相对仓库根解析(handlers → 仓库根 = 五级上,与 docs.js 同款)。
 * @returns {string|null} 存在则返回绝对路径,否则 null。
 */
function _resolveChangelogPath(env = process.env) {
  // 显式 env 覆盖即权威:只认它,不再静默回退到仓库根(否则覆盖失效难排查)。
  const override = env && env.KHY_CHANGELOG_PATH;
  const candidates = override && String(override).trim()
    ? [String(override).trim()]
    : [path.resolve(__dirname, '../../../../../', 'CHANGELOG.md')];
  for (const p of candidates) {
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* fail-soft */ }
  }
  return null;
}

/** 把单个版本条目格式化为可读多行串(纯展示)。 */
function _renderEntry(entry) {
  const lines = [];
  lines.push(`## ${entry.version}`);
  if (entry.summary) lines.push(entry.summary);
  if (Array.isArray(entry.highlights) && entry.highlights.length) {
    lines.push('');
    for (const h of entry.highlights) {
      const title = h && h.title ? h.title : '';
      lines.push(`  • ${title}`);
    }
  }
  if (Array.isArray(entry.sections) && entry.sections.length) {
    lines.push(`  (另含小节:${entry.sections.join(' / ')})`);
  }
  return lines.join('\n');
}

/**
 * @param {string} subCommand 第一个位置参数(数量 N 或版本号,可空)
 * @param {string[]} args 其余参数
 * @returns {Promise<boolean>}
 */
async function handleReleaseNotes(subCommand, args = [], _options = {}) {
  if (!_enabled(process.env)) {
    printInfo('查看变更日志:打开仓库根目录的 CHANGELOG.md。');
    return false;
  }

  const arg = String(subCommand || (Array.isArray(args) && args[0]) || '').trim();

  const file = _resolveChangelogPath(process.env);
  if (!file) {
    printWarn('未找到 CHANGELOG.md(本地变更日志)。');
    printInfo('可设置 KHY_CHANGELOG_PATH 指向变更日志文件,或在源码仓库内运行。');
    return false;
  }

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    printError(`读取 CHANGELOG.md 失败:${e && e.message ? e.message : e}`);
    return false;
  }

  const entries = parseChangelog(raw);
  if (!entries.length) {
    printWarn('CHANGELOG.md 中未解析到任何版本条目。');
    return false;
  }

  // arg 是纯数字 → 当数量;含点/字母 → 当版本号;空 → 最新 1 个。
  const opts = {};
  if (arg) {
    if (/^\d+$/.test(arg)) opts.limit = parseInt(arg, 10);
    else opts.version = arg;
  }
  const selected = selectReleaseNotes(entries, opts);

  if (!selected.length) {
    printWarn(`未找到版本 ${arg} 的发布说明。`);
    printInfo(`可用版本(最近):${entries.slice(0, 8).map((e) => e.version).join(', ')}`);
    return false;
  }

  printInfo('khy OS 发布说明');
  for (const entry of selected) {
    printInfo('');
    printInfo(_renderEntry(entry));
  }
  return true;
}

module.exports = { handleReleaseNotes, _resolveChangelogPath, _renderEntry };
