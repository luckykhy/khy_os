'use strict';

/**
 * restoreFieldAttribution.js — 字段-消费者归属探针（label-preservation），纯零 IO 判定叶子
 *
 * 一句话：效应探针（OPS-113）只**数**「某字段动了几道还原门」，它是 breadth-blind——只问
 * 「≥1 门反应吗？」。本层问一个**正交**的问题：那道反应的门，是不是这个字段**声明的属主门**？
 * 一次重构若把 `crypto.algo` 的效应从 `crypto(110)` 挪到了 `provenance(107)`，OPS-113 依旧全绿
 * （字段仍 ≥1 门反应），但这是**真串扰**——来源门（git 溯源）的裁决竟被加密算法左右 = 关注点
 * 泄漏（且若加密字段开始左右非加密裁决，还是安全隐患）。本探针专抓 OPS-113 看不见的这一类。
 *
 * 思想源自 Anthropic《Verbalizable Representations Form a Global Workspace in Language Models》
 * 的 §4.3.2 **label preservation**：广播头必须同时过两关——gain（把方向放大得够广，≈ OPS-113 的
 * 「有没有效应」）与 label preservation（把方向**忠实地映回它自己**，而不是把它和别的方向**打散**
 * 混在一起）。论文把这两条当作**独立**评分。本探针就是那第二条评分的对偶：
 *   OPS-113 = gain / breadth（字段有没有效应）；
 *   本层     = label preservation / attribution（效应打在**对**的门上没有）。
 *
 * 判定完全在这个叶子里（零 IO、可离线全测）：入参是 OPS-113 `probeHeaderEffects` 的结果
 * （fields[].wiredBy + fields[].hits[{context,gate}]），本叶只读**字段路径 / 属主 OPS 号 / 门名**，
 * 据此把每个契约字段的「实际反应门集」与「声明属主门」比对分档。采事实（跑还原门面板）在 CLI。
 *
 * 密钥卫生（红线）：本叶**绝不读、绝不返回、绝不扰动任何密钥/口令/明文材料**——入参 probeResult
 *   已由 OPS-113 保证不含快照头取值；本叶只碰字段路径与门名，输出只含路径、门名、OPS 号、归属标签，
 *   从不含任何 header 取值。crypto.salt/iv/authTag 既不在契约、其值也无从进入本层。
 *
 * ── HOW-TO-EXTEND（抄写式）──────────────────────────────────────────────────
 * 归属探针的「声明属主」直接取自 OPS-113 `CONTRACT_FIELDS` 每个字段的 `wiredBy`（如 'OPS-107'），
 * 与门名里的编号（如 'provenance(107)'）按**数字令牌**匹配。新增一层还原门后：
 *   1) 照 OPS-113 HOW-TO-EXTEND 往 CONTRACT_FIELDS 追加 { path, wiredBy:'OPS-XXX' }；
 *   2) 确保 CLI 门面板里那道门的**名字含相同编号**（如 'newgate(XXX)'），归属才对得上；
 *   3) 若某字段**本应**被多道门消费（真正的广播字段），把 wiredBy 写成含多个编号的串
 *      （如 'OPS-105+108'）——本叶按「门名含其中任一编号即算属主」判忠实，缺任一属主门 → partial。
 * ────────────────────────────────────────────────────────────────────────────
 */

const STATUS_OK = 'ok';
const STATUS_MISWIRED = 'miswired';
const STATUS_UNVERIFIABLE = 'unverifiable';

// 每字段归属分档。
const ATTR_FAITHFUL = 'faithful';       // 只反应它声明的属主门 = label preserved
const ATTR_CROSS_TALK = 'cross-talk';   // 反应了非属主门 = 串扰 / 关注点泄漏（scrambled label）
const ATTR_PARTIAL = 'partial';         // 多属主字段缺了某道声明的属主门（仅 wiredBy 多编号时可能）
const ATTR_DEAD = 'dead';               // 一门都不反应（OPS-113 领域，此处照实报，仍非 ok）
const ATTR_UNATTRIBUTED = 'unattributed'; // 字段无 wiredBy / 取不出编号 → 无从判归属，保守非 ok

/** 从 'OPS-107' / 'OPS-105+108' 抽出编号令牌数组（['107'] / ['105','108']）；取不出 → []。 */
function _opsNums(wiredBy) {
  if (typeof wiredBy !== 'string') return [];
  const m = wiredBy.match(/\d+/g);
  return Array.isArray(m) ? m : [];
}

/** 门名（如 'provenance(107)'）是否属于编号令牌 num（子串匹配数字令牌）。 */
function _gateHasNum(gateName, num) {
  return typeof gateName === 'string' && gateName.indexOf(num) !== -1;
}

/** 从一个字段的 hits 数组抽出去重后的实际反应门名集（稳定排序）。 */
function _distinctGates(hits) {
  const set = new Set();
  if (Array.isArray(hits)) {
    for (const h of hits) {
      if (h && typeof h.gate === 'string') set.add(h.gate);
    }
  }
  return Array.from(set).sort();
}

/**
 * 对单个字段判归属：给定实际反应门集与声明属主编号集，返回
 * { attribution, ownerGates, foreignGates, missingNums }。绝不抛。
 */
function _classifyField(actualGates, expectedNums) {
  if (!expectedNums.length) {
    return { attribution: ATTR_UNATTRIBUTED, ownerGates: [], foreignGates: actualGates.slice(), missingNums: [] };
  }
  const ownerGates = [];
  const foreignGates = [];
  for (const g of actualGates) {
    if (expectedNums.some((n) => _gateHasNum(g, n))) ownerGates.push(g);
    else foreignGates.push(g);
  }
  // 缺失的属主编号：声明了但没有任何实际门覆盖它。
  const missingNums = expectedNums.filter((n) => !actualGates.some((g) => _gateHasNum(g, n)));

  let attribution;
  if (actualGates.length === 0) {
    attribution = ATTR_DEAD;                    // 一门不反应
  } else if (foreignGates.length > 0) {
    attribution = ATTR_CROSS_TALK;              // 反应了非属主门 = 串扰（最毒，OPS-113 看不见）
  } else if (missingNums.length > 0) {
    attribution = ATTR_PARTIAL;                 // 只反应部分声明属主门（多属主字段才可能）
  } else {
    attribution = ATTR_FAITHFUL;                // 恰好只反应全部声明属主门
  }
  return { attribution, ownerGates, foreignGates, missingNums };
}

/**
 * 字段-消费者归属探针（label preservation 对偶）。
 * @param {object} opts
 * @param {object} opts.probeResult OPS-113 probeHeaderEffects 的结果：需含 fields[]（{path,wiredBy,hits}）。
 * @returns {{status:string, ok:boolean, fields:Array, offenders:Array, summary:object, reason:string}}
 *   ok===true 仅当 status==='ok'（有可判字段、且**每个**契约字段都 faithful）。绝不抛、绝不含密钥值。
 */
function assessFieldAttribution(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const pr = o.probeResult && typeof o.probeResult === 'object' ? o.probeResult : null;
  const rawFields = pr && Array.isArray(pr.fields) ? pr.fields : null;

  // 证据不足：上游探针没跑出字段（无门/无语料/畸形）→ 无从判归属，绝不臆断绿。
  if (!rawFields || rawFields.length === 0) {
    return {
      status: STATUS_UNVERIFIABLE,
      ok: false,
      fields: [],
      offenders: [],
      summary: { contract: 0, faithful: 0, crossTalk: 0, partial: 0, dead: 0, unattributed: 0 },
      reason: '证据不足：上游效应探针未产出任何字段（无门 / 无上下文语料 / 结果畸形），无法判定字段-消费者归属（绝不臆断忠实接线）',
    };
  }

  const fields = [];
  const offenders = [];
  const tally = { faithful: 0, crossTalk: 0, partial: 0, dead: 0, unattributed: 0 };
  for (const f of rawFields) {
    const path = f && typeof f.path === 'string' ? f.path : String(f && f.path);
    const wiredBy = f ? f.wiredBy : undefined;
    const expectedNums = _opsNums(wiredBy);
    const actualGates = _distinctGates(f && f.hits);
    const c = _classifyField(actualGates, expectedNums);

    if (c.attribution === ATTR_FAITHFUL) tally.faithful++;
    else if (c.attribution === ATTR_CROSS_TALK) tally.crossTalk++;
    else if (c.attribution === ATTR_PARTIAL) tally.partial++;
    else if (c.attribution === ATTR_DEAD) tally.dead++;
    else tally.unattributed++;

    const rec = {
      path,
      wiredBy: typeof wiredBy === 'string' ? wiredBy : null,
      expected: expectedNums,
      attribution: c.attribution,
      ownerGates: c.ownerGates,
      foreignGates: c.foreignGates,
      missingNums: c.missingNums,
    };
    fields.push(rec);
    if (c.attribution !== ATTR_FAITHFUL) offenders.push(rec);
  }

  const ok = offenders.length === 0;
  return {
    status: ok ? STATUS_OK : STATUS_MISWIRED,
    ok,
    fields,
    offenders,
    summary: {
      contract: fields.length,
      faithful: tally.faithful,
      crossTalk: tally.crossTalk,
      partial: tally.partial,
      dead: tally.dead,
      unattributed: tally.unattributed,
    },
    reason: ok
      ? `全部 ${fields.length} 个契约字段都只驱动其声明的属主门（label preserved）：还原家族字段-消费者归属无串扰、无错接`
      : `归属回归：${offenders.map((x) => `${x.path}[${x.attribution}${x.foreignGates.length ? '→' + x.foreignGates.join('/') : ''}]`).join(', ')} —— 字段驱动了非属主门（串扰/关注点泄漏）或缺失声明的属主门`,
  };
}

module.exports = {
  assessFieldAttribution,
  STATUS_OK,
  STATUS_MISWIRED,
  STATUS_UNVERIFIABLE,
  ATTR_FAITHFUL,
  ATTR_CROSS_TALK,
  ATTR_PARTIAL,
  ATTR_DEAD,
  ATTR_UNATTRIBUTED,
  _opsNums,
  _gateHasNum,
  _distinctGates,
  _classifyField,
};
