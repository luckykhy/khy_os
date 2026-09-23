#!/usr/bin/env node
'use strict';

// SOURCING-003 / SOURCING-006 — assert the proposal-artifact index is complete,
// and that the repository's real proposal artifacts follow the B-P2 template.
//
// SOURCING-003 (先提案后编码): the seven-field template must be fully declared
// so an artifact can be judged 齐全 / 不全.
// SOURCING-006 (决策只追加不改写): B-L2 three-step separation and B-L3 append-only
// rules must be recorded, and one-commit-three-steps must be detectable.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = process.env.RULEGUARD_REPO_ROOT || path.resolve(__dirname, '..', '..');
const INDEX_REL = 'docs/10_规范/registry/PROPOSAL-ARTIFACT-INDEX.json';
const SSOT_DOC = 'docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md';
const DECISION_LEDGER_REL = '.ai/GOVERNANCE-LEDGER.md';

const strictWarnings = process.argv.includes('--strict-warnings');
const findings = [];
const add = (severity, id, relFile, line, message) =>
  findings.push({ severity, id, file: relFile, line, message });

const read = (rel) => {
  const abs = path.join(repoRoot, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};
const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));

let index = null;
const raw = read(INDEX_REL);
if (raw === null) {
  add('error', 'index-missing', INDEX_REL, 0, '提案工件索引缺失，SOURCING-003/006 无可断言对象。');
} else {
  try {
    index = JSON.parse(raw);
  } catch (err) {
    add('error', 'index-invalid-json', INDEX_REL, 0, `索引不是合法 JSON：${err.message}`);
  }
}

if (index) {
  checkTemplate(index);
  checkRules(index);
  checkPrimaryArtifact(index);
  checkMappingSchema(index);
  checkDecisionLedger(index);
}
checkMigrationSeparation(index);

// ── SOURCING-003: the seven numbered fields must all be declared ──
function checkTemplate(idx) {
  const t = idx.proposalTemplate || {};
  const fields = Array.isArray(t.fields) ? t.fields : [];
  if (fields.length === 0) {
    add('error', 'template-empty', INDEX_REL, 0,
      'proposalTemplate.fields 为空：B-P2 模板字段定义缺失，无法判定提案是否「齐全」。');
    return;
  }
  // The doc title says 六字段 but numbers 1-7; the artifact records 7 and must
  // say so explicitly rather than silently picking one number.
  const counted = t.countDiscrepancy && t.countDiscrepancy.modeledAs;
  if (counted !== fields.length) {
    add('error', 'template-count-mismatch', INDEX_REL, 0,
      `proposalTemplate.countDiscrepancy.modeledAs=${counted} 与实际字段数 ${fields.length} 不一致。`);
  }
  if (!t.countDiscrepancy) {
    add('warn', 'template-count-discrepancy-unrecorded', INDEX_REL, 0,
      '未记录「六字段标题 vs 7 个编号项」的计数不一致——索引必须显式声明按几项建模。');
  }
  if (t.headingVerbatim && !read(SSOT_DOC).includes(t.headingVerbatim)) {
    add('error', 'template-heading-drifted', SSOT_DOC, 0,
      `B-P2 标题原文已变更：${t.headingVerbatim}`);
  }
  const nos = fields.map((f) => f.no);
  for (let i = 1; i <= fields.length; i++) {
    if (!nos.includes(i)) {
      add('error', 'template-number-gap', INDEX_REL, 0, `模板缺编号 ${i} 的字段。`);
    }
  }
  for (const f of fields) {
    for (const attr of ['no', 'key', 'labelVerbatim', 'required', 'meaningVerbatim']) {
      if (!(attr in f)) {
        add('error', 'template-attribute-missing', INDEX_REL, 0,
          `模板字段 ${f.no || '<未编号>'} 缺属性 ${attr}。`);
      }
    }
    if (f.required !== true) {
      add('error', 'template-field-optional', INDEX_REL, 0,
        `模板字段 ${f.no}「${f.labelVerbatim}」required 必须为 true——B-P2 标题为「缺一不落地」。`);
    }
    if (f.no === 5 && !Array.isArray(f.enumValues)) {
      add('error', 'template-method-enum-missing', INDEX_REL, 0,
        '模板第 5 字段「借鉴方式」缺 enumValues——B-M 判定值域不可断言。');
    }
    if (f.no === 6 && (!Array.isArray(f.subFields) || f.subFields.length < 2)) {
      add('error', 'template-subfields-missing', INDEX_REL, 0,
        '模板第 6 字段「落点与现有实现对比」必须含 a/b 两个子字段。');
    }
  }
}

// ── SOURCING-003 ordering rule + SOURCING-006 append-only rules ──
function checkRules(idx) {
  const o = idx.orderingRule || {};
  for (const key of ['id', 'coreVerbatim', 'fullVerbatim', 'assertion']) {
    if (!o[key]) add('error', 'ordering-rule-incomplete', INDEX_REL, 0, `B-P2.1 顺序规则缺字段 ${key}。`);
  }
  if (o.coreVerbatim && !/先提案.*后编码/.test(o.coreVerbatim)) {
    add('error', 'ordering-rule-text', INDEX_REL, 0, `B-P2.1 coreVerbatim 与原文「先提案、后编码」不符：${o.coreVerbatim}`);
  }
  if (o.postHocMarker === undefined) {
    add('warn', 'ordering-rule-posthoc-unrecorded', INDEX_REL, 0,
      '未记录事后补写的标记方式——B-P2.1 要求事后补写必须标记为违规，不得静默豁免。');
  }

  const m = idx.migrationSteps || {};
  const steps = Array.isArray(m.steps) ? m.steps : [];
  if (steps.length !== 3) {
    add('error', 'migration-steps-count', INDEX_REL, 0,
      `B-L2 必须登记三步迁移，实际 ${steps.length} 步。`);
  }
  for (const step of steps) {
    for (const attr of ['no', 'labelVerbatim', 'meaningVerbatim']) {
      if (!(attr in step)) add('error', 'migration-step-attribute-missing', INDEX_REL, 0,
        `B-L2 步骤 ${step.no || '<未编号>'} 缺属性 ${attr}。`);
    }
  }
  if (!m.rollbackRuleVerbatim) {
    add('error', 'migration-rollback-missing', INDEX_REL, 0,
      'B-L2 缺回滚规则原文——「不允许一次 PR 同时标记 + 迁移 + 删除」是 SOURCING-006 的核心断言依据。');
  }

  const a = idx.appendOnlyDecisions || {};
  for (const key of ['id', 'coreVerbatim', 'assertion', 'decisionRecordLocations']) {
    if (!a[key]) add('error', 'append-only-incomplete', INDEX_REL, 0, `B-L3 追加规则缺字段 ${key}。`);
  }
  if (Array.isArray(a.decisionRecordLocations) && a.decisionRecordLocations.length === 0) {
    add('error', 'append-only-no-locations', INDEX_REL, 0,
      'B-L3 decisionRecordLocations 为空——无法知道「决策记录」存在哪些文件里。');
  }
}

// ── the recorded proposal artifact must still parse as B-P2 proposals ──
function checkPrimaryArtifact(idx) {
  const p = (((idx.proposalArtifacts || {}).primary)) || {};
  if (!p.path || !exists(p.path)) {
    add('error', 'proposal-artifact-missing', INDEX_REL, 0,
      `索引登记的提案工件不存在：${p.path || '<未登记>'}`);
    return;
  }
  const lines = read(p.path).split('\n');
  const headingRe = /^###\s+【借鉴提案\s+(P-\d+)】(.*)$/;
  const headings = [];
  lines.forEach((line, i) => {
    const m = line.match(headingRe);
    if (m) headings.push({ proposalId: m[1], line: i + 1, title: m[2].trim() });
  });
  const recorded = Array.isArray(p.items) ? p.items : [];
  if (recorded.length && headings.length !== recorded.length) {
    add('error', 'proposal-count-drifted', p.path, 0,
      `文档实际含 ${headings.length} 条【借鉴提案】，索引登记 ${recorded.length} 条——索引已过时。`);
  }
  if (headings.length === 0) {
    add('warn', 'proposal-artifact-unparseable', p.path, 0,
      '文档中未找到【借鉴提案 P-NN】标题——B-P2 模板可能被改写。');
    return;
  }
  // each proposal block must declare numbered fields 1..7
  const blocks = headings.map((h, i) => {
    const end = headings[i + 1] ? headings[i + 1].line - 1 : lines.length;
    return { ...h, text: lines.slice(h.line - 1, end) };
  });
  for (const b of blocks) {
    const nums = new Set(b.text.map((l) => {
      const m = l.match(/^\s*([1-7])\.\s+/);
      return m ? Number(m[1]) : null;
    }).filter((n) => n !== null));
    const missing = [1, 2, 3, 4, 5, 6, 7].filter((n) => !nums.has(n));
    if (missing.length) {
      add('error', 'proposal-fields-incomplete', p.path, b.line,
        `${b.proposalId} 缺编号 ${missing.join('/')} 的字段——B-P2「缺一不落地」。`);
    }
  }
  // line numbers recorded in the artifact must still point at the headings
  for (const rec of recorded) {
    const actual = headings.find((h) => h.proposalId === rec.proposalId);
    if (!actual) {
      add('error', 'proposal-id-gone', p.path, 0, `索引登记的 ${rec.proposalId} 已不在文档中。`);
    } else if (actual.line !== rec.line) {
      add('warn', 'proposal-line-drifted', p.path, actual.line,
        `${rec.proposalId} 索引登记行号 ${rec.line}，实际在第 ${actual.line} 行。`);
    }
  }
}

// ── the commit↔proposal mapping schema must be declarable ──
function checkMappingSchema(idx) {
  const m = idx.commitProposalMapping || {};
  const fields = Array.isArray(m.schema && m.schema.fields) ? m.schema.fields : [];
  if (fields.length === 0) {
    add('error', 'mapping-schema-empty', INDEX_REL, 0,
      'commitProposalMapping.schema.fields 为空——提交与提案工件无法建立映射。');
    return;
  }
  for (const f of fields) {
    for (const attr of ['key', 'type', 'required']) {
      if (!(attr in f)) add('error', 'mapping-attribute-missing', INDEX_REL, 0,
        `映射字段缺属性 ${attr}（字段 ${f.key || '<未命名>'}）`);
    }
  }
  for (const core of ['commitSha', 'proposalRef']) {
    const f = fields.find((x) => x.key === core);
    if (!f) add('error', 'mapping-core-missing', INDEX_REL, 0, `映射缺核心字段 ${core}。`);
    else if (f.required !== true) add('error', 'mapping-core-optional', INDEX_REL, 0,
      `映射核心字段 ${core} 必须 required=true。`);
  }
  if (!fields.map((f) => f.key).includes('postHoc')) {
    add('warn', 'mapping-no-posthoc-flag', INDEX_REL, 0,
      '映射 schema 缺 postHoc 标记——B-P2.1 要求事后补写必须标记为违规。');
  }
  const entries = Array.isArray(m.entries) ? m.entries : [];
  if (entries.length === 0) {
    add('warn', 'mapping-empty', INDEX_REL, 0,
      `提交↔提案映射表为空${m.emptyReason ? `（原因：${m.emptyReason.slice(0, 40)}…）` : ''}——`
        + '历史映射需维护者从 git log 回填；新增能力域提交无映射时报 SOURCING-003。');
  }
}

// ── B-L3: the append-only decision ledger must still be append-only shaped ──
function checkDecisionLedger(idx) {
  const locations = (((idx.appendOnlyDecisions || {}).decisionRecordLocations)) || [];
  const ledger = locations.find((l) => typeof l === 'string' && l.includes('GOVERNANCE-LEDGER.md'));
  if (!ledger || !exists(DECISION_LEDGER_REL)) return;
  const lines = read(DECISION_LEDGER_REL).split('\n').filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l));
  const dates = lines.map((l) => (l.match(/\d{4}-\d{2}-\d{2}/) || [])[0]);
  let prev = null;
  for (const d of dates) {
    if (prev && d < prev) {
      add('error', 'ledger-out-of-order', DECISION_LEDGER_REL, 0,
        `决策台账出现日期回退（${prev} → ${d}）——B-L3 只允许追加，不得原地改写历史。`);
      break;
    }
    prev = d;
  }
}

// ── SOURCING-006: detect one commit doing all three B-L2 steps ──
function checkMigrationSeparation(idx) {
  const m = idx.migrationSteps || {};
  if (!m.assertion) {
    add('warn', 'migration-assertion-missing', INDEX_REL, 0,
      'B-L2 未登记 assertion——一次提交同时做三步无法断言。');
    return;
  }
  let log;
  try {
    log = execSync('git log --oneline -50 --name-only', { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  } catch (_) {
    return;
  }
  const commits = log.split('\n\n').filter((c) => c.includes('\n'));
  let suspicious = 0;
  for (const block of commits) {
    const sha = block.split('\n')[0].slice(0, 7);
    const files = block.split('\n').slice(1).filter(Boolean);
    const marked = files.some((f) => /deprecated|obsolete|legacy/i.test(f));
    const removed = files.some((f) => /delete|remove|cleanup/i.test(f));
    const touched = files.filter((f) => /service|routes|tools/.test(f));
    // 标记 + 删除 + 大量调用方改动集中在一次提交 => 疑似 B-L2 三步合一
    if (marked && removed && touched.length >= 2) {
      suspicious += 1;
      add('warn', 'migration-steps-combined', 'git:' + sha, 0,
        `提交 ${sha} 同时触及标记/删除/调用方三类改动（${touched.length} 个调用方文件）——`
          + 'B-L2 要求每步独立可回滚，不得一次 PR 同时标记 + 迁移 + 删除。');
    }
  }
  if (suspicious === 0) {
    console.log(`  B-L2 三步分离：最近 ${commits.length} 个提交中未发现「标记+迁移+删除」合一。`);
  }
}

// ── output ─────────────────────────────────────────────────────────────
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

console.log('check-proposal-index: SOURCING-003/006 提案工件索引');
console.log(`索引: ${INDEX_REL}`);
console.log(`语义真源: ${SSOT_DOC}`);

for (const f of findings) {
  const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
  console.log(`[${tag}] ${f.id} ${f.file}:${f.line}`);
  console.log(`  ${f.message}`);
}

console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s).`);
process.exitCode = errors.length || (strictWarnings && warns.length) ? 1 : 0;
