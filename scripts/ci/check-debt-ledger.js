#!/usr/bin/env node
'use strict';

/**
 * check-debt-ledger.js — 门禁债务台账守卫。
 *
 * 解决什么问题：两个门禁长期失效 ——
 *   ① `code-standards.baseline.json` 的数字**不是测出来的**（functionLines 与
 *      nestingDepth 都写 10800、max 都写 12000，而实测分别是 2145 与 8707；
 *      容忍度是实际的 5.6 倍，门只能拦「翻倍级」恶化）；
 *   ② `check-repo-layout.js` 存量 148 处违规而 baseline 全为 0，门永远红。
 * 红着的门等于没有门 —— 因为它训练所有人忽略红色。
 *
 * 本守卫不重复测量（测量是各门禁自己的事），它管的是**责任**：
 *   - 每一类门禁指标都必须在台账里有条目（**覆盖完整性**，从守卫源码解析后强制）；
 *   - 每条都要有 owner / dueBy / target / plan；
 *   - target 必须严格小于 measured（只降不升）；
 *   - 逾期必须显式标记为 slipped 并写明理由与修订日期（禁止静默滑动）；
 *   - measuredAt 超过 90 天未更新 → 警告（防止台账变化石）。
 *
 * 「覆盖完整性」是这套机制的关键：新增一类可豁免指标时，守卫会立刻要求为它
 * 补一条带责任人与期限的台账条目 —— 于是「悄悄加一个没人管的指标」不再可能。
 *
 * 用法：
 *   node scripts/ci/check-debt-ledger.js
 *   node scripts/ci/check-debt-ledger.js --json
 *   cargo-style fixture root: KHY_DEBT_LEDGER_ROOT=/path/to/repo
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.KHY_DEBT_LEDGER_ROOT
  ? path.resolve(process.env.KHY_DEBT_LEDGER_ROOT)
  : path.resolve(__dirname, '..', '..');

const LEDGER_REL = 'scripts/ci/debt-ledger.json';
const LAYOUT_GUARD_REL = 'scripts/ci/check-repo-layout.js';
const STANDARDS_BASELINE_REL = 'scripts/ci/code-standards.baseline.json';
const STALE_DAYS = 90;

const findings = [];
function add(level, rule, message) {
  findings.push({ level, rule, message });
}

function readText(rel) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

function exists(rel) {
  try {
    return fs.statSync(path.join(REPO_ROOT, rel)).isFile();
  } catch {
    return false;
  }
}

// ── 台账加载 ──────────────────────────────────────────────────────────────
let ledger = null;
const ledgerRaw = readText(LEDGER_REL);
if (ledgerRaw === null) {
  add('error', 'ledger-exists', `台账缺失：${LEDGER_REL}`);
} else {
  try {
    ledger = JSON.parse(ledgerRaw);
  } catch (e) {
    add('error', 'ledger-parse', `台账 JSON 解析失败：${e.message}`);
  }
}

const entries = (ledger && Array.isArray(ledger.entries)) ? ledger.entries : [];
if (ledger && !Array.isArray(ledger.entries)) {
  add('error', 'ledger-shape', '台账缺少 entries 数组。');
}

// ── 必填字段与取值校验 ────────────────────────────────────────────────────
const REQUIRED_FIELDS = ['id', 'guard', 'metric', 'measured', 'measuredAt', 'target', 'risk', 'owner', 'dueBy', 'status', 'note', 'plan'];
const VALID_STATUS = new Set(['open', 'slipped', 'closed']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TODAY = new Date();
function daysBetween(fromIso) {
  const d = new Date(`${fromIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return NaN;
  return Math.floor((TODAY.getTime() - d.getTime()) / 86400000);
}

const seenIds = new Set();
let slippedCount = 0;
let targetPendingCount = 0;

for (const e of entries) {
  const tag = e && e.id ? e.id : '(缺 id)';
  if (!e || typeof e !== 'object') {
    add('error', 'entry-shape', '台账条目不是对象。');
    continue;
  }
  for (const f of REQUIRED_FIELDS) {
    if (e[f] === undefined || e[f] === null || e[f] === '') {
      add('error', 'entry-required-field', `${tag}: 缺必填字段 ${f}。`);
    }
  }
  if (seenIds.has(e.id)) add('error', 'entry-duplicate-id', `${tag}: id 重复。`);
  seenIds.add(e.id);

  if (!VALID_STATUS.has(e.status)) {
    add('error', 'entry-status', `${tag}: status 必须是 open / slipped / closed，实为 ${JSON.stringify(e.status)}。`);
  }
  if (!DATE_RE.test(String(e.measuredAt || ''))) {
    add('error', 'entry-date', `${tag}: measuredAt 必须是 YYYY-MM-DD。`);
  }
  if (!DATE_RE.test(String(e.dueBy || ''))) {
    add('error', 'entry-date', `${tag}: dueBy 必须是 YYYY-MM-DD。`);
  }

  if (typeof e.measured === 'number' && typeof e.target === 'number') {
    // QUAL-2 只降不升：target 必须严格小于 measured，除非：
    //   (a) 两者同为 0（已归零）；或
    //   (b) 显式声明 targetPending（「目标待定：先修计量/口径，再定目标」）。
    // (b) 不是后门 —— 它要求给出理由与「目标必须在何时定下来」的日期，并被单独计入
    // 摘要，使「暂时定不了目标」成为一个**有期限的公开状态**而非无限期豁免。
    const pendingOk =
      e.targetPending &&
      typeof e.targetPending === 'object' &&
      String(e.targetPending.reason || '').trim() !== '' &&
      DATE_RE.test(String(e.targetPending.by || ''));
    if (e.targetPending && !pendingOk) {
      add('error', 'entry-target-pending-shape',
        `${tag}: targetPending 必须带非空 reason 与 YYYY-MM-DD 格式的 by。`);
    }
    if (!(e.target < e.measured || (e.target === 0 && e.measured === 0) || pendingOk)) {
      const hint = e.targetPending
        ? '（已声明 targetPending，但其 reason/by 不完整）'
        : '；若暂时无法定目标，请显式声明 targetPending: { reason, by }';
      add('error', 'entry-target-ratchet',
        `${tag}: target (${e.target}) 必须严格小于 measured (${e.measured})，或二者同为 0${hint}。`
        + '基线只降不升 —— 上调目标等于放宽标准。');
    }
    if (pendingOk) {
      targetPendingCount++;
      const byAge = daysBetween(String(e.targetPending.by));
      if (Number.isFinite(byAge) && byAge > 0) {
        add('error', 'entry-target-pending-overdue',
          `${tag}: targetPending.by (${e.targetPending.by}) 已过期 —— 该定目标了。`);
      }
    }
  } else if (typeof e.measured !== 'number' || typeof e.target !== 'number') {
    add('error', 'entry-number', `${tag}: measured 与 target 必须是数字。`);
  }

  if (e.guard && !exists(e.guard)) {
    add('error', 'entry-guard-exists', `${tag}: guard 指向的文件不存在：${e.guard}`);
  }

  // 逾期处理：禁止静默滑动
  const dueAge = daysBetween(String(e.dueBy || ''));
  if (e.status === 'open' && Number.isFinite(dueAge) && dueAge > 0) {
    add('error', 'entry-overdue',
      `${tag}: 已逾期 ${dueAge} 天（dueBy ${e.dueBy}）。要么修完归零，要么把 status 改为 slipped`
      + '并写明 slippedReason 与修订后的 dueBy —— 逾期必须留痕，不允许静默滑动。');
  }
  if (e.status === 'slipped') {
    slippedCount++;
    if (!e.slippedReason) add('error', 'entry-slip-reason', `${tag}: status=slipped 必须带 slippedReason。`);
    if (Number.isFinite(dueAge) && dueAge > 0) {
      add('error', 'entry-slip-overdue', `${tag}: slipped 条目的 dueBy 仍是过去时间 —— 请给出修订后的期限。`);
    }
  }
  if (e.status === 'closed' && e.measured !== 0) {
    add('error', 'entry-closed-mismatch', `${tag}: status=closed 但 measured=${e.measured}（应已归零）。`);
  }

  // 台账化石检测
  const measuredAge = daysBetween(String(e.measuredAt || ''));
  if (Number.isFinite(measuredAge) && measuredAge > STALE_DAYS) {
    add('warning', 'entry-stale-measurement',
      `${tag}: measuredAt 距今 ${measuredAge} 天（> ${STALE_DAYS}）—— 台账可能已成化石，请重新测量。`);
  }
}

// ── 覆盖完整性：每个门禁指标都必须有台账条目 ──────────────────────────────
const ledgerMetrics = new Set(entries.map((e) => `${path.basename(String(e.guard || ''))}#${e.metric}`));

/** 从 check-repo-layout.js 源码里解析 BASELINE_IDS 集合。 */
function parseLayoutBaselineIds() {
  const src = readText(LAYOUT_GUARD_REL);
  if (src === null) {
    add('error', 'coverage-layout-guard', `找不到 ${LAYOUT_GUARD_REL}，无法校验覆盖完整性。`);
    return [];
  }
  const m = src.match(/const BASELINE_IDS = new Set\(\[([\s\S]*?)\]\)/);
  if (!m) {
    add('error', 'coverage-layout-parse',
      `未能从 ${LAYOUT_GUARD_REL} 解析出 BASELINE_IDS —— 守卫结构变了，请同步更新本脚本的解析。`);
    return [];
  }
  return [...m[1].matchAll(/['"]([a-z0-9-]+)['"]/g)].map((x) => x[1]);
}

/** 从 code-standards.baseline.json 里解析 baselines 键集合。 */
function parseStandardsBaselineKeys() {
  const raw = readText(STANDARDS_BASELINE_REL);
  if (raw === null) {
    add('error', 'coverage-standards-baseline', `找不到 ${STANDARDS_BASELINE_REL}，无法校验覆盖完整性。`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Object.keys(parsed.baselines || {});
  } catch (e) {
    add('error', 'coverage-standards-parse', `${STANDARDS_BASELINE_REL} 解析失败：${e.message}`);
    return [];
  }
}

const layoutGuardBase = path.basename(LAYOUT_GUARD_REL);
const standardsGuardBase = path.basename(decodeURIComponent('check-code-standards.js'));

const coverage = [
  ...parseLayoutBaselineIds().map((id) => ({ key: `${layoutGuardBase}#${id}`, label: `${layoutGuardBase} 的 ${id}` })),
  ...parseStandardsBaselineKeys().map((k) => ({ key: `${standardsGuardBase}#${k}`, label: `${standardsGuardBase} 的 ${k}` })),
];

for (const c of coverage) {
  if (!ledgerMetrics.has(c.key)) {
    add('error', 'coverage-missing',
      `台账未覆盖门禁指标「${c.label}」。每一类门禁指标都必须有 owner / dueBy / target / plan ——`
      + ' 新增可豁免指标必须携带责任人与期限（QUAL-3）。');
  }
}

// ── 输出 ──────────────────────────────────────────────────────────────────
const errors = findings.filter((f) => f.level === 'error');
const warnings = findings.filter((f) => f.level === 'warning');
const isJson = process.argv.includes('--json');

const summary = {
  entries: entries.length,
  covered: ledgerMetrics.size,
  requiredCoverage: coverage.length,
  slipped: slippedCount,
  open: entries.filter((e) => e.status === 'open').length,
  closed: entries.filter((e) => e.status === 'closed').length,
  totalMeasured: entries.reduce((n, e) => n + (typeof e.measured === 'number' ? e.measured : 0), 0),
};

if (isJson) {
  console.log(JSON.stringify({
    schema: 'khy.debt-ledger/v1',
    errors: errors.length,
    warnings: warnings.length,
    summary,
    findings,
  }, null, 2));
} else {
  console.log('门禁债务台账守卫');
  console.log('='.repeat(72));
  console.log(`台账条目 ${summary.entries} 条：open ${summary.open} / slipped ${summary.slipped} / closed ${summary.closed}`);
  console.log(`覆盖指标 ${summary.covered} / 应有 ${summary.requiredCoverage}`);
  console.log(`累计实测债务量 ${summary.totalMeasured} 处`);

  console.log('\n逐条：');
  for (const e of entries) {
    const mark = e.status === 'closed' ? '✓' : e.status === 'slipped' ? '!' : '·';
    console.log(`  ${mark} [${String(e.risk || '?').padEnd(2)}] ${String(e.id).padEnd(34)} ${e.measured} → ${e.target}  (owner=${e.owner}, due=${e.dueBy}, ${e.status})`);
  }

  if (findings.length === 0) {
    console.log('\n无违规。✓');
  } else {
    console.log('');
    for (const f of findings) {
      console.log(`[${f.level === 'error' ? 'FAIL' : 'WARN'}] ${f.rule}`);
      console.log(`        ${f.message}`);
    }
  }
  console.log('\n' + '='.repeat(72));
  console.log(`结果: ${errors.length} error, ${warnings.length} warning`);
}

process.exit(errors.length > 0 ? 1 : 0);
