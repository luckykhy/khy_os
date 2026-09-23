#!/usr/bin/env node
'use strict';

// SOURCING-001 — assert the upstream→local provenance ledger is complete and
// that every recorded local path actually exists.
//
// The ledger records mapping FACTS only. The vendored decision logic (license /
// no official package / deletable-as-whole) stays in DESIGN-SOURCING-001 §2 B-M1 —
// this checker does not duplicate that judgement.
const fs = require('fs');
const path = require('path');

const repoRoot = process.env.RULEGUARD_REPO_ROOT || path.resolve(__dirname, '..', '..');
const LEDGER_REL = 'docs/10_规范/registry/SOURCING-PROVENANCE.json';
const SSOT_DOC = 'docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md';
const FEATURE_REL = 'docs/10_规范/registry/FEATURE-OWNERSHIP.json';
const PROVENANCE_DOC_REL = 'kernel/vendor/moonbit/PROVENANCE.md';

const strictWarnings = process.argv.includes('--strict-warnings');
const findings = [];
const add = (severity, id, relFile, line, message) =>
  findings.push({ severity, id, file: relFile, line, message });

const read = (rel) => {
  const abs = path.join(repoRoot, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};
const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));

let ledger = null;
const raw = read(LEDGER_REL);
if (raw === null) {
  add('error', 'ledger-missing', LEDGER_REL, 0, '来源出处台账缺失，SOURCING-001 无可断言对象。');
} else {
  try {
    ledger = JSON.parse(raw);
  } catch (err) {
    add('error', 'ledger-invalid-json', LEDGER_REL, 0, `台账不是合法 JSON：${err.message}`);
  }
}

if (ledger) {
  checkModelCompleteness(ledger);
  checkLedgerEntries(ledger);
  checkObservedDirs(ledger);
}
checkFeatureOwnershipCrossRef(ledger);

// ── the field model must declare every field with requiredness ──
function checkModelCompleteness(l) {
  const model = l.provenanceModel || {};
  const fields = Array.isArray(model.fields) ? model.fields : [];
  if (fields.length === 0) {
    add('error', 'model-empty', LEDGER_REL, 0,
      'provenanceModel.fields 为空：台账字段定义缺失，无法判定「字段齐全」。');
    return;
  }
  const declared = new Set();
  for (const f of fields) {
    for (const attr of ['key', 'required', 'type']) {
      if (!(attr in f)) {
        add('error', 'model-attribute-missing', LEDGER_REL, 0,
          `台账字段缺属性 ${attr}（字段 ${f.key || '<未命名>'}）。`);
      }
    }
    declared.add(f.key);
  }
  // 三项核心字段必须必填——缺任一项即不可判定「是否复制」
  for (const core of ['source', 'localPath', 'relationship']) {
    const f = fields.find((x) => x.key === core);
    if (!f) {
      add('error', 'core-field-missing', LEDGER_REL, 0, `台账缺核心字段 ${core}。`);
    } else if (f.required !== true) {
      add('error', 'core-field-optional', LEDGER_REL, 0,
        `核心字段 ${core} 必须 required=true——上游来源标识 / 本地路径 / 对应关系缺一项即不可判定。`);
    }
  }
  if (declared.size !== fields.length) {
    add('warn', 'model-key-duplicate', LEDGER_REL, 0, '台账字段 key 存在重复。');
  }
}

// ── every ledger row must be well-formed and point at a real file ──
function checkLedgerEntries(l) {
  const rows = Array.isArray(l.ledger) ? l.ledger : [];
  if (rows.length === 0) {
    add('warn', 'ledger-empty', LEDGER_REL, 0,
      '台账 ledger 为空。若确无 vendored/生成产物，请在 knownGaps 登记原因。');
  }
  const enumVals = new Set(((l.relationshipEnum || {}).values || []).concat('generated'));
  const seen = new Set();

  for (const [i, row] of rows.entries()) {
    const where = row.localPath || `ledger[${i}]`;
    for (const core of ['source', 'localPath', 'relationship']) {
      if (!row[core]) {
        add('error', 'row-missing-field', LEDGER_REL, 0, `台账第 ${i + 1} 条缺 ${core}（${where}）。`);
      }
    }
    if (!enumVals.has(row.relationship)) {
      add('error', 'row-relationship-unknown', LEDGER_REL, 0,
        `台账第 ${i + 1} 条 relationship=${JSON.stringify(row.relationship)} 不在枚举内（${[...enumVals].join(' | ')}）。`);
    }
    if (seen.has(row.localPath)) add('error', 'row-duplicate-path', LEDGER_REL, 0, `台账 localPath 重复：${row.localPath}`);
    seen.add(row.localPath);

    if (row.localPath && !exists(row.localPath)) {
      add('error', 'row-path-missing', LEDGER_REL, 0, `台账记录的本地路径不存在：${row.localPath}`);
    }
    if (row.relationship === 'generated' && !row.regenerationCommand) {
      add('error', 'row-no-regen-command', LEDGER_REL, 0,
        `generated 关系必须填 regenerationCommand（${row.localPath}）——否则版本钉子不可复核。`);
    }
    if (['vendored', 'fork'].includes(row.relationship)) {
      if (!row.license) add('error', 'row-no-license', LEDGER_REL, 0,
        `vendored/fork 关系必须填 license（${row.localPath}），B-M1 第 1 条要求许可证可核实。`);
      if (!row.approvedBy) add('error', 'row-no-approval', LEDGER_REL, 0,
        `vendored/fork 关系必须填 approvedBy（${row.localPath}），B-P3 要求维护者显式批准且裁决人不得是唯一实现者。`);
    }
    if (row.localPath && row.localPath.startsWith('kernel/vendor/moonbit/')) {
      // 版本钉子不得静默变更（呼应 B-L3 决策不可回退）
      if (!row.versionPin) {
        add('warn', 'row-no-version-pin', LEDGER_REL, 0,
          `MoonBit 产物 ${row.localPath} 无 versionPin——ABI 相关产物必须钉版本。`);
      }
    }
  }
}

// ── observed vendor dirs must still exist and be accounted for ──
function checkObservedDirs(l) {
  const dirs = (((l.observedVendorDirs || {}).dirs) || []);
  const gapPaths = new Set(((l.knownGaps || []).map((g) => g.path || '')));
  const ledgerPaths = new Set(((l.ledger || []).map((r) => r.localPath || '')));

  for (const d of dirs) {
    if (!d.path) continue;
    if (!exists(d.path)) {
      add('error', 'observed-dir-missing', LEDGER_REL, 0, `observedVendorDirs 记录的目录不存在：${d.path}`);
    }
    // 有内容但未登记的目录必须进 knownGaps，否则等于绕过台账
    const covered = d.state === 'ledgered' || d.state === 'empty' || gapPaths.has(d.path) ||
      [...ledgerPaths].some((p) => p === d.path || p.startsWith(`${d.path}/`));
    if (!covered && d.state !== 'ledgered') {
      add('warn', 'observed-dir-unaccounted', LEDGER_REL, 0,
        `vendor 目录 ${d.path} 状态为 ${JSON.stringify(d.state)} 且既不在台账也不在 knownGaps——登记缺口。`);
    }
  }
}

// ── B-M1 第 6 条：vendored 必须在 FEATURE-OWNERSHIP.json 登记 ──
function checkFeatureOwnershipCrossRef(l) {
  const text = read(FEATURE_REL);
  if (text === null) {
    add('error', 'feature-ownership-missing', FEATURE_REL, 0,
      'FEATURE-OWNERSHIP.json 不存在——B-M1 第 6 条要求的 vendored 登记载体缺失。');
    return;
  }
  let own = null;
  try { own = JSON.parse(text); } catch (_) {
    add('error', 'feature-ownership-invalid', FEATURE_REL, 0, 'FEATURE-OWNERSHIP.json 不是合法 JSON。');
    return;
  }
  const caps = Array.isArray(own.capabilities) ? own.capabilities : [];
  const vendored = caps.filter((c) => c.method === 'vendored');
  const vendoredRows = ((l.ledger || []).filter((r) => r.relationship === 'vendored'));
  if (vendoredRows.length && vendored.length === 0) {
    add('error', 'vendored-not-cross-registered', LEDGER_REL, 0,
      `台账有 ${vendoredRows.length} 条 vendored 记录，但 FEATURE-OWNERSHIP.json 中零条 method=vendored——B-M1 第 6 条未满足。`);
  }
  if (vendored.length === 0 && vendoredRows.length === 0) {
    add('warn', 'no-vendored-records', FEATURE_REL, 0,
      '全仓零条 vendored 登记（method 实测仅 self-developed / idea）。若引入了 vendored 产物须同时登记两处。');
  }
}

// ── the upstream provenance convention doc must still exist ──
(function checkProvenanceDoc() {
  const text = read(PROVENANCE_DOC_REL);
  if (text === null) {
    add('warn', 'provenance-doc-missing', PROVENANCE_DOC_REL, 0,
      'kernel/vendor/moonbit/PROVENANCE.md 不存在——台账 4 条 moonbit 记录的转录来源丢失。');
    return;
  }
  if (!text.includes('moon 0.1.20260427')) {
    add('warn', 'provenance-doc-version-drifted', PROVENANCE_DOC_REL, 0,
      'PROVENANCE.md 的版本钉子已变更，台账的 versionPin 需同步。');
  }
})();

// ── output ─────────────────────────────────────────────────────────────
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

console.log('check-provenance: SOURCING-001 上游来源出处台账');
console.log(`台账: ${LEDGER_REL}`);
console.log(`语义真源: ${SSOT_DOC}`);

for (const f of findings) {
  const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
  console.log(`[${tag}] ${f.id} ${f.file}:${f.line}`);
  console.log(`  ${f.message}`);
}

console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s).`);
process.exitCode = errors.length || (strictWarnings && warns.length) ? 1 : 0;
