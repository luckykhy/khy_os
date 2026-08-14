'use strict';

const test = require('node:test');
const assert = require('node:assert');

const router = require('../../src/cli/router');

// 捕获 stdout(printInfo/printWarn 最终走 console.log → process.stdout.write)。
// 强制 TUI 模式(isTTY=true):这正是本修复针对的场景——TUI 下 router 的交互式 inquirer
// 模糊纠错块(`&& !isTui`)被跳过,不阻塞 stdin,而我们的非交互提示在此路径补位。
function _capture(fn) {
  const chunks = [];
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  const origTty = process.stdout.isTTY;
  process.stdout.isTTY = true;
  console.log = (...a) => { chunks.push(a.join(' ')); };
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  const restore = () => { console.log = origLog; process.stdout.write = origWrite; process.stdout.isTTY = origTty; };
  return Promise.resolve()
    .then(fn)
    .then((ret) => { restore(); return { ret, out: chunks.join('\n') }; })
    .catch((e) => { restore(); throw e; });
}

async function _route(input, env) {
  const parsed = router.parseInput(input.split(/\s+/));
  const prev = {};
  for (const k of Object.keys(env || {})) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  try {
    return await _capture(() => router.route(parsed, {}));
  } finally {
    for (const k of Object.keys(env || {})) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

test('E2E: unknown slash command prints hint and returns false (→ AI)', async () => {
  const { ret, out } = await _route('/deploytttt', { KHY_UNKNOWN_COMMAND_HINT: '1' });
  assert.strictEqual(ret, false, 'still falls through to AI');
  assert.ok(out.includes('未知命令 "/deploytttt"'), `expected hint, got: ${out}`);
  assert.ok(out.includes('khy help'));
});

test('E2E: unknown slash command near a real one surfaces a did-you-mean', async () => {
  // /statuz 近似 status(git 子命令表里有;主命令层也可能给候选)。
  const { ret, out } = await _route('/statuz', { KHY_UNKNOWN_COMMAND_HINT: '1' });
  assert.strictEqual(ret, false);
  assert.ok(out.includes('未知命令 "/statuz"'), `got: ${out}`);
});

test('E2E: gate OFF → no hint (byte-revert to silent fall-through)', async () => {
  const { ret, out } = await _route('/deploytttt', { KHY_UNKNOWN_COMMAND_HINT: 'off' });
  assert.strictEqual(ret, false);
  assert.ok(!out.includes('未知命令'), `expected silence, got: ${out}`);
});

test('E2E: bare word (non-slash) → no unknown-command scold, returns false', async () => {
  const { ret, out } = await _route('blarghhh', { KHY_UNKNOWN_COMMAND_HINT: '1' });
  assert.strictEqual(ret, false);
  assert.ok(!out.includes('未知命令'), `bare word should not be scolded, got: ${out}`);
});

test('E2E: natural-language question (Chinese) → no scold, returns false', async () => {
  const { ret, out } = await _route('帮我解释一下这段代码', { KHY_UNKNOWN_COMMAND_HINT: '1' });
  assert.strictEqual(ret, false);
  assert.ok(!out.includes('未知命令'), `question should go silently to AI, got: ${out}`);
});
