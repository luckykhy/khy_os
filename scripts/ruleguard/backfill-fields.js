#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * backfill-fields.js — fill the [DESIGN-ARCH-111] fields into the registry.
 *
 * Adds `gate`, `exec` and `paths` to every rule so the binding layer can
 * derive gate membership. Idempotent by design: a field that is already set
 * is never overwritten, so this can be re-run after hand edits without
 * clobbering them. Run:
 *
 *   node scripts/ruleguard/backfill-fields.js            # preview diff only
 *   node scripts/ruleguard/backfill-fields.js --write    # apply
 *
 * The mapping table below is the auditable decision record: each entry says
 * which checker carries the rule, which of that checker's finding ids belong
 * to it, and where the rule applies. `null` exec means "no machine executor"
 * and requires a `manual` gate plus an `exception` justification.
 */

const ROOT = path.resolve(process.argv.includes('--write') ? process.cwd() : process.cwd());
const WRITE = process.argv.includes('--write');
const REGISTRY_REL = path.join('docs', '10_规范', 'registry', 'RULES-REGISTRY.json');

// LAYOUT-002's checker lives outside scripts/ci; ruleguard tracks it because
// a rule declares it, not because of its directory.
const ARB = 'services/backend/scripts/archDebtScan.js';

const MAPPING = {
  'LAYOUT-001': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-repo-layout.js', args: [], findings: ['root-whitelist', 'layer-registry', 'docs-index-first', 'docs-index-complete'] },
    paths: ['kernel/**', 'platform/**', 'services/**', 'apps/**', 'software/**', 'extensions/**', 'tools/**', 'scripts/**', 'packaging/**', 'docs/**'],
  },
  'LAYOUT-002': {
    gate: 'pr',
    exec: { script: ARB, args: ['--changed'], findings: ['god-file'] },
    paths: ['services/**', 'platform/**', 'apps/**', 'software/**', 'kernel/**', 'tools/**'],
  },
  'LAYOUT-003': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-gov-rules.js', args: [], findings: [], anchors: ['checkRegisteredTargets'] },
    paths: ['package.json'],
  },
  'RUNTIME-001': {
    gate: 'commit',
    exec: { script: 'scripts/ci/check-agent-rules.js', args: ['--changed'], findings: ['no-hardcoded-endpoint', 'no-hardcoded-prod-domain', 'no-hardcoded-abs-path'] },
    paths: ['services/**', 'apps/**', 'platform/**', 'software/**', 'kernel/**', 'tools/**', 'scripts/**'],
  },
  'RUNTIME-002': {
    gate: 'commit',
    exec: { script: 'scripts/ci/check-agent-rules.js', args: ['--changed'], findings: ['no-opaque-status'] },
    paths: ['services/**', 'apps/**', 'platform/**', 'software/**', 'kernel/**', 'tools/**', 'scripts/**'],
  },
  'RUNTIME-003': {
    gate: 'commit',
    exec: { script: 'scripts/ci/check-agent-rules.js', args: ['--changed'], findings: ['no-hard-timeout-kill', 'timeout-needs-progress-awareness', 'no-unbounded-loop'] },
    paths: ['services/**', 'apps/**', 'platform/**', 'software/**', 'kernel/**', 'tools/**', 'scripts/**'],
  },
  'RUNTIME-004': {
    gate: 'commit',
    exec: { script: 'scripts/ci/check-agent-rules.js', args: ['--changed'], findings: ['no-scroll-region'] },
    paths: ['services/backend/src/cli/**', 'services/backend/bin/**'],
  },
  'COMMS-001': {
    gate: 'pr',
    exec: { script: 'scripts/ci/validate-protocol-contracts.js', args: [], findings: [] },
    paths: ['services/backend/src/contracts/**', 'services/backend/src/services/acpTransport.js', 'scripts/ci/json-schemas/**'],
  },
  'COMMS-002': {
    gate: 'pr',
    exec: { script: 'scripts/ci/validate-json-schemas.js', args: [], findings: [] },
    paths: ['scripts/ci/json-schemas/**', 'services/backend/src/contracts/**'],
  },
  'COMMS-003': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-gov-rules.js', args: [], findings: [], anchors: ['checkAcpProtocolCompliance'] },
    paths: ['services/backend/src/**'],
  },
  'COMMS-004': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-protocol-conformance.js', args: [], findings: [] },
    paths: ['services/backend/src/services/**', 'services/backend/src/routes/**'],
  },
  'API-001': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-api-contracts.js', args: [], findings: ['API-001'] },
    paths: ['services/backend/src/routes/**', 'services/backend/src/services/**'],
  },
  'API-002': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-api-contracts.js', args: [], findings: ['API-002'] },
    paths: ['services/backend/src/routes/**', 'services/backend/src/services/**'],
  },
  'API-003': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-api-contracts.js', args: [], findings: ['API-003'] },
    paths: ['services/backend/src/routes/**', 'services/backend/src/services/**'],
  },
  'API-004': {
    gate: 'advisory',
    exec: { script: 'scripts/ci/check-api-contracts.js', args: [], findings: [] },
    paths: ['services/backend/src/routes/**', 'services/backend/src/services/**'],
  },
  'TOOLING-001': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-repo-layout.js', args: [], findings: ['extension-contract', 'extension-id-hardcode', 'extension-path-drift'] },
    paths: ['extensions/**'],
  },
  'TOOLING-002': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-tool-contract.js', args: ['--changed'], findings: [] },
    paths: ['extensions/**', 'tools/**'],
  },
  'TOOLING-003': {
    gate: 'advisory',
    exec: { script: 'scripts/ci/check-lifecycle-policy.js', args: [], findings: [] },
    paths: ['extensions/**', 'tools/**'],
  },
  'TOOLING-004': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-gov-rules.js', args: [], findings: [], anchors: ['checkRegisteredTargets'] },
    paths: ['package.json', 'scripts/ci/**'],
  },
  'TOOLING-005': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-wiring.js', args: [], findings: [] },
    paths: ['package.json', '.github/workflows/**', '.githooks/**', 'scripts/**'],
  },
  'TOOLING-006': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-gov-rules.js', args: [], findings: [], anchors: ['checkRulesRegistry'] },
    paths: ['docs/10_规范/registry/RULES-REGISTRY.json', 'docs/10_规范/rules-registry.json'],
  },
  'TOOLING-007': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-rules-registry.js', args: ['--changed'], findings: [] },
    paths: ['docs/10_规范/**', 'docs/03_DESIGN_设计/**', 'docs/08_MGMT_项目管理/**'],
  },
  'TOOLING-008': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-rules-registry.js', args: [], findings: [], anchors: [], carriers: ['scripts/docs/gen-rules-cards.js'] },
    paths: ['docs/10_规范/**'],
  },
  'PROCESS-002': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-version-sync.js', args: [], findings: [] },
    paths: ['pyproject.toml', 'package.json', 'packaging/**', 'services/backend/package.json', 'services/ai-backend/package.json', 'platform/packages/**/package.json', 'apps/ai-frontend/package.json', 'software/khyquant/frontend/package.json'],
  },
  'PROCESS-003': {
    gate: 'manual',
    exec: { script: null, carriers: ['services/backend/src/cli/handlers/goal.js', 'services/backend/src/services/goalModeService.js'] },
    paths: ['services/backend/src/services/goalModeService.js', 'services/backend/src/cli/handlers/goal.js'],
  },
  'SECURITY-001': {
    gate: 'commit',
    exec: { script: 'scripts/ci/check-change-safety.js', args: ['--changed'], findings: [] },
    paths: ['services/**', 'platform/**', 'apps/**', 'software/**', 'packaging/**'],
  },
  'SECURITY-002': {
    gate: 'manual',
    exec: { script: null, carriers: ['services/backend/src/services/riskGate.js'] },
    paths: ['services/backend/src/services/riskGate.js', 'services/backend/src/services/**'],
  },
  'SECURITY-003': {
    gate: 'manual',
    exec: { script: null, carriers: ['services/backend/src/services/weakModelChangeGuard.js'] },
    paths: ['services/backend/src/services/weakModelChangeGuard.js'],
  },
  'SECURITY-004': {
    gate: 'manual',
    exec: { script: null, carriers: ['services/backend/src/permissions/rules.js'] },
    paths: ['services/backend/src/permissions/**'],
  },
  'SOURCING-005': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-duplication.js', args: ['--changed', '--gate'], findings: [] },
    paths: ['services/**', 'platform/**', 'apps/**', 'software/**', 'tools/**'],
  },
  'DOCS-001': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-repo-layout.js', args: [], findings: ['docs-index-first', 'docs-index-complete'] },
    paths: ['docs/**'],
  },
  'DOCS-002': {
    gate: 'advisory',
    exec: { script: 'scripts/ci/check-repo-layout.js', args: [], findings: ['docs-index-first'] },
    paths: ['docs/**'],
  },
  'MGMT-STD-008': {
    gate: 'pr',
    exec: { script: 'scripts/ci/check-gov-rules.js', args: [], findings: [], anchors: ['checkRulesRegistry'] },
    paths: ['docs/10_规范/**', 'docs/08_MGMT_项目管理/**'],
  },
};

// Rules with no machine executor at all: gate=manual plus a written reason.
// `exception` is required by check-gov-rules-style schema validation, so each
// entry states why a checker is impossible rather than leaving it silent.
const MANUAL = {
  'LAYOUT-003': null, // mapped above
  'MEMORY-001': '记忆分档由调用方语义决定，机械上无法判定一条记录"应当"落在 session 还是 persistent；由 [DESIGN-MEM-006] 冻结的入口契约与评审兜底。',
  'MEMORY-002': 'persistent 记录要素属内容质量约定，无确定性判定信号；靠 .ai/CONTEXT 生成与评审兜底。',
  'MEMORY-003': '指定读写入口已冻结于 [DESIGN-MEM-006]，但"是否走了指定入口"需跨调用图分析，超出静态守卫能力；评审兜底。',
  'MEMORY-004': 'session 生命周期清除依赖运行时行为，静态扫描无法判定；由 sessionWatchdog.js 与测试兜底。',
  'SOURCING-001': '上游源码是否"复制"需与上游仓库逐文件比对，且需人读 LICENSE 文本判定归属；CODEOWNERS 与 PR 评审兜底。',
  'SOURCING-002': '许可证分级硬门槛依赖人工核对上游 LICENSE 与分级表；自动判级会误判宽松/非宽松许可证的语义差异。',
  'SOURCING-003': '六字段提案是流程约定，产物在指挥部仓库而非本仓库；机械上无法在本机校验。',
  'SOURCING-004': 'FEATURE-OWNERSHIP.json 登记表已就位，守卫 check:feature-ownership 尚未落地（[DESIGN-SOURCING-001] §6 B-G1/B-G2 分阶段建设项）。',
  'SOURCING-006': '"只追加不改写"需对比历史版本判断语义改写，静态守卫只能看单快照；评审兜底。',
  'PROCESS-001': '分支纪律属人机协作约定：机械上无法区分"用户授权的提交"与"擅自提交"，误判会阻断正常协作；由 khy 的确认对话框与审计轨迹兜底。',
  'PROCESS-101': '贡献者规则提案权是流程权利，无可判定的机器信号；靠 CONTRIBUTING.md 与评审兜底。',
};

function resolveRegistryFile() {
  for (const candidate of ['rules-registry.json', 'RULES-REGISTRY.json']) {
    const rel = path.join('docs', '10_规范', 'registry', candidate);
    if (fs.existsSync(path.join(ROOT, rel))) return rel;
  }
  throw new Error('找不到规则登记表（docs/10_规范/rules-registry.json）');
}

function main() {
  const rel = resolveRegistryFile();
  const abs = path.join(ROOT, rel);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));

  const changed = [];
  const skipped = [];

  for (const rule of data.rules || []) {
    const spec = MAPPING[rule.id];
    if (!spec) {
      if (MANUAL[rule.id]) {
        applyManual(rule, MANUAL[rule.id]);
        changed.push(rule.id);
      }
      continue;
    }

    if (!rule.gate) { rule.gate = spec.gate; changed.push(`${rule.id}+gate`); } else { skipped.push(`${rule.id} gate`); }
    if (!rule.paths) { rule.paths = spec.paths; changed.push(`${rule.id}+paths`); } else { skipped.push(`${rule.id} paths`); }

    if (spec.exec && spec.exec.script) {
      if (!rule.exec) { rule.exec = structuredClone(spec.exec); changed.push(`${rule.id}+exec`); }
      else { skipped.push(`${rule.id} exec`); }
    } else if (spec.exec && !rule.exec) {
      // Carriers only: record them, keep the legacy free-text enforcement.
      // `script` is omitted rather than null so the schema can distinguish
      // "no checker" from "typo'd checker path".
      rule.exec = { carriers: spec.exec.carriers || [], args: [], findings: [], anchors: [] };
      changed.push(`${rule.id}+carriers`);
    }
  }

  if (!WRITE) {
    console.log(`待补登 ${changed.length} 项（预览，未写入）：`);
    for (const item of changed) console.log(`  ${item}`);
    if (skipped.length) {
      console.log(`已有字段，跳过 ${skipped.length} 项：${skipped.join(', ')}`);
    }
    return;
  }

  fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${rel}：补登 ${changed.length} 项`);
  for (const item of changed) console.log(`  ${item}`);
}

/** gate=manual requires a written justification; assert the pair stays intact. */
function applyManual(rule, reason) {
  if (!rule.gate) { rule.gate = 'manual'; }
  if (!rule.exception || !String(rule.exception).trim()) {
    rule.exception = reason;
  }
  if (!rule.paths) rule.paths = [];
}

main();
