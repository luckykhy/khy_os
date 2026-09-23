'use strict';

/**
 * 三个新检查器的测试（消费四份机器可读真源工件）。
 *
 * check-memory-schema / check-provenance / check-proposal-index 此前的共同缺口是
 * 「无可断言对象」而非「检查器坏了」，因此测试重点是：检查器必须真的去读工件并
 * 对它的内容做断言——把工件删掉、把字段删掉、把行号漂移，都要有对应报错，而不是
 * 一律绿灯。真仓库的 smoke 测试只验证接线，不验证规则逻辑。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CHECKERS = {
  memory: path.join(ROOT, 'scripts', 'ci', 'check-memory-schema.js'),
  provenance: path.join(ROOT, 'scripts', 'ci', 'check-provenance.js'),
  proposal: path.join(ROOT, 'scripts', 'ci', 'check-proposal-index.js'),
};

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruleguard-artifact-'));
  tempDirs.push(dir);
  return dir;
}

function write(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return relPath;
}

function run(checker, root) {
  const r = cp.spawnSync(process.execPath, [checker], {
    cwd: root,
    env: { ...process.env, RULEGUARD_REPO_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

// ── minimal-but-complete fixtures ────────────────────────────────────────
const MEM_SCHEMA = {
  fiveElements: [
    { key: 'subject', required: true, type: 'string', constraints: {} },
    { key: 'source', required: true, type: 'string', constraints: {} },
    { key: 'writtenAt', required: true, type: 'string', constraints: {} },
    { key: 'scope', required: true, type: 'string', constraints: {} },
    { key: 'cleanup', required: true, type: 'string', constraints: {} },
  ],
  recordIntegrity: { allFiveRequired: true },
  credentialPolicy: { credentialTokens: ['api', 'key', 'token'], appliesToFields: ['source'] },
  designatedEntries: [
    { id: 'e1', storage: '.ai/', entry: 'khy metadata gen', implemented: true, carrier: 'carrier.js' }
  ],
  observed: { canonicalWriteSeam: { file: 'seam.js' }, bypassWrites: [] },
};

const PROV_LEDGER = {
  provenanceModel: {
    fields: [
      { key: 'source', required: true, type: 'string' },
      { key: 'localPath', required: true, type: 'string' },
      { key: 'relationship', required: true, type: 'string' },
    ]
  },
  relationshipEnum: { values: ['idea', 'reference', 'adapter', 'vendored', 'fork'] },
  ledger: [
    { source: 'up@1.0', localPath: 'a.js', relationship: 'reference' }
  ],
  observedVendorDirs: { dirs: [{ path: 'v/', state: 'empty' }] },
  knownGaps: [],
};

const PROP_INDEX = {
  proposalTemplate: {
    countDiscrepancy: { modeledAs: 7 },
    fields: [1, 2, 3, 4, 5, 6, 7].map((no) => ({
      no, key: `f${no}`, labelVerbatim: `L${no}`, required: true, meaningVerbatim: `M${no}`,
      ...(no === 5 ? { enumValues: ['idea'] } : null),
      ...(no === 6 ? { subFields: [{}, {}] } : null),
    })).filter(Boolean)
  },
  orderingRule: { id: 'B-P2.1', coreVerbatim: '先提案、后编码', fullVerbatim: 'x', assertion: 'a', postHocMarker: 'm' },
  migrationSteps: {
    steps: [1, 2, 3].map((no) => ({ no, labelVerbatim: `S${no}`, meaningVerbatim: `M${no}` })),
    rollbackRuleVerbatim: '不允许一次 PR 同时标记 + 迁移 + 删除',
    assertion: 'a'
  },
  appendOnlyDecisions: {
    id: 'B-L3', coreVerbatim: 'c', assertion: 'a',
    decisionRecordLocations: ['docs/x.md']
  },
  proposalArtifacts: { primary: { path: 'prop.md', items: [] } },
  commitProposalMapping: {
    schema: {
      fields: [
        { key: 'commitSha', type: 'string', required: true },
        { key: 'proposalRef', type: 'string', required: true },
        { key: 'postHoc', type: 'boolean', required: false }
      ]
    },
    entries: [],
    emptyReason: '首次登记'
  }
};

describe('check-memory-schema', () => {
  test('完整工件 → 无 error', () => {
    const root = fixture();
    write(root, 'docs/10_规范/registry/MEMORY-RECORD-SCHEMA.json', JSON.stringify(MEM_SCHEMA));
    write(root, 'docs/10_规范/DESIGN-MEM/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md',
      '```yaml\nsubject: a\nsource: b\nwrittenAt: c\nscope: d\ncleanup: e\n```');
    write(root, 'carrier.js', '// carrier');
    write(root, 'services/backend/src/memdir/memdir.js', '// seam');
    const r = run(CHECKERS.memory, root);
    const errors = (r.out.match(/^\[ERROR\]/gm) || []).length;
    assert.equal(errors, 0, r.out);
  });

  test('删掉一个五要素 → field-missing', () => {
    const root = fixture();
    const bad = JSON.parse(JSON.stringify(MEM_SCHEMA));
    bad.fiveElements = bad.fiveElements.filter((e) => e.key !== 'scope');
    write(root, 'docs/10_规范/registry/MEMORY-RECORD-SCHEMA.json', JSON.stringify(bad));
    write(root, 'docs/10_规范/DESIGN-MEM/[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md', '');
    const r = run(CHECKERS.memory, root);
    assert.match(r.out, /field-missing/);
    assert.match(r.out, /「scope」/);
  });

  test('五要素缺 constraints → field-attribute-missing', () => {
    const root = fixture();
    const bad = JSON.parse(JSON.stringify(MEM_SCHEMA));
    delete bad.fiveElements[0].constraints;
    write(root, 'docs/10_规范/registry/MEMORY-RECORD-SCHEMA.json', JSON.stringify(bad));
    const r = run(CHECKERS.memory, root);
    assert.match(r.out, /field-attribute-missing/);
  });

  test('凭据策略清空 → credential-policy-empty', () => {
    const root = fixture();
    const bad = JSON.parse(JSON.stringify(MEM_SCHEMA));
    bad.credentialPolicy = { credentialTokens: [], appliesToFields: [] };
    write(root, 'docs/10_规范/registry/MEMORY-RECORD-SCHEMA.json', JSON.stringify(bad));
    const r = run(CHECKERS.memory, root);
    assert.match(r.out, /credential-policy-empty/);
  });

  test('工件缺失 → schema-missing 且退出非零', () => {
    const root = fixture();
    const r = run(CHECKERS.memory, root);
    assert.match(r.out, /schema-missing/);
    assert.notEqual(r.code, 0);
  });
});

describe('check-provenance', () => {
  test('完整工件 → 无 error', () => {
    const root = fixture();
    write(root, 'docs/10_规范/registry/SOURCING-PROVENANCE.json', JSON.stringify(PROV_LEDGER));
    write(root, 'docs/10_规范/registry/FEATURE-OWNERSHIP.json', JSON.stringify({ capabilities: [] }));
    write(root, 'a.js', '// a');
    write(root, 'v/.keep', '');
    const r = run(CHECKERS.provenance, root);
    const errors = (r.out.match(/^\[ERROR\]/gm) || []).length;
    assert.equal(errors, 0, r.out);
  });

  test('核心字段设为非必填 → core-field-optional', () => {
    const root = fixture();
    const bad = JSON.parse(JSON.stringify(PROV_LEDGER));
    bad.provenanceModel.fields.find((f) => f.key === 'localPath').required = false;
    write(root, 'docs/10_规范/registry/SOURCING-PROVENANCE.json', JSON.stringify(bad));
    const r = run(CHECKERS.provenance, root);
    assert.match(r.out, /core-field-optional/);
  });

  test('台账记录的本地路径不存在 → row-path-missing', () => {
    const root = fixture();
    write(root, 'docs/10_规范/registry/SOURCING-PROVENANCE.json', JSON.stringify(PROV_LEDGER));
    write(root, 'docs/10_规范/registry/FEATURE-OWNERSHIP.json', JSON.stringify({ capabilities: [] }));
    const r = run(CHECKERS.provenance, root);
    assert.match(r.out, /row-path-missing/);
    assert.match(r.out, /a\.js/);
  });

  test('relationship 不在枚举内 → row-relationship-unknown', () => {
    const root = fixture();
    const bad = JSON.parse(JSON.stringify(PROV_LEDGER));
    bad.ledger[0].relationship = 'copied';
    write(root, 'docs/10_规范/registry/SOURCING-PROVENANCE.json', JSON.stringify(bad));
    write(root, 'docs/10_规范/registry/FEATURE-OWNERSHIP.json', JSON.stringify({ capabilities: [] }));
    write(root, 'a.js', '');
    const r = run(CHECKERS.provenance, root);
    assert.match(r.out, /row-relationship-unknown/);
  });

  test('vendored 缺 license/approvedBy → 两条 error', () => {
    const root = fixture();
    const bad = JSON.parse(JSON.stringify(PROV_LEDGER));
    bad.ledger[0].relationship = 'vendored';
    write(root, 'docs/10_规范/registry/SOURCING-PROVENANCE.json', JSON.stringify(bad));
    write(root, 'docs/10_规范/registry/FEATURE-OWNERSHIP.json', JSON.stringify({ capabilities: [] }));
    write(root, 'a.js', '');
    const r = run(CHECKERS.provenance, root);
    assert.match(r.out, /row-no-license/);
    assert.match(r.out, /row-no-approval/);
    // vendored 未在 FEATURE-OWNERSHIP 登记 → B-M1 第 6 条
    assert.match(r.out, /vendored-not-cross-registered/);
  });
});

describe('check-proposal-index', () => {
  test('完整工件 → 无 error', () => {
    const root = fixture();
    write(root, 'docs/10_规范/registry/PROPOSAL-ARTIFACT-INDEX.json', JSON.stringify(PROP_INDEX));
    write(root, 'docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md',
      '### B-P2 借鉴提案（六字段模板，缺一不落地）');
    write(root, 'prop.md', '# 空提案文档\n');
    const r = run(CHECKERS.proposal, root);
    const errors = (r.out.match(/^\[ERROR\]/gm) || []).length;
    assert.equal(errors, 0, r.out);
  });

  test('模板少一个编号字段 → template-number-gap', () => {
    const root = fixture();
    const bad = JSON.parse(JSON.stringify(PROP_INDEX));
    bad.proposalTemplate.fields = bad.proposalTemplate.fields.filter((f) => f.no !== 3);
    bad.proposalTemplate.countDiscrepancy.modeledAs = 6;
    write(root, 'docs/10_规范/registry/PROPOSAL-ARTIFACT-INDEX.json', JSON.stringify(bad));
    const r = run(CHECKERS.proposal, root);
    assert.match(r.out, /template-number-gap/);
    assert.match(r.out, /编号 3/);
  });

  test('真实提案工件缺字段 → proposal-fields-incomplete', () => {
    const root = fixture();
    const idx = JSON.parse(JSON.stringify(PROP_INDEX));
    idx.proposalArtifacts.primary.items = [{ proposalId: 'P-01', line: 3, title: 't' }];
    write(root, 'docs/10_规范/registry/PROPOSAL-ARTIFACT-INDEX.json', JSON.stringify(idx));
    // 只写 1-4 与 6-7，缺第 5 字段
    write(root, 'prop.md',
      '# doc\n\n### 【借鉴提案 P-01】主题\n\n1. 借鉴对象：x\n2. 借鉴内容：x\n3. 解决的问题：x\n4. 许可证与代码性质：x\n6. 落点与现有实现对比：x\n7. 验收方式：x\n');
    const r = run(CHECKERS.proposal, root);
    assert.match(r.out, /proposal-fields-incomplete/);
    assert.match(r.out, /P-01/);
    assert.match(r.out, /缺编号 5/);
  });

  test('提案数量漂移 → proposal-count-drifted', () => {
    const root = fixture();
    const idx = JSON.parse(JSON.stringify(PROP_INDEX));
    idx.proposalArtifacts.primary.items = [{ proposalId: 'P-01', line: 3 }];
    write(root, 'docs/10_规范/registry/PROPOSAL-ARTIFACT-INDEX.json', JSON.stringify(idx));
    write(root, 'prop.md', '### 【借鉴提案 P-01】a\n1. x\n2. x\n3. x\n4. x\n5. x\n6. x\n7. x\n\n### 【借鉴提案 P-02】b\n1. x\n2. x\n3. x\n4. x\n5. x\n6. x\n7. x\n');
    const r = run(CHECKERS.proposal, root);
    assert.match(r.out, /proposal-count-drifted/);
  });

  test('B-L3 决策台账日期回退 → ledger-out-of-order', () => {
    const root = fixture();
    const idx = JSON.parse(JSON.stringify(PROP_INDEX));
    idx.appendOnlyDecisions.decisionRecordLocations = ['.ai/GOVERNANCE-LEDGER.md'];
    write(root, 'docs/10_规范/registry/PROPOSAL-ARTIFACT-INDEX.json', JSON.stringify(idx));
    write(root, '.ai/GOVERNANCE-LEDGER.md',
      '| 2026-09-10 | B | 动作 → 目标 → 进度 |\n| 2026-08-01 | A | 动作 → 目标 → 进度 |\n');
    const r = run(CHECKERS.proposal, root);
    assert.match(r.out, /ledger-out-of-order/);
  });
});

describe('真仓库 smoke（接线验证）', () => {
  for (const [name, checker] of Object.entries(CHECKERS)) {
    test(`${name} 在真仓库可运行且不误报 error`, () => {
      const r = run(checker, ROOT);
      const errors = (r.out.match(/^\[ERROR\]/gm) || []).length;
      assert.equal(errors, 0, r.out);
    });
  }
});
