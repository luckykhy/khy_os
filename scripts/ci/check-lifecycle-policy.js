#!/usr/bin/env node
/**
 * Lifecycle-policy drift guard(后台常驻 vs 按需加载 边界防漂移)。
 *
 * serviceLifecyclePolicy.js 是「常驻 / 一次性 / 按需」层级的单一真源;deferredPrefetch 由它驱动。
 * 本守卫纯读文件 + 正则,退出码非 0 即 fail,防止有人新增/删除后台任务却不同步策略,或让本应按需
 * 的重子系统(aiGateway)回退到同步冷启动路径。
 *
 * 校验:
 *   A.  主门 KHY_LIFECYCLE_POLICY 已在 flagRegistry.js 登记。
 *   A2. 策略声明的每个非空 gate 都是真实存在的 flag(在 services/backend/src 里可见)。
 *   B.  prefetch.js 的 RUNNERS 键集合 === 策略 cli-startup 条目 id 集合(双向,防漂移)。
 *   C.  策略 process==='daemon' 条目的 startSymbol 在 daemonEntry.js / aiManagementServer.js 可见。
 *   D.  on-demand 边界:aiGateway 不得出现在 bin/khy.js / cli/bootstrap.js 顶部 require;
 *       tools/index.js 含 KHY_DEFER_TOOLS(惰性加载门仍在)。
 *
 * Usage:
 *   node scripts/check-lifecycle-policy.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SRC = path.join(REPO, 'services/backend/src');

const P = {
  policy: path.join(SRC, 'services/serviceLifecyclePolicy.js'),
  prefetch: path.join(SRC, 'bootstrap/prefetch.js'),
  flagRegistry: path.join(SRC, 'services/flagRegistry.js'),
  daemonEntry: path.join(SRC, 'services/daemonEntry.js'),
  aiManagementServer: path.join(SRC, 'services/aiManagementServer.js'),
  binKhy: path.join(REPO, 'services/backend/bin/khy.js'),
  bootstrap: path.join(SRC, 'cli/bootstrap.js'),
  toolsIndex: path.join(SRC, 'tools/index.js'),
};

const errors = [];
const fail = (msg) => errors.push(msg);

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    fail(`无法读取 ${path.relative(REPO, file)}: ${e && e.message ? e.message : e}`);
    return '';
  }
}

// 载入策略 SSoT(纯叶子,零 IO,require 安全)。
let policy;
try {
  policy = require(P.policy);
} catch (e) {
  console.error(`[check-lifecycle-policy] 无法 require 策略叶子: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
}

const prefetchSrc = read(P.prefetch);
const flagSrc = read(P.flagRegistry);

// ── A. 主门登记 ──────────────────────────────────────────────────────────────
if (!/KHY_LIFECYCLE_POLICY\s*:/.test(flagSrc)) {
  fail('flagRegistry.js 未登记主门 KHY_LIFECYCLE_POLICY');
}

// ── A2. 每个策略 gate 都是真实 flag(在 services/backend/src 可见)──────────────
const gates = (typeof policy.allGates === 'function' ? policy.allGates() : []) || [];
if (gates.length) {
  const IGNORE = new Set(['node_modules', 'tests', '__tests__', '.git', 'coverage', 'dist', 'build']);
  const pending = new Set(gates);
  const stack = [SRC];
  while (stack.length && pending.size) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (pending.size === 0) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!IGNORE.has(ent.name)) stack.push(full);
      } else if (ent.isFile() && /\.(js|cjs|mjs)$/.test(ent.name)) {
        let txt = '';
        try { txt = fs.readFileSync(full, 'utf8'); } catch { continue; }
        for (const g of Array.from(pending)) if (txt.includes(g)) pending.delete(g);
      }
    }
  }
  for (const g of pending) {
    fail(`策略声明的 gate ${g} 在 services/backend/src 里找不到引用(疑似拼写错误或已删除的 flag)`);
  }
}

// ── B. RUNNERS 键 === cli-startup id(双向)──────────────────────────────────
const cliIds = (typeof policy.listByProcess === 'function'
  ? policy.listByProcess('cli-startup') : [])
  .map((e) => e && e.id)
  .filter(Boolean);

// 提取 prefetch.js 的 RUNNERS 块 → 4 空格缩进的 `key: () =>` / `key: async () =>`。
let runnerKeys = [];
const startIdx = prefetchSrc.indexOf('const RUNNERS = {');
if (startIdx === -1) {
  fail('prefetch.js 未找到 `const RUNNERS = {`(deferredPrefetch 应由策略驱动)');
} else {
  const closeIdx = prefetchSrc.indexOf('\n  };', startIdx);
  const block = closeIdx === -1 ? prefetchSrc.slice(startIdx) : prefetchSrc.slice(startIdx, closeIdx);
  const re = /^ {4}(\w+):\s*(?:async\s*)?\(\)\s*=>/gm;
  let m;
  while ((m = re.exec(block)) !== null) runnerKeys.push(m[1]);
}

const cliSet = new Set(cliIds);
const runnerSet = new Set(runnerKeys);
for (const id of cliSet) {
  if (!runnerSet.has(id)) fail(`策略声明 cli-startup 条目 "${id}",但 prefetch.js 的 RUNNERS 缺对应 runner`);
}
for (const k of runnerSet) {
  if (!cliSet.has(k)) fail(`prefetch.js 的 RUNNERS 含 "${k}",但策略 cli-startup 无对应条目`);
}

// ── C. daemon startSymbol 可见 ───────────────────────────────────────────────
const daemonSrc = read(P.daemonEntry) + '\n' + read(P.aiManagementServer);
const daemonRows = (typeof policy.listByProcess === 'function' ? policy.listByProcess('daemon') : []);
for (const e of daemonRows) {
  if (e && e.startSymbol && !daemonSrc.includes(e.startSymbol)) {
    fail(`daemon 条目 "${e.id}" 的 startSymbol \`${e.startSymbol}\` 在 daemonEntry.js / aiManagementServer.js 找不到`);
  }
}

// ── D. on-demand 边界防回退 ──────────────────────────────────────────────────
const AIGW_RE = /require\([^)]*gateway\/aiGateway[^)]*\)/;
for (const [label, file] of [['bin/khy.js', P.binKhy], ['cli/bootstrap.js', P.bootstrap]]) {
  const src = read(file);
  if (AIGW_RE.test(src)) {
    fail(`${label} 顶部出现 aiGateway require —— aiGateway 是 on-demand(17 adapter 需 init),严禁进同步冷启动路径`);
  }
}
const toolsSrc = read(P.toolsIndex);
if (!toolsSrc.includes('KHY_DEFER_TOOLS')) {
  fail('tools/index.js 缺少 KHY_DEFER_TOOLS —— 工具惰性加载门必须在(on-demand 边界)');
}

// ── 结果 ─────────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error('✗ check-lifecycle-policy 失败:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✓ check-lifecycle-policy 通过(cli-startup ${cliSet.size} · daemon ${daemonRows.length} · gates ${gates.length})`);
process.exit(0);
