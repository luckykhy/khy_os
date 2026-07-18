'use strict';

/**
 * _dbTimeout.test.js — 纯叶子 _dbTimeout 的单测(node:test)。
 *
 * 覆盖:总开关 on/off;connect/statement 超时解析(默认 + clamp);pg 超时 delta(ON 三字段 /
 * OFF 空 delta);mysql connect delta(ON connectTimeout / OFF 空)。空 delta 是「OFF 逐字节回退」
 * 的 oracle——调用方展开 `{...base, ...{}}` 后与今日选项一致。
 *
 * 运行:node --test services/backend/tests/tools/_dbTimeout.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const dt = require('../../src/tools/_dbTimeout');

test('isDbTimeoutEnabled:默认 on;显式 off 关', () => {
  assert.equal(dt.isDbTimeoutEnabled({}), true);
  assert.equal(dt.isDbTimeoutEnabled({ KHY_DB_QUERY_TIMEOUT: 'off' }), false);
  assert.equal(dt.isDbTimeoutEnabled({ KHY_DB_QUERY_TIMEOUT: '0' }), false);
  assert.equal(dt.isDbTimeoutEnabled({ KHY_DB_QUERY_TIMEOUT: 'no' }), false);
});

test('resolveConnectTimeoutMs:默认 10000;clamp[500,120000];非法回默认', () => {
  assert.equal(dt.resolveConnectTimeoutMs({}), 10000);
  assert.equal(dt.resolveConnectTimeoutMs({ KHY_DB_CONNECT_TIMEOUT_MS: '2000' }), 2000);
  assert.equal(dt.resolveConnectTimeoutMs({ KHY_DB_CONNECT_TIMEOUT_MS: '10' }), 500);       // clamp low
  assert.equal(dt.resolveConnectTimeoutMs({ KHY_DB_CONNECT_TIMEOUT_MS: '999999' }), 120000); // clamp high
  assert.equal(dt.resolveConnectTimeoutMs({ KHY_DB_CONNECT_TIMEOUT_MS: 'abc' }), 10000);     // illegal
});

test('resolveStatementTimeoutMs:默认 30000;clamp[1000,600000];非法回默认', () => {
  assert.equal(dt.resolveStatementTimeoutMs({}), 30000);
  assert.equal(dt.resolveStatementTimeoutMs({ KHY_DB_STATEMENT_TIMEOUT_MS: '5000' }), 5000);
  assert.equal(dt.resolveStatementTimeoutMs({ KHY_DB_STATEMENT_TIMEOUT_MS: '10' }), 1000);     // clamp low
  assert.equal(dt.resolveStatementTimeoutMs({ KHY_DB_STATEMENT_TIMEOUT_MS: '9999999' }), 600000); // clamp high
  assert.equal(dt.resolveStatementTimeoutMs({ KHY_DB_STATEMENT_TIMEOUT_MS: '' }), 30000);      // illegal
});

test('buildPostgresTimeoutOptions:ON → 三字段;OFF → 空 delta(逐字节回退 oracle)', () => {
  const on = dt.buildPostgresTimeoutOptions({ KHY_DB_CONNECT_TIMEOUT_MS: '1500', KHY_DB_STATEMENT_TIMEOUT_MS: '20000' });
  assert.equal(on.connectionTimeoutMillis, 1500);
  assert.equal(on.query_timeout, 20000);
  assert.equal(on.statement_timeout, 20000);
  const off = dt.buildPostgresTimeoutOptions({ KHY_DB_QUERY_TIMEOUT: 'off' });
  assert.deepEqual(off, {}, 'OFF must yield empty delta so spread is a no-op');
});

test('buildMysqlConnectOptions:ON → connectTimeout;OFF → 空 delta', () => {
  const on = dt.buildMysqlConnectOptions({ KHY_DB_CONNECT_TIMEOUT_MS: '3000' });
  assert.deepEqual(on, { connectTimeout: 3000 });
  const off = dt.buildMysqlConnectOptions({ KHY_DB_QUERY_TIMEOUT: 'off' });
  assert.deepEqual(off, {});
});
