'use strict';

/**
 * projectHygiene — facade for the two project-creation red lines
 * ([DESIGN-ARCH-054]):
 *   1. no god files          (one file, one cohesive responsibility)
 *   2. no duplicate modules  (one capability lives in one place)
 *
 * `assessWrite` is the single entry the guard layer calls before a file write.
 * Pure-ish: filesystem access for sibling discovery is injectable (listFiles /
 * readFile) so the core is unit-testable without touching disk. Fail-open by
 * contract — any internal error yields `{ ok: true }`, never a thrown error on
 * the write path (a hygiene check must never break the user's edit).
 */

const fs = require('fs');
const path = require('path');
const { assessGodFile } = require('./godFile');
const { findDuplicateModule } = require('./duplicateModule');
const { extOf, CODE_EXTS } = require('./symbols');
const T = require('./thresholds');

const SKIP_DIR_RE = /(^|\/)(node_modules|\.git|dist|build|out|coverage|vendor|\.next|\.cache|__pycache__)(\/|$)/;

/** Default sibling discovery: code files under the same directory subtree as the
 * target, bounded by dupMaxScanFiles, same extension only, skipping vendor/build
 * dirs. Same-dir-first keeps the scan focused on the cohesive unit the new file
 * joins, which is where real duplicates cluster. */
function defaultListFiles(targetAbs) {
  const ext = extOf(targetAbs);
  if (!ext) return { files: [], capped: false };
  const root = path.dirname(targetAbs);
  const cap = T.dupMaxScanFiles();
  const out = [];
  let capped = false;
  const stack = [root];
  while (stack.length && out.length < cap) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = full.split(path.sep).join('/');
      if (ent.name.startsWith('.') || SKIP_DIR_RE.test('/' + rel)) continue;
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.isFile()) continue;
      if (extOf(ent.name) !== ext) continue;
      if (out.length >= cap) { capped = true; break; }
      out.push(full);
    }
  }
  return { files: out, capped };
}

function defaultReadFile(p) {
  try {
    const st = fs.statSync(p);
    if (st.size > T.dupMaxFileBytes()) return null; // too big to compare cheaply
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

/**
 * Assess a pending file write against the hygiene red lines.
 *
 * @param {object} opts
 * @param {string} opts.path        target file path (abs or cwd-relative)
 * @param {string} opts.content     FULL resulting file content
 * @param {boolean} [opts.isNew]    is this creating a new file? (duplicate check
 *                                  only runs for new files; overwriting an
 *                                  existing path is an edit, not a duplicate)
 * @param {Function} [opts.listFiles] (targetAbs) => { files: string[], capped }
 * @param {Function} [opts.readFile]  (absPath) => string|null
 * @returns {{ ok: boolean, violations: Array<{type, message, ...}>, capped?: boolean }}
 */
function assessWrite(opts = {}) {
  if (!T.enabled()) return { ok: true, violations: [] };
  try {
    const { path: filePath, content } = opts;
    if (!filePath || typeof content !== 'string') return { ok: true, violations: [] };
    const targetAbs = path.resolve(String(filePath));
    const violations = [];

    // ── Rule 1: god file (applies to create AND overwrite — size is size) ──
    const god = assessGodFile({ path: filePath, content });
    if (god.violation) {
      violations.push({
        type: 'god-file',
        loc: god.loc,
        threshold: god.threshold,
        message:
          `"${path.basename(filePath)}" 将达到 ${god.loc} 行，超过单文件上限 ${god.threshold} 行（上帝文件）。` +
          `请按职责拆分为多个聚焦模块，而不是继续堆积。` +
          `（如确需超限：可批准放行；或调 KHY_PROJECT_GOD_FILE_LOC）`,
      });
    }

    // ── Rule 2: duplicate module (new files only) ──
    const isNew = opts.isNew !== undefined ? !!opts.isNew : !safeExists(targetAbs);
    let capped = false;
    if (isNew && CODE_EXTS.has(extOf(filePath))) {
      const lister = opts.listFiles || defaultListFiles;
      const reader = opts.readFile || defaultReadFile;
      const listing = lister(targetAbs) || { files: [], capped: false };
      capped = !!listing.capped;
      const siblings = [];
      for (const f of (listing.files || [])) {
        const abs = path.resolve(String(f));
        if (abs === targetAbs) continue;
        const c = reader(abs);
        if (typeof c === 'string') siblings.push({ path: f, content: c });
      }
      const dup = findDuplicateModule({ path: filePath, content, siblings });
      if (dup.duplicate) {
        const pct = Math.round(dup.similarity * 100);
        const why = dup.reason === 'name'
          ? '同名/改名复制'
          : dup.reason === 'symbols'
            ? `导出符号高度重叠（${pct}%）`
            : `内容近乎重复（${pct}%）`;
        violations.push({
          type: 'duplicate-module',
          existingPath: dup.existingPath,
          similarity: dup.similarity,
          reason: dup.reason,
          message:
            `新建 "${path.basename(filePath)}" 与既有文件 "${dup.existingPath}" 功能重复（${why}）。` +
            `同一能力只应存在一处：请扩展/复用既有模块，而不是再造一个。` +
            `（如确属不同职责：可批准放行）`,
        });
      }
    }

    return { ok: violations.length === 0, violations, capped };
  } catch {
    // Hygiene must never break a write — degrade to allow.
    return { ok: true, violations: [] };
  }
}

// 收敛到 utils/existsSyncSafe 单一真源(逐字节委托,调用点不变)
const safeExists = require('../../utils/existsSyncSafe');

/**
 * Assess a BATCH of pending file writes (project scaffolding) against the same
 * red lines as `assessWrite`, but WITHOUT touching disk — the files don't exist
 * yet, so the only meaningful siblings are the other entries in the same batch.
 * This is the seam the project-generation writer (scaffoldFiles) goes through;
 * without it, the agent can emit a god component as long as it does so via the
 * batch tool instead of a single writeFile.
 *
 * Pure and deterministic: no fs access. Same fail-open contract — any internal
 * error yields `{ ok: true }`.
 *
 * @param {object} opts
 * @param {Array<{path:string, content:string}>} opts.files  the batch entries
 * @returns {{ ok: boolean, violations: Array<{file, type, message, ...}> }}
 */
function assessScaffold(opts = {}) {
  if (!T.enabled()) return { ok: true, violations: [] };
  try {
    const files = Array.isArray(opts.files) ? opts.files : [];
    if (files.length === 0) return { ok: true, violations: [] };

    // Normalize once; only entries that actually carry a path are assessable.
    const entries = [];
    for (const f of files) {
      if (!f || typeof f !== 'object') continue;
      const p = String(f.path || f.file_path || '').trim();
      const content = typeof f.content === 'string' ? f.content : '';
      if (!p) continue;
      entries.push({ path: p, content });
    }

    const dupScanCap = T.dupMaxScanFiles();
    const violations = [];

    for (let i = 0; i < entries.length; i++) {
      const { path: filePath, content } = entries[i];

      // ── Rule 1: god file (size is size — applies to every code entry) ──
      const god = assessGodFile({ path: filePath, content });
      if (god.violation) {
        violations.push({
          file: filePath,
          type: 'god-file',
          loc: god.loc,
          threshold: god.threshold,
          message:
            `"${path.basename(filePath)}" 将达到 ${god.loc} 行，超过单文件上限 ${god.threshold} 行（上帝组件）。` +
            `生成项目时禁止产生上帝组件：请按职责拆分为多个聚焦文件（如 routes/、services/、models/ 分层），` +
            `而不是把路由+持久化+渲染堆进一个文件。` +
            `（如确需超限：可批准放行；或调 KHY_PROJECT_GOD_FILE_LOC）`,
        });
      }

      // ── Rule 2: duplicate module — compare against the OTHER batch entries ──
      if (CODE_EXTS.has(extOf(filePath))) {
        const siblings = [];
        for (let j = 0; j < entries.length && siblings.length < dupScanCap; j++) {
          if (j === i) continue;
          if (extOf(entries[j].path) !== extOf(filePath)) continue;
          siblings.push({ path: entries[j].path, content: entries[j].content });
        }
        if (siblings.length > 0) {
          const dup = findDuplicateModule({ path: filePath, content, siblings });
          // Only flag the SECOND occurrence (its match sits earlier in the
          // batch) so a pair of near-clones yields one violation, not two
          // mirror-image ones.
          if (dup.duplicate) {
            const matchIdx = entries.findIndex((e) => e.path === dup.existingPath);
            if (matchIdx === -1 || matchIdx < i) {
              const pct = Math.round(dup.similarity * 100);
              const why = dup.reason === 'name'
                ? '同名/改名复制'
                : dup.reason === 'symbols'
                  ? `导出符号高度重叠（${pct}%）`
                  : `内容近乎重复（${pct}%）`;
              violations.push({
                file: filePath,
                type: 'duplicate-module',
                existingPath: dup.existingPath,
                similarity: dup.similarity,
                reason: dup.reason,
                message:
                  `生成的 "${path.basename(filePath)}" 与同批 "${dup.existingPath}" 功能重复（${why}）。` +
                  `同一能力只应存在一处：合并为一个模块或互相复用，不要在同一项目里铺并行实现。`,
              });
            }
          }
        }
      }
    }

    return { ok: violations.length === 0, violations };
  } catch {
    return { ok: true, violations: [] };
  }
}

module.exports = {
  assessWrite,
  assessScaffold,
  defaultListFiles,
  // re-exports for callers/tests that want the pieces directly
  assessGodFile,
  findDuplicateModule,
  thresholds: T,
};
