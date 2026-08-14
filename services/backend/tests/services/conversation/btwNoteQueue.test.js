'use strict';

/**
 * btwNoteQueue.test.js — 进程级单例队列薄壳契约(node:test)。
 *
 * 锁定:enqueue 经叶子规范化(空不入队/返回布尔)、count、drainAll(取出并清空)、clear、
 * 模块单例(同一 require 缓存共享同一队列)。
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const queue = require('../../../src/services/conversation/btwNoteQueue');

beforeEach(() => queue.clear());

describe('enqueue / count', () => {
  test('入队非空 → true,count 递增', () => {
    assert.equal(queue.enqueue('改用 deepseek'), true);
    assert.equal(queue.count(), 1);
    assert.equal(queue.enqueue('再加一条'), true);
    assert.equal(queue.count(), 2);
  });
  test('空 / 空白 / 非串 → false,不入队', () => {
    assert.equal(queue.enqueue(''), false);
    assert.equal(queue.enqueue('   '), false);
    assert.equal(queue.enqueue(null), false);
    assert.equal(queue.count(), 0);
  });
  test('入队前后经叶子 trim', () => {
    queue.enqueue('  有空白  ');
    assert.deepEqual(queue.drainAll(), ['有空白']);
  });
});

describe('drainAll', () => {
  test('取出全部并清空', () => {
    queue.enqueue('a');
    queue.enqueue('b');
    assert.deepEqual(queue.drainAll(), ['a', 'b']);
    assert.equal(queue.count(), 0);
  });
  test('空队列 → 空数组', () => {
    assert.deepEqual(queue.drainAll(), []);
  });
});

describe('clear', () => {
  test('清空不返回内容', () => {
    queue.enqueue('a');
    queue.clear();
    assert.equal(queue.count(), 0);
  });
});

describe('模块单例', () => {
  test('二次 require 共享同一队列', () => {
    queue.enqueue('shared');
    const again = require('../../../src/services/conversation/btwNoteQueue');
    assert.equal(again.count(), 1);
    assert.deepEqual(again.drainAll(), ['shared']);
    assert.equal(queue.count(), 0);
  });
});
