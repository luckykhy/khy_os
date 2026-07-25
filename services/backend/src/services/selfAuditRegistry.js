'use strict';

/**
 * selfAuditRegistry.js — khyos「自我认知」的确定性单一真源(纯叶子:零 IO、确定性、绝不抛、可单测)。
 *
 * goal(2026-07-04「khy 应该对自己的情况做到自知,当我问你觉得 khyos 最大的问题有哪些等时,
 * 需要能快速了解情况回复,做到在 khyos 上运行的模型自我充分认知」)。
 *
 * 问题定位:khyos 早有一份**自审报告**(#1..#7),它驱动了一整个「收敛/透明」修复族——
 *   #1 directiveRegistryAudit、#4 toolClusterActivation、#5 configureErrorShape、
 *   #6 visionRoutingTruth、#7 commandOverlapAudit ……但这份报告**只以散落的代码注释存在**,
 *   跑在 khyos 上的模型**读不到**。于是被问「khyos 最大的问题有哪些」时,模型只能凭空猜,
 *   谈不上「自知」。缺的不是修复,是把这份自审**变成模型可读的结构化真值**并推入系统提示。
 *
 * 本叶子把自审报告变成机器可读 SSOT(每条 {id,area,title,severity,status,mitigation}),并提供
 * 一段 token 高效的系统提示块(A 层),让模型在**回答前就已知道**自己的已评估问题、严重度、
 * 现状(已缓解/已处理/开放)与对应的缓解手段——被问时据实快答,不夸大、不装作全知。
 *
 * 零编造铁律:只收录**代码库里确有依据**的自审项(模块/门控可追溯)。原报告 #2/#3 在本代码库
 * 中**无任何缓解模块引用其编号**,故不臆造其标题——只在 meta.note 里如实说明「原报告含 7 项,
 * 本 build 仅追踪到有代码依据的 5 项;#2/#3 未在代码库记录」,让模型对「自己认知的边界」也自知。
 *
 * 契约:零 IO、确定性、绝不抛。env 门控 KHY_SELF_AUDIT_AWARENESS(默认开,仅显式 0/false/off/no
 * 关;关闭后 isEnabled 返 false、formatForSystemPrompt 返 '' → 接缝逐字节回退到「不注入」)。
 * 父门控经 flagRegistry 集中判定(CANON 词表),fail-soft 回退本地 CANON。
 *
 * @module services/selfAuditRegistry
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。优先走 flagRegistry(集中优先级 + dogfood),不可用时回退本地 CANON 词表。
 * 默认开,仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_SELF_AUDIT_AWARENESS', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_SELF_AUDIT_AWARENESS;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 系统提示自审块首行标记(便于接缝去重 / 测试定位)。
const SELF_AUDIT_MARKER = '## khyos 自我认知';

// 严重度枚举(展示排序用:critical > high > medium > low)。
const _SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// 现状枚举:mitigated=已上收敛/透明机制缓解;addressed=已修复;open=已知未解。
const _STATUS_ZH = { mitigated: '已缓解', addressed: '已处理', open: '开放', unknown: '未知' };

/**
 * 自审报告 SSOT。**只收录代码库确有依据的项**(mitigation 指向真实模块/门控,可被 grep 验证)。
 * 顺序 = 原报告编号;severity 采原报告口径(#1 标注「最严重」)。
 * 冻结每条 + 数组,防调用方原地改动真值(纯叶子对外只读)。
 * @type {ReadonlyArray<{id:string,area:string,title:string,severity:string,status:string,mitigation:string}>}
 */
const SELF_AUDIT_ITEMS = Object.freeze([
  Object.freeze({
    id: '#1',
    area: '系统提示/编排',
    title: '系统提示词膨胀 + 多协议冲突(叠加式协议堆叠、无编译期冲突检测)',
    severity: 'critical',
    status: 'mitigated',
    mitigation: 'directiveComposer 指令注册表 SSOT + directiveRegistryAudit 编译期一致性审计(未登记指令不再无声漂移进 protocol 兜底)',
  }),
  Object.freeze({
    id: '#4',
    area: '工具发现',
    title: '工具发现成本高(30 个工具默认 defer,子代理起手拿不到,ToolSearch 关键词召回不稳)',
    severity: 'high',
    status: 'mitigated',
    mitigation: 'toolClusterActivation 按用户输入的能力信号确定式预激活对应延迟工具簇(门控 KHY_TOOL_CLUSTER_ACTIVATION)',
  }),
  Object.freeze({
    id: '#5',
    area: '工具健壮性',
    title: 'Configure 工具不稳定,失败只返回裸 `Error: Unknown error`,无可诊断结构',
    severity: 'medium',
    status: 'addressed',
    mitigation: 'configureErrorShape 把配置失败规范成结构化错误(类别 + 可诊断字段),不再裸吞',
  }),
  Object.freeze({
    id: '#6',
    area: '多模态/路由',
    title: '无原生多模态能力 + 视觉路由链路不透明(主模型可能纯文本,答不出哪个模型能看图)',
    severity: 'high',
    status: 'mitigated',
    mitigation: 'visionRoutingTruth 两层透明:系统提示告知「视觉是路由而非原生」+ 网关据 visionCapability SSOT 据实列出可看图的真实模型并回显本轮实际路由(门控 KHY_VISION_ROUTING_TRUTH)',
  }),
  Object.freeze({
    id: '#7',
    area: '命令可发现性',
    title: '命令过载:173 条命令重叠(/schedule vs /cron、/push vs /repo publish…),别名无机器声明',
    severity: 'high',
    status: 'mitigated',
    mitigation: 'COMMAND_ALIASES 声明式别名 SSOT + commandOverlapAudit 守卫锁死 route 碰撞 + commandCatalog 按类别聚合/别名折叠面板(门控 KHY_COMMAND_PRIMARY_PANEL)',
  }),
]);

// 元信息:原报告规模 vs 本 build 追踪到的规模,如实标注编号缺口(模型对自知边界也要自知)。
const SELF_AUDIT_META = Object.freeze({
  reportedTotal: 7,          // 原自审报告条目数(#1..#7)
  trackedInCode: SELF_AUDIT_ITEMS.length,
  untracked: Object.freeze(['#2', '#3']), // 无代码依据、本 build 未追踪(不臆造其内容)
  note: '原自审报告含 7 项;本代码库仅有 5 项存在可追溯的缓解模块/门控。#2、#3 未在代码库记录,其内容不在此臆造。',
});

/** 返回自审项的浅拷贝数组(对外只读;元素本身已冻结)。 */
function getSelfAuditItems() {
  return SELF_AUDIT_ITEMS.slice();
}

/** 返回元信息(编号缺口如实标注)。 */
function getSelfAuditMeta() {
  return SELF_AUDIT_META;
}

/** 按展示口径排序:severity 升序(critical 先),同级保持原报告编号顺序。 */
function _sortedForDisplay() {
  return SELF_AUDIT_ITEMS
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => {
      const ra = _SEVERITY_RANK[a.it.severity] ?? 9;
      const rb = _SEVERITY_RANK[b.it.severity] ?? 9;
      return ra !== rb ? ra - rb : a.idx - b.idx;
    })
    .map((x) => x.it);
}

/**
 * 系统提示自审块(A 层)。token 高效:一行一项(编号 · 严重度/现状 · 标题 → 缓解)。门控关 → ''。
 * 让模型被问「khyos 最大的问题 / 你有哪些局限」时,不猜、据此快答,并诚实标注这是已评估的已知集。
 * @param {object} [opts]  {env}
 * @returns {string}
 */
function formatForSystemPrompt(opts = {}) {
  const o = opts || {};
  if (!isEnabled(o.env)) return '';
  const items = _sortedForDisplay();
  if (!items.length) return '';

  const lines = [SELF_AUDIT_MARKER + '(被问「khyos 最大的问题/你的局限」时据此据实回答,勿凭空猜)'];
  lines.push('khyos 有一份自审报告,已知问题(按严重度)及现状如下——这些是**已评估**的项,不是全部,不要夸大成「已完美」:');
  for (const it of items) {
    const sev = it.severity || 'medium';
    const st = _STATUS_ZH[it.status] || it.status || '未知';
    lines.push(`- ${it.id} [${sev}·${st}] ${it.title}${it.mitigation ? ` → 缓解:${it.mitigation}` : ''}`);
  }
  lines.push(`说明:${SELF_AUDIT_META.note}被追问细节时可用 KhySelf 工具或直接读自身源码(自审模块名见各条缓解)。`);
  return lines.join('\n');
}

/**
 * 人读/工具用摘要(KhySelf 的 self_audit action 消费)。返回结构化对象,绝不抛。
 * @param {object} [opts] {env}
 * @returns {{enabled:boolean, meta:object, items:Array}}
 */
function summarize(opts = {}) {
  const o = opts || {};
  return {
    enabled: isEnabled(o.env),
    meta: SELF_AUDIT_META,
    items: getSelfAuditItems(),
  };
}

module.exports = {
  isEnabled,
  SELF_AUDIT_MARKER,
  SELF_AUDIT_ITEMS,
  SELF_AUDIT_META,
  getSelfAuditItems,
  getSelfAuditMeta,
  formatForSystemPrompt,
  summarize,
};
