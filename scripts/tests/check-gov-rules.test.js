'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-gov-rules.js');
const DOC = 'docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md';
const dirs = [];

after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function fixture(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gov-'));
  dirs.push(root);
  write(root, 'scripts/ci/check-gov-rules.js', '// fixture target\n');
  write(root, DOC, [
    '# 治理总纲',
    '## GOV-MOD',
    '## GOV-MEM',
    '## GOV-TOOL',
    '## GOV-ACP',
    '## GOV-API',
    '## GOV-BORROW',
    '## GOV-RUNTIME',
    '## GOV-PROCESS',
    '## GOV-SECURITY',
    '## GOV-DOCS',
  ].join('\n'));
  write(root, 'package.json', JSON.stringify({ scripts: {
    'check:gov-rules': 'node scripts/ci/check-gov-rules.js',
    'check:structure': 'npm run check:gov-rules',
  } }, null, 2));
  write(root, '.github/workflows/pr-gate.yml', 'run: node scripts/ci/check-gov-rules.js\n');
  if (mutate) mutate(root);
  return root;
}

function run(root) {
  const result = cp.spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KHY_GOV_RULES_ROOT: root },
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

describe('check-gov-rules', () => {
  test('完整 fixture 通过', () => {
    const result = run(fixture());
    assert.equal(result.status, 0, result.output);
  });

  test('缺少治理板块时以 GOV-MOD-004 失败', () => {
    const root = fixture((dir) => write(dir, DOC, '# 治理总纲\n## GOV-MOD\n'));
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /GOV-MOD-004/);
    assert.match(result.output, /GOV-API/);
  });

  test('检查任务的脚本目标缺失时以 GOV-TOOL-004 失败', () => {
    const root = fixture((dir) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      pkg.scripts['check:missing'] = 'node scripts/ci/missing.js';
      write(dir, 'package.json', JSON.stringify(pkg, null, 2));
    });
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /GOV-TOOL-004/);
    assert.match(result.output, /check:missing/);
  });

  test('未接入结构链和 PR gate 时以 GOV-TOOL-005 失败', () => {
    const root = fixture((dir) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      pkg.scripts['check:structure'] = 'npm run check:layout';
      write(dir, 'package.json', JSON.stringify(pkg, null, 2));
      write(dir, '.github/workflows/pr-gate.yml', 'name: gate\n');
    });
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /GOV-TOOL-005/);
  });

  test('缺少 RUNTIME 板块时以 GOV-MOD-004 失败（十板块全覆盖）', () => {
    const root = fixture((dir) => {
      const doc = fs.readFileSync(path.join(dir, DOC), 'utf8');
      write(dir, DOC, doc.replace('## GOV-RUNTIME\n', ''));
    });
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /GOV-MOD-004/);
    assert.match(result.output, /GOV-RUNTIME/);
  });

  test('规则登记表字段齐全时通过 GOV-TOOL-006', () => {
    const root = fixture((dir) => {
      write(dir, 'docs/10_规范/registry/RULES-REGISTRY.json', JSON.stringify({
        meta: { name: 'fixture' },
        rules: [{
          id: 'RUNTIME-001', name: '零硬编码', domain: 'RUNTIME',
          nature: '约束为主', scope: 'services/**', priority: 'P1',
          status: 'active', trigger: '出现端点字面量时',
          constraint: '禁止硬编码端点', grants: '见约束边界',
          benefit: '统一来源', version: '1.0.0', ssot: 'AGENTS.md', owner: 'team',
        }],
      }, null, 2));
    });
    const result = run(root);
    assert.equal(result.status, 0, result.output);
  });

  test('规则缺三元字段时以 GOV-TOOL-006 失败', () => {
    const root = fixture((dir) => {
      // 刻意漏掉 benefit：只写约束不写福利视为不完整
      write(dir, 'docs/10_规范/registry/RULES-REGISTRY.json', JSON.stringify({
        meta: { name: 'fixture' },
        rules: [{
          id: 'RUNTIME-002', name: '状态透明', domain: 'RUNTIME',
          nature: '约束为主', scope: 'cli/**', priority: 'P1', status: 'active',
          trigger: '打印状态时', constraint: '动作+目标+进度', grants: '见约束边界',
          version: '1.0.0', ssot: 'AGENTS.md', owner: 'team',
        }],
      }, null, 2));
    });
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /GOV-TOOL-006/);
    assert.match(result.output, /benefit/);
  });

  test('登记表使用 formerId 字段名时以 GOV-TOOL-006 失败', () => {
    const root = fixture((dir) => {
      write(dir, 'docs/10_规范/registry/RULES-REGISTRY.json', JSON.stringify({
        meta: { name: 'fixture' },
        rules: [{
          id: 'PROCESS-001', name: '分支纪律', domain: 'PROCESS',
          nature: '约束为主', scope: 'git 操作', priority: 'P0', status: 'active',
          trigger: 'commit 前', constraint: '禁止 AI 自动提交', grants: '见约束边界',
          benefit: '主干可信', version: '1.0.0', ssot: 'CLAUDE.md', owner: 'team',
          formerId: 'R1',
        }],
      }, null, 2));
    });
    const result = run(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /GOV-TOOL-006/);
    assert.match(result.output, /formerly/);
  });
});
