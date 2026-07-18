'use strict';

/**
 * philosophyDesignResolver.js — 纯叶子:自然语言「哲学内容 → 软件设计落地」意图解析(单一真源)。
 *
 * 背景(goal「khyos 能理解人类社会中的哲学;当用户给哲学内容、想应用于软件项目创建时,
 * khyos 能理解类比并用软件实现」):khyos 已有 NL→指令注入族——
 *   nlConfigResolver —— NL → 配置开关(开/关某能力);
 *   nlActionResolver —— NL → 动作意图(找/修自身 bug、去开源平台学习)。
 * 但「把一段人类社会的哲学/思想忠实地类比成软件设计、并真正实现」此前无任何机制:
 * 模型只会把哲学复述一遍、或写一段比喻散文,而不会建立**显式的类比映射表**(哲学概念
 * → 软件构造)再落成可运行的架构/代码。本叶子补这条正交缺口。
 *
 * 与 nlConfig/nlAction 的分工(三者正交,绝不混淆):
 *   - nlConfigResolver:NL → 配置开关(envKey on/off)。
 *   - nlActionResolver :NL → 动作(用既有工具找/修 bug、学开源)。
 *   - philosophyDesignResolver(本文件):NL「哲学 + 想用软件实现」→ 一段系统提示词指令,
 *     命模型走「忠实提炼内核 → 建显式类比映射表 → 转可执行架构 → 真用软件实现 → 诚实标注
 *     强/弱类比」的确定性协议,而非停在比喻散文。本叶子只产「该怎么做」的方法与指令。
 *
 * 契约(CONTRACT):零 IO(只读 process.env 做门控)、确定性(无随机/无时钟)、绝不抛
 *   (fail-soft,任何异常 → null)、单一真源(识别判据 + 协议指令 + 示例映射只在此处)、
 *   env 门控 KHY_PHILOSOPHY_DESIGN 默认开(仅 {0,false,off,no} 关;关 → routePhilosophyIntent
 *   恒 null,注入点字节回退到「不注入任何哲学设计指令」的今日行为)。
 *
 * 零假阳性优先:必须**同时**命中 ① 哲学/思想信号 ② 「应用到软件/项目」信号 才成立。
 *   「我们讨论一下康德的伦理学」(纯哲学讨论,不建软件)、「帮我建一个待办项目」(建项目
 *   但无哲学)等绝不误触。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function isEnabled(env = process.env) {
  const raw = env && env.KHY_PHILOSOPHY_DESIGN;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── 识别判据(中/英,大小写不敏感)──────────────────────────────────────────────
// ① 哲学/思想信号:点名的流派/人物,或泛化的哲学词。
const _PHILOSOPHY_RE = new RegExp(
  [
    // 泛化哲学词(注意:「主义/思想」较宽,靠 ② 的「应用到软件」门控收敛零假阳性)
    '哲学', '哲理', '思想', '主义', '世界观', '价值观', '方法论', '理念', '道德经',
    'philosoph', 'ideolog', 'doctrine', 'worldview', 'ethos', '\\btenets?\\b', 'principle of life',
    // 中国哲学
    '道家', '儒家', '法家', '墨家', '无为(?:而治)?', '中庸', '阴阳', '太极', '禅', '佛家', '禅宗',
    '老子', '孔子', '庄子', '孟子', '荀子', '韩非',
    // 西方哲学流派/人物
    '斯多葛', 'stoic', '存在主义', 'existential', '虚无主义', 'nihilis', '功利主义', 'utilitarian',
    '康德', 'kant', '苏格拉底', 'socrat', '柏拉图', 'plato', '亚里士多德', 'aristotl',
    '尼采', 'nietzsch', '黑格尔', 'hegel', '马克思', 'marx', '罗尔斯', 'rawls', '萨特', 'sartre',
    // 社会/政治哲学常被借喻进软件
    '三权分立', '制衡', '社会契约', 'social\\s*contract', '辩证', 'dialectic',
  ].join('|'),
  'i',
);

// ② 「应用到软件/项目」信号:明确想把它落成软件/系统/架构/代码/项目。
const _APPLY_SW_RE = new RegExp(
  [
    '应用(?:到|于|进|在)?.{0,8}(?:软件|项目|系统|架构|代码|程序|工程|设计)',
    '用(?:软件|代码|程序|系统)(?:来)?(?:实现|表达|表现|落地|体现|呈现|构建|做)',
    '(?:做|实现|落地|转化|转成|转换|映射|体现|设计)(?:成|为|进|到)?.{0,6}(?:软件|系统|项目|架构|代码|程序|应用)',
    '(?:建|搭建|创建|构建|开发|写)(?:一个|个)?.{0,10}(?:软件|系统|项目|架构|应用|程序)',
    'apply.{0,20}(?:to|in|into).{0,20}(?:software|project|system|architect|code|app)',
    '(?:build|create|design|implement|model).{0,30}(?:software|project|system|architecture|app|codebase)',
    'turn.{0,20}(?:into).{0,20}(?:software|code|system|design)',
  ].join('|'),
  'i',
);

/**
 * 哲学 → 软件类比落地协议指令([SYSTEM:] 形式)—— 单一真源。
 * 命模型:忠实提炼 → 显式映射表 → 可执行架构 → 真实现 → 诚实标注强/弱类比。
 * 内含「示例映射」仅为锚定质量,**明确标注非封闭清单**。
 */
const PHILOSOPHY_DESIGN_DIRECTIVE = [
  '[SYSTEM: 哲学 → 软件 类比落地]',
  '用户给出了一段人类社会/思想的**哲学内容**,并希望把它**应用到软件项目的创建**。',
  'khy 的职责不是把哲学复述一遍、也不是写一段比喻散文,而是**理解其类比、并用软件真正实现**。',
  '请严格走以下确定性协议:',
  '1. 忠实提炼内核:用一两句话准确概括该哲学/思想的**真实核心主张**(忠于该流派/人物的本意)。',
  '   **绝不**编造某流派的教义、绝不假托某哲学家说过他没说过的话;若用户所指模糊(只说「哲学」',
  '   却没点明是哪一种),先用一句话请他点明是哪种哲学/原则,再继续。',
  '2. 建立**显式类比映射表**(这是本任务的核心产物,单一真源):逐行写',
  '   `哲学概念 → 软件落点`,把每个核心概念映射到具体软件构造(模块边界 / 数据结构 / 控制流 /',
  '   不变量 invariant / 接口 / 权限 / 生命周期 / 失败处理)。每行都要说明**为什么这是忠实(faithful)',
  '   的类比而非牵强(superficial)的文字游戏**。',
  '3. 转成可执行设计:把映射落成具体架构决策——模块划分、数据流、关键不变量与守卫、扩展点、约束。',
  '   优先用**本仓库的工程纪律**表达(纯叶子 / 单一真源 / 门控默认开关即字节回退 / 可变性分级 /',
  '   fail-soft),让哲学落点同时是好工程。',
  '4. **真正用软件实现**:用现有工具(Write/editFile/Bash 等)产出可运行的代码、脚手架或最小可验证',
  '   原型,并在每步标注它对应映射表里的哪一条。**绝不**停在「这就像……」的散文层面。',
  '5. 诚实区分:明确指出**哪些类比强、哪些牵强或根本不适用**;当哲学的诗意与工程的正确性/可维护性',
  '   冲突时,**永远以工程现实为准**,并如实说明取舍。绝不为追求优雅的比喻牺牲正确性。',
  '',
  '示例映射(**仅为锚定思路的示例,非封闭清单**,请针对用户实际给的哲学重新推导):',
  '  · 道家「无为而治 / 自组织」→ 事件驱动 + 最小干预编排:框架只设边界与默认值,组件自洽运行,',
  '    不微管理每一步(对应:声明式配置、默认开关、约定优于配置)。',
  '  · 三权分立 / 制衡 → 关注点分离 + 权限隔离 + 不可绕过的校验:没有单点独裁,关键操作需多方校验。',
  '  · 斯多葛「区分可控与不可控」→ 把外部不确定性(网络/上游/用户输入)隔离到边界并 fail-soft,',
  '    核心域只处理可控状态(对应:防腐层、纯函数核心 + 薄 IO 壳)。',
].join('\n');

const PHILOSOPHY_DESIGN_SUMMARY = '把哲学/思想类比成软件设计并真正实现';

// 去掉代码块与行内 code,避免把示例里的关键词误判为用户指令。委托单一真源 utils/stripCodeSpans。
const _stripCode = require('../../utils/stripCodeSpans');

/**
 * 判定本轮文本是否「哲学内容 + 想用软件实现」。零假阳性:两类信号须同时命中。
 * fail-soft:任何异常 → false。
 */
function matchPhilosophyDesign(text) {
  try {
    const t = _stripCode(text);
    if (!t.trim()) return false;
    return _PHILOSOPHY_RE.test(t) && _APPLY_SW_RE.test(t);
  } catch {
    return false;
  }
}

/**
 * 自然语言 → 哲学设计意图。命中 → { id, summary, directive };否则/门控关 → null。
 * fail-soft:任何异常 → null。
 */
function resolvePhilosophyIntent(text, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    if (!matchPhilosophyDesign(text)) return null;
    return {
      id: 'philosophy-design',
      summary: PHILOSOPHY_DESIGN_SUMMARY,
      directive: PHILOSOPHY_DESIGN_DIRECTIVE,
    };
  } catch {
    return null;
  }
}

/**
 * 缝入口:解析本轮文本,命中 → { directive, intent };未命中/门控关 → null。
 * 与 nlActionResolver 同:**仅命中时注入**,未命中零注入(零噪声)。
 */
function routePhilosophyIntent(opts = {}) {
  try {
    const env = opts.env || process.env;
    if (!isEnabled(env)) return null;
    const intent = resolvePhilosophyIntent(opts.text || '', env);
    if (!intent) return null;
    return { directive: intent.directive, intent };
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  PHILOSOPHY_DESIGN_DIRECTIVE,
  PHILOSOPHY_DESIGN_SUMMARY,
  matchPhilosophyDesign,
  resolvePhilosophyIntent,
  routePhilosophyIntent,
};
