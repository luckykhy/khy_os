'use strict';
/**
 * dbTimeout.integration.test.js �?证明 databaseQuery 的网络路径不再「零超时真无限挂」�?
 *
 * �?postgres(�?pg 驱动):连接一个不可路由主�?SYN 被黑�?,门控开 + �?connect 超时 �?
 *    必须在超时内**有界失败**(而非挂到内核 TCP 超时的分钟级)。这是「khy 调用工具卡死」在 DB
 *    路径上的真实回归守卫�?
 * �?mysql(注入假驱�?mysql2 未安�?:execute() 返回一�?*永不 resolve** �?promise 模拟挂死;
 *    门控开 + �?statement 超时 �?墙钟竞赛必须在超时内�?_query 错误返回,�?*强制 destroy 连接**
 *    (防泄�?。这直接证明 query 相的无限挂被兜住�?
 *
 * 运行:node --test services/backend/tests/tools/dbTimeout.integration.test.js
 */
const path = require('path');
const Module = require('module');
const TOOL_PATH = path.resolve(__dirname, '../../src/tools/databaseQuery.js');
function loadFreshTool() {
  delete require.cache[require.resolve(TOOL_PATH)];
  return require(TOOL_PATH);
}
test('postgres:不可达主�?�?门控开 + �?connect 超时下有界失�?不挂�?', async (t) => {
  try { require.resolve('pg'); } catch { t.skip('pg 未安�?跳过'); return; }
  const prev = { g: process.env.KHY_DB_QUERY_TIMEOUT, c: process.env.KHY_DB_CONNECT_TIMEOUT_MS };
  process.env.KHY_DB_QUERY_TIMEOUT = 'on';
  process.env.KHY_DB_CONNECT_TIMEOUT_MS = '1500';
  try {
    const tool = loadFreshTool();
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

describe('Db Timeout integration', () => {
  test('mysql:query 永不返回(挂死)�?墙钟超时兜住 + 强制 destroy(注入假驱�?', async () => {
      let destroyed = false;
      let ended = false;
      const fakeMysql = {
        createConnection: async () => ({
          execute: () => new Promise(() => { /* 永不 resolve:模拟挂死�?query */ }),
          destroy: () => { destroyed = true; },
          end: async () => { ended = true; },
        }),
      };
    
      // 拦截 require('mysql2/promise')(该包未安�?,�?_runMysql 拿到假驱动�?
      const origLoad = Module._load;
      Module._load = function (request, parentMod, isMain) {
        if (request === 'mysql2/promise') return fakeMysql;
        return origLoad.apply(this, arguments);
      };
    
      const prev = { g: process.env.KHY_DB_QUERY_TIMEOUT, s: process.env.KHY_DB_STATEMENT_TIMEOUT_MS };
      process.env.KHY_DB_QUERY_TIMEOUT = 'on';
      process.env.KHY_DB_STATEMENT_TIMEOUT_MS = '1000'; // clamp 下限,足够�?
      try {
        const tool = loadFreshTool();
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
        Module._load = origLoad;
        if (prev.g === undefined) delete process.env.KHY_DB_QUERY_TIMEOUT; else process.env.KHY_DB_QUERY_TIMEOUT = prev.g;
        if (prev.s === undefined) delete process.env.KHY_DB_STATEMENT_TIMEOUT_MS; else process.env.KHY_DB_STATEMENT_TIMEOUT_MS = prev.s;
      }
  });

  test('mysql:门控�?�?无墙钟兜�?逐字节回退今日:直接 await execute)', async () => {
      let raced = false;
      const fakeMysql = {
        createConnection: async () => ({
          execute: async () => {
            // 门控关时应被直接 await(而非进墙钟竞�?。这里立�?resolve 一个正常结果�?
            return [[{ n: 1 }], [{ name: 'n' }]];
          },
          destroy: () => { raced = true; },
          end: async () => {},
        }),
      };
      const origLoad = Module._load;
      Module._load = function (request) {
        if (request === 'mysql2/promise') return fakeMysql;
        return origLoad.apply(this, arguments);
      };
      const prev = process.env.KHY_DB_QUERY_TIMEOUT;
      process.env.KHY_DB_QUERY_TIMEOUT = 'off';
      try {
        const tool = loadFreshTool();
        const res = await tool.execute(
          { dialect: 'mysql', connection: 'mysql://u:p@127.0.0.1:3306/db', query: 'SELECT 1' },
          {},
        );
        expect(res.success).toBe(true);
        expect(res.rowCount).toBe(1);
        expect(raced).toBe(false);
      } finally {
        Module._load = origLoad;
        if (prev === undefined) delete process.env.KHY_DB_QUERY_TIMEOUT; else process.env.KHY_DB_QUERY_TIMEOUT = prev;
      }
  });

});

