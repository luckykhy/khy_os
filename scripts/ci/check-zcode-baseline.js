#!/usr/bin/env node
'use strict';

/**
 * check-zcode-baseline.js — 「达到 ZCode 级别」的客观代理指标记分器。
 *
 * 背景：ZCode 是闭源商业产品，其 agent loop 内部实现不公开，无法逐行对比。
 * 因此「是否达到 ZCode 级别」只能被操作化为一组**可度量、可回归的代理指标**，
 * 每项给一个明确阈值，记分板打印 current-vs-target。阈值达标即视为该项达标。
 *
 * 落地阶段：本守卫按 [DESIGN-PROCESS-002] §2 / PROCESS-008 登记为 **S1 观察者**
 * （STAGE 常量见下方，登记表 rollout.mechanisms[] 镜像之）——**只记录、不拦截，恒 exit 0**。
 * 升阶到 S2/S3 需样本达标且为人的决定，见 check-rollout-stage.js 的 PP-1~PP-6。
 *
 * 规则合规：
 *   - RUNTIME-001：无字面量 IP/端口/绝对路径/生产域名。仓库根由 __dirname 推导；
 *     日志目录可由 KHY_ZCODE_LOG_DIR 覆盖，默认 <repoRoot>/.khy/logs（开发者本机态）。
 *   - PROCESS-008：S1 只记录不阻断（本文件 STAGE='S1' 且无阻断分支）。
 *
 * 用法：
 *   node scripts/ci/check-zcode-baseline.js            # 人读记分板
 *   node scripts/ci/check-zcode-baseline.js --json     # 机读（供测试消费）
 *   KHY_ZCODE_BASELINE_ROOT=<dir> node ...             # fixture 根（测试用）
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// ── 阶段权威（PP 一致性：check-rollout-stage.js 会读本常量与登记表比对） ──────
const STAGE = 'S1';

// ── 阈值：直接对齐 ZCode 公布的 architecture-policy.yaml `global`（不再是自拟数字）。
//    来源：github.com/zai-org/ZCode → architecture-policy.yaml
//      global.maxFileLines: 400, maxContractLines: 300, maxPublicMethods: 12,
//      forbidCycles: true, forbidDeepImports: true
//    ZCode 用 managed/legacy 迁移模型：存量模块 managed:false（豁免），迁移后
//    managed:true 必须满足策略，且 .architecture-baseline.json 维持 violations:[]。
//    khy-os 无等价「managed 白名单」，故 M1 以「全量 vs 400 行」如实暴露政策债规模。
const DEFAULT_TARGETS = {
  archMaxFileLinesHard: 400, // ZCode global.maxFileLines
  archP99FileLines: 400, // 对齐同一硬标准（ZCode 无 p99 概念，取同值）
  logEncodingInvalidFilesAllowed: 0, // 非法 UTF-8 / 乱码日志文件数上限
};

// M1 扫描的源目录（仅这些顶层目录下的 JS 计入「架构表面积」）。
const SCAN_DIRS = ['kernel', 'platform', 'services', 'apps', 'software', 'extensions', 'tools'];
// 排除路径片段（构建产物 / 依赖 / 打包资产 / 测试）。
const EXCLUDE_SEGMENTS = [
  'node_modules', path.sep + 'out' + path.sep, path.sep + 'dist' + path.sep,
  path.sep + 'build' + path.sep, '.git' + path.sep, 'coverage',
  path.join('entries', ''), path.join('_产物', ''), '.next', 'assets',
];
const EXCLUDE_NAME_SUFFIX = ['.test.js', '.spec.js', '.bundle.js', '.min.js', '_gen.js', 'generated.js'];

function resolveRepoRoot() {
  return process.env.KHY_ZCODE_BASELINE_ROOT
    ? path.resolve(process.env.KHY_ZCODE_BASELINE_ROOT)
    : path.resolve(__dirname, '..', '..');
}

function parseArgs(argv) {
  const out = { json: false, config: null };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a.startsWith('--config=')) out.config = a.slice('--config='.length);
  }
  return out;
}

function isExcluded(absPath) {
  const norm = absPath.split(path.sep).join('/');
  for (const seg of EXCLUDE_SEGMENTS) {
    if (!seg) continue;
    if (norm.includes(seg.split(path.sep).join('/'))) return true;
  }
  const base = path.basename(absPath);
  for (const suf of EXCLUDE_NAME_SUFFIX) if (base.endsWith(suf)) return true;
  return false;
}

function countLines(buffer) {
  if (!buffer.length) return 0;
  let n = 0;
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0x0a) n++;
  // 末字节非换行 → 存在一个不带结尾换行的尾行，计 +1（对齐 wc -l 的行数语义）。
  if (buffer[buffer.length - 1] !== 0x0a) n++;
  return n;
}

function walkJs(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!isExcluded(abs)) walkJs(abs, acc);
    } else if (e.isFile() && e.name.endsWith('.js') && !isExcluded(abs)) {
      try {
        acc.push({ abs, lines: countLines(fs.readFileSync(abs)) });
      } catch {
        /* unreadable file: skip, must not crash the observer */
      }
    }
  }
  return acc;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.max(0, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[idx];
}

// ── 架构策略契约（khy-os 版 architecture-policy，对齐 ZCode 同名文件）──────────
// 细粒度**模块边界**策略：check:layout 只管 L0–L6 粗粒度层向（DESIGN-LAY-005），
// 本策略管 services/backend/src 内的模块级 file-size / 禁环 / 禁深引用。
// managedOnly 语义（同 ZCode）：策略只对 managed:true 模块生效；managed:false 是
// 存量 legacy，豁免但单列展示，逐模块迁移时翻成 managed:true。
const POLICY_REL = path.join('docs', '10_规范', 'registry', 'ARCHITECTURE-POLICY.json');

function loadPolicy(root) {
  const abs = path.join(root, POLICY_REL);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

// 把仓库内相对路径映射到模块 id（最长前缀匹配）。
function makeModuleResolver(policy) {
  const mods = ((policy && policy.modules) || []).map((m) => ({
    id: m.id,
    managed: !!m.managed,
    publicEntrypoints: m.publicEntrypoints || null,
    roots: (m.roots || []).map((r) => r.split(path.sep).join('/').replace(/\/+$/, '')),
  }));
  return function moduleIdOf(rel) {
    const norm = rel.split(path.sep).join('/').replace(/^\.\//, '');
    let best = null;
    let bestLen = -1;
    for (const m of mods) {
      for (const r of m.roots) {
        if ((norm === r || norm.startsWith(r + '/')) && r.length > bestLen) {
          best = m; bestLen = r.length;
        }
      }
    }
    return best;
  };
}

// 从源码抽取 require('x') / import ... from 'x' 的相对/内部说明符。
const SPEC_RE = /(?:require\(|from\s+)['"](\.[^'"]+|services\/[^'"]+|@khy\/[^'"]+)['"]/g;
function extractSpecifiers(text) {
  const out = [];
  let m;
  SPEC_RE.lastIndex = 0;
  while ((m = SPEC_RE.exec(text))) out.push(m[1]);
  return out;
}

// 解析一个说明符到仓库相对路径（best-effort，仅用于归类到模块；解析不到则 null）。
function resolveSpecifier(fromRel, spec, relSet) {
  let candidate;
  if (spec.startsWith('.')) {
    candidate = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  } else if (spec.startsWith('services/')) {
    candidate = path.posix.normalize(spec);
  } else {
    return null; // @khy/* 等 workspace 别名不在模块图内解析（保守忽略）
  }
  const tries = [candidate, candidate + '.js', candidate + '/index.js'];
  for (const t of tries) if (relSet.has(t)) return t;
  return null;
}

// 收集全部纳入范围的源文件（同 M1 的扫描范围），返回 {rel, abs} 列表 + relSet。
function scanScopedFiles(root) {
  const found = [];
  const collectFiles = (dir, relDir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!isExcluded(abs)) collectFiles(abs, rel); }
      else if (e.isFile() && e.name.endsWith('.js') && !isExcluded(abs)) found.push({ abs, rel });
    }
  };
  for (const d of SCAN_DIRS) {
    const abs = path.join(root, d);
    if (fs.existsSync(abs)) collectFiles(abs, d);
  }
  const relSet = new Set(found.map((f) => f.rel));
  return { found, relSet };
}

// ── M1 架构表面积：源文件行数（managed 模块受策略约束，legacy 单列展示）────────
function measureArchitecture(root, targets, ctx) {
  const { policy, found } = ctx;
  const cap = policy && policy.global && policy.global.maxFileLines
    ? policy.global.maxFileLines : targets.archMaxFileLinesHard;

  if (!policy) {
    // 无策略文件 → 回退全量口径（旧行为 / fixture）。
    const counts = found.map((f) => f.lines).sort((a, b) => a - b);
    const p99 = percentile(counts, 0.99);
    const max = counts.length ? counts[counts.length - 1] : 0;
    const over = found.filter((f) => f.lines > cap);
    const worst = over.sort((a, b) => b.lines - a.lines).slice(0, 5).map((f) => `${f.rel}=${f.lines}`);
    return {
      id: 'M1-architecture-size',
      label: '架构表面积（无 policy 回退 · 全量口径）',
      target: `≤${cap} 行/文件（ZCode architecture-policy.global.maxFileLines）`,
      current: `文件 ${found.length} · 最大 ${max} · p99 ${p99} · 超硬顶 ${over.length}`,
      status: over.length === 0 && p99 <= targets.archP99FileLines ? 'PASS' : 'GAP',
      detail: worst.length ? `最超标: ${worst.join(', ')}` : '',
    };
  }

  const moduleIdOf = ctx.moduleIdOf;
  let managedFiles = 0; let managedViol = []; let legacyFiles = 0; let legacyOver = 0;
  for (const f of found) {
    const mod = moduleIdOf(f.rel);
    if (mod && mod.managed) {
      managedFiles++;
      if (f.lines > cap) managedViol.push(`${f.rel}=${f.lines}`);
    } else {
      legacyFiles++;
      if (f.lines > cap) legacyOver++;
    }
  }
  const pass = managedViol.length === 0;
  managedViol = managedViol.sort();
  return {
    id: 'M1-architecture-size',
    label: `架构表面积（managed 模块 ≤${cap} 行）`,
    target: `纳管模块全部 ≤${cap} 行（managedOnly，对齐 ZCode global.maxFileLines）`,
    current: `纳管 ${managedFiles} 文件 · 违规 ${managedViol.length} ‖ legacy 未纳管 ${legacyFiles} 文件 · 超标 ${legacyOver}（豁免，逐模块迁移）`,
    status: pass ? 'PASS' : 'GAP',
    detail: managedViol.length ? `纳管违规: ${managedViol.slice(0, 5).join(', ')}` : '',
  };
}

// ── M6 模块级 import 环（forbidCycles · managedOnly）──────────────────────────
function findCyclesTouching(adj, managedSet) {
  const cycles = [];
  const dfs = (node, start, pathArr, onstack) => {
    for (const next of (adj.get(node) || [])) {
      if (next === start) { cycles.push([...pathArr, next]); continue; }
      if (onstack.has(next) || pathArr.length >= 6) continue;
      onstack.add(next); pathArr.push(next);
      dfs(next, start, pathArr, onstack);
      pathArr.pop(); onstack.delete(next);
    }
  };
  for (const m of managedSet) {
    if (!adj.has(m)) continue;
    dfs(m, m, [m], new Set([m]));
  }
  const uniq = []; const keys = new Set();
  for (const c of cycles) {
    const k = [...new Set(c)].sort().join('|');
    if (!keys.has(k)) { keys.add(k); uniq.push(c); }
  }
  return uniq;
}

function buildModuleGraph(ctx, edgeFilter) {
  const { found, relSet, moduleIdOf } = ctx;
  const adj = new Map();
  for (const f of found) {
    const from = moduleIdOf(f.rel);
    if (!from) continue;
    let text; try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    for (const spec of extractSpecifiers(text)) {
      const dep = resolveSpecifier(f.rel, spec, relSet);
      if (!dep) continue;
      const to = moduleIdOf(dep);
      if (!to || to.id === from.id) continue;
      if (edgeFilter && !edgeFilter(from, to)) continue;
      if (!adj.has(from.id)) adj.set(from.id, new Set());
      adj.get(from.id).add(to.id);
    }
  }
  return adj;
}

function measureCycles(ctx) {
  if (!ctx.policy) {
    return { id: 'M6-import-cycles', label: '模块 import 环（forbidCycles）', target: '纳管模块不参与 import 环', current: '无 policy 文件，未测量', status: 'OBSERVE' };
  }
  const managedSet = new Set(ctx.policy.modules.filter((m) => m.managed).map((m) => m.id));
  // managedOnly：纳管模块可依赖 legacy，但纳管模块之间不得成环——只在两端皆纳管时建边。
  const adj = buildModuleGraph(ctx, (from, to) => managedSet.has(from.id) && managedSet.has(to.id));
  const cycles = findCyclesTouching(adj, managedSet);
  const pass = cycles.length === 0;
  return {
    id: 'M6-import-cycles',
    label: '模块 import 环（forbidCycles · managed↔managed）',
    target: '纳管模块之间不互相成环（依赖 legacy 不计）',
    current: `纳管互依模块 ${adj.size} · 纳管间环 ${cycles.length}`,
    status: pass ? 'PASS' : 'GAP',
    detail: cycles.length ? cycles.slice(0, 3).map((c) => c.join('→')).join(' ; ') : '',
  };
}

// ── M7 跨模块深引用（forbidDeepImports · managedOnly）─────────────────────────
function measureDeepImports(ctx) {
  if (!ctx.policy) {
    return { id: 'M7-deep-imports', label: '跨模块深引用（forbidDeepImports）', target: '只经 publicEntrypoints 跨模块', current: '无 policy 文件，未测量', status: 'OBSERVE' };
  }
  const entryMods = new Map(
    ctx.policy.modules
      .filter((m) => Array.isArray(m.publicEntrypoints) && m.publicEntrypoints.length)
      .map((m) => [m.id, new Set(m.publicEntrypoints.map((p) => p.split(path.sep).join('/')))])
  );
  const managedSet = new Set(ctx.policy.modules.filter((m) => m.managed).map((m) => m.id));
  const { found, relSet, moduleIdOf } = ctx;
  const vios = [];
  for (const f of found) {
    const from = moduleIdOf(f.rel);
    if (!from || !managedSet.has(from.id)) continue; // managedOnly：只查纳管模块作为发起方
    let text; try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    for (const spec of extractSpecifiers(text)) {
      const dep = resolveSpecifier(f.rel, spec, relSet);
      if (!dep) continue;
      const to = moduleIdOf(dep);
      if (!to || to.id === from.id) continue;
      const entry = entryMods.get(to.id);
      if (!entry) continue; // 目标未声明 publicEntrypoints → 不约束
      if (!entry.has(dep)) vios.push(`${from.id} 深引用 ${to.id}: ${dep}`);
    }
  }
  const uniq = [...new Set(vios)];
  const pass = uniq.length === 0;
  return {
    id: 'M7-deep-imports',
    label: '跨模块深引用（forbidDeepImports · managedOnly）',
    target: '纳管模块只经目标模块的 publicEntrypoints 跨模块引用',
    current: `已声明入口的目标模块 ${entryMods.size} · 深引用违规 ${uniq.length}`,
    status: pass ? 'PASS' : 'GAP',
    detail: uniq.length ? uniq.slice(0, 5).join(' ; ') : '',
  };
}

// ── M2 守护启动 shim fail-soft ─────────────────────────────────────────────
function readDaemon(root) {
  const abs = path.join(root, 'services', 'backend', 'scripts', 'ai-manage-daemon.js');
  if (!fs.existsSync(abs)) return null;
  return { abs, text: fs.readFileSync(abs, 'utf8'), lines: fs.readFileSync(abs, 'utf8').split(/\r?\n/) };
}

function measureShimFailsoft(root) {
  const d = readDaemon(root);
  if (!d) {
    return { id: 'M2-daemon-shim', label: '守护启动 shim fail-soft', target: '关键 require 包在 try/catch 内', current: '未找到 ai-manage-daemon.js', status: 'OBSERVE' };
  }
  const re = /require\(['"][^'"]*services\/workflow['"]\)/;
  const idx = d.lines.findIndex((l) => re.test(l));
  if (idx === -1) {
    return { id: 'M2-daemon-shim', label: '守护启动 shim fail-soft', target: '关键 require 包在 try/catch 内', current: '未发现顶层 workflow require（已惰化/移除）', status: 'PASS' };
  }
  // 向上最多 5 行找 try {，判定 require 是否被 fail-soft 包裹。
  let guarded = false;
  for (let i = idx; i > Math.max(-1, idx - 5); i--) {
    if (/\btry\s*\{/.test(d.lines[i])) { guarded = true; break; }
  }
  // 目标即「缺模块只降级不崩守护」：require 被 try 包裹 = 达标（PASS）；
  // 裸 require（无 try）才会启动即崩（GAP）。
  return {
    id: 'M2-daemon-shim',
    label: '守护启动 shim fail-soft',
    target: '顶层 require 包在 try/catch 内（缺模块只降级不崩守护）',
    current: `workflow require 于第 ${idx + 1} 行${guarded ? '，已被 try/catch fail-soft 包裹' : '，无 try 包裹'}`,
    status: guarded ? 'PASS' : 'GAP',
    detail: guarded ? '' : '单次 MODULE_NOT_FOUND 会让守护启动即崩',
  };
}

// ── M3 守护 startup-timeout 自杀循环 ───────────────────────────────────────
function measureSuicideLoop(root) {
  const d = readDaemon(root);
  if (!d) {
    return { id: 'M3-daemon-liveness', label: '守护 startup-timeout 抖动循环', target: '服务过请求/探针后不按启动宽限自杀', current: '未找到 ai-manage-daemon.js', status: 'OBSERVE' };
  }
  const hasStartupTimeout = /startup-timeout/.test(d.text);
  // 真实防抖（已验证）：请求活动计入空闲时钟 + 在途工作探针刷新存活，
  // 二者使守护只在「真正空闲」时才按 startupGraceMs 回收，而非空窗误杀。
  const requestLiveness = /Math\.max\([^)]*lastRequestAt/.test(d.text);
  const inFlightProbe = /anyProbeActive\(\)/.test(d.text);
  let status;
  if (!hasStartupTimeout) status = 'PASS';
  else if (requestLiveness && inFlightProbe) status = 'PASS';
  else if (requestLiveness || inFlightProbe) status = 'PARTIAL';
  else status = 'GAP';
  return {
    id: 'M3-daemon-liveness',
    label: '守护 startup-timeout 抖动循环',
    target: 'startup-timeout 仅在真空闲触发：请求活动 + 在途工作均计入存活',
    current: `startup-timeout 分支存在=${hasStartupTimeout} · 请求计入空闲=${requestLiveness} · 在途探针刷新=${inFlightProbe}`,
    status,
    detail: status === 'PASS'
      ? ''
      : '缺请求/在途存活信号时长任务可能被启动宽限误杀',
  };
}

// ── M4 日志编码 UTF-8 纯净度 ───────────────────────────────────────────────
function measureLogEncoding(root) {
  const logDir = process.env.KHY_ZCODE_LOG_DIR || path.join(root, '.khy', 'logs');
  let names = [];
  try {
    names = fs.readdirSync(logDir).filter((n) => n.endsWith('.log'));
  } catch {
    return { id: 'M4-log-encoding', label: '日志编码 UTF-8 纯净度', target: `非法/乱码日志文件 ≤${DEFAULT_TARGETS.logEncodingInvalidFilesAllowed}`, current: `无日志目录（${path.relative(root, logDir) || '.'}）`, status: 'OBSERVE' };
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const bad = [];
  for (const n of names) {
    try {
      const buf = fs.readFileSync(path.join(logDir, n));
      const txt = decoder.decode(buf);
      if (txt.includes('\uFFFD') || txt.includes('锟斤拷')) bad.push(n + '(mojibake)');
    } catch {
      bad.push(n + '(invalid-utf8)');
    }
  }
  const allowed = DEFAULT_TARGETS.logEncodingInvalidFilesAllowed;
  const pass = bad.length <= allowed;
  return {
    id: 'M4-log-encoding',
    label: '日志编码 UTF-8 纯净度',
    target: `非法/乱码日志文件 ≤${allowed}`,
    current: `扫描 ${names.length} 个 .log · 异常 ${bad.length}${bad.length ? `: ${bad.slice(0, 5).join(', ')}` : ''}`,
    status: pass ? 'PASS' : 'GAP',
  };
}

// ── M5 分发完整性（校验和 + SBOM） ─────────────────────────────────────────
function measureDistribution(root) {
  // 「发布链」跨两处：脚本实现（scripts/release）与流程定义（release workflow
  // YAML）。SBOM 步骤实际写在 workflow 里（cyclonedx-npm / cyclonedx-py），
  // 校验和逻辑在脚本里 —— 只看其中一处会漏检、误报 GAP。
  const sources = [];
  const rel = path.join(root, 'scripts', 'release');
  try {
    for (const f of fs.readdirSync(rel)) {
      if (/\.(sh|js|py)$/.test(f)) {
        try { sources.push(fs.readFileSync(path.join(rel, f), 'utf8')); } catch { /* skip */ }
      }
    }
  } catch { /* scripts/release missing */ }

  const wfDir = path.join(root, '.github', 'workflows');
  let sawWorkflow = false;
  try {
    for (const f of fs.readdirSync(wfDir)) {
      if (/release/i.test(f) && /\.ya?ml$/.test(f)) {
        sawWorkflow = true;
        try { sources.push(fs.readFileSync(path.join(wfDir, f), 'utf8')); } catch { /* skip */ }
      }
    }
  } catch { /* workflows dir missing */ }

  if (!sources.length) {
    return { id: 'M5-distribution-integrity', label: '分发完整性（校验和+SBOM）', target: '发布链生成 SHA256 + SBOM', current: '未找到发布链脚本/workflow', status: 'OBSERVE' };
  }
  const hay = sources.join('\n');
  const hasSha = /sha256|sha-256|SHA256SUMS|shasum/i.test(hay);
  // 要求是「生成 SBOM」的动作，而非任意提及。
  const hasSbom = /(cyclonedx|syft|spdx|sbom)[^\n]*(generate|--output|install|> )|(generate[^\n]*sbom)|name:\s*Generate SBOM|cyclonedx-(npm|py)/i.test(hay);
  const pass = hasSha && hasSbom;
  return {
    id: 'M5-distribution-integrity',
    label: '分发完整性（校验和+SBOM）',
    target: '发布链同时生成 SHA256 校验和 + SBOM',
    current: `SHA256=${hasSha} · SBOM=${hasSbom}（含 release workflow=${sawWorkflow}）`,
    status: pass ? 'PASS' : (hasSha || hasSbom ? 'PARTIAL' : 'GAP'),
  };
}

function collect(root, targets) {
  const policy = loadPolicy(root);
  const { found, relSet } = scanScopedFiles(root);
  for (const f of found) {
    try { f.lines = countLines(fs.readFileSync(f.abs)); } catch { f.lines = 0; }
  }
  const ctx = { policy, found, relSet };
  if (policy) ctx.moduleIdOf = makeModuleResolver(policy);
  return [
    measureArchitecture(root, targets, ctx),
    measureShimFailsoft(root),
    measureSuicideLoop(root),
    measureLogEncoding(root),
    measureDistribution(root),
    measureCycles(ctx),
    measureDeepImports(ctx),
  ];
}

function summarize(metrics) {
  const count = (s) => metrics.filter((m) => m.status === s).length;
  return { PASS: count('PASS'), PARTIAL: count('PARTIAL'), GAP: count('GAP'), OBSERVE: count('OBSERVE') };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRepoRoot();
  let targets = { ...DEFAULT_TARGETS };
  if (args.config) {
    try { Object.assign(targets, JSON.parse(fs.readFileSync(path.resolve(root, args.config), 'utf8'))); } catch { /* keep defaults */ }
  }
  const metrics = collect(root, targets);
  const summary = summarize(metrics);
  const report = { stage: STAGE, blocking: false, root, targets, summary, metrics };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return; // S1：恒不阻断
  }

  const w = 66;
  process.stdout.write('== ZCode 级别代理指标记分板 ==\n');
  process.stdout.write(`阶段: ${STAGE}（观察者 · 只记录不拦截）  根: ${root}\n`);
  process.stdout.write('-'.repeat(w) + '\n');
  for (const m of metrics) {
    process.stdout.write(`[${m.status.padEnd(7)}] ${m.label}\n`);
    process.stdout.write(`          目标: ${m.target}\n`);
    process.stdout.write(`          现状: ${m.current}\n`);
    if (m.detail) process.stdout.write(`          备注: ${m.detail}\n`);
  }
  process.stdout.write('-'.repeat(w) + '\n');
  process.stdout.write(`汇总: PASS ${summary.PASS} · PARTIAL ${summary.PARTIAL} · GAP ${summary.GAP} · OBSERVE ${summary.OBSERVE}\n`);
  process.stdout.write('（S1 观察者档不参与放行判定，本脚本恒返回 0）\n');
}

// 仅在作为脚本直接运行时执行 main；被 require（如 node --test）时只导出纯函数。
if (require.main === module) {
  try {
    main();
  } catch (err) {
    // 观察者绝不因自身异常阻断流程。
    process.stderr.write(`check-zcode-baseline: 记录失败（忽略）: ${err && err.message}\n`);
  }
  process.exitCode = 0;
}

module.exports = { collect, summarize, DEFAULT_TARGETS, STAGE };
