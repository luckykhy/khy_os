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
const REQUIRED_BLOCKS = ['GOV-MOD', 'GOV-MEM', 'GOV-TOOL', 'GOV-ACP', 'GOV-API'];

// ── ACP Protocol Version ────────────────────────────────────────────────
const ACP_PROTOCOL_VERSION = '1.0';

// ── ACP Schema Validation ────────────────────────────────────────────────
const ACP_SCHEMA_PATH = 'services/backend/src/contracts/acp/acp-message.schema.json';

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
    addFinding(findings, 'GOV-MOD-004', GOVERNANCE_DOC, '治理总纲缺失，无法提供五板块规则入口。');
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

  findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.message.localeCompare(b.message));
  if (findings.length === 0) {
    console.log('治理规则检查通过：GOV-MOD-004、GOV-TOOL-004、GOV-TOOL-005 均满足。');
    return;
  }
  for (const finding of findings) {
    console.error(`[ERROR] ${finding.rule} ${finding.file}\n  ${finding.message}`);
  }
  console.error(`\nSummary: ${findings.length} governance error(s).`);
  process.exitCode = 1;
}

main();
