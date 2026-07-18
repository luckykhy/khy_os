'use strict';

/**
 * traceChain.js — 轨迹防篡改哈希链（DESIGN-ARCH-047 PHASE 2）。
 *
 * 镜像 evoEngine/evoLedger 的「append-only prevHash→hash」单链，但作为**与 JSONL
 * transcript 并列的 sidecar 文件**（`<session>.trace-chain.json`）落盘，而不是把 hash
 * 折进 JSONL 行本身。理由（已在方案核实）：
 *   - JSONL 是 append-only、多消费者；逐行嵌 prevHash 会把每个 reader 耦合进链算，
 *     且单行损坏会污染整链重建。
 *   - sidecar 单 JSON 数组、evoLedger 式原子写（tmp+fsync+rename），热 append 路径
 *     （appendMessage 的 `fs.appendFileSync`）完全不变。
 *
 * 篡改证据 = 确定性 sha256 链（prevHash→hash），**跨进程可校验**：任何对盘上 JSONL
 * 内容或链文件的事后改动都会令 `verify()` 在首坏块处暴露。`contentHash` 把每条链记录
 * 绑定到消息内容（不拷贝正文），改正文 → contentHash 失配 → 断链。
 *
 * 另有可选的 per-entry HMAC `seal`（进程私有盐，复用 chaosInterceptor 思路）：仅防活
 * 会话内「能重算 sha256 的同进程攻击者」伪造，**不跨进程**——因此 `verify()` 默认只校验
 * 确定性链，绝不因跨进程读不出 seal 而误报断链（防呆②：断/缺链告警不 brick）。
 *
 * 全部 API 基于**显式绝对文件路径**（不依赖全局 dataHome），以便 sidecar 与会话 JSONL
 * 同目录共址；调用方（sessionPersistence）用同一套 `_resolvePath` 解析路径。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHAIN_VERSION = 1;
const GENESIS_PREV = '0'.repeat(64);
const CHAIN_EXT = '.trace-chain.json';

// 进程私有封印盐：不持久、不出进程。仅用于活会话内 seal 增益，跨进程不参与 verify。
const SEAL_SALT = crypto.randomBytes(16).toString('hex');

function _sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex');
}

/** 内容哈希：把消息内容绑定进链而不拷贝正文。 */
function contentHash(content) {
  if (content == null) return _sha256Hex('');
  if (typeof content === 'string') return _sha256Hex(content);
  try { return _sha256Hex(JSON.stringify(content)); } catch { return _sha256Hex(String(content)); }
}

/** 一条链记录的确定性内容哈希（不含 hash/seal 字段自身），跨进程稳定。 */
function _hashEntry(entry) {
  const basis = JSON.stringify({
    seq: entry.seq,
    uuid: entry.uuid,
    prevHash: entry.prevHash,
    producer: entry.producer,
    trust: entry.trust,
    contentHash: entry.contentHash,
    at: entry.at,
  });
  return crypto.createHash('sha256').update(basis).digest('hex');
}

/** per-entry 进程私有 HMAC 封印（活会话内防同进程伪造；跨进程不可验，故仅增益）。 */
function _seal(entry) {
  return crypto.createHmac('sha256', SEAL_SALT).update(entry.hash).digest('hex');
}

function _stamp() { try { return Date.now(); } catch { return 0; } }

/** 由会话 JSONL 路径派生并列的链文件路径（同目录、同 basename、换扩展名）。 */
function chainPathFor(jsonlPath) {
  const dir = path.dirname(jsonlPath);
  const base = path.basename(jsonlPath).replace(/\.jsonl$/i, '');
  return path.join(dir, `${base}${CHAIN_EXT}`);
}

function _readRaw(chainFile) {
  try {
    if (!fs.existsSync(chainFile)) return [];
    const arr = JSON.parse(fs.readFileSync(chainFile, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function _writeAtomic(chainFile, chain) {
  const dir = path.dirname(chainFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(chainFile)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(chain, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, chainFile);
}

/**
 * 追加一条链记录（唯一写入口；只增不改 —— 无 update/delete）。
 * @param {string} chainFile  绝对路径（chainPathFor 派生）
 * @param {object} record  { uuid, producer, trust, content?|contentHash? }
 * @returns {{ok:boolean, seq?:number, hash?:string, error?:string}}
 */
function append(chainFile, record = {}) {
  try {
    const chain = _readRaw(chainFile);
    const prev = chain.length ? chain[chain.length - 1] : null;
    const entry = {
      version: CHAIN_VERSION,
      seq: chain.length,
      uuid: record.uuid == null ? null : String(record.uuid),
      prevHash: prev ? prev.hash : GENESIS_PREV,
      producer: record.producer == null ? null : String(record.producer),
      trust: record.trust == null ? null : String(record.trust),
      contentHash: record.contentHash != null
        ? String(record.contentHash)
        : contentHash(record.content),
      at: record.at != null ? record.at : _stamp(),
    };
    entry.hash = _hashEntry(entry);
    entry.seal = _seal(entry);
    chain.push(entry);
    _writeAtomic(chainFile, chain);
    return { ok: true, seq: entry.seq, hash: entry.hash };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 读取整条链（拷贝）。 */
function read(chainFile) {
  return _readRaw(chainFile);
}

/**
 * 校验链完整性：逐条重算确定性 hash 并核对 prevHash 链接。任何篡改/断链定位到首坏块。
 * 仅依赖确定性 sha256 链，**跨进程可校验**；seal 不参与（跨进程不可验，避免误报）。
 * @returns {{ok, available, length, brokenAt, reason}}
 */
function verify(chainFile) {
  if (!fs.existsSync(chainFile)) {
    return { ok: false, available: false, length: 0, brokenAt: null, reason: 'chain 文件不存在' };
  }
  const chain = _readRaw(chainFile);
  let prevHash = GENESIS_PREV;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    if (e.seq !== i) {
      return { ok: false, available: true, length: chain.length, brokenAt: i, reason: `seq 不连续：期望 ${i} 实为 ${e.seq}` };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, available: true, length: chain.length, brokenAt: i, reason: `prevHash 断链于 #${i}` };
    }
    if (_hashEntry(e) !== e.hash) {
      return { ok: false, available: true, length: chain.length, brokenAt: i, reason: `内容哈希不匹配于 #${i}（疑似篡改）` };
    }
    prevHash = e.hash;
  }
  return { ok: true, available: true, length: chain.length, brokenAt: null, reason: null };
}

/**
 * 交叉校验链记录与对应 JSONL 条目的 contentHash 是否一致——抓「JSONL 正文被改而链未被
 * 重算」的篡改。entries 形如 appendMessage 写出的 `{uuid, content, _khyTrace}`。
 * @returns {{ok, available, length, brokenAt, reason}}
 */
function verifyAgainstEntries(chainFile, entries = []) {
  const base = verify(chainFile);
  if (!base.ok) return base;
  const chain = _readRaw(chainFile);
  const byUuid = new Map();
  for (const e of entries) if (e && e.uuid != null) byUuid.set(String(e.uuid), e);
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i];
    if (link.uuid == null) continue;
    const msg = byUuid.get(String(link.uuid));
    if (!msg) {
      return { ok: false, available: true, length: chain.length, brokenAt: i, reason: `链记录 #${i} 在 transcript 中缺失（uuid=${link.uuid}，疑似删行）` };
    }
    if (contentHash(msg.content) !== link.contentHash) {
      return { ok: false, available: true, length: chain.length, brokenAt: i, reason: `transcript 正文哈希不匹配于 #${i}（uuid=${link.uuid}，疑似改正文）` };
    }
  }
  return { ok: true, available: true, length: chain.length, brokenAt: null, reason: null };
}

module.exports = {
  CHAIN_VERSION,
  GENESIS_PREV,
  CHAIN_EXT,
  contentHash,
  chainPathFor,
  append,
  read,
  verify,
  verifyAgainstEntries,
  _hashEntry,
};
