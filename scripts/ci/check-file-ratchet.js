#!/usr/bin/env node
'use strict';

/**
 * check-file-ratchet.js — L1 防劣化：逐文件「改前→改后」棘轮。
 *
 * 解决的问题（详见 _产物/防止越改越差-方案-2026-09-17.md）：
 *   全仓债务棘轮以「全仓分母」计量，劣化被稀释到看不见
 *   （全仓 4584 条 console.log，小模型一次加 8 条 → 漂移 0.17%，全仓门毫无反应；
 *    但被改的那个文件 12→20 条，+67%，立刻红）。
 *
 * 本脚本把分母换成「被改动的文件」：存量债冻结不动，但凡你碰过的文件，
 * 改完不许比改前更脏。8 个脏度指标分两档：
 *   - HARD（变差即红，阻断）：maxFuncLines / maxNesting / consoleCount /
 *     debuggerCount / todoCount
 *   - SOFT（只报告，不阻断）：lines / dupBlock（避免误伤正常增长）
 * 指标均为 AST-free、本地零依赖、秒级可跑（不依赖 eslint 全量）。
 *
 * 行为：
 *   - 改动文件（M/R）：before = base 版本内容，after = 工作树内容；任一 HARD 指标
 *     after > before → regression（error）。
 *   - 新增文件（A）：无 before，按 config.caps 绝对上限卡（新增文件也应干净）。
 *   - 未变化的指标、未触及的文件：不计入。
 *
 * 与 check-change-safety 的关系：同类「改动集」入口，但职责不同 ——
 *   它管「凭据/横幅/改动面」，本脚本管「被改文件是否更脏」。互不重叠。
 *
 * 用法：
 *   node scripts/ci/check-file-ratchet.js                 # 自动选 base（PR 用 GIT_BASE_REF）
 *   GIT_BASE_REF=abc123 node scripts/ci/check-file-ratchet.js
 *   node scripts/ci/check-file-ratchet.js --base=origin/main
 *   node scripts/ci/check-file-ratchet.js --config=scripts/ci/file-ratchet.config.json
 *   node scripts/ci/check-file-ratchet.js --json
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// 默认指向仓库根；测试/fixture 可用 KHY_FILE_RATCHET_ROOT 覆盖。
const repoRoot = process.env.KHY_FILE_RATCHET_ROOT
  ? path.resolve(process.env.KHY_FILE_RATCHET_ROOT)
  : path.resolve(__dirname, '..', '..');

// ── 配置（可被 config 文件覆盖） ────────────────────────────────────────────
const DEFAULT_CONFIG = {
  // 新增文件的绝对上限（modified 文件走 delta，不比这个）。
  caps: {
    maxFuncLines: 300,
    maxNesting: 6,
    consoleCount: 5,
    debuggerCount: 0,
    todoCount: 40,
    lines: 2000,
    dupBlock: 40,
  },
  softMetrics: ['lines', 'dupBlock'],
  window: 6, // dupBlock 滑动窗口大小
  // 有期限的豁免：path 命中且 within `by` 日期 → 跳过该文件。空数组=无豁免。
  exceptions: [],
};

function loadConfig(cliConfigPath) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const rel = cliConfigPath || 'scripts/ci/file-ratchet.config.json';
  try {
    const raw = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const parsed = JSON.parse(raw);
    Object.assign(cfg.caps, parsed.caps || {});
    if (Array.isArray(parsed.softMetrics)) cfg.softMetrics = parsed.softMetrics;
    if (typeof parsed.window === 'number') cfg.window = parsed.window;
    if (Array.isArray(parsed.exceptions)) cfg.exceptions = parsed.exceptions;
  } catch {
    // 配置文件缺失/非法 → 用默认，不报错（让门禁在任何环境都能跑）。
  }
  return cfg;
}

// ── git 助手 ────────────────────────────────────────────────────────────────
function runGit(cmd) {
  try {
    return cp
      .execSync(cmd, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .trim();
  } catch {
    return '';
  }
}

function resolveBaseRef(cliBase) {
  if (cliBase) return cliBase.trim();
  const env = String(process.env.GIT_BASE_REF || '').trim();
  if (env) return env;
  // 本地回退：动态取上游（本仓库 main 实际上游可能是 khy-mirror/main，勿硬编码）。
  const upstream = runGit('git rev-parse --abbrev-ref @{upstream} 2>/dev/null');
  if (upstream) {
    const mb = runGit(`git merge-base HEAD ${upstream} 2>/dev/null`);
    if (mb) return mb;
  }
  if (runGit('git rev-parse --verify origin/main 2>/dev/null')) {
    const mb = runGit('git merge-base HEAD origin/main 2>/dev/null');
    if (mb) return mb;
  }
  return 'HEAD~1'; // 最后兜底：比上一提交
}

// ── 改动集列举（复刻 check-change-safety 的 name-status 解析） ────────────────
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.cache', '.tmp', 'coverage', 'logs',
]);

const SUPPORTED_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.py']);

function parseNameStatus(output) {
  return String(output || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t').filter(Boolean);
      const statusToken = String(parts[0] || '').trim();
      const status = statusToken.charAt(0).toUpperCase() || 'M';
      // R100\told\tnew  → path=new, basePath=old
      if (status === 'R' && parts.length >= 3) {
        return { status, path: parts[parts.length - 1], basePath: parts[1] };
      }
      const p = parts.length > 1 ? parts[parts.length - 1] : '';
      return { status, path: p, basePath: p };
    })
    .filter((e) => !!e.path);
}

function listChangedFiles(baseRef) {
  const threeDot = runGit(
    `git diff --name-status --find-renames --diff-filter=ACMRD ${baseRef}...HEAD`
  );
  if (threeDot) return parseNameStatus(threeDot);

  const cached = runGit('git diff --name-status --find-renames --cached --diff-filter=ACMRD');
  if (cached) return parseNameStatus(cached);

  const head = runGit('git diff --name-status --find-renames --diff-filter=ACMRD HEAD');
  return parseNameStatus(head);
}

// ── 指标计算（AST-free） ─────────────────────────────────────────────────────
function stripLineComment(line) {
  return line.replace(/\/\/.*$/, '');
}

function countConsole(text) {
  let n = 0;
  for (const raw of text.split('\n')) {
    if (/\bconsole\./.test(stripLineComment(raw))) n++;
  }
  return n;
}

function countDebugger(text) {
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = stripLineComment(raw).replace(/\/\*.*?\*\//g, '');
    if (/\bdebugger\b\s*;?/.test(line)) n++;
  }
  return n;
}

function countTodo(text) {
  const m = text.match(/\b(?:TODO|FIXME|XXX|HACK|@todo)\b/gi);
  return m ? m.length : 0;
}

// 结构指标：括号深度扫描（识别字符串/注释，避免误数）。
function analyzeStructure(text) {
  const lines = text.split('\n');
  let depth = 0;
  let maxDepth = 0;
  const stack = [];
  let maxBlockLines = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; j++; }
        continue;
      }
      if (inLineComment) continue;
      if (inString) {
        if (ch === '\\') { j++; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '/' && next === '/') { inLineComment = true; break; }
      if (ch === '/' && next === '*') { inBlockComment = true; j++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '{') {
        depth++;
        if (depth > maxDepth) maxDepth = depth;
        stack.push(i);
      } else if (ch === '}') {
        if (stack.length) {
          const startLine = stack.pop();
          const span = i - startLine - 1; // 花括号之间的行数（函数体长度近似）
          if (span > maxBlockLines) maxBlockLines = span;
        }
        if (depth > 0) depth--;
      }
    }
    inLineComment = false;
  }
  return { maxNesting: maxDepth, maxFuncLines: maxBlockLines };
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

// 重复块探测器：归一化后滑动窗口，统计重复出现的窗口数（复制粘贴增长信号）。
function computeDup(text, window) {
  const lines = text
    .split('\n')
    .map((l) => stripLineComment(l).trim().toLowerCase())
    .filter((l) => l.length >= 8);
  const seen = new Map();
  let dup = 0;
  for (let i = 0; i + window <= lines.length; i++) {
    const win = lines.slice(i, i + window).join('\n');
    const h = hashStr(win);
    const prev = seen.get(h) || 0;
    if (prev === 1) dup += 1; // 第一次出现重复
    if (prev >= 1) seen.set(h, prev + 1);
    else seen.set(h, 1);
  }
  return dup;
}

function computeMetrics(text, cfg) {
  const struct = analyzeStructure(text);
  return {
    lines: text.split('\n').length,
    maxFuncLines: struct.maxFuncLines,
    maxNesting: struct.maxNesting,
    consoleCount: countConsole(text),
    debuggerCount: countDebugger(text),
    todoCount: countTodo(text),
    dupBlock: computeDup(text, cfg.window || 6),
  };
}

// ── 评估单文件（纯函数，便于单测） ───────────────────────────────────────────
function isExcepted(filePath, exceptions) {
  const today = new Date().toISOString().slice(0, 10);
  for (const ex of exceptions || []) {
    const p = ex && ex.path;
    if (!p) continue;
    const within = !ex.by || String(ex.by) >= today;
    if (within && (filePath === p || filePath.startsWith(`${p}/`))) return ex;
  }
  return null;
}

function evaluateFile({ path: filePath, before, after, isAdded }, cfg) {
  const ex = isExcepted(filePath, cfg.exceptions);
  if (ex) return { skipped: true, reason: ex.reason || 'excepted' };

  const HARD = ['maxFuncLines', 'maxNesting', 'consoleCount', 'debuggerCount', 'todoCount'];
  const SOFT = cfg.softMetrics || ['lines', 'dupBlock'];
  const findings = [];
  const bump = (m, severity, info) => findings.push({ metric: m, severity, ...info });

  for (const m of HARD) {
    if (isAdded) {
      const cap = cfg.caps[m];
      if (typeof cap === 'number' && after[m] > cap) {
        bump(m, 'error', { before: null, after: after[m], cap, kind: 'over-cap' });
      }
    } else if (before && after[m] > before[m]) {
      bump(m, 'error', { before: before[m], after: after[m], delta: after[m] - before[m], kind: 'regression' });
    }
  }
  for (const m of SOFT) {
    if (isAdded) {
      const cap = cfg.caps[m];
      if (typeof cap === 'number' && after[m] > cap) {
        bump(m, 'warning', { before: null, after: after[m], cap, kind: 'over-cap' });
      }
    } else if (before && after[m] > before[m]) {
      bump(m, 'warning', { before: before[m], after: after[m], delta: after[m] - before[m], kind: 'regression' });
    }
  }
  return { skipped: false, findings };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const cliBase = (args.find((a) => a.startsWith('--base=')) || '').slice('--base='.length) || null;
  const cliConfig = (args.find((a) => a.startsWith('--config=')) || '').slice('--config='.length) || null;
  const isJson = args.includes('--json');
  const cfg = loadConfig(cliConfig);

  const baseRef = resolveBaseRef(cliBase);
  const entries = listChangedFiles(baseRef);

  const results = [];
  let skippedExt = 0;
  let addedCount = 0;
  let modifiedCount = 0;
  let renamedCount = 0;

  for (const entry of entries) {
    const rel = String(entry.path || '').replace(/\\/g, '/');
    if (!rel || IGNORE_DIRS.has(rel.split('/')[0])) continue;
    const ext = path.extname(rel).toLowerCase();
    if (!SUPPORTED_EXT.has(ext)) { skippedExt++; continue; }

    const isAdded = entry.status === 'A';
    const isRenamed = entry.status === 'R';
    if (isAdded) addedCount++;
    else if (isRenamed) renamedCount++;
    else modifiedCount++;

    const afterPath = path.join(repoRoot, rel);
    let afterText;
    try {
      afterText = fs.readFileSync(afterPath, 'utf8');
    } catch {
      continue; // 读取失败（极少见）→ 跳过，不误报
    }

    let beforeText = null;
    if (!isAdded) {
      const basePath = (entry.basePath || rel).replace(/\\/g, '/');
      beforeText = runGit(`git show ${baseRef}:${basePath}`);
      if (beforeText === '') beforeText = null; // 该路径在 base 不存在 → 当作新增处理
    }

    const after = computeMetrics(afterText, cfg);
    const before = beforeText === null ? null : computeMetrics(beforeText, cfg);
    const ev = evaluateFile({ path: rel, before, after, isAdded: before === null }, cfg);
    results.push({ path: rel, status: entry.status, before, after, ...ev });
  }

  // ── 输出 ──────────────────────────────────────────────────────────────────
  const errors = [];
  const warnings = [];
  for (const r of results) {
    if (r.skipped) continue;
    for (const f of r.findings) {
      (f.severity === 'error' ? errors : warnings).push({ path: r.path, ...f });
    }
  }

  if (isJson) {
    console.log(JSON.stringify({
      schema: 'khy.file-ratchet/v1',
      baseRef,
      scanned: results.length,
      skippedExt,
      errors: errors.length,
      warnings: warnings.length,
      results: results.map((r) => ({
        path: r.path, status: r.status, skipped: r.skipped,
        before: r.before, after: r.after,
        findings: r.findings,
      })),
    }, null, 2));
  } else {
    console.log('L1 逐文件改前改后棘轮 (check-file-ratchet)');
    console.log('='.repeat(72));
    console.log(`base ref: ${baseRef}`);
    console.log(`扫描 ${results.length} 个改动文件（修改 ${modifiedCount} / 新增 ${addedCount} / 重命名 ${renamedCount}），跳过 ${skippedExt} 个非源码文件`);

    const relevant = results.filter((r) => !r.skipped && r.findings.length > 0);
    if (relevant.length === 0) {
      console.log('\n无脏度回归。✓（存量债冻结，被改文件未变脏）');
    } else {
      console.log('');
      for (const r of relevant) {
        const tag = r.status === 'A' ? '新增' : r.status === 'R' ? '重命名' : '修改';
        console.log(`● ${r.path} [${tag}]`);
        for (const f of r.findings) {
          const ann = f.severity === 'error' ? 'FAIL' : 'WARN';
          const detail = f.kind === 'over-cap'
            ? `  ${f.metric} = ${f.after} > 上限 ${f.cap}（新增）`
            : `  ${f.metric}: ${f.before} → ${f.after}（+${f.delta}）`;
          console.log(`    [${ann}]${detail}`);
          if (process.env.GITHUB_ACTIONS) {
            console.log(`::${f.severity === 'error' ? 'error' : 'warning'} file=${r.path}::${f.metric} ${f.kind === 'over-cap' ? '>' + f.cap : '+' + f.delta}`);
          }
        }
      }
    }
    console.log('\n' + '='.repeat(72));
    console.log(`结果: ${errors.length} error, ${warnings.length} warning`);
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

module.exports = {
  computeMetrics,
  evaluateFile,
  analyzeStructure,
  countConsole,
  countDebugger,
  countTodo,
  computeDup,
  parseNameStatus,
  resolveBaseRef,
  isExcepted,
  DEFAULT_CONFIG,
};

if (require.main === module) main();
