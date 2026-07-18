'use strict';

/**
 * sessionForestService.js — 会话拓扑「森林」的薄壳服务(IO + 接线;算法在纯叶子)。
 *
 * 学自 Stello 的 orchestrator SDK:把磁盘上一堆 /fork 分叉(各自 metadata.forkedFrom
 * 反向边 + insight/memory 槽)**组织成一张可读的网**,并提供「读全部 digest」这一对
 * orchestrator 友好、零隐式 LLM 的数据接口。
 *
 * 复用既有、绝不另起炉灶:
 *   - 读:sessionPersistence.listPersistedSessions / loadSessionMeta(轻量,不重建消息链)
 *   - 写槽:sessionPersistence.updateSessionMetadata(就地改快照,镜像 renameSession)
 *   - 算法:cli/sessionTopology(buildForest / renderForestTree / buildHereLine,纯叶子)
 *   - 当前会话 id:ai.getLiveSessionId,退最近一条持久会话(对齐 handlers/fork._resolveSource)
 *
 * 门控:KHY_SESSION_TOPOLOGY(森林索引)默认开;关 → buildForest flat(平铺退化)。
 */

function _persistence() {
  return require('../sessionPersistence');
}

function _topology() {
  return require('../../cli/sessionTopology');
}

/** 当前 live 会话 id;无 live → 当前项目作用域最近一条持久会话。对齐 handlers/fork._resolveSource。 */
function getCurrentSessionId() {
  try {
    const ai = require('../../cli/ai');
    const liveId = ai.getLiveSessionId && ai.getLiveSessionId();
    if (liveId) return liveId;
  } catch { /* fall through */ }
  try {
    const sp = _persistence();
    const all = sp.listPersistedSessions({ limit: 200 });
    if (Array.isArray(all) && all.length > 0) {
      const cwd = process.cwd();
      const scoped = all.filter((s) => s && s.cwd === cwd);
      const pick = (scoped.length > 0 ? scoped : all)[0];
      if (pick && pick.sessionId) return pick.sessionId;
    }
  } catch { /* fall through */ }
  return null;
}

/** env 可覆盖的新近度阈值(ms)。默认 active=1h,idle=7d,超过 → archived。 */
function _statusThresholds(env) {
  const e = env || process.env || {};
  const a = Number(e.KHY_TOPOLOGY_ACTIVE_MS);
  const i = Number(e.KHY_TOPOLOGY_IDLE_MS);
  return {
    activeMs: Number.isFinite(a) && a > 0 ? a : 60 * 60 * 1000,
    idleMs: Number.isFinite(i) && i > 0 ? i : 7 * 24 * 60 * 60 * 1000,
  };
}

/** 由 updatedAt 新近度派生会话状态(khy 无显式会话状态机)。 */
function _deriveStatus(updatedAt, now, th) {
  const age = now - (Number(updatedAt) || 0);
  if (age <= th.activeMs) return 'active';
  if (age <= th.idleMs) return 'idle';
  return 'archived';
}

/**
 * 列出会话森林。读每条会话的快照 metadata(forkedFrom + 槽),派生 status,
 * 经纯叶子 buildForest 反推正向 children。
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {object} [opts.env=process.env]
 * @param {number} [opts.now=Date.now()]
 * @returns {{ forest, records, byMeta }}
 */
function listForest(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const th = _statusThresholds(env);
  const sp = _persistence();
  const topo = _topology();

  const listed = sp.listPersistedSessions({ limit: o.limit || 50 }) || [];
  const records = [];
  const byMeta = Object.create(null);
  for (const s of listed) {
    if (!s || !s.sessionId) continue;
    let meta = null;
    try { meta = sp.loadSessionMeta(s.sessionId); } catch { /* skip */ }
    const m = (meta && meta.metadata) || {};
    byMeta[s.sessionId] = meta || { sessionId: s.sessionId, metadata: {} };
    const label = s.title && s.title !== '(untitled)'
      ? s.title
      : (meta && meta.title) || (typeof m.title === 'string' && m.title) || s.title || '(untitled)';
    records.push({
      id: s.sessionId,
      parentId: m.forkedFrom || null,
      label,
      turnCount: s.messageCount || (meta && meta.messageCount) || 0,
      status: _deriveStatus(s.updatedAt || (meta && meta.updatedAt), now, th),
      updatedAt: s.updatedAt || (meta && meta.updatedAt) || 0,
    });
  }

  const flat = !topo.topologyEnabled(env);
  const forest = topo.buildForest(records, { flat });
  return { forest, records, byMeta };
}

/**
 * orchestrator-facing digest 列表(零隐式 LLM):每会话 {id,label,status,memory,insight}。
 * @param {object} [opts]
 * @param {string} [opts.status] 仅返回该 status 的会话
 * @returns {Array<{id,label,status,memory,insight,turnCount,depth,parentId}>}
 */
function listDigests(opts) {
  const o = opts || {};
  const { forest, byMeta } = listForest(o);
  const wantStatus = o.status ? String(o.status) : null;
  const out = [];
  for (const node of forest.nodes) {
    if (wantStatus && node.status !== wantStatus) continue;
    const m = (byMeta[node.id] && byMeta[node.id].metadata) || {};
    out.push({
      id: node.id,
      label: node.label,
      status: node.status,
      memory: typeof m.memory === 'string' ? m.memory : '',
      insight: typeof m.insight === 'string' ? m.insight : '',
      turnCount: node.turnCount,
      depth: node.depth,
      parentId: node.parentId,
    });
  }
  return out;
}

/** 取单个节点(forest 节点 + 其 metadata 槽)。 */
function getNode(sessionId) {
  if (!sessionId) return null;
  const { forest, byMeta } = listForest({});
  const node = forest.byId[sessionId];
  if (!node) return null;
  const m = (byMeta[sessionId] && byMeta[sessionId].metadata) || {};
  return { node, metadata: m };
}

// ── 刀 2:每轮注入 + 一次性 insight + memory 蒸馏 + 槽写入 ─────────────────

function _slots() {
  return require('../../cli/sessionSlots');
}

/**
 * 为「当前所在节点」产「你在这里」注入串(供 cli/ai.js chat() 每轮注入)。
 * 门控 KHY_SESSION_TOPOLOGY 关 → ''(buildForest flat 后无 children/路径,here-line 退化为根自身,
 * 但森林既已扁平,注入意义消失,故直接空串字节回退)。fail-soft:任何异常 → ''。
 * @param {object} [opts]
 * @returns {string}
 */
function buildHereLineForCurrent(opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    const topo = _topology();
    if (!topo.topologyEnabled(env)) return '';
    const current = o.currentId || getCurrentSessionId();
    if (!current) return '';
    const { forest } = listForest(o);
    if (!forest.byId[current]) return '';
    return topo.buildHereLine(forest, current);
  } catch {
    return '';
  }
}

/**
 * 一次性消费当前会话的 insight 槽(注入一次即清空)。门控 KHY_SESSION_SLOTS。
 * fail-soft:任何异常 → 空注入、不改盘。
 * @param {object} [opts]
 * @returns {{insightText:string, changed:boolean}}
 */
function consumeInsightForCurrent(opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    const slots = _slots();
    if (!slots.slotsEnabled(env)) return { insightText: '', changed: false };
    const current = o.currentId || getCurrentSessionId();
    if (!current) return { insightText: '', changed: false };
    const sp = _persistence();
    const meta = sp.loadSessionMeta(current);
    const m = (meta && meta.metadata) || {};
    const { insightText, changed } = slots.applyInsightOnce(m);
    if (changed) {
      // 清空 insight 槽(一次性);best-effort 回写,失败不影响本轮已取到的注入文本。
      try { sp.updateSessionMetadata(current, { insight: '' }); } catch { /* best-effort */ }
    }
    return { insightText, changed };
  } catch {
    return { insightText: '', changed: false };
  }
}

/** 写 insight 槽到指定会话(orchestrator SDK:putInsight)。门控 KHY_SESSION_SLOTS。 */
function putInsight(sessionId, text) {
  return _putSlot(sessionId, 'insight', text);
}

/** 写 memory 槽到指定会话(orchestrator SDK:putMemory)。memory 绝不自注入,仅外向读。 */
function putMemory(sessionId, text) {
  return _putSlot(sessionId, 'memory', text);
}

function _putSlot(sessionId, slot, text) {
  try {
    if (!sessionId) return false;
    const env = process.env;
    const slots = _slots();
    if (!slots.slotsEnabled(env)) return false;
    const sp = _persistence();
    const meta = sp.loadSessionMeta(sessionId);
    if (!meta) return false;
    const next = slots.writeSlot((meta && meta.metadata) || {}, slot, text);
    if (!next) return false;
    return sp.updateSessionMetadata(sessionId, { [slot]: next[slot] }) !== false;
  } catch {
    return false;
  }
}

/** env 可覆盖的 consolidate 节拍:每 N 轮蒸馏一次 memory。默认 5。 */
function _consolidateEvery(env) {
  const e = env || process.env || {};
  const n = Number(e.KHY_CONSOLIDATE_EVERY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/**
 * consolidate:每 N 轮把当前会话 history 蒸馏进 memory 槽(fire-and-forget)。
 * 学自 Stello 的 consolidate `.catch(()=>{})`:绝不阻塞/翻红当轮。
 *
 * 蒸馏分两级(诚实降级):
 *   - 确定性底座:sessionRecapService.generateRecap(messages).summary(零 LLM,离线可用)。
 *   - 可选 LLM 升级:若 llmGenerateSink 有 provider,best-effort 生成更好的摘要;失败 → 退底座。
 *
 * 门控 KHY_SESSION_SLOTS(memory 槽属三槽);关 → 不蒸馏。节拍由 KHY_CONSOLIDATE_EVERY 控。
 * @param {object} opts
 * @param {Array} opts.messages 当前会话消息(user/assistant)
 * @param {string} [opts.sessionId] 默认当前会话
 * @returns {Promise<{distilled:boolean, reason?:string, memory?:string}>}
 */
async function consolidateCurrent(opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    const slots = _slots();
    if (!slots.slotsEnabled(env)) return { distilled: false, reason: 'disabled' };

    const messages = Array.isArray(o.messages) ? o.messages : [];
    const sessionId = o.sessionId || getCurrentSessionId();
    if (!sessionId || messages.length === 0) return { distilled: false, reason: 'empty' };

    // 节拍:仅每 N 轮(轮 = user 消息)蒸馏一次。
    const turnCount = messages.filter((m) => m && m.role === 'user').length;
    const every = _consolidateEvery(env);
    if (turnCount === 0 || turnCount % every !== 0) return { distilled: false, reason: 'skip' };

    // 蒸馏:确定性底座 → 可选 LLM 升级。
    let memoryText = '';
    try {
      const recap = require('../sessionRecapService').generateRecap(messages);
      memoryText = (recap && recap.summary) || '';
    } catch { /* recap best-effort */ }
    try {
      const llmGenerate = require('../llmGenerateSink').getLlmGenerateProvider();
      if (typeof llmGenerate === 'function') {
        const prompt = _consolidatePrompt(messages, memoryText);
        const res = await llmGenerate(prompt, { maxTokens: 400, strictPreferred: false });
        if (res && res.success && res.content && String(res.content).trim()) {
          memoryText = String(res.content).trim();
        }
      }
    } catch { /* LLM upgrade best-effort → keep deterministic base */ }

    if (!memoryText) return { distilled: false, reason: 'nothing' };

    const next = slots.writeSlot({}, 'memory', memoryText);
    if (!next) return { distilled: false, reason: 'nothing' };
    const sp = _persistence();
    sp.updateSessionMetadata(sessionId, { memory: next.memory });
    return { distilled: true, memory: next.memory };
  } catch (e) {
    return { distilled: false, reason: 'error' };
  }
}

/** 确定性拼装 consolidate 提示串(零 LLM 副作用;只取最近若干轮,避免超长)。 */
function _consolidatePrompt(messages, base) {
  const recent = messages.slice(-20).map((m) => {
    const role = m && m.role === 'assistant' ? 'AI' : '用户';
    const content = typeof (m && m.content) === 'string' ? m.content : '';
    return `${role}: ${content.slice(0, 600)}`;
  }).join('\n');
  return [
    '把下面这段对话蒸馏成一段「外向摘要」(memory):它会被其它分支/orchestrator 读取,',
    '用来理解本分支聊了什么、得出什么结论、还留着什么待办。要点式、客观、不超过 6 行。',
    '绝不包含密钥/令牌。',
    base ? `已有粗摘要(供参考):${base}` : '',
    '---',
    recent,
  ].filter(Boolean).join('\n');
}

// ── 刀 3:跨支综合 ────────────────────────────────────────────────────────

/**
 * 跨支综合(学自 Stello «把线性对话炸开成一张网» 的收口):读遍**所有**分支 digest →
 * 经模型反思 → 给每个分支回写一条一次性 insight + 根节点回写网级 memory。
 *
 * 诚实降级:需 llmGenerate;无 provider / 调用失败 / 门控关 → 返回 {ok:false, reason},
 * **绝不**伪造综合(对齐 khy Tier-A 诚实降级)。算法(拼提示 / 解析回文)在纯叶子
 * crossBranchSynthesis;本函数只接线 IO(listDigests → llmGenerate → put*)。
 *
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, reason?:string, rootSynthesis?:string,
 *   perNodeInsight?:object, written?:{insights:number, rootId:string|null}, targetIds?:string[]}>}
 */
async function synthesize(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  let cbs;
  try { cbs = require('../../cli/crossBranchSynthesis'); } catch { return { ok: false, reason: 'error' }; }
  if (!cbs.synthesisEnabled(env)) return { ok: false, reason: 'disabled' };

  const digests = listDigests(o);
  if (!digests.length) return { ok: false, reason: 'empty' };

  const { prompt, targetIds } = cbs.planSynthesis(digests);

  let raw = null;
  try {
    const llmGenerate = require('../llmGenerateSink').getLlmGenerateProvider();
    if (typeof llmGenerate !== 'function') return { ok: false, reason: 'no-model', targetIds };
    const res = await llmGenerate(prompt, { maxTokens: 800, strictPreferred: false });
    if (!res || !res.success || !res.content || !String(res.content).trim()) {
      return { ok: false, reason: 'no-model', targetIds };
    }
    raw = String(res.content);
  } catch {
    return { ok: false, reason: 'no-model', targetIds };
  }

  const { perNodeInsight, rootSynthesis } = cbs.applySynthesis(raw, digests);

  // 逐节点 putInsight(把别支相关发现「投递」过去)。
  let insightCount = 0;
  for (const id of Object.keys(perNodeInsight)) {
    const txt = perNodeInsight[id];
    if (txt && putInsight(id, txt)) insightCount += 1;
  }

  // 根节点回写网级 memory(对齐 Stello:综合落在根的外向摘要)。
  let rootId = null;
  if (rootSynthesis) {
    try {
      const { forest } = listForest(o);
      const root = forest.roots && forest.roots[0];
      if (root) { rootId = root.id; putMemory(rootId, rootSynthesis); }
    } catch { /* best-effort */ }
  }

  return {
    ok: true,
    rootSynthesis,
    perNodeInsight,
    written: { insights: insightCount, rootId },
    targetIds,
  };
}

module.exports = {
  getCurrentSessionId,
  listForest,
  listDigests,
  getNode,
  // 刀 2:注入 + 槽。
  buildHereLineForCurrent,
  consumeInsightForCurrent,
  putInsight,
  putMemory,
  consolidateCurrent,
  // 刀 3:跨支综合。
  synthesize,
  // 暴露内部派生供测试。
  _deriveStatus,
  _statusThresholds,
  _consolidateEvery,
};
