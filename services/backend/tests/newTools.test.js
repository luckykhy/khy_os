'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../src/tools/databaseQuery');
const http = require('../src/tools/httpRequest');
const gitLog = require('../src/tools/gitLog');

// 这些用例只覆盖「确定性」路径(不依赖真实网络/数据库/已装驱动),
// 故在任意环境下结果稳定。真实连接路径在集成环境验证。

test('databaseQuery:未配置方言 → CONFIG_MISSING', async () => {
  const prevD = process.env.KHY_DB_DIALECT; const prevU = process.env.KHY_DB_URL;
  delete process.env.KHY_DB_DIALECT; delete process.env.KHY_DB_URL;
  try {
    const r = await db.execute({ query: 'SELECT 1' }, {});
    assert.equal(r.success, false);
    assert.equal(r.code, 'CONFIG_MISSING');
    assert.equal(r.errorClass, 'CONFIG_MISSING');
  } finally {
    if (prevD !== undefined) process.env.KHY_DB_DIALECT = prevD;
    if (prevU !== undefined) process.env.KHY_DB_URL = prevU;
  }
});

test('databaseQuery:有方言无连接 → CONFIG_MISSING', async () => {
  const r = await db.execute({ query: 'SELECT 1', dialect: 'postgres' }, {});
  assert.equal(r.success, false);
  assert.equal(r.code, 'CONFIG_MISSING');
});

test('databaseQuery:只读模式拒绝写语句 → BAD_PARAM', async () => {
  const r = await db.execute(
    { query: 'DELETE FROM users', dialect: 'sqlite', connection: ':memory:' },
    {},
  );
  assert.equal(r.success, false);
  assert.equal(r.code, 'BAD_PARAM');
  assert.equal(r.errorClass, 'BAD_PARAM');
});

test('databaseQuery:只读放行 SELECT/WITH/PRAGMA(前缀识别·容注释)', async () => {
  // 这里只验证「不被只读护栏拦下」——即不会因 readonly 返回 BAD_PARAM。
  // 真正能否执行取决于驱动是否安装,故只断言 code !== BAD_PARAM。
  for (const q of ['SELECT 1', '  with t as (select 1) select * from t', '-- c\nSELECT 1', 'PRAGMA table_info(x)']) {
    const r = await db.execute({ query: q, dialect: 'postgres', connection: 'postgres://invalid:5432/x' }, {});
    assert.notEqual(r.code, 'BAD_PARAM', `只读查询不应被拦:${q}`);
  }
});

test('databaseQuery:postgres 驱动缺失 → MISSING_DEPENDENCY(若未装 pg)', async () => {
  let hasPg = true;
  try { require('pg'); } catch { hasPg = false; }
  const r = await db.execute({ query: 'SELECT 1', dialect: 'postgres', connection: 'postgres://x' }, {});
  if (!hasPg) {
    assert.equal(r.code, 'MISSING_DEPENDENCY');
    assert.equal(r.errorClass, 'MISSING_DEPENDENCY');
    assert.ok(r.meta && r.meta.install, '应给安装提示');
  } else {
    // 装了 pg:连不上 invalid host → SERVICE_UNAVAILABLE(不会是 MISSING_DEPENDENCY)
    assert.notEqual(r.code, 'MISSING_DEPENDENCY');
  }
});

test('httpRequest:非法 URL → BAD_PARAM', async () => {
  const r = await http.execute({ url: 'ht!tp://nope', method: 'GET' }, {});
  assert.equal(r.success, false);
  assert.equal(r.code, 'BAD_PARAM');
  assert.equal(r.errorClass, 'BAD_PARAM');
});

test('httpRequest:不支持的方法 → BAD_PARAM', async () => {
  const r = await http.execute({ url: 'https://example.com', method: 'TRACE' }, {});
  assert.equal(r.success, false);
  assert.equal(r.code, 'BAD_PARAM');
});

test('httpRequest:非 http(s) 协议 → BAD_PARAM', async () => {
  const r = await http.execute({ url: 'file:///etc/passwd', method: 'GET' }, {});
  assert.equal(r.success, false);
  assert.equal(r.code, 'BAD_PARAM');
});

test('三新工具均为 defineTool 产物(有 name/execute,行为标志已归一为谓词)', () => {
  for (const t of [db, http, gitLog]) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.execute, 'function');
    assert.equal(typeof t.isReadOnly, 'function'); // defineTool 把布尔归一成谓词
  }
  assert.equal(gitLog.name, 'gitLog');
  assert.equal(db.name, 'databaseQuery');
  assert.equal(http.name, 'httpRequest');
});
