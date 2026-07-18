'use strict';

/**
 * gitignoreService.js — 薄壳(IO):探测技术栈 + 读写工作区根 .gitignore。
 *
 * 背景:纯叶子 gitignoreAdvisor.js 负责「按栈生成 / 解析现有 / 求差集」的确定性运算(零 IO);
 *   本壳负责真正的 IO——探测项目技术栈(复用 deploy/projectDetector.detectProject)、
 *   读写 .gitignore 文件。.gitignore 落点走 `instructionFileService.findGitRoot(cwd) || cwd`
 *   (与既有指令文件定位一致,总是落在仓库根)。
 *
 * 本文件做 IO,是薄壳,不是纯叶子——不扫叶子契约。所有 IO fail-soft,绝不抛。
 */

const fs = require('fs');
const path = require('path');

const advisor = require('./gitignoreAdvisor');

/** 解析 .gitignore 应落的目录:优先仓库根,否则 cwd。 */
function _resolveRoot(cwd) {
  const base = cwd || process.env.KHYQUANT_CWD || process.cwd();
  try {
    const instr = require('./instructionFileService');
    const root = (instr && typeof instr.findGitRoot === 'function') ? instr.findGitRoot(base) : null;
    return root || base;
  } catch {
    return base;
  }
}

function _gitignorePath(cwd) {
  return path.join(_resolveRoot(cwd), '.gitignore');
}

/**
 * 幂等拼接:把 renderGitignoreBlock 产出的块(形如 "\n# header\n...\n")接到已有内容后。
 * - 空文件:去掉块前导换行,直接写块。
 * - 已有内容:先补齐尾换行,再接块(块的前导 \n 充当一个空行分隔)。
 */
function _joinBlock(existingText, block) {
  if (!existingText) return block.replace(/^\n/, '');
  let base = existingText;
  if (!base.endsWith('\n')) base += '\n';
  return base + block;
}

/**
 * 探测工作区技术栈标签数组(去重、保序)。复用 projectDetector 的单栈签名;
 * detectProject 返回单个最具体的 type,足以驱动模板选择。fail-soft → []。
 * @param {string} cwd
 * @returns {string[]}
 */
function detectStacks(cwd) {
  const dir = _resolveRoot(cwd);
  const stacks = [];
  try {
    const { detectProject } = require('./deploy/projectDetector');
    const plan = detectProject(dir) || {};
    if (plan.type && plan.type !== 'unknown') stacks.push(String(plan.type));
  } catch { /* fail-soft */ }
  return stacks;
}

/** 读工作区根 .gitignore 文本;无文件 / 异常 → ''。 */
function readGitignore(cwd) {
  try {
    const file = _gitignorePath(cwd);
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/** 工作区根是否已有 .gitignore(向导判定用)。 */
function hasGitignore(cwd) {
  try {
    return fs.existsSync(_gitignorePath(cwd));
  } catch {
    return false;
  }
}

/**
 * 幂等追加一组 pattern 到 .gitignore(只补缺失,现有已覆盖的跳过)。
 *
 * @param {string} cwd
 * @param {string[]} patterns  要补充的具体 pattern(如 `.env`、`build/`)。
 * @param {object} [opts]
 * @param {string} [opts.header] 分组注释。
 * @returns {{success:boolean, file?:string, added:string[], skipped:string[], error?:string}}
 */
function appendPatterns(cwd, patterns, opts = {}) {
  try {
    if (!advisor.isEnabled()) {
      return { success: false, added: [], skipped: [], error: 'gitignore advisor disabled (KHY_GITIGNORE_ADVISOR=off)' };
    }
    const list = Array.isArray(patterns) ? patterns : [];
    const file = _gitignorePath(cwd);
    const existingText = readGitignore(cwd);

    const additions = advisor.buildGitignoreAdditions({
      stacks: [],
      existingText,
      extraPaths: list,
      includeCommon: false,
    });

    const skipped = list.filter((p) => {
      const n = String(p == null ? '' : p).trim();
      return n && !additions.includes(n);
    });

    if (additions.length === 0) {
      return { success: true, file, added: [], skipped };
    }

    const block = advisor.renderGitignoreBlock(additions, { header: opts && opts.header });
    if (!block) return { success: true, file, added: [], skipped };

    fs.writeFileSync(file, _joinBlock(existingText, block), 'utf-8');
    return { success: true, file, added: additions, skipped };
  } catch (err) {
    return { success: false, added: [], skipped: [], error: (err && err.message) || String(err) };
  }
}

/**
 * 一步到位:探栈 → 求差集(栈模板 + common + extraPaths)→ 幂等追加。
 * 用户显式跑 `/gitignore generate` 或初始化向导时调用。
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string[]} [opts.extraPaths]  额外要忽略的具体路径(如自检检出)。
 * @param {string[]} [opts.stacks]      覆盖自动探测的栈(缺省自动探测)。
 * @param {string}   [opts.header]
 * @returns {{success:boolean, file?:string, stacks:string[], added:string[], skipped:string[], error?:string}}
 */
function generateForProject(cwd, opts = {}) {
  try {
    if (!advisor.isEnabled()) {
      return { success: false, stacks: [], added: [], skipped: [], error: 'gitignore advisor disabled (KHY_GITIGNORE_ADVISOR=off)' };
    }
    const stacks = Array.isArray(opts && opts.stacks) && opts.stacks.length
      ? opts.stacks
      : detectStacks(cwd);
    const existingText = readGitignore(cwd);
    const file = _gitignorePath(cwd);

    const additions = advisor.buildGitignoreAdditions({
      stacks,
      existingText,
      extraPaths: Array.isArray(opts && opts.extraPaths) ? opts.extraPaths : [],
      includeCommon: true,
    });

    if (additions.length === 0) {
      return { success: true, file, stacks, added: [], skipped: [] };
    }

    const header = (opts && opts.header)
      || `khy 按技术栈(${stacks.join(', ') || '通用'})生成的忽略项`;
    const block = advisor.renderGitignoreBlock(additions, { header });
    if (!block) return { success: true, file, stacks, added: [], skipped: [] };

    fs.writeFileSync(file, _joinBlock(existingText, block), 'utf-8');
    return { success: true, file, stacks, added: additions, skipped: [] };
  } catch (err) {
    return { success: false, stacks: [], added: [], skipped: [], error: (err && err.message) || String(err) };
  }
}

module.exports = {
  detectStacks,
  readGitignore,
  hasGitignore,
  appendPatterns,
  generateForProject,
};
