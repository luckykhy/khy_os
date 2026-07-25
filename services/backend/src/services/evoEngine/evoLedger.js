'use strict';

/**
 * evoLedger.js — 不可变进化日志（防呆⑤）。
 *
 * 自举进化的「黑历史」绝不允许被模型篡改：每一次需求、生成的代码、沙箱判决、热载/回滚
 * 决策都以**append-only 哈希链**落盘。每条记录携带 `prevHash`，链式指向上一条，构成
 * 防篡改的 Merkle 式单链——任何中途改动都会令后续所有 `hash` 校验失败，`verify()` 立刻
 * 暴露断链位置。
 *
 * 设计要点：
 *   - 仅暴露 `append` / `read` / `verify`，**没有** update/delete API（结构性只增不改）。
 *   - 原子落盘（tmp+fsync+rename），整条链作为一个 JSON 数组持久化；崩溃不留半截。
 *   - 复用 `utils/dataHome.getProjectDataDir` 分桶，与既有持久化同一套项目领地。
 *
 * 注意：哈希链是「防篡改 evidence」而非「防写」——它不能阻止有人手改盘上文件，但任何手改
 * 都会被 `verify()` 当场抓出，从而满足「绝不允许模型篡改进化黑历史」的可审计铁律。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_VERSION = 1;
const GENESIS_PREV = '0'.repeat(64);

// 记录种类——覆盖一次演进闭环的全生命周期。
const KIND = Object.freeze({
  REQUIREMENT: 'requirement',   // 需求铸造
  CODE: 'code',                 // 自生成代码快照
  SANDBOX: 'sandbox',           // 沙箱判决
  HOTLOAD: 'hotload',           // 受控热载
  ROLLBACK: 'rollback',         // 回滚
  FUSE: 'fuse',                 // 熔断/只读锁
  ALERT: 'alert',               // 架构级人类告警
});

function _dir() {
  try {
    const { getProjectDataDir } = require('../../utils/dataHome');
    return getProjectDataDir('evo_engine');
  } catch {
    const os = require('os');
    return path.join(os.tmpdir(), 'khy-evo-engine');
  }
}

const _safe = require('../../utils/slugifyToken'); // 文件名安全化单一真源

function _file(branch) {
  return path.join(_dir(), `ledger.${_safe(branch || 'main')}.json`);
}

function _stamp() { try { return Date.now(); } catch { return 0; } }

/** 计算一条记录的内容哈希（不含 hash 字段自身）。 */
function _hashEntry(entry) {
  const basis = JSON.stringify({
    seq: entry.seq, kind: entry.kind, prevHash: entry.prevHash,
    payload: entry.payload, at: entry.at,
  });
  return crypto.createHash('sha256').update(basis).digest('hex');
}

function _readRaw(branch) {
  try {
    const f = _file(branch);
    if (!fs.existsSync(f)) return [];
    const arr = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function _writeRaw(branch, chain) {
  const dir = _dir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = _file(branch);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(chain, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * 追加一条记录（唯一的写入口；只增不改）。
 * @param {string} kind  KIND.*
 * @param {object} payload  任意可序列化负载（需求/代码/判决…）
 * @param {object} [opts] { branch }
 * @returns {{ok:boolean, seq?:number, hash?:string, error?:string}}
 */
function append(kind, payload, opts = {}) {
  try {
    const branch = opts.branch || 'main';
    const chain = _readRaw(branch);
    const prev = chain.length ? chain[chain.length - 1] : null;
    const entry = {
      version: LEDGER_VERSION,
      seq: chain.length,
      kind: String(kind || 'unknown'),
      prevHash: prev ? prev.hash : GENESIS_PREV,
      at: _stamp(),
      payload: payload == null ? null : payload,
    };
    entry.hash = _hashEntry(entry);
    chain.push(entry);
    _writeRaw(branch, chain);
    return { ok: true, seq: entry.seq, hash: entry.hash };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 读取整条链（拷贝）。 */
function read(opts = {}) {
  return _readRaw(opts.branch || 'main');
}

/**
 * 校验链完整性：逐条重算 hash 并核对 prevHash 链接。任何篡改/断链即定位到首个坏块。
 * @returns {{ok:boolean, length:number, brokenAt:(number|null), reason:(string|null)}}
 */
function verify(opts = {}) {
  const chain = _readRaw(opts.branch || 'main');
  let prevHash = GENESIS_PREV;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    if (e.seq !== i) {
      return { ok: false, length: chain.length, brokenAt: i, reason: `seq 不连续：期望 ${i} 实为 ${e.seq}` };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, length: chain.length, brokenAt: i, reason: `prevHash 断链于 #${i}` };
    }
    if (_hashEntry(e) !== e.hash) {
      return { ok: false, length: chain.length, brokenAt: i, reason: `内容哈希不匹配于 #${i}（疑似篡改）` };
    }
    prevHash = e.hash;
  }
  return { ok: true, length: chain.length, brokenAt: null, reason: null };
}

module.exports = {
  LEDGER_VERSION,
  GENESIS_PREV,
  KIND,
  append,
  read,
  verify,
  _hashEntry,
  _file,
};
