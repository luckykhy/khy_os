'use strict';

/**
 * dimensionReducer.js — L0「降维打击」坍缩器（DESIGN-ARCH-036 §3.2）。
 *
 * 把简单单任务自然语言剥去语气词，映射为标准动作原语 + 目标实体指针 + 原子参数，
 * 产出 ActionIntent。这是三级坍缩的最小单元——L1 织网器、L2 重构器都复用本模块
 * 对“单个子句”做降维（单一真源，动词表/实体抽取只此一份）。
 *
 * 纯函数式：不调用模型，仅词法映射。映射不中则 action=UNKNOWN（交由上层降级），
 * 绝不“脑补”一个动作（防呆④）。
 */

const crypto = require('crypto');
const S = require('../metaplan/constraintStrategy');
const { EntityRegistry } = require('./entityRegistry');
const { coerceVagueness, ACTION_PRIMITIVES } = require('./forgeSchema');

// 自然语言动词 → 标准动作原语。靠前的更具体，命中即停。
const VERB_MAP = [
  [/(新建|建立|创建|建个|写一个|写个|生成|create|new|scaffold|generate)/i, 'CREATE'],
  [/(删除|删掉|移除|清除|delete|remove|rm\b)/i, 'DELETE'],
  [/(修改|更新|改一下|改成|编辑|update|modify|edit)/i, 'UPDATE'],
  [/(移动|挪到|move|mv\b)/i, 'MOVE'],
  [/(复制|拷贝|copy|cp\b)/i, 'COPY'],
  [/(搜索|搜一下|查找|检索|search|find|grep)/i, 'SEARCH'],
  [/(分析|审查|评估|analyze|review|audit)/i, 'ANALYZE'],
  [/(运行|执行|跑一下|run|execute|exec)/i, 'EXECUTE'],
  [/(构建|编译|打包|build|compile|bundle)/i, 'BUILD'],
  [/(测试|跑测试|test)/i, 'TEST'],
  [/(部署|上线|发布|deploy|release|publish)/i, 'DEPLOY'],
  [/(通知|提醒|告知|notify|alert)/i, 'NOTIFY'],
  [/(等待|等到|稍等|wait|hold)/i, 'WAIT'],
  [/(获取|下载|拉取|抓取|fetch|download|pull)/i, 'FETCH'],
  [/(总结|归纳|概括|summari[sz]e)/i, 'SUMMARIZE'],
  [/(读取|查看|打开|看一下|read|open|view|cat)/i, 'READ'],
];

// 高风险动作 → 推荐更重的锁级（桥接 constraintStrategy，不自定义枚举）。
const RISKY_ACTIONS = new Set(['DELETE', 'DEPLOY', 'EXECUTE', 'MOVE', 'UPDATE', 'BUILD']);

// 语气词/礼貌前缀，降维时剥离。
const FILLER_RE = /^(请|帮我|麻烦|能不能|可以|帮忙|给我|我想|我要|想要|please|can you|could you|i want to|i'd like to)\s*/i;

function mapActionVerb(text) {
  for (const [re, action] of VERB_MAP) if (re.test(text)) return action;
  return 'UNKNOWN';
}

/** 从子句里抽取目标实体描述（文件名/引号串/动词后名词），登记到 registry 取 uid。 */
function extractTarget(text, registry) {
  // 1) 文件型 token（含扩展名）最具体。
  const fileTok = text.match(/[\w./-]+\.[A-Za-z0-9]{1,8}\b/);
  if (fileTok) return registry.mint('file', fileTok[0]);
  // 2) 引号包裹的对象。
  const quoted = text.match(/["'「『“]([^"'」』”]{1,40})["'」』”]/);
  if (quoted) return registry.mint('topic', quoted[1]);
  // 3) URL。
  const url = text.match(/https?:\/\/\S+/);
  if (url) return registry.mint('url', url[0]);
  // 4) 兜底：剥掉语气词与命中的动词后，剩余名词短语作 topic。
  let stripped = text.replace(FILLER_RE, '');
  for (const [re] of VERB_MAP) stripped = stripped.replace(re, '');
  const noun = stripped.replace(/[\s,，。.!！?？;；:：]+/g, ' ').trim();
  return registry.mint('topic', (noun || text.trim()).slice(0, 40) || '<unspecified>');
}

/** 推荐锁级：任一高风险动作 → Code_Hard，否则 Prompt_Soft（仍可被上层 escalate 加严）。 */
function strategyForActions(actions) {
  const risky = actions.some((a) => RISKY_ACTIONS.has(a));
  return risky ? S.STRATEGIES.CODE_HARD : S.STRATEGIES.PROMPT_SOFT;
}

function _uid(prefix, text) {
  return `${prefix}_${crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 8)}`;
}

/**
 * 把单个子句降维为一个节点骨架 { action, target, params, confidence }（不含 kind/uid）。
 * 供 L1/L2 逐子句复用。
 */
function reduceClause(clause, registry) {
  const text = String(clause || '').trim();
  const { clean, confidence } = coerceVagueness(text.replace(FILLER_RE, ''));
  const action = mapActionVerb(clean);
  const target = extractTarget(clean, registry);
  return { action, target: { uid: target }, params: {}, confidence };
}

/**
 * L0 主入口：整段输入 → ActionIntent。
 * @param {string} raw
 * @param {EntityRegistry} [registry]
 * @returns {object} ActionIntent payload（待 forgeSchema 校验）
 */
function reduce(raw, registry = new EntityRegistry()) {
  const node = reduceClause(raw, registry);
  const uid = _uid('ai', raw);
  const entities = {};
  for (const e of registry.list()) entities[e.uid] = e;
  return {
    kind: 'ActionIntent',
    uid,
    action: ACTION_PRIMITIVES.includes(node.action) ? node.action : 'UNKNOWN',
    target: node.target,
    params: node.params,
    confidence: node.confidence,
    strategy: strategyForActions([node.action]),
    entities,
  };
}

module.exports = {
  reduce,
  reduceClause,
  mapActionVerb,
  extractTarget,
  strategyForActions,
  RISKY_ACTIONS,
  _uid,
};
