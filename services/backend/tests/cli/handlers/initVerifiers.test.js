'use strict';

/**
 * initVerifiers.test.js — `/init-verifiers` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → false 不注入;门控开 → 返回 { aiForward } 且文本含五阶段 + khy 真发现结构。
 * 经 require.cache 桩 formatters。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/initVerifiers');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');

let calls;

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function installStubs() {
  cacheStub(FORMATTERS_PATH, {
    printInfo: (m) => calls.info.push(String(m)),
    printSuccess: (m) => calls.success.push(String(m)),
    printWarn: (m) => calls.warn.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
  });
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/initVerifiers');
}

beforeEach(() => {
  calls = { info: [], success: [], warn: [], error: [] };
  delete process.env.KHY_INIT_VERIFIERS;
  installStubs();
});

afterEach(() => {
  for (const p of [HANDLER_PATH, FORMATTERS_PATH]) delete require.cache[p];
  delete process.env.KHY_INIT_VERIFIERS;
});

describe('门控关 → 不接管', () => {
  test('KHY_INIT_VERIFIERS=0 → printInfo + 返回 false(不注入)', async () => {
    process.env.KHY_INIT_VERIFIERS = '0';
    const { handleInitVerifiers } = freshHandler();
    const r = await handleInitVerifiers('', []);
    assert.equal(r, false);
    assert.ok(calls.info.some((m) => /KHY_INIT_VERIFIERS|未启用/.test(m)));
  });
});

describe('门控开 → 注入脚手架指令', () => {
  test('返回 { aiForward } 且含五阶段 + khy 真发现结构', async () => {
    const { handleInitVerifiers } = freshHandler();
    const r = await handleInitVerifiers('', []);
    assert.ok(r && typeof r === 'object');
    assert.equal(typeof r.aiForward, 'string');
    assert.match(r.aiForward, /Phase 1/);
    assert.match(r.aiForward, /Phase 5/);
    assert.match(r.aiForward, /\.khy\/skills/);
    assert.match(r.aiForward, /manifest\.json/);
    // 诚实:正向脚手架目标是 .khy/skills(而非 CC 的 .claude/skills)
    assert.match(r.aiForward, /把每个校验器写到 `\.khy\/skills/);
  });
});
