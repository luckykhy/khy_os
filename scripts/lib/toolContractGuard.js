'use strict';

/**
 * toolContractGuard —— 工具契约 CI 守卫的核心（薄壳 check-tool-contract.js 调用）。
 *
 * 与逐文件守卫（leafContractGuard 等）不同,工具契约是**注册表级**不变量:一个工具的
 * 命名冲突/坏 schema 只有把整表放在一起才能判定。故本守卫不做 assessFile,而是
 * assessRegistry():require 真实工具注册表 + 纯叶子审计器 toolContract.auditTools,
 * 把 findings 映射成守卫标准形状 {severity, rule, file, line, message, snippet}。
 *
 * **恒巡检**:审计器运行时门控 KHY_TOOL_CONTRACT 只影响 CLI/运行时入口;CI 守卫在此
 * 强制置开（临时覆写 env）后调 auditTools,保证守卫不被运行时门控关静默跳过。
 *
 * `--changed` 相关性:工具契约只被 src/tools/** 与 toolRegistryDedup/toolCalling 影响,
 * isRelevantChange() 供薄壳判断改动是否触及这些路径(无关改动 → 薄壳 exit 0 跳过)。
 */

const path = require('path');

// 审计器（纯叶子）——从 scripts/lib 相对定位到 backend 源。
const AUDITOR_PATH = path.resolve(__dirname, '../../services/backend/src/services/toolCatalog/toolContract');
// findings 无 per-tool 文件（注册表级）→ file 字段回退到注册表模块路径，line=0。
const REGISTRY_REL = 'services/backend/src/tools/index.js';

/** 触及工具契约的路径前缀/文件（相对 repo 根，正斜杠）。 */
const RELEVANT_PREFIXES = [
  'services/backend/src/tools/',
];
const RELEVANT_FILES = new Set([
  'services/backend/src/services/toolRegistryDedup.js',
  'services/backend/src/services/toolCalling.js',
  'services/backend/src/services/toolCatalog/toolContract.js',
  'services/backend/src/constants/riskOrder.js',
]);

// bundled 三树是构建产物,不巡检(与既有守卫 IGNORE 一致)。
const IGNORE_SEGMENTS = ['bundled', '_source', 'node_modules'];

/**
 * 改动文件是否与工具契约相关(供薄壳 --changed 门控)。
 * @param {string} relPath repo 相对路径(正斜杠)
 * @returns {boolean}
 */
function isRelevantChange(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (!p) return false;
  if (IGNORE_SEGMENTS.some((seg) => p.split('/').includes(seg))) return false;
  if (RELEVANT_FILES.has(p)) return true;
  return RELEVANT_PREFIXES.some((pre) => p.startsWith(pre));
}

/**
 * 对真实注册表跑契约审计,返回守卫标准 findings。
 * @param {object} [deps] 测试注入:{ audit } 覆写审计入口
 * @returns {{findings: Array, errors: number, warnings: number, total: number}}
 */
function assessRegistry(deps = {}) {
  let audit;
  try {
    audit = (deps && typeof deps.audit === 'function')
      ? deps.audit
      : require(AUDITOR_PATH).auditTools;
  } catch (e) {
    return {
      findings: [{ severity: 'error', rule: 'guard', file: REGISTRY_REL, line: 0, message: `无法加载工具契约审计器: ${e && e.message}` }],
      errors: 1, warnings: 0, total: 0,
    };
  }

  // 恒巡检:临时强制门控开,跑完还原(守卫不受运行时 KHY_TOOL_CONTRACT 影响)。
  const prev = process.env.KHY_TOOL_CONTRACT;
  process.env.KHY_TOOL_CONTRACT = 'on';
  let report;
  try {
    report = audit({});
  } catch (e) {
    report = { findings: [{ severity: 'error', rule: 'guard', tool: '(registry)', message: `审计抛异常: ${e && e.message}` }], errors: 1, warnings: 0, total: 0 };
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_CONTRACT;
    else process.env.KHY_TOOL_CONTRACT = prev;
  }

  const findings = (report.findings || []).map((f) => ({
    severity: f.severity,
    rule: `tool-${f.rule}`,
    file: REGISTRY_REL,
    line: 0,
    message: `${f.tool ? f.tool + ': ' : ''}${f.message}`,
  }));

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return { findings, errors, warnings, total: report.total || 0 };
}

module.exports = { assessRegistry, isRelevantChange, RELEVANT_PREFIXES, RELEVANT_FILES };
