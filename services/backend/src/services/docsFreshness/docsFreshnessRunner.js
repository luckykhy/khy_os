'use strict';

/**
 * docsFreshnessRunner.js — 薄壳(IO):文档新鲜度自检的编排器。
 *
 * 背景(真缺口):代码常更新,文档不能及时跟上。本壳把「取变更源码 → 读 docs/ → 派生映射 →
 * 匹配过时嫌疑(Layer 1)→ 可选重生成产物(Layer 2)→ 可选标记同步(Layer 3)」收成一处。
 * 纯逻辑全在叶子(docPathIndex / docProductPlan / docMarkerSync);本壳只做 IO:
 *   git 探测(镜像 precommitCheck._gitSoft)、读 docs、写盘、re-stage、调 md-to-pdf.js。
 *
 * 门控:KHY_DOCS_FRESHNESS 默认开(关 → 整体不跑,byte-identical 今日行为)。
 *   子门控 KHY_DOCS_REGEN / KHY_DOCS_MARKER_SYNC 由各叶子自判。
 *
 * 定位(重要):**warn-only** —— 默认只报不写、不阻断。写盘/重生成/re-stage 仅在 fix 模式。
 *   CI 阻断由 handler 依 KHY_DOCS_FRESHNESS_BLOCK / --ci 决定退出码,本壳只返回结构。
 *
 * 全 fail-soft:任何一步出错都不影响调用方(提交绝不被自检本身破坏)。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  docsFreshnessEnabled,
  buildDocPathIndex,
  matchStaleSuspects,
} = require('./docPathIndex');

const MAX_DOC_BYTES = 512 * 1024; // 单篇文档读取上限(防超大文件)
const SKIP_DIRS = new Set(['node_modules', '.git', 'bundled', 'dist', 'build', '.ai', 'coverage']);

/** 极薄 git 包装:失败返回 { ok:false }(绝不抛)。镜像 precommitCheck._gitSoft。 */
const _gitSoft = require('../../utils/gitSoftExec');

const { SOURCE_EXTS } = require('./docPathIndex');

function _isSourceRel(rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r.startsWith('docs/') || r.startsWith('.ai/')) return false;
  const ext = (r.split('.').pop() || '').toLowerCase();
  return SOURCE_EXTS.has(ext);
}

/**
 * 收集本次变更的源码路径(仓库相对)。
 * @param {string} cwd
 * @param {{staged?:boolean, gitSoft?:Function}} opts  gitSoft 可注入(测试)。
 */
function collectChangedSources(cwd, opts = {}) {
  const git = typeof opts.gitSoft === 'function' ? opts.gitSoft : _gitSoft;
  const out = new Set();
  try {
    const runs = opts.staged
      ? [['diff', '--cached', '--name-only', '--diff-filter=ACMR']]
      : [
          ['diff', '--name-only', '--diff-filter=ACMR'],
          ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
        ];
    for (const args of runs) {
      const r = git(args, cwd);
      if (r && r.ok && r.out) {
        for (const line of r.out.split(/\r?\n/)) {
          const rel = line.trim();
          if (rel && _isSourceRel(rel)) out.add(rel.replace(/\\/g, '/'));
        }
      }
    }
  } catch {
    /* fail-soft */
  }
  return [...out];
}

function _safeRead(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_DOC_BYTES) return null;
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 读取 docs/ 下全部 .md 为文档记录(BFS,跳过重目录,字节上限)。
 * @param {string} repoRoot
 * @returns {Array<{path:string, text:string}>}
 */
function loadDocRecords(repoRoot) {
  const recs = [];
  const docsRoot = path.join(repoRoot, 'docs');
  try {
    if (!fs.existsSync(docsRoot)) return recs;
    const stack = [docsRoot];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { stack.push(abs); continue; }
        if (!e.name.endsWith('.md')) continue;
        const text = _safeRead(abs);
        if (text != null) recs.push({ path: path.relative(repoRoot, abs).replace(/\\/g, '/'), text });
      }
    }
  } catch {
    /* fail-soft */
  }
  return recs;
}

/**
 * 运行文档新鲜度自检。
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {boolean} [opts.staged]      只看已暂存改动(hook 模式)。
 * @param {boolean} [opts.fix]         写盘/重生成/re-stage(否则只报)。
 * @param {boolean} [opts.markerSync]  是否跑 Layer 3 标记同步(默认跟随 fix)。
 * @param {object}  [opts.env]
 * @param {Function}[opts.gitSoft]     注入 git(测试)。
 * @returns {{ran:boolean, suspects:Array, unmatchedChanges:string[], productActions:Array, markerActions:Array, restaged:string[], warnOnly:true}}
 */
function runDocsFreshness(repoRoot, opts = {}) {
  const env = opts.env || process.env;
  const empty = {
    ran: false,
    suspects: [],
    unmatchedChanges: [],
    productActions: [],
    markerActions: [],
    restaged: [],
    warnOnly: true,
  };
  try {
    if (!docsFreshnessEnabled(env)) return empty;
    const root = repoRoot || env.KHYQUANT_CWD || process.cwd();
    const git = typeof opts.gitSoft === 'function' ? opts.gitSoft : _gitSoft;

    const changed = collectChangedSources(root, { staged: !!opts.staged, gitSoft: git });
    const docRecords = loadDocRecords(root);
    const index = buildDocPathIndex(docRecords);
    const { suspects, unmatchedChanges } = matchStaleSuspects(changed, index);

    const result = {
      ran: true,
      changedSources: changed,
      suspects,
      unmatchedChanges,
      productActions: [],
      markerActions: [],
      restaged: [],
      warnOnly: true,
    };

    // ── Layer 2:产物重生成(仅 fix 模式且有 committed 产物兄弟) ─────────────
    if (opts.fix) {
      try {
        result.productActions = _regenerateProducts(root, docRecords, git, env);
        result.markerActions = opts.markerSync === false
          ? []
          : _syncMarkers(root, docRecords, git, env);
        result.restaged = [
          ...result.productActions.filter((a) => a.restaged).map((a) => a.rel),
          ...result.markerActions.filter((a) => a.restaged).map((a) => a.rel),
        ];
      } catch {
        /* fail-soft:修复失败不影响报告 */
      }
    }

    return result;
  } catch {
    return empty;
  }
}

/**
 * Layer 2:对**已有 committed .html/.pdf 兄弟**的、且本次变更过的 .md 重生成产物。
 * committed 产物集合由 `git ls-files` 求得(只重生成已进版本控制的产物,绝不新建)。
 */
function _regenerateProducts(repoRoot, docRecords, git, env) {
  const actions = [];
  let plan;
  try { plan = require('./docProductPlan'); } catch { return actions; }
  if (!plan.docRegenEnabled(env)) return actions;

  // committed 产物清单。
  const ls = git(['ls-files', 'docs'], repoRoot);
  const committed = ls.ok && ls.out ? ls.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  const committedProducts = committed.filter((f) => f.endsWith('.html') || f.endsWith('.pdf'));
  if (committedProducts.length === 0) return actions;

  // 本次变更过的 docs/*.md(暂存或工作树)。
  const changedMd = new Set();
  for (const args of [['diff', '--name-only'], ['diff', '--cached', '--name-only']]) {
    const r = git(args, repoRoot);
    if (r.ok && r.out) for (const l of r.out.split(/\r?\n/)) {
      const rel = l.trim().replace(/\\/g, '/');
      if (rel.startsWith('docs/') && rel.endsWith('.md')) changedMd.add(rel);
    }
  }

  const mdToPdf = path.join(repoRoot, 'scripts', 'docs', 'md-to-pdf.js');
  if (!fs.existsSync(mdToPdf)) return actions;

  for (const md of changedMd) {
    const p = plan.planDocProducts(md, committedProducts);
    for (const item of p.regen) {
      const mdAbs = path.join(repoRoot, item.md);
      if (!fs.existsSync(mdAbs)) continue;
      const flag = item.mode; // '--html-only' or null(全量)
      try {
        const args = [mdToPdf, mdAbs];
        if (flag) args.push(flag);
        execFileSync(process.execPath, args, { cwd: repoRoot, timeout: 60000, stdio: 'ignore' });
        // 只 re-stage 自己重生成的、且属 committed 产物的文件。
        let restaged = false;
        for (const prod of item.products) {
          const add = git(['add', '--', prod], repoRoot);
          if (add.ok) restaged = true;
        }
        actions.push({ rel: item.md, products: item.products, mode: flag || 'full', ok: true, restaged });
      } catch (e) {
        // fail-soft:留旧产物,继续。
        actions.push({ rel: item.md, products: item.products, ok: false, err: (e && e.message) || String(e) });
      }
    }
  }
  return actions;
}

/**
 * Layer 3:标记区块值同步。对 docs/ 下含 khy-docs-sync 标记的 .md,按 SSOT 值填充,
 * 幂等;仅在内容真变时写盘 + re-stage。
 */
function _syncMarkers(repoRoot, docRecords, git, env) {
  const actions = [];
  let sync;
  try { sync = require('./docMarkerSync'); } catch { return actions; }
  if (!sync.docMarkerSyncEnabled(env)) return actions;

  let valueMap;
  try { valueMap = sync.buildValueMap(_gatherSsotDeps(repoRoot)); } catch { return actions; }
  if (!valueMap || valueMap.size === 0) return actions;

  for (const rec of docRecords) {
    if (!rec.text.includes('khy-docs-sync:begin')) continue;
    let res;
    try { res = sync.syncManagedRegions(rec.text, valueMap); } catch { continue; }
    if (!res || !res.changed) continue;
    const abs = path.join(repoRoot, rec.path);
    try {
      fs.writeFileSync(abs, res.text, 'utf-8');
      const add = git(['add', '--', rec.path], repoRoot);
      actions.push({ rel: rec.path, changedRegions: res.changedRegions, ok: true, restaged: add.ok });
    } catch (e) {
      actions.push({ rel: rec.path, ok: false, err: (e && e.message) || String(e) });
    }
  }
  return actions;
}

/** 采集 Layer-3 SSOT 依赖(命令清单 / 端口 / 版本)。fail-soft。 */
function _gatherSsotDeps(repoRoot) {
  const deps = {};
  try {
    const cmd = require('../../constants/commandSchema');
    if (typeof cmd.getBuiltinSlashCommands === 'function') deps.slashCommands = cmd.getBuiltinSlashCommands();
  } catch { /* ignore */ }
  try {
    const sd = require('../../constants/serviceDefaults');
    if (sd && sd.AI_BACKEND_DEFAULT_PORT != null) deps.aiBackendPort = sd.AI_BACKEND_DEFAULT_PORT;
  } catch { /* ignore */ }
  try {
    const pkg = require(path.join(repoRoot, 'services', 'backend', 'package.json'));
    if (pkg && pkg.version) deps.khyVersion = pkg.version;
  } catch {
    try {
      const pkg2 = require('../../../package.json');
      if (pkg2 && pkg2.version) deps.khyVersion = pkg2.version;
    } catch { /* ignore */ }
  }
  return deps;
}

module.exports = {
  runDocsFreshness,
  collectChangedSources,
  loadDocRecords,
  _gitSoft,
  _isSourceRel,
  _gatherSsotDeps,
};
