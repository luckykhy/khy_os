'use strict';

/**
 * gatewayLogLease/devLog.js — L1 开发者日志接收端。
 *
 * 被租界判为"对用户不可见但需留痕"的日志（非活跃适配器报错、游离后台异常、沙箱回放、
 * 全局未捕获摘要）落到这里。两层接收端，永不抢占用户 stdout：
 *
 *   ① 内存环形缓冲（始终在）：最近 N 条结构化事件，供 /gateways 排障或测试断言读取。
 *   ② debug.log 文件（可选）：env KHY_GATEWAY_LOG_LEASE_FILE 指定路径时，附加结构化行。
 *
 * 防呆：写文件失败绝不抛错、绝不回退到 stdout（回退到 stdout 等于又污染主流）；
 *       仅静默落入内存环，保证"未被选中的适配器报错绝不触发可见输出"。
 */

const fs = require('fs');

const RING_MAX = 500;
const _ring = [];
let _seq = 0;

function _filePath() {
  const p = process.env.KHY_GATEWAY_LOG_LEASE_FILE;
  return p && String(p).trim() ? String(p).trim() : null;
}

/**
 * 写一条 L1 事件。
 * @param {object} ev { kind, adapter, level, message, extra }
 */
function write(ev = {}) {
  _seq += 1;
  const rec = {
    seq: _seq,
    kind: String(ev.kind || 'log'),
    adapter: ev.adapter || null,
    level: ev.level || 'info',
    message: String(ev.message == null ? '' : ev.message),
    extra: ev.extra || null,
  };
  _ring.push(rec);
  if (_ring.length > RING_MAX) _ring.shift();

  const file = _filePath();
  if (file) {
    // 结构化单行 JSON；任何 I/O 失败都吞掉，绝不回退 stdout。
    try { fs.appendFileSync(file, JSON.stringify(rec) + '\n'); } catch { /* 静默：L1 不得污染主流 */ }
  }
  return rec;
}

/** 读取最近 n 条（默认全部）。供状态查询/测试。 */
function tail(n) {
  if (!n || n >= _ring.length) return _ring.slice();
  return _ring.slice(_ring.length - n);
}

/** 清空（测试用）。 */
function clear() {
  _ring.length = 0;
  _seq = 0;
}

module.exports = { write, tail, clear, RING_MAX };
