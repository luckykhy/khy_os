'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-rules-registry.js');
const CARD_GEN = path.join(ROOT, 'scripts', 'docs', 'gen-rules-cards.js');
const REG = 'docs/_规范/RULES-REGISTRY.json';
const CARD_GEN_REL = 'scripts/docs/gen-rules-cards.js';
const CARD_DIR = 'docs/_规范/规则卡';
const LAY = 'docs/_规范/[DESIGN-LAY-002] 目录层级与文件归类规范.md';
const DOC = 'docs/08_MGMT_项目管理/[MGMT-STD-007] 文档规则总纲.md';
const ARCH104 = 'docs/03_DESIGN_设计/[DESIGN-ARCH-104] 借鉴与实现统一规则.md';
const GOV = 'docs/03_DESIGN_设计/[DESIGN-ARCH-070] 治理总纲与可执行规则.md';
const OWNERS = 'docs/_规范/FEATURE-OWNERSHIP.json';
const dirs = [];

after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function readReg(root) {
  return JSON.parse(fs.readFileSync(path.join(root, REG), 'utf8'));
}

function makeRule(id, ssot, extra) {
  return Object.assign({
    id,
    name: id,
    domain: id.split('-').slice(0, -1).join('-'),
    nature: '约束为主',
    scope: '**',
    priority: 'P2',
    status: 'active',
    trigger: '始终',
    constraint: 'c',
    grants: '见约束边界',
    benefit: 'b',
    exception: '无',
    version: '1.0.0 (2026-09-15)',
    formerly: '无',
    ssot,
    owner: 'governance-team',
  }, extra || {});
}

function fixture(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-rules-reg-'));
  dirs.push(root);

  // 生成器按 formerly 回连治理总纲取「反例 / 校验方式」，故 fixture 必须提供该文档。
  write(root, GOV, [
    '# 治理总纲',
    '',
    '| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |',
    '|---|---|---|---|---|',
    '| GOV-TOOL-001 | 扩展一目录一 manifest | extensions/ | 两个扩展共用一个 manifest。 | `npm run check:layout` |',
    '| GOV-BORROW-004 | 能力域归属登记 | 全仓 | 两个服务各实现一份同一能力。 | 人工评审 |',
  ].join('\n'));

  // 三种真源形态各一：Markdown（HTML 注释标记）、代码（行注释标记）、数据文件。
  write(root, LAY, '# [DESIGN-LAY-002] 目录层级与文件归类规范\n\n<!-- RULES-REGISTRY: LAYOUT-001 -->\n');
  write(root, DOC, '# 文档规则总纲\n\n<!-- RULES-REGISTRY: DOCS-001 -->\n');
  write(root, ARCH104, '# [DESIGN-ARCH-104] 借鉴与实现统一规则\n\n<!-- RULES-REGISTRY: SOURCING-004 -->\n');
  write(root, 'scripts/ci/check-tool-contract.js',
    "// RULES-REGISTRY: TOOLING-001\n'use strict';\n");
  write(root, OWNERS, '{}\n');

  write(root, REG, JSON.stringify({
    meta: { version: '2.2.0' },
    rules: [
      makeRule('LAYOUT-001', LAY, { formerly: 'GOV-MOD-001' }),
      makeRule('DOCS-001', DOC, { formerly: '无' }),
      makeRule('TOOLING-001', 'scripts/ci/check-tool-contract.js', { formerly: 'GOV-TOOL-001' }),
      makeRule('SOURCING-004', `${ARCH104} §3`,
        { enforcement: OWNERS, formerly: 'GOV-BORROW-004' }),
    ],
  }, null, 2));

  // 生成器脚本本身从真实仓库复制：卡片的渲染逻辑只有一份。
  fs.mkdirSync(path.join(root, path.dirname(CARD_GEN_REL)), { recursive: true });
  fs.copyFileSync(CARD_GEN, path.join(root, CARD_GEN_REL));

  if (mutate) mutate(root);
  return root;
}

/** 在 fixture 内生成规则卡（对应真实流程 `npm run docs:rules-cards`）。 */
function genCards(root) {
  return cp.spawnSync(process.execPath, [path.join(root, CARD_GEN_REL)], {
    cwd: root,
    encoding: 'utf8',
  });
}

function run(root, args) {
  const result = cp.spawnSync(process.execPath, [SCRIPT].concat(args || []), {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KHY_RULES_REGISTRY_ROOT: root },
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

describe('check-rules-registry.js — TOOLING-007 双向可达', () => {
  test('完整 fixture 通过：登记表与真源标记行双向一致', () => {
    const root = fixture();
    genCards(root);
    const result = run(root);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /TOOLING-007/);
  });

  test('真源缺少标记行时以 TOOLING-007 失败', () => {
    const root = fixture();
    write(root, LAY, '# [DESIGN-LAY-002] 目录层级与文件归类规范\n\n正文无标记行。\n');
    genCards(root);
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /TOOLING-007/);
    assert.match(result.output, /LAYOUT-001/);
    assert.match(result.output, /断链/);
  });

  test('标记行出现未登记 ID 时以 TOOLING-007 失败（孤儿标记）', () => {
    const root = fixture();
    write(root, DOC, '# 文档规则总纲\n\n<!-- RULES-REGISTRY: DOCS-001, DOCS-009 -->\n');
    genCards(root);
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /DOCS-009/);
    assert.match(result.output, /孤儿标记/);
  });

  test('真源文件缺失时以 TOOLING-007 失败', () => {
    const root = fixture();
    fs.rmSync(path.join(root, LAY));
    genCards(root);
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /语义真源文件不存在/);
  });

  test('enforcement 指向不存在的文件时以 TOOLING-007 失败', () => {
    const root = fixture();
    fs.rmSync(path.join(root, OWNERS));
    genCards(root);
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /SOURCING-004/);
    assert.match(result.output, /enforcement 指向不存在的文件/);
  });

  test('ssot 不是文件路径时以 TOOLING-007 失败', () => {
    const root = fixture();
    const data = readReg(root);
    data.rules[0].ssot = '见治理总纲的工程规则节';
    write(root, REG, JSON.stringify(data, null, 2));
    genCards(root);
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /LAYOUT-001/);
    assert.match(result.output, /无法定位语义真源/);
  });

  test('enforcement 指向 .json 时不被误截为 .js', () => {
    // 回归：扩展名 alternation 若未按长度降序，`FEATURE-OWNERSHIP.json` 会被解析成
    // `FEATURE-OWNERSHIP.js`，进而误报「enforcement 指向不存在的文件」。
    const root = fixture();
    genCards(root);
    const result = run(root);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /FEATURE-OWNERSHIP\.js/);
  });

  test('登记表缺失时静默跳过', () => {
    const root = fixture();
    fs.rmSync(path.join(root, REG));
    const result = run(root);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /跳过/);
  });
});

describe('check-rules-registry.js — TOOLING-008 规则卡一致性', () => {
  test('生成器缺失时以 TOOLING-008 失败', () => {
    const root = fixture();
    fs.rmSync(path.join(root, CARD_GEN_REL));
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /TOOLING-008/);
    assert.match(result.output, /生成器.*不存在/);
  });

  test('规则卡缺失时以 TOOLING-008 失败', () => {
    const root = fixture();
    genCards(root);
    fs.rmSync(path.join(root, CARD_DIR, '[LAYOUT-001] LAYOUT-001.md'));
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /TOOLING-008/);
    assert.match(result.output, /LAYOUT-001/);
  });

  test('规则卡被手改时以 TOOLING-008 失败', () => {
    const root = fixture();
    genCards(root);
    const card = path.join(root, CARD_DIR, '[LAYOUT-001] LAYOUT-001.md');
    fs.appendFileSync(card, '\n<!-- 手改痕迹 -->\n');
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /TOOLING-008/);
    assert.match(result.output, /LAYOUT-001/);
  });

  test('登记新规则但未重跑生成器时以 TOOLING-008 失败', () => {
    const root = fixture();
    genCards(root);
    const data = readReg(root);
    data.rules.push(makeRule('RUNTIME-009', LAY, { formerly: '无' }));
    write(root, REG, JSON.stringify(data, null, 2));
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /TOOLING-008/);
    assert.match(result.output, /RUNTIME-009/);
  });

  test('孤儿规则卡以 TOOLING-008 失败', () => {
    const root = fixture();
    genCards(root);
    write(root, `${CARD_DIR}/[TOOLING-999] 幽灵卡.md`, '# [TOOLING-999] 幽灵卡\n\n## 约束\n\n无\n');
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /TOOLING-008/);
    assert.match(result.output, /TOOLING-999/);
    assert.match(result.output, /孤儿规则卡/);
  });

  test('--changed 模式不会崩溃（非 git 检出保守回退）', () => {
    const root = fixture();
    genCards(root);
    const result = run(root, ['--changed']);
    assert.equal(result.status, 0, result.output);
  });
});
