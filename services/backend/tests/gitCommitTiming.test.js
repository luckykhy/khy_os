'use strict';

/**
 * AI 工具 `gitCommit` 的**提交时机判断**接线测试。
 *
 * 背景：`gitCommit` 是 AI 真正用来提交的工具（不是 `khy commit` CLI）。
 * 它的原始描述是「**只在用户要求时提交**」—— 这正是用户抱怨的「AI 不知道什么时候该提交」
 * 的机制根源。本测试保证接线后：
 *
 * 1. `checkTiming: 'enforce'` 下，判据不满足 → **拒绝提交**（AI 拿到的是 fail 而非静默成功）
 * 2. `checkTiming: 'warn'`（默认）下 → **照样提交**，但把判断结果回给 AI
 * 3. `checkTiming: 'off'` → 完全不判断（逐字节回退旧行为）
 * 4. 工具描述已不再宣称「只在用户要求时提交」，而是给出「到点就该提交」的判据
 *
 * ⚠ 全部在 `os.tmpdir()` 的临时 git 仓库里跑真 `git commit`，不落仓库树。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const assert = require('node:assert');
const test = require('node:test');
const os = require('os');
const path = require('path');

const tool = require('../src/tools/gitCommit');

const _tmpdirs = [];

function makeRepo(seed = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gitcommit-test-'));
  _tmpdirs.push(dir);
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '.']);
  git(['config', 'user.email', 'test@test.local']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(dir, '.no-hooks')]);
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function gitIn(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function runTool(dir, params) {
  const origCwd = process.cwd();
  const origEnv = process.env.KHYQUANT_CWD;
  try {
    process.chdir(dir);
    process.env.KHYQUANT_CWD = dir;
    return await tool.execute(params, {});
  } finally {
    process.chdir(origCwd);
    if (origEnv === undefined) delete process.env.KHYQUANT_CWD;
    else process.env.KHYQUANT_CWD = origEnv;
  }
}

function logCount(dir) {
  try {
    return gitIn(dir, ['rev-list', '--count', 'HEAD']).trim();
  } catch {
    return '0';
  }
}

process.on('exit', () => {
  for (const d of _tmpdirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

// ── 描述契约 ────────────────────────────────────────────────────────────────

test('工具描述：不再宣称「只在用户要求时提交」，改为给出到点判据', () => {
  assert.ok(!/only when the user asks/i.test(tool.description), '旧的「只在用户要求时」必须删掉');
  assert.match(tool.description, /commit-worthy/i, '应告诉 AI「什么是到点」');
  assert.match(tool.description, /PROCESS-009/, '应引用判据真源');
  assert.ok(tool.description.length <= 600, `描述须 ≤600 字符，当前 ${tool.description.length}`);
});

test('工具 schema：新增 checkTiming，取值受 enum 约束且有 example', () => {
  const p = tool.inputSchema.checkTiming;
  assert.ok(p, 'checkTiming 参数应存在');
  assert.deepStrictEqual(p.enum, ['warn', 'enforce', 'off']);
  assert.ok(p.example, 'enum 参数必须有 example（否则 check-tool-contract 报 enum-example-missing）');
  assert.ok(!p.required, 'checkTiming 不应是必填 —— 默认 warn，不改变既有调用方');
});

// ── enforce：拒绝提交 ───────────────────────────────────────────────────────

test('enforce：无验证证据 → 拒绝提交，且 git log 不动', async () => {
  const dir = makeRepo({ 'services/backend/src/a.js': '// a\n' });
  gitIn(dir, ['add', 'services/backend/src/a.js']);

  const res = await runTool(dir, { message: 'feat: x', checkTiming: 'enforce' });
  assert.strictEqual(res.success, false, 'enforce 下判据不满足必须失败');
  assert.match(res.error, /提交时机判据未通过/);
  assert.ok(res.timing, '应把判断结果一并返回');
  assert.strictEqual(res.timing.decision, 'do-not-commit');
  assert.strictEqual(logCount(dir), '0', 'git log 必须仍为空');
});

test('enforce：含删除 → 拒绝提交（安全护栏也归 enforce 管）', async () => {
  const dir = makeRepo({ 'services/backend/src/a.js': '// a\n' });
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  gitIn(dir, ['rm', '-q', 'services/backend/src/a.js']);
  fs.mkdirSync(path.join(dir, '.khy', 'feedback', 't1'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.khy', 'feedback', 't1', 'verify.txt'), 'ok');

  const before = logCount(dir);
  const res = await runTool(dir, { message: 'refactor: 删掉', checkTiming: 'enforce' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.timing.decision, 'ask-first');
  assert.strictEqual(logCount(dir), before, 'ask-first 下不能提交');
});

test('enforce：判据全绿 → 真的提交', async () => {
  const dir = makeRepo({ 'services/backend/src/a.js': '// a\n' });
  gitIn(dir, ['add', 'services/backend/src/a.js']);
  fs.mkdirSync(path.join(dir, '.khy', 'feedback', 't1'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.khy', 'feedback', 't1', 'verify.txt'), 'ok');

  const res = await runTool(dir, { message: 'feat(cli): 加一个文件', checkTiming: 'enforce' });
  assert.strictEqual(res.success, true, `应提交成功：${res.error || ''}`);
  assert.strictEqual(res.timing.decision, 'commit-now');
  assert.strictEqual(res.timing.files, 1);
  assert.strictEqual(logCount(dir), '1');
});

// ── warn（默认）：提交但回传判断 ────────────────────────────────────────────

test('warn 默认：判据不满足仍提交，但 timing 结果回给 AI', async () => {
  const dir = makeRepo({ 'services/backend/src/a.js': '// a\n' });
  gitIn(dir, ['add', 'services/backend/src/a.js']);

  // 不传 checkTiming，走默认 warn
  const res = await runTool(dir, { message: 'feat: x' });
  assert.strictEqual(res.success, true, 'warn 模式不应阻断提交（保持向后兼容）');
  assert.ok(res.timing, '默认也要把判断回传');
  assert.strictEqual(res.timing.decision, 'do-not-commit');
  assert.ok(res.timing.blockers.length > 0, '应列出缺口');
  assert.strictEqual(logCount(dir), '1', 'warn 模式确实提交了');
});

// ── off：完全不判断 ─────────────────────────────────────────────────────────

test('off：不判断、不回传 timing（逐字节回退旧行为）', async () => {
  const dir = makeRepo({ 'services/backend/src/a.js': '// a\n' });
  gitIn(dir, ['add', 'services/backend/src/a.js']);

  const res = await runTool(dir, { message: 'feat: x', checkTiming: 'off' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.timing, undefined, 'off 时不应有 timing 字段');
  assert.strictEqual(logCount(dir), '1');
});

// ── fail-soft：判断本身出错不许阻断提交 ─────────────────────────────────────

test('fail-soft：非 git 环境下判断失败也不炸（提交照旧走）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gitcommit-norepo-'));
  _tmpdirs.push(dir);
  // 这里没有 git init —— git commit 本身会失败，但不应该是「判断」把它炸掉的
  const res = await runTool(dir, { message: 'x', checkTiming: 'enforce' });
  assert.strictEqual(typeof res.success, 'boolean', '必须返回结构化结果而不是抛异常');
});
