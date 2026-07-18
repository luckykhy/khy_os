'use strict';

/**
 * intentWeaver.js — L1「意图织网」坍缩器（DESIGN-ARCH-036 §3.2，骨架强制实现项 IntentWeaver）。
 *
 * 把含时序/因果/条件依赖的复合需求织成有向无环图（TaskGraph），而非扁平列表（防呆②）。
 *
 * 流程：
 *   1. 按连接词把整段切成有序子句，同时记录“连接词类型”（决定边的语义）。
 *   2. 每个子句下沉到 L0 dimensionReducer.reduceClause 取 { action, target, confidence }。
 *   3. 相邻子句之间按连接词类型连边：
 *        如果/若/when/if   → cond 边，condition={ on:前驱, expect:true }
 *        否则/不然/else     → cond 边，condition={ on:最近条件源, expect:false }
 *        因为/所以/since/so → cause 边
 *        其余（然后/接着…） → seq 边
 *   产出经 forgeSchema.validateTaskGraph(opts.hadDependency=true) 把关：边必非空。
 *
 * 纯词法、零模型。连接词无法判定时退化为 seq（确定性优先，绝不“脑补”因果方向）。
 */

const { EntityRegistry } = require('./entityRegistry');
const { TaskGraph } = require('./taskGraph');
const { reduceClause, strategyForActions, _uid } = require('./dimensionReducer');

// 连接词 → 边类型。每条带捕获，用于在切分时同时识别“子句之间是什么关系”。
const CONNECTORS = [
  { re: /(否则|不然|要不然|else|otherwise)/i, kind: 'cond-false' },
  { re: /(如果|假如|若|一旦|当|if|when|once)/i, kind: 'cond-true' },
  { re: /(因为|由于|所以|因此|since|because|so that|therefore)/i, kind: 'cause' },
  { re: /(然后|接着|之后|再|随后|then|after that|next|and then)/i, kind: 'seq' },
  { re: /(并且|同时|以及|还要|and|also)/i, kind: 'seq' },
];

// Precomputed once at module load (Ch2「不要每轮重建可复用结构」). splitClauses is on
// the per-turn L1 structured-furnace path (weave → chaosInterceptor → toolUseLoop's
// maybeForgeStructuredIntent, default-on) and formerly rebuilt ~10 RegExp per clause
// segment from CONNECTORS[].re.source: one anchored full-match (`^(?:src)$`) plus one
// leading match (`^(?:src)`) per connector. The sources are static literals; both
// regexes are used via .test()/.replace() with NO /g flag, so shared non-global
// instances carry no lastIndex state and are byte-identical. CONNECTORS insertion
// order is preserved so first-match precedence (cond-false before cond-true) holds.
const _CONNECTOR_MATCHERS = CONNECTORS.map((c) => ({
  kind: c.kind,
  full: new RegExp(`^(?:${c.re.source})$`, 'i'),
  lead: new RegExp(`^(?:${c.re.source})`, 'i'),
}));

const SPLIT_RE =
  /(否则|不然|要不然|如果|假如|若|一旦|因为|由于|所以|因此|然后|接着|之后|随后|并且|同时|以及|还要|，|,|；|;|。|\b(?:else|otherwise|if|when|once|because|since|so that|therefore|then|after that|next|and then|and|also)\b)/i;

/** 切分为 [{ text, connector }]：connector 是该子句**前面**的连接词类型（首子句为 null）。 */
function splitClauses(raw) {
  const text = String(raw || '').trim();
  const parts = text.split(SPLIT_RE).filter((s) => s != null);
  const clauses = [];
  let pendingConnector = null;
  for (const seg of parts) {
    const piece = String(seg).trim();
    if (!piece) continue;
    // 判定：该 piece 本身是否“纯连接词”（整体即一个连接词）。
    const pureConn = _CONNECTOR_MATCHERS.find((m) => m.full.test(piece));
    if (pureConn) { pendingConnector = pureConn.kind; continue; }
    if (/^[，,；;。]$/.test(piece)) { pendingConnector = pendingConnector || 'seq'; continue; }
    // piece 内嵌前导连接词（如“如果A”未被标点切开）→ 抽出连接词作为本子句的入边类型。
    let connector = pendingConnector;
    let body = piece;
    for (const m of _CONNECTOR_MATCHERS) {
      if (m.lead.test(body)) { connector = m.kind; body = body.replace(m.lead, '').trim(); break; }
    }
    if (body) clauses.push({ text: body, connector: clauses.length === 0 ? null : (connector || 'seq') });
    pendingConnector = null;
  }
  return clauses;
}

function _edgeFor(connectorKind, prevUid, condSourceUid) {
  switch (connectorKind) {
    case 'cause':
      return { type: 'cause', condition: null };
    case 'cond-true':
      return { type: 'cond', condition: { on: prevUid, expect: true } };
    case 'cond-false':
      return { type: 'cond', condition: { on: condSourceUid || prevUid, expect: false } };
    default:
      return { type: 'seq', condition: null };
  }
}

/**
 * L1 主入口：复合 NL → TaskGraph payload。
 * @param {string} raw
 * @param {EntityRegistry} [registry]
 * @returns {object} TaskGraph payload（待 forgeSchema.validateTaskGraph 校验）
 */
function weave(raw, registry = new EntityRegistry()) {
  const clauses = splitClauses(raw);
  const graph = new TaskGraph();
  const nodeUids = [];
  const actions = [];

  clauses.forEach((c, i) => {
    const reduced = reduceClause(c.text, registry);
    const nodeUid = _uid('node', `${i}:${c.text}`);
    graph.addNode({
      uid: nodeUid,
      action: reduced.action,
      target: reduced.target,
      params: reduced.params,
      confidence: reduced.confidence,
    });
    nodeUids.push(nodeUid);
    actions.push(reduced.action);
  });

  // 织边：相邻子句按其连接词类型连接。记录最近一个条件源用于 else 回指。
  let lastCondSource = null;
  for (let i = 1; i < clauses.length; i++) {
    const prev = nodeUids[i - 1];
    const cur = nodeUids[i];
    const kind = clauses[i].connector || 'seq';
    if (kind === 'cond-true') lastCondSource = prev;
    const { type, condition } = _edgeFor(kind, prev, lastCondSource);
    graph.addEdge(prev, cur, type, condition);
  }

  const entities = {};
  for (const e of registry.list()) entities[e.uid] = e;

  return {
    kind: 'TaskGraph',
    uid: _uid('tg', raw),
    graph: graph.toJSON(),
    entities,
    confidence: Math.min(...clauses.map((c, i) => graph.nodes.get(nodeUids[i]).confidence), 1),
    strategy: strategyForActions(actions),
  };
}

module.exports = { weave, splitClauses, _edgeFor };
