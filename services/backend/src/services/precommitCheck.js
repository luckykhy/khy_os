'use strict';

/**
 * precommitCheck.js — 薄壳(IO):提交前自检的单一真源。
 *
 * 背景(真缺口):khy 有两条 commit 路径(tools/gitCommit.js 的工具,cli/handlers/repo.js 的
 * `repo save`),在 `git commit` 之前**零校验**——夹带密钥/大文件/构建产物都会直接进历史。
 * `services/repoDisciplineRisk.assessRepoRisk` 早就能对一次待提交做确定性风险裁决(密钥内容扫描、
 * 大文件、产物、分支纪律),但从未接到这两条 commit 路径上。本壳复用 `repo.js:handleAudit` 已跑通的
 * 「staged diff + name-only + statSize → {path,size}[] → assessRepoRisk」逻辑,收成一处共享自检。
 *
 * 用户定案(重要):**只提示不阻断**——即便检出密钥,也只印醒目警告后**放行**;
 *   保留门控 `KHY_COMMIT_PRECHECK_BLOCK`(默认关)供日后一键升级为「阻断」。
 * **联动**:检出的「本不该提交的文件」自动入 gitignoreReviewStore 待审核队列。
 *
 * 门控:`KHY_COMMIT_PRECHECK` 默认开(关 → 自检整体跳过,byte-identical 今日行为);
 *   `KHY_COMMIT_PRECHECK_BLOCK` 默认关(开 → verdict==='block' 时返回 shouldBlock:true)。
 *
 * 本文件做 IO(git 探测 + fs.statSync),是薄壳,不是纯叶子——不扫叶子契约。全 fail-soft。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** KHY_COMMIT_PRECHECK 默认开。 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_COMMIT_PRECHECK;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_OFF.has(v);
}

/** KHY_COMMIT_PRECHECK_BLOCK 默认关(仅显式开才阻断)。 */
function isBlockMode(env = process.env) {
  const v = String((env && env.KHY_COMMIT_PRECHECK_BLOCK) || '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(v);
}

/** 极薄 git 包装:失败返回 { ok:false }(绝不抛)。 */
const _gitSoft = require('../utils/gitSoftExec');

function _statSize(cwd, rel) {
  try { return fs.statSync(path.join(cwd, rel)).size; } catch { return undefined; }
}

function _currentBranch(cwd) {
  const r = _gitSoft(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return r.ok && r.out ? r.out : undefined;
}

function _detectMainBranch(cwd) {
  const ref = _gitSoft(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (ref.ok && ref.out.includes('/')) return ref.out.split('/').pop();
  return undefined;
}

/**
 * 从风险报告中挑出「本不该提交、建议加进 .gitignore」的具体路径:大文件、二进制产物。
 * 注意:密钥类 finding **无 path**(扫的是 diff 文本行,不是整文件),且密钥的正确处置是
 * 从源码里移除而非 gitignore,故不导出。路径分级/分支纪律/提交信息等也不导出。
 */
function _offendingPaths(report) {
  const out = new Set();
  try {
    for (const f of (report && report.findings) || []) {
      if (!f || !f.path) continue;
      if (f.kind === 'large-file' || f.kind === 'binary-artifact') {
        out.add(f.path);
      }
    }
  } catch { /* fail-soft */ }
  return [...out];
}

/**
 * 运行提交前自检。
 *
 * @param {object} opts
 * @param {string} [opts.cwd]        仓库工作目录(默认 KHYQUANT_CWD || cwd)。
 * @param {string} [opts.message]    待提交信息(用于质量评分)。
 * @param {boolean} [opts.addAll]    本次是否 git add -A(风险提示)。
 * @param {boolean} [opts.noVerify]  --no-verify(既跳过自检,也传给风险评估)。
 * @param {Function} [opts.log]      打印函数 (line, style) => void(默认 console.log)。
 * @param {object} [opts.env]
 * @returns {{ran:boolean, verdict?:string, shouldBlock:boolean, report?:object, enqueued?:string[]}}
 *          ran:false → 自检未跑(门控关 / --no-verify / 无暂存改动)。shouldBlock 仅在
 *          KHY_COMMIT_PRECHECK_BLOCK=on 且 verdict==='block' 时为 true;否则恒 false(只提示)。
 */
function runPrecommitCheck(opts = {}) {
  const env = opts.env || process.env;
  const log = typeof opts.log === 'function' ? opts.log : (line) => { try { console.log(line); } catch { /* ignore */ } };
  try {
    if (!isEnabled(env)) return { ran: false, shouldBlock: false };
    if (opts.noVerify) return { ran: false, shouldBlock: false };

    const cwd = opts.cwd || env.KHYQUANT_CWD || process.cwd();

    // 只看已暂存(即将提交)的改动。无暂存 → 不跑(commit 也无内容)。
    const names = _gitSoft(['diff', '--cached', '--name-only'], cwd);
    const fileList = names.ok && names.out ? names.out.split(/\r?\n/).filter(Boolean) : [];
    if (fileList.length === 0) return { ran: false, shouldBlock: false };

    const diff = _gitSoft(['diff', '--cached'], cwd);
    const files = fileList.map((rel) => ({ path: rel, size: _statSize(cwd, rel) }));

    const repoDiscipline = require('./repoDisciplineRisk');
    const report = repoDiscipline.assessRepoRisk({
      branch: _currentBranch(cwd),
      mainBranch: _detectMainBranch(cwd),
      noVerify: !!opts.noVerify,
      addAll: !!opts.addAll,
      files,
      diffText: diff.ok ? diff.out : '',
      message: opts.message,
      env,
    });

    if (!report || !report.enabled) return { ran: false, shouldBlock: false };
    if (report.verdict === 'clean') return { ran: true, verdict: 'clean', shouldBlock: false, report, enqueued: [] };

    // ── 呈现(只提示不阻断)────────────────────────────────────────────────────
    if (report.verdict === 'block') {
      log('\n⛔ 提交前自检:发现须立即注意的严重风险(如密钥/敏感内容)', 'block');
    } else {
      log('\n⚠️  提交前自检:发现纪律/风险提示', 'caution');
    }
    const icon = { critical: '⛔', high: '⚠️', medium: '•', low: '·' };
    for (const f of report.findings) {
      const where = f.path ? ` [${f.path}${f.line ? `:${f.line}` : ''}]` : '';
      log(`   ${icon[f.severity] || '•'} ${f.message}${where}`, report.verdict);
    }

    // ── 联动:把「本不该提交的文件」入 gitignore 待审核队列 ─────────────────────
    const enqueued = [];
    const offending = _offendingPaths(report);
    if (offending.length > 0) {
      try {
        const store = require('./gitignoreReviewStore');
        const r = store.enqueue({ patterns: offending, reason: 'precommit', source: 'auto', cwd });
        if (r && r.success && !r.skipped) {
          enqueued.push(...offending);
          log(`   → 已把 ${offending.length} 个文件加入 \`/gitignore\` 待审核队列(approve 后写入 .gitignore)`, 'info');
        }
      } catch { /* fail-soft:联动失败不影响自检 */ }
    }

    const blockMode = isBlockMode(env);
    const shouldBlock = blockMode && report.verdict === 'block';
    if (blockMode && shouldBlock) {
      log('   本次提交被阻断(KHY_COMMIT_PRECHECK_BLOCK=on)。解决后重试,或用 --no-verify 跳过自检。', 'block');
    } else if (report.verdict === 'block') {
      log('   ⚠️ 已放行(仅提示不阻断)。如需硬阻断:设 KHY_COMMIT_PRECHECK_BLOCK=on。', 'info');
    }

    return { ran: true, verdict: report.verdict, shouldBlock, report, enqueued };
  } catch {
    // 自检本身出错绝不阻塞提交。
    return { ran: false, shouldBlock: false };
  }
}

module.exports = {
  isEnabled,
  isBlockMode,
  runPrecommitCheck,
  _offendingPaths,
};
