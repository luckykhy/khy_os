'use strict';

/**
 * configRepairPolicy.js — 纯叶子:.env 配置文件「损坏检测 + 修复策略」的单一真源。
 *
 * 背景(真缺口):khy 此前**没有统一的 .env 损坏检测与修复能力**——用户手动
 * 编辑 .env 文件可能引入语法错误(重复键、畸形行、未闭合引号、空键名),
 * 导致配置解析失败或行为异常。`config.js` 的 `_readEnvMap` 容错解析但
 * 静默忽略畸形行,从不报告问题。本叶子把损坏检测与修复策略收成单一真源:
 *   - detectEnvCorruption(lines)     —— 检测配置损坏类型(重复键/畸形行/空键/未闭合引号);
 *   - repairEnvLines(lines, issues)  —— 保守修复:只移除畸形行,不臆造缺失值;
 *   - isEnabled()                    —— 门控:KHY_CONFIG_REPAIR 默认开。
 *
 * 契约(CONTRACT):零 IO(只读 process.env 做门控,绝不碰 fs/网络/子进程/git/流;
 *   文件读写留给薄壳 configRepairService.js)、确定性、绝不抛(fail-soft,任何坏输入返回安全空值)、
 *   env 门控 `KHY_CONFIG_REPAIR` 默认开。门控关 → detectEnvCorruption 返回
 *   {isCorrupted: false, issues: []}、repairEnvLines 返回 {repaired: lines, removed: 0}
 *   (让薄壳字节回退到「不修复任何东西」)。
 *
 * 全局门控惯例:khy 所有 KHY_* 开关读法为「仅 0/false/off/no(去空白小写)才算关」。
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_CONFIG_REPAIR 默认开,仅 {0,false,off,no} 关。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_CONFIG_REPAIR;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/toStr').toStrSafe;

/**
 * 检测 .env 文件的损坏类型。
 *
 * @param {string[]} lines - .env 文件的行数组
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @returns {{isCorrupted: boolean, issues: Array<{line: number, type: string, message: string}>}}
 *
 * 检测类型:
 *   - duplicate-key: 重复的键(同一键出现多次)
 *   - malformed-line: 畸形行(有内容但无 =,非注释非空行)
 *   - empty-key: 空键名(如 "=value")
 *   - unclosed-quote: 未闭合引号(引号不成对)
 *
 * fail-soft:坏输入(非数组/门控关) → {isCorrupted: false, issues: []}
 */
function detectEnvCorruption(lines, opts = {}) {
  try {
    const env = (opts && opts.env) || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) return { isCorrupted: false, issues: [] };

    if (!Array.isArray(lines)) return { isCorrupted: false, issues: [] };

    const issues = [];
    const seenKeys = new Map(); // key → [line numbers]

    for (let i = 0; i < lines.length; i++) {
      const raw = _str(lines[i]);
      const trimmed = raw.trim();
      const lineNum = i + 1;

      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) continue;

      // 检查是否包含 =
      const eqIdx = raw.indexOf('=');
      if (eqIdx === -1) {
        issues.push({
          line: lineNum,
          type: 'malformed-line',
          message: `行 ${lineNum}: 非注释非空行缺少 '=' (${raw.slice(0, 40)}${raw.length > 40 ? '...' : ''})`,
        });
        continue;
      }

      // 提取键名
      const key = raw.slice(0, eqIdx).trim();
      if (!key) {
        issues.push({
          line: lineNum,
          type: 'empty-key',
          message: `行 ${lineNum}: 空键名 (${raw.slice(0, 40)}${raw.length > 40 ? '...' : ''})`,
        });
        continue;
      }

      // 记录键出现位置,检测重复
      if (!seenKeys.has(key)) {
        seenKeys.set(key, []);
      }
      seenKeys.get(key).push(lineNum);

      // 提取值,检查引号闭合
      const value = raw.slice(eqIdx + 1).trim();
      if (value) {
        const firstChar = value[0];
        const lastChar = value[value.length - 1];
        if ((firstChar === '"' || firstChar === "'") && firstChar !== lastChar) {
          issues.push({
            line: lineNum,
            type: 'unclosed-quote',
            message: `行 ${lineNum}: 引号未闭合 (${raw.slice(0, 40)}${raw.length > 40 ? '...' : ''})`,
          });
        }
      }
    }

    // 检查重复键
    for (const [key, lineNums] of seenKeys.entries()) {
      if (lineNums.length > 1) {
        issues.push({
          line: lineNums[0], // 报告首次出现位置
          type: 'duplicate-key',
          message: `键 "${key}" 重复出现在行: ${lineNums.join(', ')}`,
        });
      }
    }

    return {
      isCorrupted: issues.length > 0,
      issues,
    };
  } catch {
    return { isCorrupted: false, issues: [] };
  }
}

/**
 * 修复 .env 文件行数组。保守策略:只移除畸形行,不臆造缺失值。
 *
 * @param {string[]} lines - .env 文件的行数组
 * @param {Array<{line: number, type: string}>} issues - detectEnvCorruption 返回的问题列表
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @returns {{repaired: string[], removed: number}}
 *
 * 修复策略:
 *   - duplicate-key: 保留最后一次出现,移除之前的出现
 *   - malformed-line: 移除整行
 *   - empty-key: 移除整行
 *   - unclosed-quote: 移除整行
 *
 * fail-soft:坏输入/门控关 → {repaired: lines, removed: 0}(不修复)
 */
function repairEnvLines(lines, issues, opts = {}) {
  try {
    const env = (opts && opts.env) || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) return { repaired: lines || [], removed: 0 };

    if (!Array.isArray(lines)) return { repaired: [], removed: 0 };
    if (!Array.isArray(issues) || issues.length === 0) {
      return { repaired: lines.slice(), removed: 0 };
    }

    // 收集需要移除的行号
    const linesToRemove = new Set();

    // 收集重复键的所有出现位置
    const duplicateKeys = new Map(); // key → [line numbers]
    for (const issue of issues) {
      if (issue.type === 'duplicate-key') {
        // 从 message 中提取行号列表
        const match = issue.message.match(/行:\s*([\d,\s]+)/);
        if (match) {
          const lineNums = match[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
          if (lineNums.length > 1) {
            // 提取键名
            const keyMatch = issue.message.match(/键\s*"([^"]+)"/);
            const key = keyMatch ? keyMatch[1] : '';
            if (key) {
              duplicateKeys.set(key, lineNums);
            }
          }
        }
      }
    }

    // 对于重复键,只保留最后一次出现
    for (const [key, lineNums] of duplicateKeys.entries()) {
      // 移除除最后一个外的所有出现
      for (let i = 0; i < lineNums.length - 1; i++) {
        linesToRemove.add(lineNums[i]);
      }
    }

    // 其他类型的问题:直接移除
    for (const issue of issues) {
      if (issue.type === 'malformed-line' || issue.type === 'empty-key' || issue.type === 'unclosed-quote') {
        linesToRemove.add(issue.line);
      }
    }

    // 过滤掉需要移除的行
    const repaired = [];
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      if (!linesToRemove.has(lineNum)) {
        repaired.push(lines[i]);
      }
    }

    return {
      repaired,
      removed: linesToRemove.size,
    };
  } catch {
    return { repaired: lines || [], removed: 0 };
  }
}

module.exports = {
  isEnabled,
  detectEnvCorruption,
  repairEnvLines,
};
