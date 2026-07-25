'use strict';

/**
 * _dbTimeout.js — 给 databaseQuery 的 pg / mysql 网络路径解析**连接/语句超时选项**,根治
 * 「connect()/query() 零超时 → 不可达主机上真无限挂」这一类假死。
 *
 * 为什么要它:databaseQuery 的 `_runPostgres`/`_runMysql` 此前对 `client.connect()` 与
 * `client.query()` 不设任何超时。当主机不可达(丢包/防火墙静默丢弃 SYN)时,连接会挂到 TCP
 * 内核超时(分钟级)甚至永挂;调度层那道 120s `Promise.race` 软超时只会 reject 竞赛、**底层
 * 连接继续泄漏**。给驱动补上 native 超时后,驱动自身会在超时后抛错并释放连接,既不挂死也不泄漏。
 *
 * 各方言的 native 超时字段(单一事实来源,避免调用方各写各的):
 *   - postgres(pg):`connectionTimeoutMillis`(连接握手超时)+ `query_timeout`(单次 query 超时,
 *     客户端侧)+ `statement_timeout`(服务端 SET,双保险)。三者都是 pg.Client 构造选项。
 *   - mysql(mysql2):`connectTimeout`(连接握手超时,毫秒)。mysql2 无客户端 query 超时选项,
 *     故 query 侧由调用方用墙钟 `Promise.race` + 强制 `conn.destroy()` 兜(见 databaseQuery 接线)。
 *   - sqlite:本地文件,不涉网,不在此处理。
 *
 * 契约(纯叶子):除读 env 外零副作用、绝不抛、确定性。**门控关 ⇒ 返回空 delta(`{}`)⇒ 调用方
 * 展开后与今日选项逐字节一致**(无超时,今日行为)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_DB_QUERY_TIMEOUT          默认 on —— 总开关;关 → 所有 build* 返 `{}`(今日无超时)。
 *   KHY_DB_CONNECT_TIMEOUT_MS     默认 10000 —— 连接超时毫秒(numeric,clamp[500, 120000])。
 *   KHY_DB_STATEMENT_TIMEOUT_MS   默认 30000 —— 语句超时毫秒(numeric,clamp[1000, 600000])。
 */


const _isEnabled = require('../utils/isEnabledDefaultOn');

function _resolveMs(name, env, def, min, max) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('../services/flagRegistry');
    const v = flagRegistry.resolveNumeric(name, e);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* fall through */ }
  const raw = Number.parseInt((e && e[name]) || '', 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(max, Math.max(min, raw));
  return def;
}

/** 总开关:数据库超时是否启用。默认 on。 */
function isDbTimeoutEnabled(env) {
  return _isEnabled('KHY_DB_QUERY_TIMEOUT', env);
}

/** 连接超时(毫秒)。默认 10000,clamp[500, 120000]。 */
function resolveConnectTimeoutMs(env) {
  return _resolveMs('KHY_DB_CONNECT_TIMEOUT_MS', env, 10000, 500, 120000);
}

/** 语句超时(毫秒)。默认 30000,clamp[1000, 600000]。可传 overrideMs(模型/调用方入参)优先于 env。 */
function resolveStatementTimeoutMs(env, overrideMs) {
  const o = Number(overrideMs);
  if (Number.isFinite(o) && o > 0) return Math.min(600000, Math.max(1000, o));
  return _resolveMs('KHY_DB_STATEMENT_TIMEOUT_MS', env, 30000, 1000, 600000);
}

/**
 * postgres(pg.Client)超时选项 delta。门控关 → `{}`(今日无超时)。
 * 调用方把它并进传给 `new pg.Client({...})` 的对象;connectionString 形式先归一成对象再并。
 * @param {object} [env]
 * @param {number} [overrideStatementMs] 模型/调用方入参,优先于 env 语句超时。
 * @returns {{connectionTimeoutMillis?:number, query_timeout?:number, statement_timeout?:number}}
 */
function buildPostgresTimeoutOptions(env, overrideStatementMs) {
  if (!isDbTimeoutEnabled(env)) return {};
  const connectMs = resolveConnectTimeoutMs(env);
  const stmtMs = resolveStatementTimeoutMs(env, overrideStatementMs);
  return {
    connectionTimeoutMillis: connectMs,
    query_timeout: stmtMs,
    statement_timeout: stmtMs,
  };
}

/**
 * mysql(mysql2)连接超时选项 delta。门控关 → `{}`(今日无超时)。
 * mysql2 无客户端 query 超时字段,故只出 connectTimeout;query 侧墙钟兜底在调用方。
 * @returns {{connectTimeout?:number}}
 */
function buildMysqlConnectOptions(env) {
  if (!isDbTimeoutEnabled(env)) return {};
  return { connectTimeout: resolveConnectTimeoutMs(env) };
}

module.exports = {
  isDbTimeoutEnabled,
  resolveConnectTimeoutMs,
  resolveStatementTimeoutMs,
  buildPostgresTimeoutOptions,
  buildMysqlConnectOptions,
};
