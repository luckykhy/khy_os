#!/usr/bin/env node
'use strict';

/**
 * check-protocol-naming.js — 协议命名守卫（A2A vs ACP）。
 *
 * 解决的问题：仓库里有两个都被称为「A2A」的东西 —— 标准 Agent2Agent 协议，
 * 与 khy-os 自有的**进程内 ACP 方言**。历史上：
 *   - 文档把后者逐字写成「A2A 协议规范」；
 *   - 其方法名用的是一套形如 `a2a.<域>.<动作>` 的虚构集合，在实现中**零存在**
 *     （实测全仓只出现在文档里），属设计草案遗留、从未落地；
 *   - 传输层被写成 WebSocket（标准 A2A 用 SSE，明确不是 WebSocket）。
 * 外部读者据此对接必然失败。本守卫把 [DESIGN-NAM-002] 的命名纪律变成机器检查。
 *
 * 本文件自己也遵守 NAM-A2A-1：docstring 里只写模式占位形式，不写具体错误方法名 ——
 * 否则守卫会（应当）举报它自己。
 *
 * 规则（真源 scripts/ci/protocol-naming.json）：
 *   R1 forbidden-method   禁止 a2a.<域>.<动作> 方法名（除带豁免标记的文件）
 *   R2 env-prefix         禁止出现白名单之外的新 KHY_A2A_* 环境变量
 *   R3 contract-purity    contracts/a2a/** 禁止出现私有 ACP 方法名与私有状态名
 *   R4 doc-qualifier      描述私有方言的文档，标题/首段必须有「私有」或「进程内」
 *   R5 acp-methods-sync   acpTransport.ACP_METHODS 与 acp-message.schema.json 的 enum 必须一致
 *
 * 豁免机制：文件前 40 行内出现 `naming-guard: exempt <理由>`。
 * 仅允许用于「记录历史错误命名」的场合 —— 不允许用它继续描述一套不存在的 API。
 * 豁免会被**打印出来**，使豁免可见、可审计。
 *
 * 用法：
 *   node scripts/ci/check-protocol-naming.js
 *   node scripts/ci/check-protocol-naming.js --json
 *   KHY_PROTOCOL_NAMING_ROOT=/path/to/repo node scripts/ci/check-protocol-naming.js
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.KHY_PROTOCOL_NAMING_ROOT
  ? path.resolve(process.env.KHY_PROTOCOL_NAMING_ROOT)
  : path.resolve(__dirname, '..', '..');

const CONFIG_PATH = path.join(__dirname, 'protocol-naming.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const cfg = loadConfig();
const SKIP_DIRS = new Set(cfg.skipDirs || []);
const SCAN_EXTS = new Set(cfg.scanExtensions || []);
const EXEMPT_MARKER = String(cfg.exemptMarker || 'naming-guard: exempt');
const EXEMPT_MAX_LINE = Number(cfg.exemptMarkerMaxLine || 40);

const METHOD_RE = new RegExp(cfg.forbiddenMethodPattern, 'g');
const ENV_RE = new RegExp(`\\b${cfg.envPrefix}[A-Z0-9_]+\\b`, 'g');

const findings = [];
const exemptions = [];
let scanned = 0;

function rel(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

// 守卫自身与它的配置**必须**排除在豁免检测之外 —— 这两个文件里天然含有
// `naming-guard: exempt` 这个字面量（它们在定义这个标记），若不排除就会自我豁免，
// 等于守卫对自己失效。
const SELF_PATHS = new Set([
  'scripts/ci/check-protocol-naming.js',
  'scripts/ci/protocol-naming.json',
]);

// 规则真源载体豁免（配置化）。SELF_PATHS 是「不许自我豁免」，这里是反面：
// 规则的 JSON / JS 载体语法上写不了 `naming-guard: exempt` 标记（JSON 无注释），
// 但它们与规则卡文档一样必须引用被禁名称才能定义「什么算违规」。不登记就是
// 「规则无法描述自己」—— 与守卫把示例当违规是同一类误报，按 A4 应修判据而非改规则。
const DEFINITION_CARRIER_EXEMPT = new Map(
  (cfg.definitionCarrierExempt || []).map((entry) => [
    String((entry && entry.file) || '').replace(/\\/g, '/'),
    String((entry && entry.reason) || ''),
  ]),
);

function isExempt(relPath) {
  if (SELF_PATHS.has(relPath)) return null;
  if (DEFINITION_CARRIER_EXEMPT.has(relPath)) return DEFINITION_CARRIER_EXEMPT.get(relPath);
  let raw;
  try {
    raw = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  } catch {
    return null;
  }
  const head = raw.split(/\r?\n/).slice(0, EXEMPT_MAX_LINE).join('\n');
  if (!head.includes(EXEMPT_MARKER)) return null;
  // 抽取理由：标记之后到行尾
  const line = head.split(/\r?\n/).find((l) => l.includes(EXEMPT_MARKER)) || '';
  const reason = line.slice(line.indexOf(EXEMPT_MARKER) + EXEMPT_MARKER.length).replace(/-->|\*\//g, '').trim();
  return reason;
}

function addFinding(rule, level, file, line, message) {
  findings.push({ rule, level, file, line, message });
}

// ── 遍历 ──────────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile() && SCAN_EXTS.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/** 逐行扫描，返回 {line, text}。 */
function linesOf(abs) {
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  return raw.split(/\r?\n/);
}

// ── R1 / R2 ───────────────────────────────────────────────────────────────
const allowedEnv = new Set(cfg.a2aEnvAllowlist || []);
// 私有 ACP 历史误用 KHY_A2A_ 前缀的环境变量：允许存在，但**禁止新增**。
// 它们被单独统计并打印，使这笔「待重命名的债」始终可见，而不是被白名单悄悄掩盖。
const legacyEnv = new Set(cfg.acpLegacyEnv || []);
const seenLegacyEnv = new Set();

function scanFile(abs) {
  const relPath = rel(abs);
  scanned++;
  const exemptReason = isExempt(relPath);
  if (exemptReason !== null) {
    exemptions.push({ file: relPath, reason: exemptReason || '(未写理由)' });
    if (!exemptReason) {
      addFinding('R1-exempt-reason', 'error', relPath, 1,
        '豁免标记缺少理由 —— 豁免必须说明「为什么这里必须保留错误命名」。');
    }
  }
  const lines = linesOf(abs);
  lines.forEach((text, i) => {
    if (exemptReason === null) {
      METHOD_RE.lastIndex = 0;
      const m = METHOD_RE.exec(text);
      if (m) {
        addFinding('R1-forbidden-method', 'error', relPath, i + 1,
          `出现 ${cfg.forbiddenMethodHint} 命中: ${m[0]}`);
      }
      ENV_RE.lastIndex = 0;
      let e;
      while ((e = ENV_RE.exec(text)) !== null) {
        if (allowedEnv.has(e[0])) continue;
        if (legacyEnv.has(e[0])) {
          seenLegacyEnv.add(e[0]);
          continue;
        }
        addFinding('R2-env-prefix', 'error', relPath, i + 1,
          `${e[0]} 既不在 KHY_A2A_* 白名单内，也不在 ACP 遗留名单内。`
          + `私有 ACP 的新增环境变量请用 ${cfg.acpEnvPrefix}*；`
          + '若确属标准 A2A，请把它登记进 scripts/ci/protocol-naming.json 的 a2aEnvAllowlist。');
      }
    }
  });
}

// ── R3 契约纯净性 ─────────────────────────────────────────────────────────
function checkContractPurity() {
  const dir = path.join(REPO_ROOT, cfg.contractsA2aDir);
  if (!fs.existsSync(dir)) {
    addFinding('R3-contract-purity', 'error', cfg.contractsA2aDir, 1, '契约目录不存在。');
    return;
  }
  for (const abs of walk(dir)) {
    const relPath = rel(abs);
    const lines = linesOf(abs);
    lines.forEach((text, i) => {
      for (const method of cfg.privateAcpMethods || []) {
        if (text.includes(method)) {
          addFinding('R3-contract-purity', 'error', relPath, i + 1,
            `标准 A2A 契约中出现私有 ACP 方法名 "${method}"（NAM-A2A-5）。`);
        }
      }
      for (const state of cfg.privateTaskStates || []) {
        // 只查 status/enum 语境，避免误伤普通英文单词（如 pending 作注释）
        if (new RegExp(`["']${state}["']`).test(text)) {
          addFinding('R3-contract-purity', 'error', relPath, i + 1,
            `标准 A2A 契约中出现私有 ACP 状态名 "${state}"（NAM-A2A-5）；标准 TaskState 见 task.schema.json。`);
        }
      }
    });
  }
}

// ── R4 文档限定词 ─────────────────────────────────────────────────────────
function checkDocQualifier() {
  const qualifiers = cfg.privateDialectQualifiers || [];
  const docsDir = path.join(REPO_ROOT, 'docs');
  if (!fs.existsSync(docsDir)) return;
  for (const abs of walk(docsDir)) {
    if (path.extname(abs).toLowerCase() !== '.md') continue;
    const name = path.basename(abs);
    const isPrivateDialectDoc = (cfg.privateDialectDocs || []).some((p) => name.includes(p));
    if (!isPrivateDialectDoc) continue;
    const relPath = rel(abs);
    const head = linesOf(abs).slice(0, 40).join('\n');
    if (!qualifiers.some((q) => head.includes(q))) {
      addFinding('R4-doc-qualifier', 'warning', relPath, 1,
        `描述私有 ACP 方言的文档，标题/首段必须出现「${qualifiers.join('」或「')}」限定词（NAM-A2A-3），`
        + '否则读者会把它当成标准 A2A。');
    }
  }
}

// ── R5 ACP 方法集一致性 ───────────────────────────────────────────────────
function checkAcpMethodsSync() {
  const transportAbs = path.join(REPO_ROOT, cfg.acpTransportFile);
  const schemaAbs = path.join(REPO_ROOT, cfg.acpSchemaFile);
  if (!fs.existsSync(transportAbs) || !fs.existsSync(schemaAbs)) {
    addFinding('R5-acp-methods-sync', 'warning', cfg.acpTransportFile, 1,
      '找不到 acpTransport.js 或 acp-message.schema.json，跳过方法集一致性检查。');
    return;
  }
  const src = fs.readFileSync(transportAbs, 'utf8');
  const block = src.split('const ACP_METHODS')[1];
  // 方法名可能是点分（agent.spawn）也可能是裸词（heartbeat）——
  // 早期版本只匹配带点的形式，于是把 heartbeat 漏掉，报出「仅 schema 有 heartbeat」
  // 的假漂移。这里两种形式都收。
  const codeMethods = block
    ? [...block.slice(0, block.indexOf('});')).matchAll(/['"]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)['"]/g)]
      .map((m) => m[1])
    : [];
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaAbs, 'utf8'));
  } catch (e) {
    addFinding('R5-acp-methods-sync', 'error', cfg.acpSchemaFile, 1, `schema 解析失败: ${e.message}`);
    return;
  }
  const enumVals = (((schema.properties || {}).method || {}).enum) || [];
  const a = [...new Set(codeMethods)].sort();
  const b = [...new Set(enumVals)].sort();
  if (a.length === 0 || b.length === 0) {
    addFinding('R5-acp-methods-sync', 'warning', cfg.acpSchemaFile, 1,
      '未能解析出方法集（代码或 schema 为空），请人工核对。');
    return;
  }
  const onlyCode = a.filter((x) => !b.includes(x));
  const onlySchema = b.filter((x) => !a.includes(x));
  if (onlyCode.length || onlySchema.length) {
    addFinding('R5-acp-methods-sync', 'error', cfg.acpTransportFile, 1,
      `ACP 方法集漂移：仅代码有 ${JSON.stringify(onlyCode)}，仅 schema 有 ${JSON.stringify(onlySchema)}。`
      + '二者是同一份契约的两种表达，必须逐字一致。');
  }
}

// ── main ──────────────────────────────────────────────────────────────────
const files = walk(REPO_ROOT);
for (const abs of files) scanFile(abs);
checkContractPurity();
checkDocQualifier();
checkAcpMethodsSync();

const errors = findings.filter((f) => f.level === 'error');
const warnings = findings.filter((f) => f.level === 'warning');
const isJson = process.argv.includes('--json');

if (isJson) {
  console.log(JSON.stringify({
    schema: 'khy.protocol-naming/v1',
    scanned,
    errors: errors.length,
    warnings: warnings.length,
    exemptions: exemptions.length,
    legacyAcpEnv: [...seenLegacyEnv].sort(),
    findings,
    exemptFiles: exemptions,
  }, null, 2));
} else {
  console.log('协议命名守卫（A2A vs ACP）');
  console.log('='.repeat(72));
  console.log(`扫描文件 ${scanned} 个`);
  if (exemptions.length) {
    console.log(`\n豁免文件 ${exemptions.length} 个（需人工确认理由正当）：`);
    for (const e of exemptions) console.log(`  - ${e.file}  ⟵ ${e.reason}`);
  }
  if (seenLegacyEnv.size) {
    console.log(`\n私有 ACP 遗留 env ${seenLegacyEnv.size} 个（仍用 KHY_A2A_ 前缀，待 P2 重命名为 ${cfg.acpEnvPrefix}*）：`);
    console.log(`  ${[...seenLegacyEnv].sort().join(', ')}`);
  }
  if (findings.length === 0) {
    console.log('\n无违规。✓');
  } else {
    for (const f of findings) {
      console.log(`\n[${f.level === 'error' ? 'FAIL' : 'WARN'}] ${f.rule}  ${f.file}:${f.line}`);
      console.log(`        ${f.message}`);
    }
  }
  console.log('\n' + '='.repeat(72));
  console.log(`结果: ${errors.length} error, ${warnings.length} warning, ${exemptions.length} exempt, ${seenLegacyEnv.size} legacy-env`);
}

process.exit(errors.length > 0 ? 1 : 0);
