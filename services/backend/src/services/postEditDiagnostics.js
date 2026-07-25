'use strict';

/**
 * postEditDiagnostics.js — 编辑后「新增诊断」的 before/after 基线追踪壳服务。
 *
 * 注意:这是**壳(shell)不是纯叶子**——它经 verificationAgent.quickSyntaxCheck 跑子进程 IO、
 * 并维护模块级状态。刻意**不**在注释里自述「纯叶子」,以免 check-leaf-contract 把它当叶子扫。
 * 纯字符串判定(归一/求差/摘要)都在纯叶子 cli/postEditDiagnosticsSummary.js 里。
 *
 * 对齐 Claude Code services/diagnosticTracking.ts 的逻辑:
 *   - beforeFileEdited(→ captureBaseline):编辑**前**给文件的诊断打基线;
 *   - getNewDiagnostics(→ collectNewDiagnostics):编辑**后**再取,只报「后有前无」的新增;
 *   - handleQueryStart 的 reset:每个顶层 turn 清基线。
 * khy 诊断源是语法层 quickSyntaxCheck(node -c / py_compile / JSON.parse),故这是语法层的
 * before/after diff。门控 KHY_POST_EDIT_DIAGNOSTICS(默认开)——关时全部 no-op,逐字节回退。
 */

const path = require('path');

// 归一路径 → 该文件编辑前的错误签名集合(Set<string>)。
const _baseline = new Map();

function _enabled(env = process.env) {
  try {
    return require('./postEditDiagnosticsSummary').postEditDiagnosticsEnabled(env);
  } catch {
    return false;
  }
}

// 展开前导 ~,再 path.resolve —— 捕获侧(工具解析的 absPath)与 diff 侧(loop 传的 raw 模型路径)
// 必须走**同一个** _key,否则 baseline 存/取的键对不上、永远 miss(RISK 1)。
function _key(filePath, cwd) {
  try {
    const base = process.env.KHYQUANT_CWD || cwd || process.cwd();
    let raw = String(filePath == null ? '' : filePath);
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      raw = home + raw.slice(1);
    }
    return path.resolve(base, raw);
  } catch {
    return String(filePath == null ? '' : filePath);
  }
}

function _syntaxErrors(file, cwd) {
  try {
    const { quickSyntaxCheck } = require('./verificationAgent');
    const res = quickSyntaxCheck([file], cwd);
    return res && Array.isArray(res.errors) ? res.errors : [];
  } catch {
    return [];
  }
}

/**
 * 编辑**前**捕获基线。门控关 → no-op。
 * RISK 2:无论 quickSyntaxCheck 成功/失败/文件不存在,都**无条件登记条目**(失败→空集),
 * 否则 Write 新建的文件在 collect 阶段(只 diff「有基线」的文件)会被跳过——而新文件的所有错
 * 恰恰都该算「新增」。
 * @param {string} filePath
 * @param {string} [cwd]
 */
function captureBaseline(filePath, cwd) {
  try {
    if (!_enabled()) return;
    const key = _key(filePath, cwd);
    if (!key) return;
    let set;
    try {
      const leaf = require('./postEditDiagnosticsSummary');
      set = leaf.toSignatureSet(_syntaxErrors(filePath, cwd));
    } catch {
      set = new Set();
    }
    _baseline.set(key, set);
  } catch {
    /* fail-soft:诊断追踪绝不影响编辑本身 */
  }
}

/**
 * 编辑**后**收集新增诊断。门控关 → 返回空。
 * 对每个**有基线**的文件重跑 quickSyntaxCheck、与基线求差、推进基线到当前。
 * @param {string[]} files
 * @param {string} [cwd]
 * @returns {{issueCount:number, fileCount:number, perFile:Array<{file:string,newErrors:string[]}>}}
 */
function collectNewDiagnostics(files, cwd) {
  const empty = { issueCount: 0, fileCount: 0, perFile: [] };
  try {
    if (!_enabled()) return empty;
    if (!Array.isArray(files) || files.length === 0) return empty;
    const leaf = require('./postEditDiagnosticsSummary');
    // dedupe(并行批次同一文件可能出现两次)
    const seenKey = new Set();
    const perFile = [];
    let issueCount = 0;
    let fileCount = 0;
    for (const f of files) {
      const key = _key(f, cwd);
      if (!key || seenKey.has(key)) continue;
      seenKey.add(key);
      if (!_baseline.has(key)) continue; // 无基线的文件(未插桩工具/apply_patch 等)不产新增行
      const before = _baseline.get(key);
      const afterLines = _syntaxErrors(f, cwd);
      const news = leaf.diffNewErrors(before, afterLines);
      // 推进基线到当前(镜像 CC 的 baseline 前移,避免同一问题跨轮重复报)
      _baseline.set(key, leaf.toSignatureSet(afterLines));
      if (news.length > 0) {
        issueCount += news.length;
        fileCount += 1;
        perFile.push({ file: String(f), newErrors: news });
      }
    }
    return { issueCount, fileCount, perFile };
  } catch {
    return empty;
  }
}

/** 清空基线(每个顶层 turn 调一次,镜像 CC handleQueryStart)。 */
function reset() {
  try {
    _baseline.clear();
  } catch {
    /* fail-soft */
  }
}

module.exports = {
  captureBaseline,
  collectNewDiagnostics,
  reset,
  _key,          // 导出供测试断言键归一
  _baseline,     // 导出供测试内省(只读用途)
};
