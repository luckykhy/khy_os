'use strict';
const db = require('../src/tools/databaseQuery');
const http = require('../src/tools/httpRequest');
const gitLog = require('../src/tools/gitLog');
// 这些用例只覆盖「确定性」路�?不依赖真实网�?数据�?已装驱动),
// 故在任意环境下结果稳定。真实连接路径在集成环境验证�?

describe('New Tools', () => {
  test('databaseQuery:未配置方言 �?CONFIG_MISSING', async () => {
      const prevD = process.env.KHY_DB_DIALECT; const prevU = process.env.KHY_DB_URL;
      delete process.env.KHY_DB_DIALECT; delete process.env.KHY_DB_URL;
      try {
        const r = await db.execute({ query: 'SELECT 1' }, {});
        expect(r.success).toBe(false);
        expect(r.code).toBe('CONFIG_MISSING');
        expect(r.errorClass).toBe('CONFIG_MISSING');
      } finally {
        if (prevD !== undefined) process.env.KHY_DB_DIALECT = prevD;
        if (prevU !== undefined) process.env.KHY_DB_URL = prevU;
      }
  });

  test('databaseQuery:有方言无连�?�?CONFIG_MISSING', async () => {
      const r = await db.execute({ query: 'SELECT 1', dialect: 'postgres' }, {});
      expect(r.success).toBe(false);
      expect(r.code).toBe('CONFIG_MISSING');
  });

  test('databaseQuery:只读模式拒绝写语�?�?BAD_PARAM', async () => {
      const r = await db.execute(
        { query: 'DELETE FROM users', dialect: 'sqlite', connection: ':memory:' },
        {},
      );
      expect(r.success).toBe(false);
      expect(r.code).toBe('BAD_PARAM');
      expect(r.errorClass).toBe('BAD_PARAM');
  });

  test('databaseQuery:只读放行 SELECT/WITH/PRAGMA(前缀识别·容注�?', async () => {
      // 这里只验证「不被只读护栏拦下」——即不会�?readonly 返回 BAD_PARAM�?
      // 真正能否执行取决于驱动是否安�?故只断言 code !== BAD_PARAM�?
      for (const q of ['SELECT 1', '  with t as (select 1) select * from t', '-- c\nSELECT 1', 'PRAGMA table_info(x)']) {
        const r = await db.execute({ query: q, dialect: 'postgres', connection: 'postgres://invalid:5432/x' }, {});
        assert.notEqual(r.code, 'BAD_PARAM', `只读查询不应被拦:${q}`);
      }
  });

  test('databaseQuery:postgres 驱动缺失 �?MISSING_DEPENDENCY(若未�?pg)', async () => {
      let hasPg = true;
      try { require('pg'); } catch { hasPg = false; }
      const r = await db.execute({ query: 'SELECT 1', dialect: 'postgres', connection: 'postgres://x' }, {});
      if (!hasPg) {
        expect(r.code).toBe('MISSING_DEPENDENCY');
        expect(r.errorClass).toBe('MISSING_DEPENDENCY');
        expect(r.meta && r.meta.install).toBeTruthy();
      } else {
        // 装了 pg:连不�?invalid host �?SERVICE_UNAVAILABLE(不会�?MISSING_DEPENDENCY)
        assert.notEqual(r.code, 'MISSING_DEPENDENCY');
      }
  });

  test('httpRequest:非法 URL �?BAD_PARAM', async () => {
      const r = await http.execute({ url: 'ht!tp://nope', method: 'GET' }, {});
      expect(r.success).toBe(false);
      expect(r.code).toBe('BAD_PARAM');
      expect(r.errorClass).toBe('BAD_PARAM');
  });

  test('httpRequest:不支持的方法 �?BAD_PARAM', async () => {
      const r = await http.execute({ url: 'https://example.com', method: 'TRACE' }, {});
      expect(r.success).toBe(false);
      expect(r.code).toBe('BAD_PARAM');
  });

  test('httpRequest:�?http(s) 协议 �?BAD_PARAM', async () => {
      const r = await http.execute({ url: 'file:///etc/passwd', method: 'GET' }, {});
      expect(r.success).toBe(false);
      expect(r.code).toBe('BAD_PARAM');
  });

  test('三新工具均为 defineTool 产物(�?name/execute,行为标志已归一为谓�?', async () => {
      for (const t of [db, http, gitLog]) {
        expect(typeof t.name).toBe('string');
        expect(typeof t.execute).toBe('function');
        expect(typeof t.isReadOnly).toBe('function'); // defineTool 把布尔归一成谓�?
      }
      expect(gitLog.name).toBe('gitLog');
      expect(db.name).toBe('databaseQuery');
      expect(http.name).toBe('httpRequest');
  });

});

