'use strict';

/**
 * fenceLangCharset.test.js — 流式围栏语言段字符集加宽(修「流式识别不了 ```c# / ```f#」)。
 *
 * 现场:streamingMarkdown 的 FENCE_OPEN_RE 语言段 [\w+-]* 收不下 `#`/`.`,``` ```c# ``` 无法
 * 匹配整行 → 不进 code_fence 状态。本套件锁死:
 *   - 开门(default)→ 加宽正则,``` ```c# / ```f# / ```asp.net 都识别为 fence_open;
 *   - 关门(0/false/off/no)→ 逐字节回退历史正则(仍收不下 `#`);
 *   - E2E:MarkdownStreamState.feed(```c#\n) 进入 code_fence 且 _fenceLang==='c#'(开)/ 保持 prose(关)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  fenceLangCharsetEnabled,
  fenceOpenRegex,
  RE_WIDE,
  RE_LEGACY,
} = require('../../src/cli/fenceLangCharset');
const { MarkdownStreamState } = require('../../src/cli/streamingMarkdown');

test('gate default-on → wide regex; off (0/false/off/no) → legacy regex', () => {
  assert.strictEqual(fenceLangCharsetEnabled({}), true);
  assert.strictEqual(fenceOpenRegex({}), RE_WIDE);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(fenceLangCharsetEnabled({ KHY_FENCE_LANG_CHARSET: v }), false, v);
    assert.strictEqual(fenceOpenRegex({ KHY_FENCE_LANG_CHARSET: v }), RE_LEGACY, v);
  }
});

test('BUG FIX (default-on): #/. language tags now match the fence open line', () => {
  for (const lang of ['c#', 'f#', 'asp.net', 'objective-c', 'c++', 'ts']) {
    assert.ok(RE_WIDE.test('```' + lang), `expected ${lang} to match wide regex`);
  }
  // 捕获组正确切出语言。
  const m = '```c#'.match(RE_WIDE);
  assert.strictEqual(m[2], 'c#');
});

test('legacy (gate off) does NOT match #-containing tags — pins the bug', () => {
  assert.ok(!RE_LEGACY.test('```c#'), 'legacy regex should fail on c#');
  assert.ok(!RE_LEGACY.test('```f#'), 'legacy regex should fail on f#');
  assert.ok(!RE_LEGACY.test('```asp.net'), 'legacy regex should fail on asp.net');
  // 但纯字母语言两者都认(无回归)。
  assert.ok(RE_LEGACY.test('```js') && RE_WIDE.test('```js'));
  assert.ok(RE_LEGACY.test('```c++') && RE_WIDE.test('```c++'));
});

test('never throws on junk env', () => {
  assert.doesNotThrow(() => fenceOpenRegex(null));
  assert.doesNotThrow(() => fenceOpenRegex(undefined));
});

test('E2E MarkdownStreamState: ```c# enters code_fence with lang c# (default-on)', () => {
  delete process.env.KHY_FENCE_LANG_CHARSET;
  const state = new MarkdownStreamState(() => {});
  state.feed('```c#\n');
  assert.strictEqual(state._state, 'code_fence');
  assert.strictEqual(state._fenceLang, 'c#');
});

test('E2E MarkdownStreamState: gate-off byte-reverts — ```c# stays prose', () => {
  process.env.KHY_FENCE_LANG_CHARSET = '0';
  try {
    const state = new MarkdownStreamState(() => {});
    state.feed('```c#\n');
    // 历史正则识别不了 → 不进 code_fence(留在 prose)。
    assert.strictEqual(state._state, 'prose');
  } finally {
    delete process.env.KHY_FENCE_LANG_CHARSET;
  }
});

test('E2E: plain-language fence still works both ways (no regression)', () => {
  for (const env of [undefined, '0']) {
    if (env === undefined) delete process.env.KHY_FENCE_LANG_CHARSET;
    else process.env.KHY_FENCE_LANG_CHARSET = env;
    try {
      const state = new MarkdownStreamState(() => {});
      state.feed('```js\n');
      assert.strictEqual(state._state, 'code_fence', `env=${env}`);
      assert.strictEqual(state._fenceLang, 'js', `env=${env}`);
    } finally {
      delete process.env.KHY_FENCE_LANG_CHARSET;
    }
  }
});

test('LIVE wiring: streamingMarkdown routes fence detection through the leaf', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../../src/cli/streamingMarkdown.js'),
    'utf8',
  );
  assert.ok(/require\('\.\/fenceLangCharset'\)/.test(src), 'should require the leaf');
  assert.ok(/_fenceOpenRe\(\)\.test\(line\)/.test(src), 'classifyLine should use gated regex');
  assert.ok(/line\.match\(_fenceOpenRe\(\)\)/.test(src), '_enterFence should use gated regex');
});
