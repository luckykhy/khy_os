'use strict';

/**
 * check-duplication.test.js — scripts/check-duplication.js 薄 CLI 的 child_process e2e。
 * 覆盖 warn / --strict-warnings / --gate(基线内外)/ --write-baseline / 门关 / 无目标 各出口。
 *
 * 自身不自触:本文件在 scope 外(scripts/tests/** self-ignore);fixture 全部写 os.tmpdir(),
 * 含重复的 fixture 用拼接构造,源码里不出现 4 行字面重复块。基线经 KHY_DUPLICATION_BASELINE
 * 指向 tmp 文件隔离,绝不碰仓库根真实基线。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(ROOT, 'scripts', 'check-duplication.js');

let tmpDir;
let scopeDir;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 运行 CLI:targets = 传给 CLI 的位置/开关参数;extraEnv 覆盖环境(基线路径隔离用)。
function runGate(targets, extraEnv) {
  const outputPath = path.join(os.tmpdir(), `khy-dup-${process.pid}-${Math.abs(hashStr(targets.join('|')))}.log`);
  const command = ['node', shellQuote(path.relative(ROOT, scriptPath)), ...targets.map(shellQuote), '>', shellQuote(outputPath), '2>&1'].join(' ');
  let status = 0;
  try {
    execSync(command, { cwd: ROOT, stdio: 'ignore', shell: '/bin/bash', env: Object.assign({}, process.env, extraEnv || {}) });
  } catch (error) {
    status = typeof error.status === 'number' ? error.status : 1;
  }
  const stdout = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  fs.rmSync(outputPath, { force: true });
  return { status, stdout };
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// ── 拼接式 fixture(源码不出现字面 4 行重复块) ─────────────────────────────────────
function cloneBody() {
  return [
    '  const alpha = compute(input) + 1;',
    '  const beta = alpha * factor;',
    '  const gamma = beta - offset;',
    "  const label = 'row:' + gamma;",
    '  return { alpha, beta, gamma, label };',
  ].join('\n');
}
function fileWithClone(wrapperName) {
  return `'use strict';\nfunction ${wrapperName}(input, factor, offset) {\n${cloneBody()}\n}\n`;
}
function uniqueFile(wrapperName, seed) {
  return `'use strict';\nfunction ${wrapperName}() {\n  const v${seed} = ${seed} * 7 + 1;\n  const w${seed} = v${seed} - ${seed};\n  return '${wrapperName}:' + w${seed};\n}\n`;
}
function writeFixture(name, content) {
  const full = path.join(scopeDir, name);
  fs.writeFileSync(full, content);
  return full;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dup-e2e-'));
  scopeDir = path.join(tmpDir, 'scope');
  fs.mkdirSync(scopeDir, { recursive: true });
});
after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('check-duplication CLI — warn 阶段', () => {
  test('两文件共享 ≥4 行 → exit 0 + [WARN] duplicate-block', () => {
    writeFixture('a.js', fileWithClone('doAlpha'));
    writeFixture('b.js', fileWithClone('doBeta'));
    const { status, stdout } = runGate([scopeDir]);
    assert.equal(status, 0, 'warn 模式存量重复不红');
    assert.match(stdout, /\[WARN \] duplicate-block/);
    assert.match(stdout, /warning\(s\)/);
  });

  test('--strict-warnings → 有 warning 即 exit 1', () => {
    const { status, stdout } = runGate([scopeDir, '--strict-warnings']);
    assert.equal(status, 1);
    assert.match(stdout, /duplicate-block/);
  });

  test('无重复(各自唯一)→ exit 0 + pass 文案', () => {
    const only = path.join(tmpDir, 'uniq');
    fs.mkdirSync(only, { recursive: true });
    fs.writeFileSync(path.join(only, 'x.js'), uniqueFile('fx', 11));
    fs.writeFileSync(path.join(only, 'y.js'), uniqueFile('fy', 22));
    const { status, stdout } = runGate([only]);
    assert.equal(status, 0);
    assert.match(stdout, /no duplicate blocks/);
  });

  test('无目标文件 → exit 0 + 提示', () => {
    const empty = path.join(tmpDir, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const { status, stdout } = runGate([empty]);
    assert.equal(status, 0);
    assert.match(stdout, /No target files/);
  });

  test('门关 KHY_DUPLICATION_GUARD=off → 空判定 exit 0', () => {
    const { status, stdout } = runGate([scopeDir], { KHY_DUPLICATION_GUARD: 'off' });
    assert.equal(status, 0);
    assert.match(stdout, /no duplicate blocks/);
  });
});

describe('check-duplication CLI — 基线 + gate 阶段', () => {
  test('--write-baseline 写出指纹文件', () => {
    const baselineFile = path.join(tmpDir, 'baseline.json');
    const { status } = runGate([scopeDir, '--write-baseline'], { KHY_DUPLICATION_BASELINE: baselineFile });
    assert.equal(status, 0);
    assert.ok(fs.existsSync(baselineFile), '基线文件应生成');
    const parsed = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    assert.ok(Array.isArray(parsed.entries) && parsed.entries.length >= 1, '至少一个指纹');
    assert.ok(parsed.entries.every((e) => typeof e.hash === 'string'));
  });

  test('--gate + 基线含全部指纹 → 既有重复降为 warning,exit 0', () => {
    const baselineFile = path.join(tmpDir, 'baseline2.json');
    runGate([scopeDir, '--write-baseline'], { KHY_DUPLICATION_BASELINE: baselineFile });
    const { status, stdout } = runGate([scopeDir, '--gate'], { KHY_DUPLICATION_BASELINE: baselineFile });
    assert.equal(status, 0, '∈基线 → warning,不红');
    assert.match(stdout, /\[WARN \] duplicate-block/);
    assert.doesNotMatch(stdout, /\[ERROR\]/);
  });

  test('--gate + 空基线 + 新重复 → error,exit 1', () => {
    const baselineFile = path.join(tmpDir, 'baseline-empty.json');
    fs.writeFileSync(baselineFile, JSON.stringify({ version: 1, entries: [] }));
    const { status, stdout } = runGate([scopeDir, '--gate'], { KHY_DUPLICATION_BASELINE: baselineFile });
    assert.equal(status, 1, '∉基线的新重复 → error,硬门挡回');
    assert.match(stdout, /\[ERROR\] duplicate-block/);
  });
});
