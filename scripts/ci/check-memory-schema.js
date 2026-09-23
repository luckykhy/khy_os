#!/usr/bin/env node
'use strict';

// MEMORY-002 / MEMORY-003 — assert the memory-record schema artifact is complete
// and that the repository's actual memory write seam is registered.
//
// The schema constrains the WRITER CONTRACT (five fields a writer must supply),
// not the shape of records already on disk: .khy/memory/ holds Markdown prose, so
// this checker must not fail the whole repo for that. See the artifact's
// observed.recordShapeNote.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = process.env.RULEGUARD_REPO_ROOT || path.resolve(__dirname, '..', '..');
const SCHEMA_REL = 'docs/10_规范/registry/MEMORY-RECORD-SCHEMA.json';
const DESIGN_REL = 'docs/10_规范/DESIGN-MEM/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md';
const SEAM_REL = 'services/backend/src/memdir/memdir.js';

const strictWarnings = process.argv.includes('--strict-warnings');
const findings = [];
const add = (severity, id, relFile, line, message) =>
  findings.push({ severity, id, file: relFile, line, message });

const read = (rel) => {
  const abs = path.join(repoRoot, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};

let schema = null;
const schemaText = read(SCHEMA_REL);
if (schemaText === null) {
  add('error', 'schema-missing', SCHEMA_REL, 0, '记忆记录 schema 真源工件缺失，MEMORY-002/003 无可断言对象。');
} else {
  try {
    schema = JSON.parse(schemaText);
  } catch (err) {
    add('error', 'schema-invalid-json', SCHEMA_REL, 0, `schema 工件不是合法 JSON：${err.message}`);
  }
}

if (schema) {
  checkSchemaIntegrity(schema);
  checkDesignatedEntries(schema);
}

checkSeamRegistration(schema);
checkSsotAlignment(schema);

// ── MEMORY-002: five fields, each with name / type / constraints / required ──
function checkSchemaIntegrity(s) {
  const keys = Array.isArray(s.fiveElements) ? s.fiveElements.map((e) => e.key) : [];
  const expected = ['subject', 'source', 'writtenAt', 'scope', 'cleanup'];

  for (const wanted of expected) {
    if (!keys.includes(wanted)) {
      add('error', 'field-missing', SCHEMA_REL, lineOfField(s, expected, wanted),
        `五要素缺「${wanted}」。DESIGN-MEM-006 §2 要求落盘必带五字段，缺一不得写。`);
    }
  }
  for (const key of keys) {
    if (!expected.includes(key)) {
      add('warn', 'field-undeclared', SCHEMA_REL, lineOfField(s, expected, key),
        `五要素多出未声明字段「${key}」——DESIGN-MEM-006 §2 只列了 ${expected.length} 个字段。`);
    }
  }

  if (Array.isArray(s.fiveElements)) {
    for (const el of s.fiveElements) {
      for (const attr of ['key', 'type', 'required', 'constraints']) {
        if (!(attr in el)) {
          add('error', 'field-attribute-missing', SCHEMA_REL, lineOfField(s, ['key'], el.key),
            `五要素「${el.key || '<未命名>'}」缺属性 ${attr}——字段名/类型/取值约束/必填性四项缺一不可。`);
        }
      }
      if (el.required !== true) {
        add('error', 'field-not-required', SCHEMA_REL, lineOfField(s, ['key'], el.key),
          `五要素「${el.key}」required 必须为 true（DESIGN-MEM-006 §2：缺一不得写）。`);
      }
      if (el.type !== 'string') {
        add('warn', 'field-type-unexpected', SCHEMA_REL, lineOfField(s, ['key'], el.key),
          `五要素「${el.key}」type 为 ${JSON.stringify(el.type)}；原文未声明类型，本台账统一形式化为 string。`);
      }
    }
  }

  // recordIntegrity 必须把「缺一不得写」固化为可断言开关
  if (!s.recordIntegrity || s.recordIntegrity.allFiveRequired !== true) {
    add('error', 'integrity-flag', SCHEMA_REL, 0,
      'recordIntegrity.allFiveRequired 必须为 true，否则「缺一不得写」不可断言。');
  }
  // 凭据策略：五要素不得承载凭据值
  const cp = s.credentialPolicy || {};
  if (!Array.isArray(cp.credentialTokens) || cp.credentialTokens.length === 0) {
    add('error', 'credential-policy-empty', SCHEMA_REL, 0,
      'credentialPolicy.credentialTokens 为空：DESIGN-MEM-006 §2 要求凭据只引用存放位置、不复制值。');
  }
  if (!Array.isArray(cp.appliesToFields) || cp.appliesToFields.length === 0) {
    add('error', 'credential-policy-unscoped', SCHEMA_REL, 0,
      'credentialPolicy.appliesToFields 为空：未说明凭据校验作用于哪些字段。');
  }
}

// ── MEMORY-003: designated entries must be registered, with carrier evidence ──
function checkDesignatedEntries(s) {
  const entries = Array.isArray(s.designatedEntries) ? s.designatedEntries : [];
  if (entries.length === 0) {
    add('error', 'no-designated-entry', SCHEMA_REL, 0,
      'designatedEntries 为空：MEMORY-003 要求「先在本表加行登记，再动码」，空表等于无入口。');
    return;
  }
  const seen = new Set();
  for (const e of entries) {
    for (const attr of ['id', 'storage', 'entry']) {
      if (!e[attr]) {
        add('error', 'entry-attribute-missing', SCHEMA_REL, 0,
          `指定入口缺属性 ${attr}（条目 ${e.id || '<未命名>'}）。`);
      }
    }
    if (seen.has(e.id)) add('error', 'entry-duplicate', SCHEMA_REL, 0, `指定入口 id 重复：${e.id}`);
    seen.add(e.id);

    // 已实现条目必须给出可核实的载体
    if (e.implemented === true) {
      if (!e.carrier && !e.entryKind) {
        add('warn', 'entry-no-carrier', SCHEMA_REL, 0,
          `指定入口「${e.id}」标记 implemented=true 但未给 carrier/entryKind，无法核实。`);
      }
      if (e.carrier && !path.isAbsolute(e.carrier) && !read(e.carrier)) {
        add('error', 'entry-carrier-missing', SCHEMA_REL, 0,
          `指定入口「${e.id}」的载体 ${e.carrier} 不存在。`);
      }
    }
    // 未实现条目必须诚实标注原因
    if (e.implemented === false && !e.notImplementedReason) {
      add('warn', 'entry-unimplemented-unexplained', SCHEMA_REL, 0,
        `指定入口「${e.id}」标记 implemented=false 但未说明原因（设计文档 §6 守卫计划仍待工具化）。`);
    }
  }
}

// ── The real write seam must be registered as a designated entry ──
function checkSeamRegistration(s) {
  if (!read(SEAM_REL)) {
    add('error', 'seam-missing', SEAM_REL, 0, '实测记忆写入单点 memdir.js 不存在，schema 工件的 observed 段已过时。');
    return;
  }
  const seam = s && s.observed && s.observed.canonicalWriteSeam;
  if (!seam || seam.file !== SEAM_REL) {
    add('warn', 'seam-not-recorded', SCHEMA_REL, 0,
      '实测写入单点 services/backend/src/memdir/memdir.js 未记入 observed.canonicalWriteSeam。');
    return;
  }
  const registered = Array.isArray(s.designatedEntries) &&
    s.designatedEntries.some((e) => e.carrier === SEAM_REL);
  if (!registered) {
    add('warn', 'seam-unregistered', SCHEMA_REL, 0,
      'memdir.js 是实测唯一的记忆写入 seam，但未登记为 designatedEntries 条目——' +
      'DESIGN-MEM-006 §3 要求「新增记忆持久化模块：先在本表加行登记，再动码」。');
  }
  // 已知绕过点必须如实登记，不得静默
  const bypass = s.observed.bypassWrites;
  if (Array.isArray(bypass)) {
    for (const b of bypass) {
      const text = read(b.file);
      if (text === null) {
        add('error', 'bypass-record-stale', SCHEMA_REL, 0, `登记的绕过点 ${b.file} 不存在。`);
        continue;
      }
      const lines = text.split('\n');
      const hits = (b.lines || []).filter((ln) =>
        /^\s*fs\.(writeFileSync|appendFileSync|unlinkSync)/.test(lines[ln - 1] || ''));
      if (b.lines.length && hits.length === 0) {
        add('error', 'bypass-lines-drifted', SCHEMA_REL, 0,
          `${b.file} 登记的裸写行号 [${b.lines.join(',')}] 已漂移，无一命中 fs.(write|append|unlink)Sync。`);
      } else {
        add('warn', 'seam-bypass-write', b.file, b.lines[0] || 0,
          `绕过 memdir._safeWriteFileSync 裸写：${b.what || '直接 fs.writeFileSync'}`);
      }
    }
  }
}

// ── The five field names must still appear in the design doc ──
function checkSsotAlignment(s) {
  const doc = read(DESIGN_REL);
  if (doc === null) {
    add('error', 'ssot-missing', DESIGN_REL, 0, '语义真源文档不存在，schema 失去对照基准。');
    return;
  }
  const yamlBlock = doc.match(/```yaml([\s\S]*?)```/) || ['', ''];
  for (const key of ['subject', 'source', 'writtenAt', 'scope', 'cleanup']) {
    if (!new RegExp(`^${key}\\s*:`, 'm').test(yamlBlock[1])) {
      add('error', 'ssot-field-drifted', DESIGN_REL, 0,
        `五要素「${key}」已不在 DESIGN-MEM-006 §2 的 yaml 块中——文档与 schema 分叉。`);
    }
  }
  // git 可用性自检：本脚本不依赖 git，但留一条可追溯的登记日
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoRoot, stdio: 'pipe' });
  } catch (_) {
    add('warn', 'not-a-git-repo', SCHEMA_REL, 0, '当前不在 git 工作树内，登记日的可追溯性无法核实。');
  }
}

function lineOfField(s, group, key) {
  const arr = s.fiveElements || [];
  const idx = arr.findIndex((e) => e.key === key);
  if (idx >= 0) {
    const blob = JSON.stringify(arr.slice(0, idx + 1));
    return Math.max(1, blob.split('\n').length);
  }
  return 1;
}

// ── output ─────────────────────────────────────────────────────────────
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

console.log('check-memory-schema: MEMORY-002/003 记忆记录 schema 与指定入口');
console.log(`真源工件: ${SCHEMA_REL}`);
console.log(`语义真源: ${DESIGN_REL}`);

for (const f of findings) {
  const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
  console.log(`[${tag}] ${f.id} ${f.file}:${f.line}`);
  console.log(`  ${f.message}`);
}

console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s).`);
process.exitCode = errors.length || (strictWarnings && warns.length) ? 1 : 0;
