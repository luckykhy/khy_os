'use strict';

/**
 * btw.test.js — `/btw` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → false 不入队;有内容 → 入队 + 回执含队列计数;空内容 → 用法提示 + 当前计数;
 * args 数组空格拼接成一条提示。经 require.cache 桩 formatters;真用共享 store(隔离 clear)。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/btw');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const queue = require('../../../src/services/conversation/btwNoteQueue');

let calls;

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/btw');
}

beforeEach(() => {
  calls = { info: [] };
  cacheStub(FORMATTERS_PATH, { printInfo: (m) => calls.info.push(String(m)) });
  queue.clear();
  delete process.env.KHY_BTW;
});

afterEach(() => {
  delete require.cache[HANDLER_PATH];
  delete require.cache[FORMATTERS_PATH];
  queue.clear();
  delete process.env.KHY_BTW;
});

describe('门控关 → 不接管', () => {
  test('KHY_BTW=0 → false,不入队', async () => {
    process.env.KHY_BTW = '0';
    const { handleBtw } = freshHandler();
    const r = await handleBtw('', ['先跑测试']);
    assert.equal(r, false);
    assert.equal(queue.count(), 0);
    assert.ok(calls.info.some((m) => /KHY_BTW|未启用/.test(m)));
  });
});

describe('门控开 → 排队补充提示', () => {
  test('有内容 → 入队 + 回执含计数', async () => {
    const { handleBtw } = freshHandler();
    const r = await handleBtw('', ['注意', 'windows', '路径']);
    assert.equal(r, true);
    assert.equal(queue.count(), 1);
    assert.deepEqual(queue.drainAll(), ['注意 windows 路径']);
    assert.ok(calls.info.some((m) => /已排队/.test(m)));
  });

  test('空内容 → 用法提示 + 当前计数,不入队', async () => {
    const { handleBtw } = freshHandler();
    const r = await handleBtw('', []);
    assert.equal(r, true);
    assert.equal(queue.count(), 0);
    assert.ok(calls.info.some((m) => /用法/.test(m)));
  });

  test('多次入队累加', async () => {
    const { handleBtw } = freshHandler();
    await handleBtw('', ['一']);
    await handleBtw('', ['二']);
    assert.equal(queue.count(), 2);
  });
});
