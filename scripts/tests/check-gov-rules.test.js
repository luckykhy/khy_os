'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-gov-rules.js');
const DOC = 'docs/03_DESIGN_设计/[DESIGN-ARCH-070] 治理总纲与可执行规则.md';
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
});
