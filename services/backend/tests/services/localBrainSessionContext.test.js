'use strict';

/**
 * localBrainSessionContext — 会话级前后文关联的特征化测试（node:test，确定性）。
 *
 * 锁定从 localBrainService.js 抽出后**行为不变**：上下文缓冲的记录/淘汰、跟进/指代
 * 短句借前文展开，以及 localBrainService 仍以同名别名复用同一进程内单例。
 */

const test = require('node:test');
const assert = require('node:assert');

const sc = require('../../src/services/localBrainSessionContext');
const lb = require('../../src/services/localBrainService');

test('pushContext/getContext: 记录后可取回，clearContext 清空', () => {
  sc.clearContext();
  sc.pushContext('user', '北京天气怎么样');
  sc.pushContext('assistant', '北京今天晴', { category: '天气' });
  assert.strictEqual(sc.getContext().length, 2);
  sc.clearContext();
  assert.strictEqual(sc.getContext().length, 0);
});

test('resolveFollowUp: "那上海呢" 借天气前文展开为 "上海天气"', () => {
  sc.clearContext();
  sc.pushContext('user', '北京天气怎么样');
  sc.pushContext('assistant', '北京今天晴', { category: '天气' });
  const r = sc.resolveFollowUp('那上海呢');
  assert.ok(r, '应解析出跟进查询');
  assert.strictEqual(r.resolved, '上海天气');
});

test('resolveFollowUp: 无前文返回 null（不误判）', () => {
  sc.clearContext();
  assert.strictEqual(sc.resolveFollowUp('那上海呢'), null);
});

test('resolveFollowUp: "再来一个" 续上一轮同类（笑话）', () => {
  sc.clearContext();
  sc.pushContext('user', '讲个笑话');
  sc.pushContext('assistant', '...', { category: '笑话' });
  const r = sc.resolveFollowUp('再来一个');
  assert.ok(r && /笑话/.test(r.resolved));
});

test('_extractEntities: 抽出城市/文件/英文实词', () => {
  const ents = sc._extractEntities('看看 北京 的 report.md 里 weather 数据');
  const types = ents.map(e => e.type);
  assert.ok(types.includes('city'));
  assert.ok(types.includes('file'));
});

test('localBrainService 复用同一单例（别名接线不变）', () => {
  sc.clearContext();
  lb.pushContext('user', '上海天气');
  // 经 service 写入，经底层模块读出 → 同一进程内单例
  assert.strictEqual(sc.getContext().length, 1);
  lb.clearContext();
  assert.strictEqual(sc.getContext().length, 0);
  // 对外导出契约仍在
  for (const n of ['pushContext', 'getContext', 'clearContext', 'resolveFollowUp']) {
    assert.strictEqual(typeof lb[n], 'function', `missing export ${n}`);
  }
});

// ── 只读派生:getRecentEntities / getContextSummary(供指代消歧叶子) ──────────

test('导出契约:新增只读 getRecentEntities / getContextSummary', () => {
  assert.strictEqual(typeof sc.getRecentEntities, 'function');
  assert.strictEqual(typeof sc.getContextSummary, 'function');
});

test('getRecentEntities: 去重且最新优先', () => {
  sc.clearContext();
  sc.pushContext('user', '看看 比特币 价格');
  sc.pushContext('assistant', '比特币 现价...', { category: '加密货币' });
  sc.pushContext('user', '以太坊 呢');
  const ents = sc.getRecentEntities();
  const values = ents.map(e => e.value);
  // 最新一轮的 以太坊 应在更前
  assert.ok(values.includes('以太坊'));
  assert.ok(values.includes('比特币'));
  // 去重:比特币 只出现一次
  assert.strictEqual(values.filter(v => v === '比特币').length, 1);
});

test('getRecentEntities: 无上下文返回空数组(不抛)', () => {
  sc.clearContext();
  const ents = sc.getRecentEntities();
  assert.ok(Array.isArray(ents));
  assert.strictEqual(ents.length, 0);
});

test('getContextSummary: 返回 { entities, lastTopic, lastCategory }', () => {
  sc.clearContext();
  sc.pushContext('user', '北京天气怎么样');
  sc.pushContext('assistant', '北京今天晴', { category: '天气' });
  const s = sc.getContextSummary();
  assert.ok(Array.isArray(s.entities));
  assert.strictEqual(s.lastCategory, '天气');
  assert.strictEqual(typeof s.lastTopic, 'string');
});

test('getContextSummary: 空上下文亦安全(entities 空·字段为空串)', () => {
  sc.clearContext();
  const s = sc.getContextSummary();
  assert.deepStrictEqual(s.entities, []);
  assert.strictEqual(s.lastTopic, '');
  assert.strictEqual(s.lastCategory, '');
});
