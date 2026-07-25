'use strict';

/**
 * restoreEffectProbe.js — 雅可比透镜（有限差分效应探针），纯零 IO 判定叶子
 *
 * 一句话：把「死字段」的**静态**狩猎（grep 消费者是否为 0）升级成**动态**证明——
 * 逐字段扰动快照头、在一批上下文语料上跑还原判定面板、量出「这个字段到底动不动得了
 * 任何一道还原门」。字段的雅可比≈0（任何上下文扰动它、任何门都不反应）= **行为上证死**，
 * 无论它语法上是否「被读」。这恰好抓住静态 grep 会漏的「假消费者」死字段（读了但读完即弃）。
 *
 * 为什么要「一批上下文」而不是单个真头（源自 Anthropic「Verbalizable Representations Form a
 * Global Workspace」的 Jacobian lens：对一大批上下文求平均，才能把「恰好在这条 trace 里被用到」
 * 和「随时准备被用到（load-bearing）」区分开）：还原来源门 restoreProvenance 用的是**冗余 OR**
 * 信号（includesUncommitted===true || dirty===true 判脏；captureMode==='HEAD' || includesUncommitted
 * ===false 判净）。在真头上两个脏信号同时为真，单独扰动其一另一仍兜住 → 单上下文会把 captureMode /
 * includesUncommitted / dirty **误判成死字段**。用「隔离语料」（clean-head / clean-worktree /
 * dirty-flag 各让一个信号单独决定裁决）后，每个契约字段都能被某个上下文证明 load-bearing。
 *
 * 判定完全在这个叶子里（零 IO、零加密、可离线全测）；采事实（读 snapshot.json）在 CLI
 * scripts/restore-effect-probe.js。门面板（还原家族的纯叶）由 CLI 注入，本叶不 require 它们，
 * 保持可用 stub gate 独立单测。
 *
 * 密钥卫生（红线）：本叶**绝不读、绝不返回、绝不扰动任何密钥/口令/明文材料**——
 *   契约字段不含 crypto.salt / crypto.iv / crypto.authTag；extras 只扫顶层键、绝不下探 crypto，
 *   所以 salt/iv/authTag 的**值**永不离开判定、不进任何返回结构。裁决只含字段路径、效应标签、
 *   上下文名、门名——从不含快照头的任何取值。
 *
 * ── HOW-TO-EXTEND（抄写式）──────────────────────────────────────────────────
 * 新增一层还原门（如某个新的 header 字段消费者）后，若那个字段**必须**保持 load-bearing：
 *   1) 往 CONTRACT_FIELDS 追加 { path:'<header 字段的点路径>', wiredBy:'OPS-XXX' }；
 *   2) 若该字段只在某种上下文下才决定裁决（像 provenance 的 OR 冗余信号），
 *      往 buildContextCorpus() 追加一个**隔离该字段**的上下文，否则探针会把它误报成 dead；
 *   3) 绝不把仍无消费者的字段塞进契约来「凑绿」——契约里出现即代表「必须有门消费它」，
 *      dead 就是红灯，那正是本探针要抓的回归。
 * ────────────────────────────────────────────────────────────────────────────
 */

const STATUS_OK = 'ok';
const STATUS_REGRESSION = 'regression';
const STATUS_UNVERIFIABLE = 'unverifiable';

const EFFECT_LOAD_BEARING = 'load-bearing';
const EFFECT_DEAD = 'dead';
const EFFECT_LOAD_BEARING_EXTRA = 'load-bearing-extra';
const EFFECT_UNMONITORED = 'unmonitored';

// 确定性扰动量（绝不用随机 / 时间，保证可复现）。
const _FOREIGN_STR = 'khy-effect-probe-foreign-value';
const _FOREIGN_NUM = 1000003; // 一个大质数偏移；足以让 formatVersion 越界到 too-new

/**
 * 契约字段：还原家族各门**被接线去消费**的 header 字段。契约里出现 = 「必须有门消费它」。
 * 任何一个在整个语料上都不动任何门 → dead（回归 / 新死字段）→ 整体 ok:false。
 */
const CONTRACT_FIELDS = [
  { path: 'format', wiredBy: 'OPS-105' },
  { path: 'formatVersion', wiredBy: 'OPS-105' },
  { path: 'crypto.algo', wiredBy: 'OPS-110' },
  { path: 'crypto.kdf', wiredBy: 'OPS-110' },
  { path: 'plaintextFormat', wiredBy: 'OPS-108' },
  { path: 'layout', wiredBy: 'OPS-108' },
  { path: 'captureMode', wiredBy: 'OPS-107' },
  { path: 'includesUncommitted', wiredBy: 'OPS-107' },
  { path: 'dirty', wiredBy: 'OPS-107' },
  { path: 'gitCommit', wiredBy: 'OPS-107' },
];

// ── 纯工具（深克隆 / 点路径 get·set·delete，全部不改入参、绝不抛）────────────────

function _clone(o) {
  try { return JSON.parse(JSON.stringify(o)); } catch (_e) { return null; }
}

function _get(o, path) {
  if (!o || typeof o !== 'object') return undefined;
  return String(path).split('.').reduce((a, k) => (a == null ? a : a[k]), o);
}

/** 克隆后删除点路径末端键；父不存在 / 克隆失败 → null。 */
function _deletePath(o, path) {
  const c = _clone(o);
  if (!c || typeof c !== 'object') return null;
  const ks = String(path).split('.');
  let x = c;
  for (let i = 0; i < ks.length - 1; i++) {
    if (x == null || typeof x !== 'object') return null;
    x = x[ks[i]];
  }
  if (x == null || typeof x !== 'object') return null;
  delete x[ks[ks.length - 1]];
  return c;
}

/** 克隆后在点路径写入值（沿途缺失的对象补建）；克隆失败 → null。 */
function _setPath(o, path, v) {
  const c = _clone(o);
  if (!c || typeof c !== 'object') return null;
  const ks = String(path).split('.');
  let x = c;
  for (let i = 0; i < ks.length - 1; i++) {
    if (x[ks[i]] == null || typeof x[ks[i]] !== 'object') x[ks[i]] = {};
    x = x[ks[i]];
  }
  x[ks[ks.length - 1]] = v;
  return c;
}

// ── 门反应比较（把裁决压成 (status, ok) 键；门抛出也算一种反应）────────────────

function _verdictKey(v) {
  if (v && v.__threw) return 'threw';
  if (!v || typeof v !== 'object') return 'nil';
  const ok = v.ok === true ? '1' : v.ok === false ? '0' : '?';
  return String(v.status) + '|' + ok;
}

function _runGate(fn, header) {
  try { return fn(header); } catch (_e) { return { __threw: true }; }
}

/** 返回在该上下文里、其 (status,ok) 因扰动而改变的门名数组。 */
function _reactingGates(gates, baseHeader, perturbedHeader) {
  const changed = [];
  for (const g of gates) {
    const before = _verdictKey(_runGate(g.fn, baseHeader));
    const after = _verdictKey(_runGate(g.fn, perturbedHeader));
    if (before !== after) changed.push(g.name);
  }
  return changed;
}

// ── 扰动生成（确定性：DELETE + 同类型 foreign）─────────────────────────────────

function _perturbationsFor(header, path) {
  const out = [];
  const del = _deletePath(header, path);
  if (del) out.push(del);
  const cur = _get(header, path);
  const t = typeof cur;
  if (t === 'number') {
    const s = _setPath(header, path, cur + _FOREIGN_NUM); if (s) out.push(s);
  } else if (t === 'boolean') {
    const s = _setPath(header, path, !cur); if (s) out.push(s);
  } else if (t === 'string') {
    const s = _setPath(header, path, _FOREIGN_STR); if (s) out.push(s);
  } else {
    // 缺省 / 对象 / null：类型未知，两头都试（foreign 串 + foreign 数）。
    const s1 = _setPath(header, path, _FOREIGN_STR); if (s1) out.push(s1);
    const s2 = _setPath(header, path, _FOREIGN_NUM); if (s2) out.push(s2);
  }
  return out;
}

/** 探一个字段在整个语料上的效应，返回 { path, hits:[{context,gate}], perturbationsTried }。 */
function _probeField(path, contexts, gates) {
  const hits = [];
  let perturbationsTried = 0;
  for (const ctx of contexts) {
    const H = ctx.header;
    const perts = _perturbationsFor(H, path);
    for (const ph of perts) {
      perturbationsTried++;
      for (const gn of _reactingGates(gates, H, ph)) hits.push({ context: ctx.name, gate: gn });
    }
  }
  return { path, hits, perturbationsTried };
}

// ── 上下文语料：从一个基准头派生「隔离语料」，让每个 provenance 冗余信号能单独决定裁决 ──

/**
 * 从基准 header 派生一批上下文，使还原来源门的冗余 OR 信号（captureMode /
 * includesUncommitted / dirty）各自能被某个上下文单独证明 load-bearing。
 * 基准头非对象 → 只用它本身（探针会走 unverifiable）。
 */
function buildContextCorpus(baseHeader) {
  if (!baseHeader || typeof baseHeader !== 'object' || Array.isArray(baseHeader)) {
    return [{ name: 'base', header: baseHeader }];
  }
  const cleanHead = _clone(baseHeader);
  if (cleanHead) { cleanHead.captureMode = 'HEAD'; delete cleanHead.includesUncommitted; delete cleanHead.dirty; }
  const cleanWT = _clone(baseHeader);
  if (cleanWT) { cleanWT.captureMode = 'working-tree'; cleanWT.includesUncommitted = false; delete cleanWT.dirty; }
  const dirtyFlag = _clone(baseHeader);
  if (dirtyFlag) { dirtyFlag.captureMode = 'working-tree'; delete dirtyFlag.includesUncommitted; dirtyFlag.dirty = true; }
  return [
    { name: 'real', header: baseHeader },
    { name: 'clean-head', header: cleanHead },
    { name: 'clean-worktree', header: cleanWT },
    { name: 'dirty-flag', header: dirtyFlag },
  ].filter((c) => c.header != null);
}

// ── 顶层入口 ───────────────────────────────────────────────────────────────────

function _topLevelSegments(contract) {
  const set = new Set();
  for (const f of contract) set.add(String(f.path).split('.')[0]);
  return set;
}

/**
 * 有限差分效应探针。
 * @param {object} opts
 * @param {Array<{name:string, header:object}>} opts.contexts 上下文语料（≥1）。
 * @param {Array<{name:string, fn:(h:object)=>{status:string, ok:boolean}}>} opts.gates 注入的还原门面板。
 * @param {Array<{path:string, wiredBy:string}>} [opts.contract] 契约字段，缺省 CONTRACT_FIELDS。
 * @param {object} [opts.extrasFrom] 若提供，扫其顶层非契约键作 informational extras（不影响 ok）。
 * @returns {{status:string, ok:boolean, fields:Array, extras:Array, deadFields:Array,
 *            summary:object, contexts:Array<string>, reason:string}}
 *   ok===true 仅当 status==='ok'（有门、有上下文、零 dead 契约字段）。绝不抛、绝不含密钥值。
 */
function probeHeaderEffects(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const gates = Array.isArray(o.gates)
    ? o.gates.filter((g) => g && typeof g.fn === 'function' && typeof g.name === 'string')
    : [];
  const contexts = Array.isArray(o.contexts)
    ? o.contexts.filter((c) => c && typeof c === 'object')
    : [];
  const contract = Array.isArray(o.contract) && o.contract.length ? o.contract : CONTRACT_FIELDS;
  const ctxNames = contexts.map((c) => c.name);

  // 证据不足：没门或没上下文 → 无从证明任何字段有效应，绝不臆断绿。
  if (gates.length === 0 || contexts.length === 0) {
    return {
      status: STATUS_UNVERIFIABLE,
      ok: false,
      fields: [],
      extras: [],
      deadFields: [],
      summary: { contract: contract.length, loadBearing: 0, dead: 0, contexts: contexts.length, gates: gates.length },
      contexts: ctxNames,
      reason: '证据不足：未注入还原门面板或上下文语料为空，无法做有限差分效应探测（绝不臆断字段有效）',
    };
  }

  const fields = [];
  const deadFields = [];
  for (const cf of contract) {
    const r = _probeField(cf.path, contexts, gates);
    const effect = r.hits.length ? EFFECT_LOAD_BEARING : EFFECT_DEAD;
    if (effect === EFFECT_DEAD) deadFields.push(cf.path);
    fields.push({
      path: cf.path,
      wiredBy: cf.wiredBy,
      contract: true,
      effect,
      hits: r.hits,
      perturbationsTried: r.perturbationsTried,
    });
  }

  // informational extras：基准头里非契约的**顶层**键（绝不下探 crypto → 不碰 salt/iv/authTag）。
  const extras = [];
  const base = o.extrasFrom && typeof o.extrasFrom === 'object' && !Array.isArray(o.extrasFrom)
    ? o.extrasFrom : null;
  if (base) {
    const covered = _topLevelSegments(contract);
    for (const key of Object.keys(base)) {
      if (covered.has(key)) continue;
      const r = _probeField(key, contexts, gates);
      extras.push({
        path: key,
        contract: false,
        effect: r.hits.length ? EFFECT_LOAD_BEARING_EXTRA : EFFECT_UNMONITORED,
        hits: r.hits,
        perturbationsTried: r.perturbationsTried,
      });
    }
  }

  const loadBearing = fields.filter((f) => f.effect === EFFECT_LOAD_BEARING).length;
  const dead = deadFields.length;
  const ok = dead === 0;
  return {
    status: ok ? STATUS_OK : STATUS_REGRESSION,
    ok,
    fields,
    extras,
    deadFields,
    summary: { contract: contract.length, loadBearing, dead, contexts: contexts.length, gates: gates.length },
    contexts: ctxNames,
    reason: ok
      ? `全部 ${contract.length} 个契约字段在 ${contexts.length} 个上下文语料上均 load-bearing（每个都有门反应）：还原家族的字段接线无回归`
      : `死字段（回归）：${deadFields.join(', ')} —— 契约里声明「必须有门消费」的字段，扰动它任何门都不反应 = 消费者被摘/从未接线`,
  };
}

module.exports = {
  probeHeaderEffects,
  buildContextCorpus,
  CONTRACT_FIELDS,
  STATUS_OK,
  STATUS_REGRESSION,
  STATUS_UNVERIFIABLE,
  EFFECT_LOAD_BEARING,
  EFFECT_DEAD,
  EFFECT_LOAD_BEARING_EXTRA,
  EFFECT_UNMONITORED,
  _clone,
  _get,
  _deletePath,
  _setPath,
  _perturbationsFor,
  _reactingGates,
  _verdictKey,
};
