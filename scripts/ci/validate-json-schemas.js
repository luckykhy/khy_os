#!/usr/bin/env node
'use strict';

/**
 * validate-json-schemas.js — 校验 .khy/ 下 JSON 文件是否符合协议 schema。
 *
 * 用法:
 *   node scripts/ci/validate-json-schemas.js              # 校验全部 .khy/ JSON
 *   node scripts/ci/validate-json-schemas.js --strict     # 未知字段也报错
 *   node scripts/ci/validate-json-schemas.js --path <rel> # 校验单文件
 *
 * 需要 `ajv` 库: npm install ajv (devDependency).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMAS_DIR = path.join(ROOT, 'scripts', 'ci', 'json-schemas');

// 本执行器是 COMMS-002（gate=pr）的门，只应对**入仓内容**下判定。
// .khy/ 是运行期状态且被 .gitignore 整体覆盖（实测 `git ls-files .khy` = 0 条），
// 拿它当 pr 门的输入等于让「会话垃圾」决定 PR 能否合并：本地红、CI 恒绿，两头失真。
// 因此这里显式跳过被忽略的扫描根，并把真空转打印出来，而不是假装它有效。
function isGitIgnored(relPath) {
  const r = spawnSync('git', ['check-ignore', '-q', relPath], { cwd: ROOT, stdio: 'ignore' });
  if (r.error) return false; // 非 git 检出：退回原行为，不静默改变判定
  return r.status === 0;
}

// ── Schema file mapping (order matters — first match wins) ───────────────────
const PATTERN_MAP = [
  { pattern: /^arena-.*\.json$/,              schema: 'arena-session.schema.json' },
  { pattern: /^RCPT-.*\.json$/,               schema: 'receipt.schema.json' },
  { pattern: /^integrity_manifest\.json$/,    schema: 'integrity-manifest.schema.json' },
  { pattern: /.*/,                            schema: 'runtime-config.schema.json' },
];

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const singlePath = (() => {
  const i = args.indexOf('--path');
  return i !== -1 ? args[i + 1] : null;
})();

// ── Load schemas ─────────────────────────────────────────────────────────────
let Ajv;
try {
  Ajv = require('ajv');
} catch {
  console.error('[json-schema] ajv 未安装 — 运行: npm install ajv');
  process.exit(2);
}
const ajv = new Ajv({ allErrors: true, strict: strict });
const schemas = {};
for (const f of fs.readdirSync(SCHEMAS_DIR).filter(f => f.endsWith('.json'))) {
  const raw = fs.readFileSync(path.join(SCHEMAS_DIR, f), 'utf-8');
  schemas[f] = JSON.parse(raw);
  ajv.addSchema(schemas[f], f);
}

function resolveSchema(filePath) {
  const basename = path.basename(filePath);
  for (const rule of PATTERN_MAP) {
    if (rule.pattern.test(basename)) {
      return rule.schema;
    }
  }
  return 'runtime-config.schema.json';
}

function validate(filePath, relPath) {
  if (!fs.existsSync(filePath)) {
    console.error(`  [SKIP] 文件不存在: ${relPath}`);
    return true;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return true;

  // Skip empty files
  if (stat.size === 0) {
    console.warn(`  [WARN] 空文件: ${relPath}`);
    return true;
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error(`  [FAIL] JSON 解析错误: ${relPath}: ${e.message}`);
    return false;
  }

  // Must be object or array (per protocol)
  if (typeof doc !== 'object' || doc === null) {
    console.error(`  [FAIL] ${relPath}: 顶层必须是 Object 或 Array（实际: ${typeof doc}）`);
    return false;
  }

  const schemaFile = resolveSchema(filePath);
  const validate = ajv.getSchema(schemaFile);
  if (!validate) {
    console.error(`  [FAIL] Schema 未加载: ${schemaFile}`);
    return false;
  }
  const valid = validate(doc);
  if (valid) {
    console.log(`  [OK] ${relPath}`);
    return true;
  }
  for (const err of validate.errors) {
    console.error(`  [FAIL] ${relPath}: ${err.instancePath || '/'} ${err.message}`);
  }
  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  let files = [];

  if (singlePath) {
    const abs = path.resolve(ROOT, singlePath);
    files = [abs];
  } else {
    // Walk .khy/ for JSON files (skip node_modules, .git, etc.)
    const khyDir = path.join(ROOT, '.khy');
    if (!fs.existsSync(khyDir)) {
      console.warn('[json-schema] .khy/ 不存在，跳过校验');
      return 0;
    }
    if (isGitIgnored('.khy')) {
      console.warn('[json-schema] .khy/ 被 .gitignore 覆盖（入仓文件 0 个）— 运行期状态不由 pr 门判定，跳过。');
      console.warn('[json-schema] 注意：COMMS-002 登记的 paths 是 scripts/ci/json-schemas/** 与 services/backend/src/contracts/**，与本执行器实际扫描范围不一致，属待修缺陷。');
      return 0;
    }
    function walk(dir) {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          if (entry === 'node_modules' || entry.startsWith('.')) continue;
          walk(full);
        } else if (entry.endsWith('.json')) {
          files.push(full);
        }
      }
    }
    walk(khyDir);
    files.sort();
  }

  if (files.length === 0) {
    console.log('[json-schema] 无 JSON 文件需要校验');
    return 0;
  }

  let passed = 0, failed = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (validate(f, rel)) passed++; else failed++;
  }

  console.log(`\n[json-schema] 校验完成: ${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

process.exit(main());
