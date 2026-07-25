'use strict';

/**
 * meshCore.js — 纯叶子:多实例协作网格的全部「判定 / 校验 / 信封 / 整形」逻辑(单一真源)。
 * 对齐 Claude Code 的多实例协作:同机上多个独立运行的 khy 实例互相发现(peers)、彼此 attach/detach、
 * 跨进程互发消息(send)。
 *
 * 关键定位(先核实再动手的结论):khy 既有的 coordinator/teammate/arena 全是**单进程内**多 agent,
 * remote 是**跨机 SSH**;没有「同机多个独立 khy 实例」的在册表 + 跨进程信箱。本族补的正是这个缺口。
 *
 * 契约:零 IO(不碰 fs/网络/子进程/进程信号,只读 process.env 做门控)、确定性(不依赖时钟/随机,
 * 时间与 id 的随机部分由薄 IO 层生成后传入)、绝不抛(fail-soft)、env 门控 KHY_MESH 默认开。
 * 真正的在册文件读写 / 信箱 append-drain / 存活探测(process.kill)由薄 IO 层 meshStore 完成。
 * 单一真源:id 校验、信封格式、peer 清单排版只在这里;工具与 CLI 都委派本叶子。
 */

const STORE_VERSION = 1;
// 实例 id:字母数字开头,允许 . _ -(会话 id 形如 uuid;也容纳自定义短名)。
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_MESSAGE_CHARS = 8000;

// ── 门控 ─────────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  const raw = env && env.KHY_MESH;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * peer 会话区分标签是否开启(KHY_MESH_PEER_LABELS,default-on,CANON off)。
 * flagRegistry 优先,注册表不可用 → 本地 CANON(4 词)回退。绝不抛。
 */
function peerLabelsEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_MESH_PEER_LABELS', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_MESH_PEER_LABELS;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 校验 / 规范化 ────────────────────────────────────────────────────────────
function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}
function normalizeId(id) {
  const s = String(id == null ? '' : id).trim();
  return ID_RE.test(s) ? s : null;
}
function normalizeName(name) {
  return String(name == null ? '' : name).trim().slice(0, 64);
}
function truncateMessage(text) {
  const s = String(text == null ? '' : text);
  return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)}…[truncated]` : s;
}

/**
 * 由薄 IO 层传入的随机/时间部件拼出实例 id(确定性:同输入恒等同输出)。
 * @param {{time:number, pid:number, rand:string, prefix?:string}} parts
 * @returns {string}
 */
function buildInstanceId(parts = {}) {
  const t = Number(parts.time) || 0;
  const pid = Number(parts.pid) || 0;
  const rand = String(parts.rand || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || '0';
  const prefix = normalizeId(parts.prefix) ? `${parts.prefix}-` : 'khy-';
  return `${prefix}${t.toString(36)}-${pid.toString(36)}-${rand}`;
}

// ── 信封 ─────────────────────────────────────────────────────────────────────
/**
 * 构造一条消息信封(供 append 到目标信箱)。校验 from/to 为合法 id、text 非空。
 * @param {{from:string,to:string,text:string,ts:number,id:string}} m
 * @returns {{ok:true, envelope:object}|{ok:false, error:string}}
 */
function buildEnvelope(m = {}) {
  const from = normalizeId(m.from);
  const to = normalizeId(m.to);
  if (!from) return { ok: false, error: `非法发送方 id「${m.from}」。` };
  if (!to) return { ok: false, error: `非法接收方 id「${m.to}」。` };
  const text = String(m.text == null ? '' : m.text);
  if (!text.trim()) return { ok: false, error: '消息内容不能为空。' };
  return {
    ok: true,
    envelope: {
      v: STORE_VERSION,
      type: 'message',
      id: normalizeId(m.id) || `${from}->${to}`,
      from,
      to,
      text: truncateMessage(text),
      ts: Number(m.ts) || 0,
    },
  };
}

/** 解析信箱里的一行 JSON 信封;损坏行 → null(fail-soft,绝不抛)。 */
function parseEnvelopeLine(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s) return null;
  try {
    const obj = JSON.parse(s);
    if (!obj || typeof obj !== 'object') return null;
    if (!isValidId(obj.from) || !isValidId(obj.to)) return null;
    return {
      type: obj.type === 'message' ? 'message' : 'message',
      id: typeof obj.id === 'string' ? obj.id : '',
      from: obj.from,
      to: obj.to,
      text: typeof obj.text === 'string' ? obj.text : '',
      ts: Number(obj.ts) || 0,
    };
  } catch {
    return null;
  }
}

// ── 整形 ─────────────────────────────────────────────────────────────────────
/** cwd 的末段目录名(兼容 / 与 \\ 分隔)。空/无 → ''。 */
function _cwdBasename(cwd) {
  const s = String(cwd == null ? '' : cwd).trim();
  if (!s) return '';
  const parts = s.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/** 实例 id 的末 8 字符(紧凑标签用;不用于寻址)。 */
function _shortId(id) {
  const s = String(id == null ? '' : id);
  return s.length > 8 ? s.slice(-8) : s;
}

/**
 * 为已整形并排序的 peer 列表就地追加会话区分标签(门控开时)。
 *   - cwdLabel:目录 basename;
 *   - label:名称优先,否则目录名;**同一 label 被 ≥2 个 peer 共享时按排序追加 #1/#2…**
 *     (同目录多窗口 → Khy-OS#1 / Khy-OS#2;唯一目录 → 纯目录名);label 底为空 → 退回 shortId;
 *   - shortId:末 8 字符。
 * 纯函数式派生,只加字段不改既有字段 → 门控关时整体跳过 = 逐字节回退。
 */
function _applyPeerLabels(out) {
  const base = out.map((p) => p.name || _cwdBasename(p.cwd));
  const freq = Object.create(null);
  for (const b of base) { if (b) freq[b] = (freq[b] || 0) + 1; }
  const seen = Object.create(null);
  for (let i = 0; i < out.length; i += 1) {
    const p = out[i];
    const b = base[i];
    let label;
    if (b) {
      if (freq[b] > 1) { seen[b] = (seen[b] || 0) + 1; label = `${b}#${seen[b]}`; }
      else label = b;
    } else {
      label = _shortId(p.id);
    }
    p.cwdLabel = _cwdBasename(p.cwd);
    p.shortId = _shortId(p.id);
    p.label = label;
  }
  return out;
}

/**
 * 把在册的 peer 原始记录整形成清单。已由薄 IO 层剔除死实例并算好信箱计数。
 * @param {Array<object>} records - [{id,name,pid,cwd,startedAt,attachedTo}]
 * @param {{inboxCounts?:object, selfId?:string, env?:object}} [opts]
 * @returns {Array<object>} 按 startedAt 升序、再按 id 升序
 */
function shapePeers(records, opts = {}) {
  if (!Array.isArray(records)) return [];
  const inboxCounts = (opts.inboxCounts && typeof opts.inboxCounts === 'object') ? opts.inboxCounts : {};
  const selfId = normalizeId(opts.selfId);
  const out = [];
  for (const r of records) {
    if (!r || typeof r !== 'object' || !isValidId(r.id)) continue;
    out.push({
      id: r.id,
      name: r.name || '',
      pid: Number(r.pid) || 0,
      cwd: r.cwd || '',
      startedAt: r.startedAt || '',
      attachedTo: r.attachedTo || '',
      inbox: Number(inboxCounts[r.id]) || 0,
      isSelf: selfId != null && r.id === selfId,
    });
  }
  out.sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (peerLabelsEnabled(opts.env)) _applyPeerLabels(out);
  return out;
}

function buildSendSummary(envelope) {
  if (!envelope || !envelope.ok) return envelope && envelope.error ? envelope.error : '发送失败。';
  const e = envelope.envelope;
  return `已发送给实例「${e.to}」(${e.text.length} 字)。对方下次 drain 信箱即可读到。`;
}

function buildPeersSummary(peers) {
  const n = Array.isArray(peers) ? peers.length : 0;
  if (n === 0) return '当前没有其它在线的 khy 实例。';
  return `当前在线 ${n} 个 khy 实例。`;
}

module.exports = {
  STORE_VERSION,
  ID_RE,
  MAX_MESSAGE_CHARS,
  isEnabled,
  peerLabelsEnabled,
  isValidId,
  normalizeId,
  normalizeName,
  truncateMessage,
  buildInstanceId,
  buildEnvelope,
  parseEnvelopeLine,
  shapePeers,
  buildSendSummary,
  buildPeersSummary,
};
