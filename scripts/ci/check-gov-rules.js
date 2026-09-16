#!/usr/bin/env node
/**
 * 治理总纲的可机械判定条款守卫。
 *
 * 本脚本只检查治理入口的静态连通性，不替代 check-repo-layout.js、
 * check-agent-rules.js 等既有规则的业务判定。
 *
 * Usage: node scripts/ci/check-gov-rules.js
 * Fixture root: KHY_GOV_RULES_ROOT=/path/to/repo node scripts/ci/check-gov-rules.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = process.env.KHY_GOV_RULES_ROOT
  ? path.resolve(process.env.KHY_GOV_RULES_ROOT)
  : path.resolve(__dirname, '..', '..');
const GOVERNANCE_DOC = 'docs/03_DESIGN_设计/[DESIGN-ARCH-070] 治理总纲与可执行规则.md';
const GOVERNANCE_SCRIPT = 'scripts/ci/check-gov-rules.js';
// 十个板块，与元规则 [MGMT-STD-008] §3 十大域一一对应：
//   MOD↔LAYOUT  MEM↔MEMORY  TOOL↔TOOLING  ACP↔COMMS  API↔API
//   BORROW↔SOURCING  RUNTIME↔RUNTIME  PROCESS↔PROCESS  SECURITY↔SECURITY  DOCS↔DOCS
const REQUIRED_BLOCKS = [
  'GOV-MOD', 'GOV-MEM', 'GOV-TOOL', 'GOV-ACP', 'GOV-API', 'GOV-BORROW',
  'GOV-RUNTIME', 'GOV-PROCESS', 'GOV-SECURITY', 'GOV-DOCS',
];

// ── ACP Protocol Version ────────────────────────────────────────────────
const ACP_PROTOCOL_VERSION = '1.0';

// ── ACP Schema Validation ────────────────────────────────────────────────
const ACP_SCHEMA_PATH = 'services/backend/src/contracts/acp/acp-message.schema.json';

// ── Rules Registry Validation (MGMT-STD-008) ─────────────────────────────
// 规则单一真源登记表：docs/_规范/RULES-REGISTRY.json。
// 该检查对「文件缺失」容忍（外部 fixture / 尚未启用登记表的仓库直接跳过），
// 只在校验「存在」的登记表时介入，避免破坏既有 check-gov-rules.test.js。
const RULES_REGISTRY = 'docs/_规范/RULES-REGISTRY.json';
const RULE_DOMAINS = ['LAYOUT', 'RUNTIME', 'COMMS', 'API', 'TOOLING', 'MEMORY', 'SOURCING', 'PROCESS', 'DOCS', 'SECURITY'];
const RULE_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const RULE_STATUSES = ['draft', 'active', 'deprecated', 'archived'];
const RULE_REQUIRED_FIELDS = [
  'id', 'name', 'domain', 'nature', 'scope', 'priority', 'status',
  'trigger', 'constraint', 'grants', 'benefit', 'version', 'ssot', 'owner',
];
// grants 取值若命中这些标记，视为「未授予新权力」（纯约束型规则的合法写法）。
const NO_NEW_POWER_MARKERS = ['无新增权力', '见约束边界', '无'];

/**
 * 校验规则登记表（GOV-TOOL-006）。
 * 文件缺失时静默跳过；存在时校验：字段完整性（含 nature/grants/benefit）、
 * ID 唯一性、domain/priority/status 枚举合法、三元性质标签、权力-约束配对铁律、
 * 同 domain 同名职责重叠预警。
 */
function checkRulesRegistry(findings) {
  const text = readText(RULES_REGISTRY);
  if (text === null) return; // absent-file-tolerant：无登记表则不校验

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, `JSON 解析失败：${error.message}`);
    return;
  }

  const rules = Array.isArray(data && data.rules) ? data.rules : [];
  if (rules.length === 0) {
    addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, 'rules 为空：登记表必须至少登记元规则 MGMT-STD-008。');
    return;
  }

  const seenIds = new Map();
  const nameKeys = new Map();

  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') {
      addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, '存在非对象规则条目。');
      continue;
    }
    const where = `id=${rule.id || '(缺失)'}`;

    // 必填字段完整性（含三元字段 nature/grants/benefit）
    for (const field of RULE_REQUIRED_FIELDS) {
      const val = rule[field];
      if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
        addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, `${where} 缺少必填字段 ${field}。`);
      }
    }

    // 字段名对齐元规则 [MGMT-STD-008] §1.1：曾用标识字段名必须是 formerly。
    if ('formerId' in rule) {
      addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY,
        `${where} 字段名 formerId 应改为 formerly（元规则 §1.1 统一字段名）。`);
    }

    // ID 格式：<DOMAIN>-<NNN>，DOMAIN 自身可含连字符，末段为 3 位数字
    if (typeof rule.id === 'string' && rule.id && !/^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}$/.test(rule.id)) {
      addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, `${where} ID 格式应为 <DOMAIN>-<NNN>（如 MGMT-STD-008）。`);
    }

    // ID 全局唯一
    if (rule.id) {
      if (seenIds.has(rule.id)) {
        addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, `ID ${rule.id} 重复（与 ${seenIds.get(rule.id)} 冲突），违反全局唯一。`);
      } else {
        seenIds.set(rule.id, where);
      }
    }

    // domain 枚举
    if (typeof rule.domain === 'string' && rule.domain && !RULE_DOMAINS.includes(rule.domain)) {
      addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, `${where} domain ${rule.domain} 不在十大域 ${RULE_DOMAINS.join('/')}。`);
    }

    // priority 枚举
    if (typeof rule.priority === 'string' && rule.priority && !RULE_PRIORITIES.includes(rule.priority)) {
      addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, `${where} priority ${rule.priority} 必须是 P0/P1/P2/P3。`);
    }

    // status 枚举
    if (typeof rule.status === 'string' && rule.status && !RULE_STATUSES.includes(rule.status)) {
      addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, `${where} status ${rule.status} 必须是 draft/active/deprecated/archived。`);
    }

    // 三元性质标签：必须标注约束/权力/福利 之一
    if (typeof rule.nature === 'string' && rule.nature && !/[约束权力福利]/.test(rule.nature)) {
      addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, `${where} nature 必须标注三元性质之一（约束/权力/福利）。`);
    }

    // 配对铁律：含「权力」性质或授予了新权力，必须有约束边界（scope/constraint 非空）
    const grants = typeof rule.grants === 'string' ? rule.grants.trim() : '';
    const hasNewPower = (typeof rule.nature === 'string' && rule.nature.includes('权力')) ||
      (grants && !NO_NEW_POWER_MARKERS.some((marker) => grants.includes(marker)));
    if (hasNewPower) {
      const scope = typeof rule.scope === 'string' ? rule.scope.trim() : '';
      const constraint = typeof rule.constraint === 'string' ? rule.constraint.trim() : '';
      if (!scope || !constraint) {
        addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, `${where} 含有权力但缺少约束边界（scope/constraint 必须非空，落实配对铁律）。`);
      }
    }

    // 同 domain 同名 => 疑似职责重叠 / 重复（呼应 §3.2 单一职责）
    if (rule.domain && rule.name) {
      const key = `${rule.domain}|${String(rule.name).trim()}`;
      if (nameKeys.has(key)) {
        addFinding(findings, 'GOV-TOOL-006', RULES_REGISTRY, `规则 ${rule.id} 与 ${nameKeys.get(key)} 同 domain 同名（${key}），疑似职责重叠/重复。`);
      } else {
        nameKeys.set(key, rule.id);
      }
    }
  }
}

function readText(relPath) {
  const abs = path.join(repoRoot, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function addFinding(findings, rule, file, message) {
  findings.push({ rule, file, message });
}

function checkGovernanceDocument(findings) {
  const text = readText(GOVERNANCE_DOC);
  if (text === null) {
    addFinding(findings, 'GOV-MOD-004', GOVERNANCE_DOC, '治理总纲缺失，无法提供六板块规则入口。');
    return;
  }
  for (const block of REQUIRED_BLOCKS) {
    const heading = new RegExp(`^##\\s+(?:\\d+\\.\\s+)?${block}(?:\\s|—|$)`, 'm');
    if (!heading.test(text)) {
      addFinding(findings, 'GOV-MOD-004', GOVERNANCE_DOC, `治理总纲缺少 ${block} 板块。`);
    }
  }
}

function scriptTargets(command) {
  return [...String(command).matchAll(/(?:node|python(?:3)?)\s+((?:scripts\/ci)\/[\w./-]+\.(?:js|mjs|cjs|py))/g)]
    .map((match) => match[1]);
}

function checkRegisteredTargets(findings, packageJson) {
  for (const [name, command] of Object.entries(packageJson.scripts || {})) {
    if (!name.startsWith('check:')) continue;
    for (const target of scriptTargets(command)) {
      if (!fs.existsSync(path.join(repoRoot, target))) {
        addFinding(findings, 'GOV-TOOL-004', 'package.json', `检查入口 ${name} 指向不存在的脚本 ${target}。`);
      }
    }
  }
}

function checkGovernanceRegistration(findings, packageJson) {
  const scripts = packageJson.scripts || {};
  if (scripts['check:gov-rules'] !== `node ${GOVERNANCE_SCRIPT}`) {
    addFinding(findings, 'GOV-TOOL-005', 'package.json', 'check:gov-rules 必须精确指向 scripts/ci/check-gov-rules.js。');
  }
  if (!String(scripts['check:structure'] || '').includes('npm run check:gov-rules')) {
    addFinding(findings, 'GOV-TOOL-005', 'package.json', 'check:structure 必须调用 check:gov-rules。');
  }
  const workflow = readText('.github/workflows/pr-gate.yml');
  if (workflow === null || !workflow.includes(`node ${GOVERNANCE_SCRIPT}`)) {
    addFinding(findings, 'GOV-TOOL-005', '.github/workflows/pr-gate.yml', 'PR gate 必须显式执行治理规则检查。');
  }
}

/**
 * Check ACP protocol compliance.
 * Verifies that acpTransport.js exports the required protocol functions
 * with trace/deadline/version metadata support (GOV-ACP-001, GOV-ACP-003).
 */
function checkAcpProtocolCompliance(findings) {
  const transportPath = path.join(repoRoot, 'services', 'backend', 'src', 'services', 'acpTransport.js');
  if (!fs.existsSync(transportPath)) {
    return; // acpTransport.js not found, skip
  }
  
  const source = fs.readFileSync(transportPath, 'utf8');
  
  // Check for meta field support in createRequest/createResponse/createErrorResponse
  const hasMetaSupport = /\bcreateRequest\s*\([^)]*meta/.test(source) &&
                         /\bcreateResponse\s*\([^)]*meta/.test(source) &&
                         /\bcreateErrorResponse\s*\([^)]*meta/.test(source);
  if (!hasMetaSupport) {
    addFinding(findings, 'GOV-ACP-003', 'acpTransport.js',
      'ACP 消息构造函数必须支持 meta 字段（trace/deadline/version）。');
  }
  
  // Check for trace ID generation
  const hasTraceId = /generateTraceId|crypto\.randomBytes/.test(source);
  if (!hasTraceId) {
    addFinding(findings, 'GOV-ACP-003', 'acpTransport.js',
      'ACP 必须生成可传播的 trace ID。');
  }
  
  // Check for deadline support
  const hasDeadline = /createDeadline|deadline/.test(source);
  if (!hasDeadline) {
    addFinding(findings, 'GOV-ACP-003', 'acpTransport.js',
      'ACP 必须支持请求 deadline。');
  }
  
  // Check for protocol version constant
  const hasProtocolVersion = /ACP_PROTOCOL_VERSION|protocol.*version/i.test(source);
  if (!hasProtocolVersion) {
    addFinding(findings, 'GOV-ACP-004', 'acpTransport.js',
      'ACP 必须声明协议版本常量。');
  }
}

function main() {
  const findings = [];
  const packageText = readText('package.json');
  let packageJson;
  try {
    packageJson = packageText === null ? null : JSON.parse(packageText);
  } catch (error) {
    console.error(`[ERROR] GOV-TOOL-004 package.json\n  package.json 不是有效 JSON：${error.message}`);
    process.exitCode = 1;
    return;
  }

  checkGovernanceDocument(findings);
  checkAcpProtocolCompliance(findings);
  if (packageJson === null) {
    addFinding(findings, 'GOV-TOOL-004', 'package.json', '缺少根 package.json，无法验证检查入口。');
  } else {
    checkRegisteredTargets(findings, packageJson);
    checkGovernanceRegistration(findings, packageJson);
  }
  checkRulesRegistry(findings);

  findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.message.localeCompare(b.message));
  if (findings.length === 0) {
    console.log(`治理规则检查通过：GOV-MOD-004（${REQUIRED_BLOCKS.length} 板块）、GOV-TOOL-004、GOV-TOOL-005、GOV-TOOL-006（规则登记表）均满足。`);
    return;
  }
  for (const finding of findings) {
    console.error(`[ERROR] ${finding.rule} ${finding.file}\n  ${finding.message}`);
  }
  console.error(`\nSummary: ${findings.length} governance error(s).`);
  process.exitCode = 1;
}

main();
