'use strict';
/**
 * dbTimeout.integration.test.js — 证明 databaseQuery 的网络路径不再「零超时真无限挂」。
 *
 * ① postgres(需 pg 驱动):连接一个不可路由主机(SYN 被黑洞),门控开 + 1.5s connect 超时 →
 *    必须在超时内有界失败(而非挂到内核 TCP 超时的分钟级)。这是「khy 调用工具卡死」在 DB
 *    路径上的真实回归守卫。
 * ② mysql(注入假驱动;mysql2 未安装):execute() 返回一个永不 resolve 的 promise 模拟挂死;
 *    门控开 + statement 超时 → 墙钟竞赛必须在超时内以 _query 错误返回,并强制 destroy 连接
 *    (防泄漏)。这直接证明 query 相的无限挂被兜住。
 * ③ mysql 门控关:无墙钟兜底,直接 await execute(逐字节回退今日行为)。
 *
 * Run with:  npx jest tests/tools/dbTimeout.integration.test.js
 */
const path = require('path');

const TOOL_PATH = path.resolve(__dirname, '../../src/tools/databaseQuery.js');

// jest 的模块注册表会拦截 databaseQuery 内部的 require('mysql2/promise'):
// 虚拟 mock 让 mysql2 在未安装时也能拿到假驱动。jest 下给 Module._load
// 打补丁无法拦截被测模块内部的 require,故必须走 jest.mock。
const mockMysql = { createConnection: jest.fn() };
jest.mock('mysql2/promise', () => mockMysql, { virtual: true });

const tool = require(TOOL_PATH);

beforeEach(() => {
  mockMysql.createConnection.mockReset();
});

test('postgres:不可达主机 →门控开 + connect 超时下有界失败(不挂死)', async () => {
  // jest 会把 test 回调的第二个参数当作 done 回调等待,node:test 的 (t) 写法
  // 在 jest 下必然超时——这里不接任何参数;pg 未安装则直接跳过。
  let hasPg = true;
  try { require.resolve('pg'); } catch { hasPg = false; }
  if (!hasPg) return; // pg 未安装,跳过:本用例守卫的是连接超时,不是驱动缺失
  const prev = { g: process.env.KHY_DB_QUERY_TIMEOUT, c: process.env.KHY_DB_CONNECT_TIMEOUT_MS };
  process.env.KHY_DB_QUERY_TIMEOUT = 'on';
  process.env.KHY_DB_CONNECT_TIMEOUT_MS = '1500';
  try {
    const t0 = Date.now();
    const res = await tool.execute(
      { dialect: 'postgres', connection: 'postgres://u:p@10.255.255.1:5432/db', query: 'SELECT 1' },
      {},
    );
    const dt = Date.now() - t0;
    expect(res.success).toBe(false);
    expect(res.code).toBe('SERVICE_UNAVAILABLE');
    expect(dt < 6000).toBeTruthy();
  } finally {
    if (prev.g === undefined) delete process.env.KHY_DB_QUERY_TIMEOUT; else process.env.KHY_DB_QUERY_TIMEOUT = prev.g;
    if (prev.c === undefined) delete process.env.KHY_DB_CONNECT_TIMEOUT_MS; else process.env.KHY_DB_CONNECT_TIMEOUT_MS = prev.c;
  }
});

test('mysql:query 永不返回(挂死)→墙钟超时兜住 + 强制 destroy(注入假驱动)', async () => {
  let destroyed = false;
  mockMysql.createConnection.mockImplementation(async () => ({
    execute: () => new Promise(() => { /* 永不 resolve:模拟挂死的 query */ }),
    destroy: () => { destroyed = true; },
    end: async () => {},
  }));

  const prev = { g: process.env.KHY_DB_QUERY_TIMEOUT, s: process.env.KHY_DB_STATEMENT_TIMEOUT_MS };
  process.env.KHY_DB_QUERY_TIMEOUT = 'on';
  process.env.KHY_DB_STATEMENT_TIMEOUT_MS = '1000'; // clamp 下限,足够快
  try {
    const t0 = Date.now();
    const res = await tool.execute(
      { dialect: 'mysql', connection: 'mysql://u:p@127.0.0.1:3306/db', query: 'SELECT 1' },
      {},
    );
    const dt = Date.now() - t0;
    expect(res.success).toBe(false);
    expect(res.code).toBe('BAD_PARAM');
    expect(/超时/.test(String(res.error || ''))).toBeTruthy();
    expect(destroyed).toBe(true);
    expect(dt < 4000).toBeTruthy();
  } finally {
    if (prev.g === undefined) delete process.env.KHY_DB_QUERY_TIMEOUT; else process.env.KHY_DB_QUERY_TIMEOUT = prev.g;
    if (prev.s === undefined) delete process.env.KHY_DB_STATEMENT_TIMEOUT_MS; else process.env.KHY_DB_STATEMENT_TIMEOUT_MS = prev.s;
  }
});

test('mysql:门控关 →无墙钟兜底,直接 await execute(回退今日行为)', async () => {
  let raced = false;
  mockMysql.createConnection.mockImplementation(async () => ({
    execute: async () => {
      // 门控关时应被直接 await(而非进墙钟竞赛)。这里立即 resolve 一个正常结果。
      return [[{ n: 1 }], [{ name: 'n' }]];
    },
    destroy: () => { raced = true; },
    end: async () => {},
  }));

  const prev = process.env.KHY_DB_QUERY_TIMEOUT;
  process.env.KHY_DB_QUERY_TIMEOUT = 'off';
  try {
    const res = await tool.execute(
      { dialect: 'mysql', connection: 'mysql://u:p@127.0.0.1:3306/db', query: 'SELECT 1' },
      {},
    );
    expect(res.success).toBe(true);
    expect(res.rowCount).toBe(1);
    expect(raced).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.KHY_DB_QUERY_TIMEOUT; else process.env.KHY_DB_QUERY_TIMEOUT = prev;
  }
});
