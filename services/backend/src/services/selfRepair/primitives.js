'use strict';

/**
 * selfRepair/primitives — 自修复事务的「真实 IO 原语」工厂(非纯叶子)。
 *
 * 集中本子系统的全部副作用:git 快照/回滚、node --check 语法闸、机器守卫 require、
 * 受影响测试。编排器 transactionRunner.js 通过依赖注入消费这些原语,纯叶子
 * selfRepairTransaction.js 只做判定。这样 IO 集中一处、可被 stub 替换做单测。
 *
 * 设计要点:
 *   - 快照用 `git stash create` —— 产当前脏树的悬挂 commit SHA 而**不改动工作树**
 *     (clean 树时回退到 HEAD)。回滚只对改动集 `git checkout <ref> -- <file>`、对快照里
 *     不存在的新建文件 `fs.rm`,**保留会话内其余无关改动**。非 git 仓库 → 无回滚能力
 *     (返回 null,事务仍校验并透明告警)。
 *   - 守卫从仓库根 scripts/lib/ require,缺失(纯 pip 环境无完整仓库)→ best-effort 跳过。
 *   - 全部原语 fail-soft:抛错由编排器吞掉并回退,绝不阻断交付。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const safety = require('../evolutionSafety');

/** node --check 可解析的纯 JS 扩展名(TS/TSX 交给守卫,不走 node --check)。 */
const NODE_CHECK_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx']);

function _git(args, cwd) {
  return spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
}

function _isGitRepo(dir) {
  const r = _git(['rev-parse', '--is-inside-work-tree'], dir);
  return r.status === 0 && String(r.stdout || '').trim() === 'true';
}

/** 把可能的相对路径解析为绝对路径。 */
function _abs(projectDir, file) {
  return path.isAbsolute(file) ? file : path.resolve(projectDir, file);
}

/** 仓库相对路径(正斜杠归一),供守卫白名单匹配。 */
function _relToProject(projectDir, file) {
  const rel = path.relative(projectDir, _abs(projectDir, file));
  return rel.split(path.sep).join('/');
}

// ── 守卫(从仓库根 scripts/lib;缺失则置 null,best-effort 跳过)──────────────
let _leafGuard = null;
let _modelGuard = null;
let _watchedNames = null;
let _guardsLoaded = false;
function _loadGuards() {
  if (_guardsLoaded) return;
  _guardsLoaded = true;
  try { _leafGuard = require('../../../../../scripts/lib/leafContractGuard'); } catch { _leafGuard = null; }
  try {
    _modelGuard = require('../../../../../scripts/lib/modelHardcodingGuard');
    let modelsMod = null;
    try { modelsMod = require('../../constants/models'); } catch { modelsMod = null; }
    _watchedNames = _modelGuard.deriveWatchedNames(modelsMod);
  } catch { _modelGuard = null; _watchedNames = []; }
}

/**
 * 构造注入给 transactionRunner 的原语。
 * @param {object} opts
 * @param {string} [opts.projectDir]
 * @returns {{ snapshot:Function, restore:Function, validateFiles:Function }}
 */
function create(opts = {}) {
  const projectDir = opts.projectDir || process.env.KHYQUANT_CWD || process.cwd();

  /** 改前快照:git → {kind:'git', ref};非 git → null(无回滚能力)。 */
  async function snapshot() {
    if (!_isGitRepo(projectDir)) return null;
    const r = _git(['stash', 'create'], projectDir);
    if (r.status !== 0) return null;
    const sha = String(r.stdout || '').trim();
    // 空 = 工作树干净(无未提交改动),改前状态等同 HEAD。
    return { kind: 'git', ref: sha || 'HEAD' };
  }

  /** 回滚:只还原改动集到快照状态,保留无关改动。返回是否完整执行。 */
  async function restore(snap, changeSet) {
    if (!snap || snap.kind !== 'git') return false;
    const files = (changeSet && Array.isArray(changeSet.validatable) ? changeSet.validatable : [])
      .concat(changeSet && Array.isArray(changeSet.skipped) ? changeSet.skipped : []);
    let ok = true;
    for (const f of files) {
      const abs = _abs(projectDir, f);
      const rel = _relToProject(projectDir, f);
      // 先尝试从快照还原文件内容(改前已存在的文件)。
      const co = _git(['checkout', snap.ref, '--', rel], projectDir);
      if (co.status === 0) continue;
      // 快照里没有此文件 → fix 新建的,删除之。
      try {
        if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
      } catch { ok = false; }
    }
    return ok;
  }

  /** 校验改动集:语法 + 守卫 + 可选测试。 */
  async function validateFiles(files, plan) {
    const syntax = [];
    const guards = [];
    let tests = { ran: false, ok: true, summary: '' };
    let coverage = null;

    if (plan && plan.runGuards) _loadGuards();

    for (const f of Array.isArray(files) ? files : []) {
      const abs = _abs(projectDir, f);
      const rel = _relToProject(projectDir, f);
      const ext = path.extname(abs).toLowerCase();

      // ── 语法闸 ──────────────────────────────────────────────────
      if (plan && plan.runSyntax) {
        if (ext === '.json') {
          try {
            JSON.parse(fs.readFileSync(abs, 'utf8'));
          } catch (e) {
            syntax.push({ file: rel, line: 1, message: `JSON 解析失败: ${e && e.message}` });
          }
        } else if (NODE_CHECK_EXTS.has(ext)) {
          const r = spawnSync(process.execPath, ['--check', abs], {
            encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          if (r.status !== 0) {
            const msg = String(r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' ');
            const lineM = msg.match(/:(\d+)/);
            syntax.push({ file: rel, line: lineM ? parseInt(lineM[1], 10) : 1, message: msg });
          }
        }
        // .ts/.tsx:node --check 无法解析,跳过语法,交守卫。
      }

      // ── 机器守卫 ────────────────────────────────────────────────
      if (plan && plan.runGuards) {
        let source = '';
        try { source = fs.readFileSync(abs, 'utf8'); } catch { source = ''; }
        if (source) {
          try {
            if (_leafGuard) {
              const res = _leafGuard.assessFile({ relPath: rel, source });
              for (const fd of (res && res.findings) || []) guards.push({ ...fd, relPath: rel });
            }
          } catch { /* guard best-effort */ }
          try {
            if (_modelGuard) {
              const res = _modelGuard.assessFile({ relPath: rel, source, watchedNames: _watchedNames || [] });
              for (const fd of (res && res.findings) || []) guards.push({ ...fd, relPath: rel });
            }
          } catch { /* guard best-effort */ }
        }
      }
    }

    // ── 受影响测试(可选,best-effort)+ 覆盖率 ────────────────────────
    if (plan && plan.runTests) {
      const runnable = _runnableTests(files);                 // repo 相对、存在且 node:test 的候选
      coverage = safety.assessCoverage({ changedFiles: files, runnableTests: runnable });
      // node --test 在 services/backend 下跑,路径需相对该目录。
      const testFiles = [...runnable].map((c) => c.replace(/^services\/backend\//, ''));
      if (testFiles.length) {
        const r = spawnSync(process.execPath, ['--test', ...testFiles], {
          cwd: path.join(projectDir, 'services', 'backend'),
          encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, KHY_RTK_MODE: 'off' },
        });
        tests = {
          ran: true,
          ok: r.status === 0,
          summary: r.status === 0 ? '' : String(r.stdout || r.stderr || '').trim().split('\n').slice(-5).join(' '),
        };
      }
    }

    return coverage ? { syntax, guards, tests, coverage } : { syntax, guards, tests };
  }

  /** 候选测试(repo 相对正斜杠路径)→ 绝对路径。 */
  function _candAbs(repoRelCand) {
    return path.join(projectDir, String(repoRelCand).split('/').join(path.sep));
  }

  /**
   * 解析「存在且为 node:test」的受影响测试集合(repo 相对路径)。
   * 测试文件→源映射委派纯叶子 evolutionSafety(单一真源)。**关键防地雷**:用
   * isNodeTestSource 排除 jest 文件——`node --test` 跑 jest 文件会因缺 describe/it 全局
   * ReferenceError 致误判失败、误回滚好修复;故 jest 文件不纳入(由安全层落「未验证」告警)。
   */
  function _runnableTests(files) {
    const runnable = new Set();
    for (const sel of safety.selectAffectedTests(files)) {
      const cand = sel.candidate;
      if (!cand) continue;
      try {
        const abs = _candAbs(cand);
        if (!fs.existsSync(abs)) continue;
        const src = fs.readFileSync(abs, 'utf8');
        if (safety.isNodeTestSource(src)) runnable.add(cand);
      } catch { /* ignore */ }
    }
    return runnable;
  }

  return { snapshot, restore, validateFiles, projectDir };
}

module.exports = { create };
