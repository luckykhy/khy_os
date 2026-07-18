'use strict';

/**
 * userSkillCommands.js — 发现并暴露「用户自建技能」为斜杠命令(供 `/` 菜单与执行)。
 *
 * 背景(用户报「khy 说技能建好了，可 `/` 菜单里找不到该 skill」):khy 会把技能脚手架成
 * `~/.khy/skills/<name>/{manifest.json, prompt.md}` 约定(见 verifierScaffoldPlan.js /
 * cliAnythingService.js),`DiscoverSkills` 工具也照此读取。但 `/` 斜杠面板
 * (repl.js `_getSlashCommands()` / router.js `SLASH_COMMANDS`)只由 commandRegistry +
 * 静态 extras 构成,**从不枚举** ~/.khy/skills 下每个技能的 manifest.json —— 于是正确创建的用户技能
 * 永远不出现在菜单里、`/yt-dlp` 敲了也没反应。本模块补上这条发现接缝:
 *   ① listUserSkillCommands() → 扫三处技能根(built-in / 项目 .khy/skills / 家目录 .khy/skills)
 *      读 manifest.json,产出斜杠命令描述符(cmd/label/desc + _skillDir/_skillName 供执行)。
 *   ② loadUserSkillPrompt(dir) → 读该技能的 prompt.md(回退 SKILL.md)正文,供选中时注入模型。
 *
 * 本模块是发现层 / IO 编排(读技能目录与清单),不是零 IO 的纯逻辑单元;但保证任何 fs/JSON 异常
 * 一律降级为空结果 `[]` / `null`,决不影响 REPL 主流程。清单解析形状与
 * `tools/DiscoverSkillsTool/index.js` 保持一致(单一约定,避免两处漂移)。
 *
 * env 门控 `KHY_USER_SKILL_MENU`(默认开,仅显式 0/false/off/no/disable/disabled 关闭;
 * 关闭后逐字节回退到「不枚举用户技能」= 今日行为)。目录与 env 均可经 opts 注入以便单测。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const _FALSY = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/**
 * 门控判定。默认开,仅显式关闭词关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function userSkillMenuEnabled(env) {
  const v = (env || process.env || {}).KHY_USER_SKILL_MENU;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 技能根目录优先级链(与 DiscoverSkillsTool 一致):内置 → 项目 → 家目录。
 * @param {object} [opts] - { cwd?, home?, builtinDir? }
 * @returns {string[]}
 */
function _skillRoots(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const home = opts.home || os.homedir();
  const builtin = opts.builtinDir || path.join(__dirname, '..', '..', 'skills', 'built-in');
  return [
    { dir: builtin, source: 'built-in' },
    { dir: path.join(cwd, '.khy', 'skills'), source: 'user' },
    { dir: path.join(home, '.khy', 'skills'), source: 'user' },
  ];
}

/** 归一斜杠命令:确保单个前导 `/`、去空白、小写化前缀不做(保留大小写以对齐 manifest)。 */
function _normCmd(raw, fallbackName) {
  let s = String(raw || '').trim();
  if (!s) s = String(fallbackName || '').trim();
  if (!s) return '';
  if (!s.startsWith('/')) s = `/${s}`;
  // 命令 token 不含空白;取首段。
  return s.split(/\s+/)[0];
}

/**
 * 枚举用户自建技能为斜杠命令描述符。绝不抛;门控关或无技能 → `[]`。
 *
 * @param {object} [opts] - { env?, cwd?, home?, builtinDir? }
 * @returns {Array<{cmd,label,desc,source,_skillDir,_skillName,_aliases}>}
 */
function listUserSkillCommands(opts = {}) {
  if (!userSkillMenuEnabled(opts.env)) return [];
  const out = [];
  const seen = new Set();
  try {
    for (const { dir, source } of _skillRoots(opts)) {
      let entries;
      try {
        if (!fs.existsSync(dir)) continue;
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch { continue; }
      for (const entry of entries) {
        try {
          if (!entry.isDirectory()) continue;
          const skillDir = path.join(dir, entry.name);
          const manifestPath = path.join(skillDir, 'manifest.json');
          if (!fs.existsSync(manifestPath)) continue;
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (!manifest || typeof manifest !== 'object') continue;
          // command / trigger 二选一(scaffolder 有的写 command:"/x",有的写 trigger:"x")。
          const cmd = _normCmd(manifest.command || manifest.trigger, entry.name);
          if (!cmd || seen.has(cmd)) continue;
          seen.add(cmd);
          const aliases = Array.isArray(manifest.aliases)
            ? manifest.aliases.map((a) => _normCmd(a)).filter(Boolean)
            : [];
          out.push({
            cmd,
            label: String(manifest.name || entry.name),
            desc: String(manifest.description || ''),
            source: source === 'built-in' ? 'built-in' : 'skill',
            _skillDir: skillDir,
            _skillName: String(manifest.name || entry.name),
            _aliases: aliases,
          });
        } catch { /* 单个技能损坏 → 跳过,不影响其余 */ }
      }
    }
  } catch { /* 兜底:任何意外 → 已收集的照常返回 */ }
  return out;
}

/**
 * 读技能执行说明正文(prompt.md 优先,回退 SKILL.md)。绝不抛;缺失/异常 → `null`。
 * @param {string} skillDir
 * @returns {string|null}
 */
function loadUserSkillPrompt(skillDir) {
  if (!skillDir || typeof skillDir !== 'string') return null;
  for (const name of ['prompt.md', 'SKILL.md']) {
    try {
      const p = path.join(skillDir, name);
      if (fs.existsSync(p)) {
        const body = fs.readFileSync(p, 'utf-8');
        if (typeof body === 'string' && body.trim() !== '') return body;
      }
    } catch { /* 尝试下一个候选 */ }
  }
  return null;
}

module.exports = {
  userSkillMenuEnabled,
  listUserSkillCommands,
  loadUserSkillPrompt,
};
