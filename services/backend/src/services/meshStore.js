'use strict';

/**
 * meshStore.js — 多实例协作网格的薄 IO 层(磁盘在册表 + 跨进程信箱),逻辑全部委派纯叶子 meshCore。
 *
 * 在册表落**底座领地** `~/.khyos/peers/`:
 *   - 每个在线 khy 实例一份 presence 文件 `<id>.json`(镜像 appRegistry 的「每条目一份 pidfile」惯例);
 *   - 存活判定 = process.kill(pid, 0)(镜像 daemonManager._isAlive),读清单时顺手剪除死实例;
 *   - 每个实例一份信箱 `<id>.inbox.jsonl`,send=原子 append 一行信封,drain=rename 抢占后读取并清空。
 *
 * 契约:任何读写异常 fail-soft;明文 id/消息不含密钥(密钥由 vault 族管,二者正交)。
 * 单一真源:id 校验 / 信封格式 / 清单排版全在 meshCore;本层只做 IO。
 *
 * @module services/meshStore
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { getBaseDataDir } = require('../utils/dataHome');
const core = require('./meshCore');

function _dir() { return getBaseDataDir('peers'); }                     // ~/.khyos/peers(已确保存在)
function _presenceFile(id) { return path.join(_dir(), `${id}.json`); }
function _inboxFile(id) { return path.join(_dir(), `${id}.inbox.jsonl`); }

/** 进程是否存活。EPERM(他人进程)按惯例当作不可达 → 不计入(同 daemonManager)。 */
function _isAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    // EPERM:进程存在但非本用户。同机同用户协作场景按存活处理更稳妥。
    return !!(e && e.code === 'EPERM');
  }
}

/** 读单份 presence;缺失/损坏 → null。绝不抛。 */
function _readPresence(id) {
  try {
    const raw = JSON.parse(fs.readFileSync(_presenceFile(id), 'utf-8'));
    if (!raw || typeof raw !== 'object' || !core.isValidId(raw.id)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 原子写 presence。绝不抛。 */
function _writePresence(record) {
  try {
    const dir = _dir();
    const tmp = path.join(dir, `.${record.id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
    fs.renameSync(tmp, _presenceFile(record.id));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 统计某信箱里待读消息行数(忽略空行)。 */
function _countInbox(id) {
  try {
    const raw = fs.readFileSync(_inboxFile(id), 'utf-8');
    let n = 0;
    for (const line of raw.split('\n')) { if (line.trim()) n += 1; }
    return n;
  } catch {
    return 0;
  }
}

/** 删除某实例的 presence + 信箱(死实例剪除 / 主动注销)。绝不抛。 */
function _purge(id) {
  for (const f of [_presenceFile(id), _inboxFile(id)]) {
    try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * 把当前实例登记进网格。id 缺省则按 时间+pid+随机 生成(委派 meshCore 拼装,确定性测试友好)。
 * @param {{id?:string, name?:string, pid?:number, cwd?:string, meta?:object}} [opts]
 * @returns {{ok:true, id:string, record:object}|{ok:false, error:string}}
 */
function register(opts = {}) {
  const pid = Number(opts.pid) || process.pid;
  let id = core.normalizeId(opts.id);
  if (!id) {
    id = core.buildInstanceId({
      time: Date.now(),
      pid,
      rand: crypto.randomBytes(3).toString('hex'),
      prefix: core.normalizeId(opts.name) || undefined,
    });
  }
  const existing = _readPresence(id);
  const record = {
    id,
    name: core.normalizeName(opts.name) || (existing && existing.name) || '',
    pid,
    cwd: String(opts.cwd || (existing && existing.cwd) || process.cwd() || ''),
    host: os.hostname(),
    startedAt: (existing && existing.startedAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attachedTo: (existing && existing.attachedTo) || '',
    meta: (opts.meta && typeof opts.meta === 'object') ? opts.meta : (existing && existing.meta) || {},
  };
  const w = _writePresence(record);
  if (!w.ok) return { ok: false, error: w.error || '登记失败' };
  return { ok: true, id, record };
}

/** 注销当前实例(退出时调用)。 */
function deregister(id) {
  const key = core.normalizeId(id);
  if (!key) return { ok: false, error: '非法实例 id' };
  _purge(key);
  return { ok: true };
}

/**
 * 列出在线 peer(自动剪除死实例),并带上各自待读信箱计数。
 * @param {{selfId?:string, prune?:boolean}} [opts]
 * @returns {Array<object>} 经 meshCore.shapePeers 整形
 */
function listPeers(opts = {}) {
  const prune = opts.prune !== false;
  let names = [];
  try {
    names = fs.readdirSync(_dir());
  } catch {
    return [];
  }
  const records = [];
  const inboxCounts = {};
  for (const f of names) {
    if (!f.endsWith('.json') || f.endsWith('.inbox.jsonl')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!core.isValidId(id)) continue;
    const rec = _readPresence(id);
    if (!rec) continue;
    if (!_isAlive(rec.pid)) {
      if (prune) _purge(id);
      continue;
    }
    records.push(rec);
    inboxCounts[id] = _countInbox(id);
  }
  return core.shapePeers(records, { inboxCounts, selfId: opts.selfId });
}

/** 取单份在线 peer presence(死/不存在 → null)。 */
function getPeer(id) {
  const key = core.normalizeId(id);
  if (!key) return null;
  const rec = _readPresence(key);
  if (!rec || !_isAlive(rec.pid)) return null;
  return rec;
}

/**
 * 给目标实例信箱投递一条消息(原子 append 一行)。
 * @param {string} fromId
 * @param {string} toId
 * @param {string} text
 * @returns {{ok:true, envelope:object}|{ok:false, error:string}}
 */
function send(fromId, toId, text) {
  const built = core.buildEnvelope({ from: fromId, to: toId, text, ts: Date.now() });
  if (!built.ok) return built;
  const target = getPeer(built.envelope.to);
  if (!target) return { ok: false, error: `目标实例「${built.envelope.to}」不在线或不存在。先用 \`khy mesh peers\` 查看。` };
  try {
    fs.appendFileSync(_inboxFile(built.envelope.to), `${JSON.stringify(built.envelope)}\n`, 'utf-8');
    return { ok: true, envelope: built.envelope };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 抽空(drain)某实例信箱:rename 抢占 → 读取 → 解析 → 返回。抢占保证并发投递不丢(投到新文件)。
 * @param {string} id
 * @returns {{ok:true, messages:Array<object>}|{ok:false, error:string}}
 */
function drainInbox(id) {
  const key = core.normalizeId(id);
  if (!key) return { ok: false, error: '非法实例 id' };
  const inbox = _inboxFile(key);
  let claimed;
  try {
    if (!fs.existsSync(inbox)) return { ok: true, messages: [] };
    claimed = path.join(_dir(), `.${key}.drain.${process.pid}.${Date.now()}.jsonl`);
    fs.renameSync(inbox, claimed);
  } catch {
    // 抢占失败(可能已被并发 drain 取走)→ 视为空。
    return { ok: true, messages: [] };
  }
  const messages = [];
  try {
    const raw = fs.readFileSync(claimed, 'utf-8');
    for (const line of raw.split('\n')) {
      const env = core.parseEnvelopeLine(line);
      if (env) messages.push(env);
    }
  } catch { /* fail-soft */ }
  try { fs.rmSync(claimed, { force: true }); } catch { /* best-effort */ }
  return { ok: true, messages };
}

/** 不取走、只统计某实例信箱待读数。 */
function peekInbox(id) {
  const key = core.normalizeId(id);
  if (!key) return 0;
  return _countInbox(key);
}

/**
 * 把 fromId 挂接到 toId(记录默认对端)。两端都需在线。
 * @returns {{ok:true, record:object}|{ok:false, error:string}}
 */
function attach(fromId, toId) {
  const selfKey = core.normalizeId(fromId);
  const toKey = core.normalizeId(toId);
  if (!selfKey) return { ok: false, error: '非法实例 id' };
  if (!toKey) return { ok: false, error: '非法目标 id' };
  const self = _readPresence(selfKey);
  if (!self) return { ok: false, error: `本实例「${selfKey}」未登记。先 register。` };
  if (!getPeer(toKey)) return { ok: false, error: `目标实例「${toKey}」不在线。` };
  self.attachedTo = toKey;
  self.updatedAt = new Date().toISOString();
  const w = _writePresence(self);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, record: self };
}

/** 解除 fromId 的挂接。 */
function detach(fromId) {
  const selfKey = core.normalizeId(fromId);
  if (!selfKey) return { ok: false, error: '非法实例 id' };
  const self = _readPresence(selfKey);
  if (!self) return { ok: true, record: null };
  self.attachedTo = '';
  self.updatedAt = new Date().toISOString();
  const w = _writePresence(self);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, record: self };
}

module.exports = {
  register,
  deregister,
  listPeers,
  getPeer,
  send,
  drainInbox,
  peekInbox,
  attach,
  detach,
  // 测试/诊断辅助
  _isAlive,
};
