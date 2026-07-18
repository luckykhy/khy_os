'use strict';

/**
 * ccUserCommands.js — 发现并暴露「Claude Code 自定义斜杠命令」为 khy 斜杠命令。
 *
 * 背景(goal「khy 缺少生态,希望能用其他开发者做的生态扩展 …工具市场等」):社区里大量
 * 「command pack」仓库以 Claude Code 约定分发斜杠命令 —— 每个命令是 `.claude/commands/<name>.md`
 * (或 `.claude/commands/<ns>/<name>.md` 命名空间到 `/ns:name`),文件为 YAML frontmatter
 * (description / argument-hint / allowed-tools / model)+ markdown 正文(正文即提示词,含
 * `$ARGUMENTS` / `$1..$9` 占位)。khy 此前只读自家 `~/.khy/skills`,**从不读** CC 的
 * `.claude/commands` → 第三方 CC 命令包对 khy 不可见。本模块补上这条发现接缝,与
 * userSkillCommands.js 同构:
 *   ① listCcCommands() → 扫 ccCommandBridge 给出的 CC 命令根(项目 / 家目录),读每个 `*.md`
 *      的 frontmatter,产出斜杠命令描述符(cmd/label/desc + _commandFile/_commandName 供执行)。
 *   ② loadCcCommandBody(file) → 读该命令文件正文(剥离 frontmatter),供选中时注入模型。
 *   ③ renderCcCommandBody(body, argText) → 兑现 `$ARGUMENTS` / `$1..$9` 占位(CC 语义)。
 *
 * 本模块是发现层 / IO 编排(读命令目录与文件),不是零 IO 的纯逻辑单元;但保证任何 fs 异常
 * 一律降级为空结果 `[]` / `null`,决不影响 REPL 主流程。命令根与门控由纯叶子 ccCommandBridge
 * 决定(单一真源,避免两处漂移):门控 `KHY_CC_COMMAND_BRIDGE`(默认开,仅 0/false/off/no 关;
 * 关闭后 listCcCommands 返 [] → 逐字节回退「不读 CC 命令」= 今日行为)。目录/env 可经 opts 注入。
 *
 * 诚实边界:仅**发现**磁盘上已存在的 CC 命令文件,不安装、不联网、不执行;安装命令包(git clone /
 * CC marketplace)仍是用户 / CC 的事,khy 只读现成的。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { isCcCommandBridgeEnabled, ccCommandSearchDirs } = require('../../commands/ccCommandBridge');
const { parseFrontmatter } = require('../../agents/loadAgents');

/**
 * 从 frontmatter 原文中原样抽取 argument-hint(保留字面量,不经通用 parser 的数组化)。
 * CC 的 hint 常写成 `[file]` / `<pr-number>`,通用 parseFrontmatter 会把 `[file]` 误当内联数组
 * → 丢括号。这里直接按行抽取,去引号但保留其余字面,供菜单展示。绝不抛;缺失/异常 → ''。
 * @param {string} raw
 * @returns {string}
 */
function _extractHint(raw) {
  try {
    const m = String(raw == null ? '' : raw).match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return '';
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^\s*argument-hint\s*:\s*(.*)$/);
      if (mm) {
        let v = String(mm[1] || '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        return v;
      }
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 归一斜杠命令:确保单个前导 `/`、去空白、取首 token(不含空白)。 */
function _normCmd(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.split(/\s+/)[0];
}

/**
 * 由「命令根 + 相对路径」推出斜杠命令名。CC 语义:子目录 → 命名空间用 `:` 连接。
 *   foo.md         → /foo
 *   git/commit.md  → /git:commit
 * @param {string} relPath - 相对命令根的路径(如 'git/commit.md')
 * @returns {string} 归一后的斜杠命令(失败 → '')
 */
function _cmdFromRelPath(relPath) {
  try {
    const noExt = String(relPath || '').replace(/\.md$/i, '');
    const segs = noExt.split(/[\\/]/).map((s) => s.trim()).filter(Boolean);
    if (!segs.length) return '';
    return _normCmd(segs.join(':'));
  } catch {
    return '';
  }
}

/**
 * 枚举一个 CC 命令根下的 `*.md`(根级 + 一层命名空间子目录)。绝不抛;异常 → 已收集照返。
 * @param {string} rootDir
 * @param {string} source
 * @param {Set<string>} seen - 跨根去重(先扫的根优先,khy/项目先于家目录)
 * @returns {Array} 描述符数组
 */
function _scanCommandRoot(rootDir, source, seen) {
  const out = [];
  let topEntries;
  try {
    if (!fs.existsSync(rootDir)) return out;
    topEntries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  // 待扫文件列表:根级 *.md 直接;一层子目录里的 *.md 带命名空间。
  const files = []; // { abs, rel }
  for (const entry of topEntries) {
    try {
      if (entry.isFile() && /\.md$/i.test(entry.name)) {
        files.push({ abs: path.join(rootDir, entry.name), rel: entry.name });
      } else if (entry.isDirectory()) {
        const nsDir = path.join(rootDir, entry.name);
        let nsEntries = [];
        try { nsEntries = fs.readdirSync(nsDir, { withFileTypes: true }); } catch { nsEntries = []; }
        for (const ns of nsEntries) {
          if (ns.isFile() && /\.md$/i.test(ns.name)) {
            files.push({ abs: path.join(nsDir, ns.name), rel: `${entry.name}/${ns.name}` });
          }
        }
      }
    } catch { /* 单条目坏 → 跳过 */ }
  }

  for (const f of files) {
    try {
      const cmd = _cmdFromRelPath(f.rel);
      if (!cmd || seen.has(cmd)) continue;
      let raw = '';
      try { raw = fs.readFileSync(f.abs, 'utf-8'); } catch { continue; }
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      let frontmatter = {};
      try { ({ frontmatter } = parseFrontmatter(raw)); } catch { frontmatter = {}; }
      seen.add(cmd);
      out.push({
        cmd,
        label: cmd.slice(1),
        desc: String((frontmatter && frontmatter.description) || ''),
        source: 'cc-command',
        _commandFile: f.abs,
        _commandName: cmd.slice(1),
        _argumentHint: _extractHint(raw),
        _aliases: [],
      });
    } catch { /* 单命令坏 → 跳过,不影响其余 */ }
  }
  return out;
}

/**
 * 枚举 CC 自定义斜杠命令为描述符。绝不抛;门控关或无命令 → `[]`。
 *
 * @param {object} [opts] - { env?, cwd?, home? }
 * @returns {Array<{cmd,label,desc,source,_commandFile,_commandName,_argumentHint,_aliases}>}
 */
function listCcCommands(opts = {}) {
  const env = opts.env || process.env;
  if (!isCcCommandBridgeEnabled(env)) return [];
  const cwd = opts.cwd || process.cwd();
  const home = opts.home || os.homedir();
  const out = [];
  const seen = new Set();
  try {
    const roots = ccCommandSearchDirs({ homedir: home, projectDir: cwd });
    for (const { dir, source } of roots) {
      for (const d of _scanCommandRoot(dir, source, seen)) out.push(d);
    }
  } catch { /* 兜底:任何意外 → 已收集照返 */ }
  return out;
}

/**
 * 读 CC 命令正文(剥离 frontmatter)。绝不抛;缺失/异常 → `null`。
 * @param {string} commandFile - 绝对路径
 * @returns {string|null}
 */
function loadCcCommandBody(commandFile) {
  if (!commandFile || typeof commandFile !== 'string') return null;
  try {
    if (!fs.existsSync(commandFile)) return null;
    const raw = fs.readFileSync(commandFile, 'utf-8');
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    let body = raw;
    try { ({ body } = parseFrontmatter(raw)); } catch { body = raw; }
    const text = String(body == null ? '' : body).trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/**
 * 兑现 CC 占位符(纯函数)。CC 语义:
 *   - `$ARGUMENTS` → 全部参数原文
 *   - `$1`..`$9`   → 第 N 个空白分隔的位置参数(缺失 → 空串)
 * 若正文不含任何占位符且有参数,则在末尾追加参数(与用户技能一致的降级拼接)。
 *
 * @param {string} body
 * @param {string} [argText]
 * @returns {string}
 */
function renderCcCommandBody(body, argText = '') {
  const text = String(body == null ? '' : body);
  const args = String(argText == null ? '' : argText).trim();
  const hasArgumentsPlaceholder = /\$ARGUMENTS\b/.test(text);
  const hasPositional = /\$[1-9]\b/.test(text);

  if (!hasArgumentsPlaceholder && !hasPositional) {
    return args ? `${text}\n\n${args}` : text;
  }

  const positional = args ? args.split(/\s+/) : [];
  let rendered = text.replace(/\$ARGUMENTS\b/g, args);
  rendered = rendered.replace(/\$([1-9])\b/g, (_m, d) => {
    const idx = Number(d) - 1;
    return positional[idx] != null ? positional[idx] : '';
  });
  return rendered;
}

module.exports = {
  listCcCommands,
  loadCcCommandBody,
  renderCcCommandBody,
  // 内部纯函数导出便于单测。
  _cmdFromRelPath,
};
