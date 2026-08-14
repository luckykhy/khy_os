'use strict';

/**
 * recap.test.js — `/recap` 薄壳契约(node:test)。
 *
 * 锁定:门控关(KHY_RECAP=off)→ false 不接管;无活动会话 → 提示且接管(true);
 * 正常 → 委托既有 sessionRecapService.generateRecap + formatRecap(不另起炉灶);
 * 空会话(sections:{} 无 topics)→ 诚实降级只打印 summary,绝不因 formatRecap 抛而翻红。
 * 经 require.cache 桩 formatters + sessionForestService + sessionPersistence + sessionRecapService;
 * 绝不触真 IO / 真模型。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/recap');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const FOREST_PATH = require.resolve('../../../src/services/session/sessionForestService');
const PERSIST_PATH = require.resolve('../../../src/services/sessionPersistence');
const RECAP_PATH = require.resolve('../../../src/services/sessionRecapService');

let calls;
let forestStub;
let persistStub;
let recapStub;
let origLog;
let logged;

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/recap');
}

beforeEach(() => {
  calls = { info: [], error: [] };
  logged = [];
  origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  cacheStub(FORMATTERS_PATH, {
    printInfo: (m) => calls.info.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
  });
  forestStub = { getCurrentSessionId: () => 'sess_1' };
  cacheStub(FOREST_PATH, forestStub);
  persistStub = { buildConversationChain: () => [{ role: 'user', content: 'hi' }] };
  cacheStub(PERSIST_PATH, persistStub);
  recapStub = {
    generateRecap: () => ({ turns: 1, summary: 's', sections: { topics: [], decisions: [], filesChanged: [], commandsRun: [], openQuestions: [], keyInsights: [] } }),
    formatRecap: (r) => 'RECAP(' + r.turns + ')',
  };
  cacheStub(RECAP_PATH, recapStub);
  delete process.env.KHY_RECAP;
});

afterEach(() => {
  console.log = origLog;
  delete require.cache[HANDLER_PATH];
  delete require.cache[FORMATTERS_PATH];
  delete require.cache[FOREST_PATH];
  delete require.cache[PERSIST_PATH];
  delete require.cache[RECAP_PATH];
  delete process.env.KHY_RECAP;
});

describe('门控关 → 不接管', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    test(`KHY_RECAP=${off} → false`, async () => {
      process.env.KHY_RECAP = off;
      const { handleRecap } = freshHandler();
      const r = await handleRecap('recap', [], {});
      assert.equal(r, false);
      assert.ok(calls.info.some((m) => /KHY_RECAP|未启用/.test(m)));
    });
  }
});

describe('无活动会话', () => {
  test('getCurrentSessionId 返回空 → 提示且接管(true)', async () => {
    forestStub.getCurrentSessionId = () => null;
    const { handleRecap } = freshHandler();
    const r = await handleRecap('recap', [], {});
    assert.equal(r, true);
    assert.ok(calls.info.some((m) => /暂无活动会话/.test(m)));
  });
});

describe('正常 → 委托 sessionRecapService', () => {
  test('调 generateRecap + formatRecap 并打印', async () => {
    let gen = false; let fmt = false;
    recapStub.generateRecap = () => { gen = true; return { turns: 2, summary: 's', sections: { topics: ['a'], decisions: [], filesChanged: [], commandsRun: [], openQuestions: [], keyInsights: [] } }; };
    recapStub.formatRecap = (r) => { fmt = true; return 'RECAP(' + r.turns + ')'; };
    const { handleRecap } = freshHandler();
    const r = await handleRecap('recap', [], {});
    assert.equal(r, true);
    assert.ok(gen, 'generateRecap 被调用');
    assert.ok(fmt, 'formatRecap 被调用');
    assert.ok(logged.some((l) => /RECAP\(2\)/.test(l)));
  });
});

describe('空会话诚实降级', () => {
  test('sections:{} → 只打印 summary,绝不调 formatRecap(不抛)', async () => {
    let fmt = false;
    recapStub.generateRecap = () => ({ turns: 0, summary: 'Empty conversation.', sections: {} });
    recapStub.formatRecap = () => { fmt = true; throw new Error('should not be called'); };
    const { handleRecap } = freshHandler();
    const r = await handleRecap('recap', [], {});
    assert.equal(r, true);
    assert.equal(fmt, false);
    assert.ok(calls.info.some((m) => /Empty conversation/.test(m)));
  });
});

describe('读 transcript 失败 → 诚实报错不崩', () => {
  test('buildConversationChain 抛 → printError 且接管(true)', async () => {
    persistStub.buildConversationChain = () => { throw new Error('disk gone'); };
    const { handleRecap } = freshHandler();
    const r = await handleRecap('recap', [], {});
    assert.equal(r, true);
    assert.ok(calls.error.some((m) => /读取会话 transcript 失败/.test(m)));
  });
});
