'use strict';

/**
 * forgeSchema.js — 晶格铸造规范与手写校验器（DESIGN-ARCH-036 §3.3）。
 *
 * 坍缩产出必须满足三条机器可管理性铁律，本模块是其单一真源与校验闸：
 *
 *   原子性    每个节点/字段只表达一个不可再分语义 —— 值里不得残留并列/条件连接词，
 *             那意味着本该拆成边或属性（防呆③：禁止保留自然语言定语从句）。
 *   无歧义性  绝不允许“可能/大概/也许”等模糊词 —— 抽取阶段须先 coerceVagueness 把
 *             它转成 confidence 浮点或 status 枚举；校验阶段对残留模糊词一律拒收。
 *   可索引性  每个核心实体必带全局 UID；节点引用实体只能走 uid 指针，不得重复描述。
 *
 * 同时承接防呆②：含因果/时序依赖的输入必须织成 DAG（边非空），扁平列表判不合格。
 *
 * 与既有架构对齐：锁级不自定义枚举，桥接 metaplan/constraintStrategy（DESIGN-ARCH-034
 * 已确立“桥接不重定义”先例）。校验风格仿 metaplan/metaPlanSchema.validateMetaPlan：
 * 手写、fail-safe、返回 { valid, error } | { valid:true, normalized }，零外部依赖。
 */

const S = require('../metaplan/constraintStrategy');

// 标准动作原语 —— L0 降维的落点。模型/坍缩器只能映射到这张表内的动作，
// 杜绝把自然语言动词原样塞进结构（与 metaplan executorRegistry 的“武器库”同构思想）。
const ACTION_PRIMITIVES = Object.freeze([
  'CREATE', 'READ', 'UPDATE', 'DELETE', 'MOVE', 'COPY',
  'SEARCH', 'ANALYZE', 'EXECUTE', 'BUILD', 'TEST', 'DEPLOY',
  'NOTIFY', 'WAIT', 'FETCH', 'SUMMARIZE', 'UNKNOWN',
]);

// 模糊词：无歧义性铁律的黑名单（中英）。
const VAGUE_RE =
  /(可能|大概|也许|应该是|差不多|或许|说不定|看情况|随便|尽量)|\b(maybe|probably|perhaps|might|possibly|roughly|sort of|kind of|about|around)\b/i;

// 原子性破坏者：值里出现这些连接词 ⇒ 该值本该被拆成边/多属性。
const NON_ATOMIC_RE =
  /(并且|同时|然后|接着|如果|否则|因为|所以|以及|还要|，|,|；|;)|\b(and then|then|because|so that|in order to|if|else|after|before)\b/i;

// 定语从句标记：嵌套“的…的”，或英文 which/that/who 引导从句。
const RELATIVE_CLAUSE_RE = /的[^，。；,;]{4,}的|\b(which|that|who|whom|whose)\b/i;

/**
 * 把含模糊词的片段坍缩为 { clean, confidence } —— 抽取阶段调用。
 * 不“脑补”具体值，只把“模糊”这一事实量化为置信度并剥离模糊词，使产出无歧义。
 *
 * @param {string} text
 * @returns {{ clean:string, confidence:number, hadVague:boolean }}
 */
function coerceVagueness(text) {
  const raw = String(text || '');
  if (!VAGUE_RE.test(raw)) return { clean: raw.trim(), confidence: 1, hadVague: false };
  const clean = raw.replace(new RegExp(VAGUE_RE.source, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
  return { clean, confidence: 0.6, hadVague: true };
}

function isAtomic(value) {
  if (typeof value !== 'string') return true; // 非字符串（数值/枚举/uid）天然原子
  return !NON_ATOMIC_RE.test(value);
}

function hasRelativeClause(value) {
  return typeof value === 'string' && RELATIVE_CLAUSE_RE.test(value);
}

function _fail(error, missing) {
  return missing ? { valid: false, error, missing } : { valid: false, error };
}

function _checkStringField(label, value) {
  if (VAGUE_RE.test(String(value))) return `${label} 含模糊词（违反无歧义性，应先转为 confidence/枚举）`;
  if (hasRelativeClause(value)) return `${label} 含自然语言定语从句（违反防呆③，应拆为属性/关系边）`;
  if (!isAtomic(value)) return `${label} 非原子（含并列/条件连接词，应拆为多节点或边）`;
  return null;
}

/** 校验单个实体节点：必带 uid + type + 规范描述原子无歧义。 */
function _validateEntity(e) {
  if (!e || !e.uid) return '实体缺少 UID（违反可索引性）';
  if (!e.type) return `实体 ${e.uid} 缺少 type`;
  const err = _checkStringField(`实体 ${e.uid} 描述`, e.canonical || '');
  return err;
}

/** L0：ActionIntent。 */
function validateActionIntent(payload) {
  if (!payload || payload.kind !== 'ActionIntent') return _fail('kind 必须为 ActionIntent');
  const missing = [];
  if (!payload.uid) missing.push('uid');
  if (!ACTION_PRIMITIVES.includes(payload.action)) missing.push('action(必须是标准动作原语)');
  if (!payload.target || !payload.target.uid) missing.push('target.uid(目标实体指针)');
  if (typeof payload.confidence !== 'number') missing.push('confidence');
  if (missing.length) return _fail('ActionIntent 要素缺失', missing);

  if (!S.isStrategy(payload.strategy)) return _fail('strategy 非法（须为 constraintStrategy 枚举）');

  // 参数原子性 + 无歧义性。
  for (const [k, v] of Object.entries(payload.params || {})) {
    const err = _checkStringField(`params.${k}`, v);
    if (err) return _fail(err);
  }
  // 实体表逐一校验 + target 必须在实体表内（指针完整性）。
  const entities = payload.entities || {};
  for (const e of Object.values(entities)) {
    const err = _validateEntity(e);
    if (err) return _fail(err);
  }
  if (!entities[payload.target.uid]) return _fail('target.uid 未登记于 entities（悬空指针）');

  return { valid: true, normalized: payload };
}

/** L1：TaskGraph。含依赖必须是非空边的 DAG（防呆②）。 */
function validateTaskGraph(payload, opts = {}) {
  if (!payload || payload.kind !== 'TaskGraph') return _fail('kind 必须为 TaskGraph');
  if (!payload.uid) return _fail('TaskGraph 缺少 uid', ['uid']);
  const graph = payload.graph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return _fail('TaskGraph.graph 须含 nodes[] 与 edges[]');
  }
  if (graph.nodes.length === 0) return _fail('TaskGraph 至少一个节点', ['nodes']);

  // 防呆②：若来源含因果/时序依赖，则边不得为空（不允许退化成扁平列表）。
  if (opts.hadDependency && graph.edges.length === 0) {
    return _fail('含依赖的输入必须织成有向边，禁止扁平列表（防呆②）', ['edges']);
  }

  const nodeUids = new Set(graph.nodes.map((n) => n && n.uid));
  if (nodeUids.size !== graph.nodes.length) return _fail('存在重复/缺失的节点 uid（违反可索引性）');

  for (const n of graph.nodes) {
    if (!n.uid) return _fail('节点缺少 uid', ['node.uid']);
    if (!ACTION_PRIMITIVES.includes(n.action)) return _fail(`节点 ${n.uid} 的 action 非标准原语`);
    for (const [k, v] of Object.entries(n.params || {})) {
      const err = _checkStringField(`节点 ${n.uid} params.${k}`, v);
      if (err) return _fail(err);
    }
  }
  for (const e of graph.edges) {
    if (!nodeUids.has(e.from) || !nodeUids.has(e.to)) {
      return _fail(`边端点悬空（${e.from} -> ${e.to}）`);
    }
  }
  // 实体表 + 锁级。
  for (const ent of Object.values(payload.entities || {})) {
    const err = _validateEntity(ent);
    if (err) return _fail(err);
  }
  if (!S.isStrategy(payload.strategy)) return _fail('strategy 非法');

  return { valid: true, normalized: payload };
}

/** L2：StateMachine。 */
function validateStateMachine(payload) {
  if (!payload || payload.kind !== 'StateMachine') return _fail('kind 必须为 StateMachine');
  if (!payload.uid) return _fail('StateMachine 缺少 uid', ['uid']);
  const sm = payload.machine;
  if (!sm || !Array.isArray(sm.states) || !Array.isArray(sm.transitions)) {
    return _fail('StateMachine.machine 须含 states[] 与 transitions[]');
  }
  if (sm.states.length === 0) return _fail('StateMachine 至少一个状态', ['states']);
  if (!sm.initial) return _fail('StateMachine 缺少 initial 状态', ['initial']);

  const stateUids = new Set(sm.states.map((s) => s && s.uid));
  if (!stateUids.has(sm.initial)) return _fail('initial 不在状态集内');
  for (const t of sm.transitions) {
    if (!stateUids.has(t.from) || !stateUids.has(t.to)) {
      return _fail(`转移端点悬空（${t.from} -> ${t.to}）`);
    }
  }
  for (const ent of Object.values(payload.entities || {})) {
    const err = _validateEntity(ent);
    if (err) return _fail(err);
  }
  if (!S.isStrategy(payload.strategy)) return _fail('strategy 非法');

  return { valid: true, normalized: payload };
}

/** 统一分派校验。 */
function validate(payload, opts = {}) {
  const kind = payload && payload.kind;
  if (kind === 'ActionIntent') return validateActionIntent(payload);
  if (kind === 'TaskGraph') return validateTaskGraph(payload, opts);
  if (kind === 'StateMachine') return validateStateMachine(payload);
  return _fail(`未知坍缩产出 kind: ${kind}`);
}

module.exports = {
  ACTION_PRIMITIVES,
  VAGUE_RE,
  coerceVagueness,
  isAtomic,
  hasRelativeClause,
  validate,
  validateActionIntent,
  validateTaskGraph,
  validateStateMachine,
};
