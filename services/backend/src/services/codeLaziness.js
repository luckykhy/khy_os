'use strict';

/**
 * codeLaziness.js — 「懒人资深工程师 / 最小代码方法论」的单一真源
 * (goal 2026-06-27「让 Khyos 学习 ponytail 这个写代码的方法论,尽量用代码实现」)。
 *
 * 学习自 ponytail(「the lazy senior dev」):最好的代码是从不写的代码。核心是一道
 * 「懒人阶梯」—— 写任何代码前,停在第一条成立的横档上:
 *   1) 这功能根本需要存在吗?(YAGNI)
 *   2) 本仓里已经有了吗?(复用既有 helper/util/pattern,别重写)
 *   3) 标准库已经做了吗?
 *   4) 平台原生特性覆盖了吗?(<input type="date"> 胜过日期选择器库;CSS 胜过 JS)
 *   5) 已安装的依赖能解决吗?(绝不为几行能写的东西新加依赖)
 *   6) 能写成一行吗?
 *   7) 才轮到:写能工作的最小代码。
 * 配套铁律:不做未被请求的抽象;删除优先于新增;改 bug 修根因(grep 所有调用方,
 * 在共享函数里修一次)而非症状;故意的简化用 `// lazy:` 注释标注其上限与升级路径;
 * 非平凡逻辑留下「一个能跑的检查」。但绝不偷懒的事:理解问题、信任边界的输入校验、
 * 防数据丢失的错误处理、安全、无障碍、被显式要求的一切。
 *
 * 本叶子把这套方法论「尽量用代码实现」,而非仅写进散文提示词:
 *   - LADDER / RULES 是阶梯与铁律的数据 SSOT(指令、CLI、文档同源,改一处处处改);
 *   - detectCodingIntent 零假阳性地判定「用户在让 Khyos 写/改代码」,只在此时注入指令
 *     (写诗、翻译、解释概念都不触发,系统提示词字节不变);
 *   - buildLazinessDirective 产 [SYSTEM:] 指令,命令模型按阶梯写最小代码并用 `// lazy:`
 *     标注简化(支持强度 lite/full/ultra);
 *   - harvestDebtMarkers / summarizeDebt 是确定性的「债务台账」收割器(把模型留下的
 *     `lazy:` 标记汇成一张账,使「以后再说」不会悄悄变成「永远不做」)—— 与指令闭环。
 *
 * 与既有的区别(非重复):khyos 早已在 GUARDS/记忆里奉行「单一真源 / 先核实已存在再
 * 动手 / 删除优先 / 绝不重造平行体系」(= 同一哲学),也有 dead-code-audit 与
 * archDebtScan(= ponytail-audit);本叶子补的是两个真缺口:① 当 Khyos **自己写代码**
 * 时把阶梯作为确定性指令注入(此前无此指令);② `lazy:` 标记的确定性收割台账(此前无)。
 * 审查/审计沿用既有能力,刻意不另造一套(这本身就是阶梯第 2 档「已经有了就复用」)。
 *
 * 纯叶子:零 IO、确定性、绝不抛、单一真源、可单测。文件读取等 IO 留在调用方
 * (CLI handler 走树读文本后把 [{path,content}] 交给 harvestDebtMarkers)。
 * env 门控 KHY_CODE_LAZINESS(默认开,仅显式 0/false/off/no 关闭;关闭后
 * routeCodeLaziness 返回空指令,系统提示词字节不变)。
 */

// ── env 门控 ─────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _envVal(env, key) {
  return (env || process.env || {})[key];
}
function isEnabled(env) {
  const v = _envVal(env, 'KHY_CODE_LAZINESS');
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 数据 SSOT:阶梯 + 铁律 ────────────────────────────────────────────
// 改阶梯/铁律只改这里;指令、CLI ladder、文档都从这两张表派生。
const LADDER = [
  { n: 1, key: 'yagni', text: '这功能根本需要存在吗?投机性需求 → 跳过,并用一行说明。(YAGNI)' },
  { n: 2, key: 'reuse', text: '本仓已经有了吗?既有 helper/util/type/pattern → 复用;写之前先找,重复造已有逻辑是最常见的赘肉。' },
  { n: 3, key: 'stdlib', text: '标准库已经做了吗?用它。' },
  { n: 4, key: 'native', text: '平台原生特性覆盖了吗?<input type="date"> 胜过选择器库,CSS 胜过 JS,DB 约束胜过应用层代码。' },
  { n: 5, key: 'installed', text: '已安装的依赖能解决吗?用它;绝不为几行能写的东西新加依赖。' },
  { n: 6, key: 'oneline', text: '能写成一行吗?写成一行。' },
  { n: 7, key: 'minimum', text: '才轮到:写能工作的最小代码。' },
];

const RULES = [
  '不做未被请求的抽象:不为单一实现造接口,不为单一产物造工厂,不为永不改变的值造配置。',
  '删除优先于新增。无聊优先于聪明(聪明是别人凌晨三点要解读的东西)。文件数尽量少。',
  '改 bug 修根因不修症状:动手前 grep 你要改的函数的所有调用方,在共享函数里修一次 —— 比每个调用方各加一道守卫的 diff 更小,也不会漏修兄弟调用方。',
  '最短可工作 diff 取胜 —— 但只在你真正理解问题之后。放错地方的最小改动不是懒,是第二个 bug。',
  '两个标准库方案同样大?选边界情况正确的那个。懒 = 写更少代码,不是挑更脆弱的算法。',
  '故意的简化用 `// lazy:` 注释标注,让「简单」读作意图而非无知;有已知上限的捷径,注释要点名上限与升级路径(如 `// lazy: 全局锁,吞吐成瓶颈再换每账户锁`)。',
];

// 绝不偷懒的事(这些被简化掉 = 残缺,不是懒)。
const NEVER_LAZY = [
  '理解问题(读全、把真实流程从头到尾追一遍,再挑横档;不懂的小 diff 是伪装成效率的偷懒)',
  '信任边界的输入校验、防数据丢失的错误处理、安全、无障碍基本项',
  '真实硬件需要的校准(时钟会漂移、传感器会偏读 —— 留下校准旋钮,不是只留更少代码)',
  '被显式要求的一切(用户坚持要完整版 → 就建完整版,不再争辩)',
  '非平凡逻辑(分支/循环/解析器/金额或安全路径)留下「一个能跑的检查」:最小的、逻辑坏了就失败的 assert 自检或一个小测试文件;平凡一行无需测试。',
];

const LEVELS = ['lite', 'full', 'ultra'];
const DEFAULT_LEVEL = 'full';
function resolveLevel(env) {
  const v = String(_envVal(env, 'KHY_CODE_LAZINESS_LEVEL') || '').trim().toLowerCase();
  return LEVELS.includes(v) ? v : DEFAULT_LEVEL;
}

// ── 编码意图判定:零假阳性(动作词 + 代码对象,缺一不触发)──────────────
// 必须是「让 Khyos 写/改/造代码」的生产请求。写诗(写+诗,诗非代码对象)不触发;
// 解释代码(代码对象命中但动作是「解释」不在动作集)不触发 —— 那不需要写代码指令。
const _BUILD_VERB_RE = /(写|实现|编写|开发|构建|搭建|做一?个|做一?套|加|新增|增加|添加|改一?下|修改|重构|重写|优化|修复|修一?下|封装|生成|create|build|implement|write|add|refactor|rewrite|optimi[sz]e|fix|generate|scaffold|wire|hook\s+up|set\s+up)/i;
const _CODE_NOUN_RE = /(代码|函数|方法|脚本|程序|组件|模块|功能|特性|接口|端点|路由|类|服务|页面|按钮|表单|中间件|插件|工具|命令|算法|正则|bug|报错|错误|feature|function|method|script|program|component|module|endpoint|route|class|service|handler|middleware|plugin|api|cli\b|command|algorithm|regex|patch|wrapper|util)/i;
// 显式叫出 ponytail / 懒人模式 → 直接触发(尊重显式意图)。
const _EXPLICIT_LAZY_RE = /(懒人模式|偷懒模式|最小代码|最简实现|别过度设计|不要过度工程|ponytail|lazy\s+mode|be\s+lazy|yagni|minimal\s+(code|solution)|do\s+less|over[\s-]?engineer)/i;

/**
 * 判定用户消息是否是「让 Khyos 写/改代码」的请求。
 * @param {string} text
 * @returns {{ coding:boolean, reason:string, explicit:boolean }}
 */
function detectCodingIntent(text) {
  const t = String(text || '');
  if (!t.trim()) return { coding: false, reason: 'empty', explicit: false };
  if (_EXPLICIT_LAZY_RE.test(t)) return { coding: true, reason: 'explicit-lazy', explicit: true };
  if (_BUILD_VERB_RE.test(t) && _CODE_NOUN_RE.test(t)) {
    return { coding: true, reason: 'build-verb+code-noun', explicit: false };
  }
  return { coding: false, reason: 'no-coding-signal', explicit: false };
}

// ── 指令构建 ─────────────────────────────────────────────────────────
function _ladderLines() {
  return LADDER.map((r) => `  ${r.n}. ${r.text}`);
}
function _levelLine(level) {
  if (level === 'lite') return '强度 lite:按要求构建,但用一行点出更懒的替代方案让用户选。';
  if (level === 'ultra') return '强度 ultra:YAGNI 极端主义。删除先于新增。先交一行版,并在同一回复里质疑需求的其余部分。';
  return '强度 full(默认):阶梯强制执行。标准库与原生优先。最短 diff、最短解释。';
}

/**
 * 产出注入系统提示词的懒人方法论指令(coding 意图命中时)。
 * @param {{coding:boolean, explicit:boolean}} intent
 * @param {string} level - lite|full|ultra
 * @returns {string}
 */
function buildLazinessDirective(intent, level) {
  if (!intent || !intent.coding) return '';
  const lv = LEVELS.includes(level) ? level : DEFAULT_LEVEL;
  return [
    '[SYSTEM: 写代码时你是一位「懒人资深工程师」—— 懒 = 高效,不是马虎;最好的代码是从不写的代码。',
    '先彻底理解问题(读全任务与它触碰的代码、把真实流程追一遍),再爬这道阶梯,停在第一条成立的横档:',
    ..._ladderLines(),
    '铁律:',
    ...RULES.map((r) => `  • ${r}`),
    '改 bug 修根因不修症状(grep 所有调用方,在共享函数里修一次)。',
    '故意的简化必须留 `// lazy: <上限>, <升级路径>` 注释 —— Khyos 会确定性地把这些标记收割成债务台账(khy lazy debt)。',
    '非平凡逻辑留「一个能跑的检查」(最小 assert 自检或一个小测试),平凡一行无需测试。',
    '绝不偷懒的事:理解问题、信任边界输入校验、防数据丢失的错误处理、安全、无障碍、硬件校准、被显式要求的一切。',
    _levelLine(lv),
    '输出:代码优先,然后最多三行短句(跳过了什么、何时该加)。解释比代码长就删解释。',
    ']',
  ].join('\n');
}

/**
 * 编排:从用户消息判定编码意图并产出注入指令。镜像 routeGroundTruth 的契约。
 * @param {object} args
 * @param {string} args.text
 * @param {object} [args.env]
 * @returns {{intent:object, level:string, directive:string}}
 */
function routeCodeLaziness({ text = '', env } = {}) {
  if (!isEnabled(env)) return { intent: { coding: false, reason: 'disabled' }, level: resolveLevel(env), directive: '' };
  let intent;
  try { intent = detectCodingIntent(text); }
  catch { intent = { coding: false, reason: 'error', explicit: false }; }
  const level = resolveLevel(env);
  return { intent, level, directive: buildLazinessDirective(intent, level) };
}

// ── 债务标记收割(确定性,纯函数)─────────────────────────────────────
// 约定:`// lazy: <上限>, <升级路径>`(也认 `ponytail:`,因方法论同源)。逗号前是上限,
// 逗号后是升级触发器;无升级部分 → 标 no-trigger(会悄悄烂掉的那些)。
// 支持的注释前缀:// # -- /* * <!--(覆盖 js/py/sh/c/css/html 等常见栈)。
const MARKER_RE = /(?:\/\/|#|--|\/\*|\*|<!--)\s*(?:lazy|ponytail)\s*:\s*(.+?)\s*(?:\*\/|-->)?\s*$/i;
// 升级触发词:逗号分段之外的兜底,识别「无逗号但其实点了升级路径」的写法。
const _TRIGGER_RE = /(若|当|超过|一旦|需要|再换|再加|升级|upgrade|when|if|once|switch\s+to|replace\s+with|per[\s-])/i;

function _parseMarker(body) {
  const text = String(body || '').trim();
  const comma = text.search(/[,，]/);
  let ceiling = text;
  let upgrade = '';
  if (comma >= 0) {
    ceiling = text.slice(0, comma).trim();
    upgrade = text.slice(comma + 1).trim();
  }
  const hasTrigger = Boolean(upgrade) || _TRIGGER_RE.test(text);
  return { text, ceiling, upgrade, hasTrigger };
}

/**
 * 从已读入的文件内容里收割 lazy:/ponytail: 债务标记。零 IO —— 调用方负责读文件。
 * @param {Array<{path:string, content:string}>} files
 * @returns {Array<{file:string, line:number, text:string, ceiling:string, upgrade:string, hasTrigger:boolean}>}
 */
function harvestDebtMarkers(files) {
  const out = [];
  if (!Array.isArray(files)) return out;
  for (const f of files) {
    if (!f || typeof f.content !== 'string') continue;
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = MARKER_RE.exec(line);
      if (!m) continue;
      // 排除「仅在散文/文档里提到本约定」的假阳性:若标记落在反引号代码段内
      // (如文档里写 `// lazy: ...` 当例子),前缀前的反引号数为奇数 → 跳过。
      // 这正是 ponytail debt 技能点名的坑:提及约定的散文不该进台账。
      const before = line.slice(0, m.index);
      if ((before.match(/`/g) || []).length % 2 === 1) continue;
      const parsed = _parseMarker(m[1]);
      out.push({ file: String(f.path || ''), line: i + 1, ...parsed });
    }
  }
  return out;
}

/**
 * 汇总债务台账。
 * @param {Array} rows - harvestDebtMarkers 的输出
 * @returns {{total:number, noTrigger:number, byFile:Object<string, number>}}
 */
function summarizeDebt(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byFile = {};
  let noTrigger = 0;
  for (const r of list) {
    byFile[r.file] = (byFile[r.file] || 0) + 1;
    if (!r.hasTrigger) noTrigger++;
  }
  return { total: list.length, noTrigger, byFile };
}

module.exports = {
  isEnabled,
  LADDER,
  RULES,
  NEVER_LAZY,
  LEVELS,
  DEFAULT_LEVEL,
  resolveLevel,
  detectCodingIntent,
  buildLazinessDirective,
  routeCodeLaziness,
  MARKER_RE,
  harvestDebtMarkers,
  summarizeDebt,
};
