'use strict';

/**
 * gitignoreReviewStore.js — .gitignore 写入的「待审核队列」(薄壳 IO,单一真源)。
 *
 * 背景(为什么平行于 instructionReviewStore,而不复用它):
 *   提交前自检(§4)检出「本不该提交的文件」(密钥/大文件/产物)时,会**主动建议**把它们
 *   加进 .gitignore;`/gitignore add <pattern>` 也是主动写。按用户定案,主动写 .gitignore
 *   绝不绕过审核——先入本队列 pending,由用户 `approve` 后才真正落盘。
 *   instructionReviewStore 的 approve 硬编码 `appendQuickMemory`(写 khy.md,target/scope 枚举
 *   与 gitignore 无关),语义不同,故照抄其骨架与门控,平行新建。
 *
 * 落点:getDataDir('gitignore-review')/pending.json(与 instruction-review 同 data home 惯例)。
 *
 * 契约:
 *   - **入队前做 pattern 合法性校验**(替代 instruction 的注入扫描):非法/危险 glob 拒绝入队。
 *   - **去重**:同一组 patterns(归一排序后相同)已 pending → skip。
 *   - **approve** 才真正写文件(经 gitignoreService.appendPatterns 的幂等追加)。
 *   - 门控 KHY_GITIGNORE_REVIEW 默认开(∈{0,false,off,no} 关 → enqueue 恒 no-op;
 *     list/approve/discard 仍可用以清理历史 pending)。
 *   - **fail-soft**:任何 IO 异常 → { success:false, error },绝不抛进调用方。
 *
 * 本文件做 IO(读写 pending.json),是薄壳,不是纯叶子——不扫叶子契约。
 */

const fs = require('fs');
const path = require('path');

const _OFF = new Set(['0', 'false', 'off', 'no']);
const MAX_PENDING = 200;          // 队列上限,防失控堆积。
const MAX_PATTERNS = 100;         // 单条候选内 pattern 数上限。
const MAX_PATTERN_CHARS = 300;    // 单个 pattern 长度上限。

/** 门控:KHY_GITIGNORE_REVIEW 默认开,仅 {0,false,off,no} 关。 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_GITIGNORE_REVIEW;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_OFF.has(v);
}

function _pendingFile() {
  const { getDataDir } = require('../utils/dataHome');
  return path.join(getDataDir('gitignore-review'), 'pending.json');
}

function _readPending() {
  try {
    const file = _pendingFile();
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function _writePending(list) {
  const file = _pendingFile();
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf-8');
}

/**
 * 归一 + 校验一组 pattern。去空白、去空、去重、保序;拒绝明显非法/危险的:
 *   - 空;超长;含换行;含 NUL;
 *   - 绝对路径根 '/' 或纯 '.'/'..'(会忽略过多或无意义)。
 * @returns {{ok:boolean, patterns?:string[], error?:string}}
 */
function _sanitizePatterns(patterns) {
  const raw = Array.isArray(patterns) ? patterns : [];
  const seen = new Set();
  const out = [];
  for (const p of raw) {
    let s;
    try { s = String(p == null ? '' : p).trim(); } catch { s = ''; }
    if (!s) continue;
    if (s.length > MAX_PATTERN_CHARS) return { ok: false, error: `pattern 过长(>${MAX_PATTERN_CHARS}): ${s.slice(0, 40)}…` };
    if (/[\n\r\0]/.test(s)) return { ok: false, error: 'pattern 含非法字符(换行/NUL)' };
    if (s === '/' || s === '.' || s === '..') return { ok: false, error: `拒绝忽略过宽的路径: ${s}` };
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  if (out.length === 0) return { ok: false, error: '没有可用的 pattern(全为空或非法)' };
  if (out.length > MAX_PATTERNS) return { ok: false, error: `pattern 过多(>${MAX_PATTERNS})` };
  return { ok: true, patterns: out };
}

/** 确定性 id:序号 + 内容散列前缀(无随机、无时钟依赖)。 */
function _makeId(list, patterns) {
  let h = 5381;
  const s = patterns.join('\n');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  const hash = h.toString(36).slice(0, 6);
  const seq = list.length + 1;
  return `g${seq}-${hash}`;
}

/** 两组 pattern 是否等价(归一排序后相同)——去重判定用。 */
function _sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * 把一组 .gitignore pattern 加入待审核队列。
 *
 * @param {object} entry
 * @param {string[]} entry.patterns  要忽略的 pattern。
 * @param {string} [entry.reason]    来源原因(如 'precommit' | 'manual'),仅记录。
 * @param {string} [entry.source]    来源标签(auto | tool | cli),仅记录。
 * @param {string} [entry.cwd]       approve 时写 .gitignore 的目标目录(缺省 approve 时的 cwd)。
 * @param {Date}   [entry.now]       可注入时钟(确定性测试)。
 * @returns {{success:boolean, id?:string, skipped?:boolean, error?:string}}
 */
function enqueue(entry = {}) {
  try {
    if (!isEnabled()) return { success: false, error: 'gitignore review disabled (KHY_GITIGNORE_REVIEW=off)' };

    const san = _sanitizePatterns(entry && entry.patterns);
    if (!san.ok) return { success: false, error: san.error };
    const patterns = san.patterns;

    const reason = String((entry && entry.reason) || 'manual').trim().slice(0, 40) || 'manual';
    const source = String((entry && entry.source) || 'auto').trim().slice(0, 40) || 'auto';
    const cwd = (entry && entry.cwd) ? String(entry.cwd) : '';

    const list = _readPending();

    // 去重:同一组 pattern 已 pending → skip。
    if (list.some((e) => e && _sameSet(e.patterns, patterns))) {
      return { success: true, skipped: true };
    }
    if (list.length >= MAX_PENDING) {
      return { success: false, error: `待审核队列已满(>=${MAX_PENDING}),请先 /gitignore review 处理` };
    }

    const stamp = (entry.now instanceof Date ? entry.now : new Date()).toISOString();
    const id = _makeId(list, patterns);
    list.push({ id, patterns, reason, source, cwd, ts: stamp });
    _writePending(list);
    return { success: true, id };
  } catch (err) {
    return { success: false, error: `入队失败: ${(err && err.message) || err}` };
  }
}

/** 列出当前所有 pending 候选。fail-soft → []。 */
function list() {
  return _readPending();
}

/** pending 条数。fail-soft → 0。 */
function count() {
  try { return _readPending().length; } catch { return 0; }
}

/**
 * 批准一条候选:真正写入 .gitignore(经 gitignoreService.appendPatterns 幂等追加),
 * 成功后从 pending 移除。
 * @param {string} id
 * @param {object} [opts]
 * @param {string} [opts.cwd]  写入目录(缺省用候选记录的 cwd,再缺省当前 cwd)。
 * @returns {{success:boolean, file?:string, added?:string[], skipped?:string[], error?:string}}
 */
function approve(id, opts = {}) {
  try {
    const wanted = String(id || '').trim();
    if (!wanted) return { success: false, error: '需提供要批准的候选 id' };

    const listArr = _readPending();
    const idx = listArr.findIndex((e) => e && e.id === wanted);
    if (idx === -1) return { success: false, error: `未找到候选: ${wanted}` };

    const entry = listArr[idx];
    const cwd = (opts && opts.cwd) || entry.cwd || undefined;
    const gis = require('./gitignoreService');
    const res = gis.appendPatterns(cwd, entry.patterns, { header: `khy 待审核批准的忽略项(${entry.reason})` });
    if (!res || !res.success) {
      return { success: false, error: (res && res.error) || '写入 .gitignore 失败' };
    }

    listArr.splice(idx, 1);
    _writePending(listArr);
    return { success: true, file: res.file, added: res.added, skipped: res.skipped };
  } catch (err) {
    return { success: false, error: `批准失败: ${(err && err.message) || err}` };
  }
}

/** 丢弃一条候选(不写文件)。 */
function discard(id) {
  try {
    const wanted = String(id || '').trim();
    if (!wanted) return { success: false, error: '需提供要丢弃的候选 id' };
    const listArr = _readPending();
    const idx = listArr.findIndex((e) => e && e.id === wanted);
    if (idx === -1) return { success: false, error: `未找到候选: ${wanted}` };
    listArr.splice(idx, 1);
    _writePending(listArr);
    return { success: true };
  } catch (err) {
    return { success: false, error: `丢弃失败: ${(err && err.message) || err}` };
  }
}

/** 清空整个队列。 */
function clear() {
  try {
    _writePending([]);
    return { success: true };
  } catch (err) {
    return { success: false, error: `清空失败: ${(err && err.message) || err}` };
  }
}

module.exports = {
  isEnabled,
  enqueue,
  list,
  count,
  approve,
  discard,
  clear,
  MAX_PENDING,
  MAX_PATTERNS,
  MAX_PATTERN_CHARS,
};
