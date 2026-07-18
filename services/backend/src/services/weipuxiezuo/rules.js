'use strict';

/**
 * weipuxiezuo/rules.js — 维普 AIGC 降重方法论的「规则单一真源」。
 *
 * 设计动机（用户要求：把方法论用代码实现，不要塞提示词）：
 *   原 weipuxiezuo skill 是一段长 system prompt，把 16 种 AI 写作模式、AI 高频词、
 *   语体红线全部讲给模型听。问题是「讲」不可测、不稳定、随上下文漂移。本仓一贯做法
 *   （对照 contextDiagnostics.js「测不了就优化不了」）是把判定下沉成**确定性代码**：
 *   规则在这里集中声明一次，detector 据此**定位**命中、scorer 据此**打分**、constraints
 *   据此**判合格**。模型拿到的是「第 12 句命中模式 2，触发词『此案例印证了』」这样的
 *   结构化、带位置的修复清单，而不是一段教它认模式的提示词。
 *
 * 这里只放**纯数据 + 惰性编译的匹配器**，零副作用、绝不抛出。所有阈值集中在
 * thresholds，可被环境变量覆盖（见 _envInt）。
 *
 * 模式编号严格对应 skill 文档「一、AI 模式识别与修复速查表」与「附录 A」的 1–16。
 */

const PRIORITY = { HIGH: 'high', MID: 'mid', LOW: 'low' };

/**
 * 把字符串触发词转义为可安全嵌入正则的片段。
 * @param {string} s
 * @returns {string}
 */
function _escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 16 种 AI 写作模式。每条：
 *   - id        模式编号（1–16，对应文档）
 *   - name      可读名
 *   - priority  high|mid|low（对应文档优先级，决定 AIGC 评分权重）
 *   - triggers  字面触发词（用于人类可读报告 + 简单计数）
 *   - regex     编译用源（字符串）。命中即记一处，捕获组用于定位触发词文本
 *   - atEnd     true 表示只在「句末 / 段末」命中才算（套句类）
 *   - fix       修复方法（喂给模型的结构化提示，非散文）
 */
const PATTERNS = [
  {
    id: 1,
    name: '理论起笔',
    priority: PRIORITY.HIGH,
    triggers: ['依据', '基于', '根据', '按照', '遵循'],
    regex: '(依据|基于|根据|按照|遵循)[^，。；、\\n]{0,14}(理论|框架|观点|原则|视角|模型|范式)',
    atEnd: false,
    fix: '理论名称从段首移到段中，让现象/问题先行，理论在需要解释时才出现',
  },
  {
    id: 2,
    name: '段末套句',
    priority: PRIORITY.HIGH,
    triggers: ['此案例印证了', '此案例揭示了', '此案例挑战了', '这提示我们', '从中可以看出'],
    regex: '(此案例(印证|揭示|挑战|说明)了|这(一案例|提示我们)|从中(可以)?看出)',
    atEnd: true,
    fix: '删除「此案例 XX 了」固定开头，改为从问题逻辑出发的自然推断',
  },
  {
    id: 3,
    name: '编号逻辑',
    priority: PRIORITY.HIGH,
    triggers: ['首先', '其次', '再次', '最后'],
    // 至少出现「首先」+（其次|再次）才算编号逻辑链，避免误伤单个「首先」。
    regex: '首先[，,].{0,80}?(其次|再者|再次)[，,]',
    atEnd: false,
    fix: '改为「最根本的是…此外…至于…」，各条理由篇幅与重要性成正比',
  },
  {
    id: 4,
    name: '被动分析套话',
    priority: PRIORITY.MID,
    triggers: ['该处理体现了', '该设计基于', '该决策反映了', '这一做法展现了', '体现了'],
    regex: '(该|这一)[^，。；\\n]{0,10}(体现了|展现了|反映了|彰显了)',
    atEnd: false,
    fix: '改为说明「为什么这么做」的具体叙述，加入研究过程的真实判断与修正',
  },
  {
    id: 5,
    name: '模板化问题陈述',
    priority: PRIORITY.MID,
    triggers: ['面临的核心问题是', '核心挑战在于', '主要矛盾体现在', '核心问题是'],
    regex: '(面临的核心问题是|核心(问题|挑战)(是|在于)|主要矛盾(体现在|在于))',
    atEnd: false,
    fix: '用具体矛盾情境或反问代替抽象「核心问题」陈述',
  },
  {
    id: 6,
    name: '三元并列对称',
    priority: PRIORITY.MID,
    triggers: ['三重考量', '三方面', '三个维度', '三重'],
    regex: '(三(重|方面|个(维度|层面)|大)[^。\\n]{0,6}[:：])|((从[^，。；\\n]{1,8}(看|来看)[，,])[^。\\n]{0,40}(从[^，。；\\n]{1,8}(看|来看)[，,])[^。\\n]{0,40}(从[^，。；\\n]{1,8}(看|来看)))',
    atEnd: false,
    fix: '打破三元对称，各项长度与实际分量匹配，加入限定语',
  },
  {
    id: 7,
    name: '画蛇添足总结句',
    priority: PRIORITY.MID,
    triggers: ['综上所述', '由此可见', '不难发现', '可以看出'],
    regex: '(综上所述|由此可见|不难发现|可以看出|总而言之)',
    atEnd: true,
    fix: '直接删除，或改为承上启下的过渡语',
  },
  {
    id: 8,
    name: '模糊归因',
    priority: PRIORITY.HIGH,
    triggers: ['专家认为', '研究表明', '业内普遍认为', '有学者指出', '普遍认为'],
    // 命中后由 detector 检查邻近是否有真实引用/年份；无来源才判为模糊归因。
    regex: '(专家认为|研究表明|业内(普遍)?认为|有(学者|研究)指出|普遍认为|学界认为)',
    atEnd: false,
    requiresNoCitation: true,
    fix: '用 WebSearch 搜真实文献替换，或改为本文自身判断',
  },
  {
    id: 9,
    name: '填充短语',
    priority: PRIORITY.MID,
    triggers: ['值得注意的是', '不难发现', '众所周知', '显而易见'],
    regex: '(值得注意的是|不难发现|众所周知|显而易见|毋庸置疑)[，,]?',
    atEnd: false,
    fix: '删除引导语，直说',
  },
  {
    id: 10,
    name: '泛化结尾',
    priority: PRIORITY.HIGH,
    triggers: ['未来可期', '前景广阔', '具有重要意义', '意义深远', '提供了新思路'],
    regex: '(未来可期|前景(广阔|可观)|具有重要(的)?(理论|现实|学术)?(意义|价值)|意义深远|激动人心|为[^。\\n]{0,12}提供了(新的?)?(思路|借鉴|参考))',
    atEnd: false,
    fix: '改为可检验的推论或具体后续方向',
  },
  {
    id: 11,
    name: 'AI高频词',
    priority: PRIORITY.HIGH,
    // 由 highFreqWords 单独驱动（每段≤2 的约束），此处 regex 仅用于整体命中计数。
    triggers: ['深刻揭示', '综合运用', '不可或缺', '深入探讨', '系统梳理'],
    regex: '(深刻揭示了?|综合运用|不可或缺|深入探讨|系统梳理|深入分析|至关重要)',
    atEnd: false,
    fix: '每段≤2 个 AI 高频词，超出按替换表替换',
  },
  {
    id: 12,
    name: '回避「是」',
    priority: PRIORITY.LOW,
    triggers: ['作为...载体', '扮演...角色', '发挥...功能'],
    regex: '(作为[^，。；\\n]{0,12}(载体|桥梁|纽带|角色|媒介)|扮演[^，。；\\n]{0,8}(角色|作用)|发挥[^，。；\\n]{0,10}(功能|作用))',
    atEnd: false,
    fix: '直接用「是」',
  },
  {
    id: 13,
    name: '过度对仗排比',
    priority: PRIORITY.LOW,
    triggers: ['突破了...填补了...创新了'],
    // 四个及以上「动词+了」并列（突破了/填补了/创新了/丰富了）。
    regex: '([\\u4e00-\\u9fa5]{2}了[，,])[^。\\n]{0,20}([\\u4e00-\\u9fa5]{2}了[，,])[^。\\n]{0,20}([\\u4e00-\\u9fa5]{2}了[，,])',
    atEnd: false,
    fix: '最核心的展开说，其余缩减',
  },
  {
    id: 14,
    name: '三步走等重分析',
    priority: PRIORITY.LOW,
    triggers: ['从经济维度看', '从社会维度看', '从文化维度看'],
    regex: '(从[^，。；\\n]{1,8}维度(看|分析)[，,]).{0,60}?(从[^，。；\\n]{1,8}维度(看|分析)[，,])',
    atEnd: false,
    fix: '重要的先说多说，次要的简说',
  },
  {
    id: 15,
    name: '标点失衡',
    priority: PRIORITY.LOW,
    triggers: ['冒号连用', '破折号连用'],
    // 段级判定（detector 按段统计冒号/破折号数），此 regex 占位不单独命中。
    regex: null,
    atEnd: false,
    fix: '冒号一段≥3 次改部分为破折号；破折号一段≥4 次削减',
  },
  {
    id: 16,
    name: '加粗滥用',
    priority: PRIORITY.LOW,
    triggers: ['**加粗**'],
    // 全文级判定（detector 统计 **bold** 数）。
    regex: null,
    atEnd: false,
    fix: '正文全文加粗 ≤5 处',
  },
];

/**
 * AI 高频词清单（约束「每段≤2 个」按此计数）。来自文档「模式 11」+ 常见扩充。
 * 保持高精度，避免误伤普通学术用词。
 */
const HIGH_FREQ_WORDS = [
  '深刻揭示', '综合运用', '不可或缺', '深入探讨', '系统梳理', '深入分析',
  '具有重要意义', '至关重要', '值得注意的是', '综上所述', '总而言之',
  '不言而喻', '一系列', '极大地', '进一步', '深层次', '全方位', '多维度',
  '行之有效', '日益', '愈发', '层面', '维度',
];

/**
 * AI 高频词 → 推荐替换。供 buildRewriteBrief 生成结构化换词建议（非提示词）。
 */
const REPLACEMENTS = {
  深刻揭示了: '说明了',
  具有重要意义: '',
  综合运用: '结合',
  不可或缺: '离不开',
  深入探讨: '分析',
  系统梳理: '梳理',
  值得注意的是: '有一点要提',
  深入分析: '分析',
  进一步: '再',
  极大地: '大大',
  综上所述: '',
  总而言之: '',
};

/**
 * 语体红线：学术文里不应出现的口语 / 网络用语（命中扣学术分）。
 * 注意：这是「禁止」清单；中性语气词（把/让/就/换言之…）不在此列，按文档属允许。
 */
const COLLOQUIAL_BLOCKLIST = [
  '说白了就是', '说白了', '搞了个', '搞定', '挂了', '卡死了', '这玩意儿',
  '吃进去的数据', '玩意儿', '牛逼', '666', '坑爹', '给力', '吐槽', '秒杀',
  '简单粗暴', '一波', '666', 'yyds', '绝绝子',
];

/**
 * 中性语气词 / 过渡词（文档「六、语体红线」允许列）。仅用于「无魂写作」正向信号，
 * 不参与扣分。
 */
const NEUTRAL_TONE_MARKERS = [
  '换句话说', '换言之', '坦率地说', '回头想想', '罢了', '而已', '倒是',
  '笔者认为', '出乎意料', '事后来看', '说来', '问题的关键',
];

function _envInt(name, fallback) {
  const v = parseInt(String(process.env[name] || ''), 10);
  return Number.isFinite(v) ? v : fallback;
}

function _envFloat(name, fallback) {
  const v = parseFloat(String(process.env[name] || ''));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 强制硬约束阈值 + 三维评分合格线。集中声明，环境变量可覆盖（便于按学校/期刊调档）。
 */
const thresholds = {
  highFreqPerParagraph: _envInt('KHY_WEIPU_HIFREQ_PER_PARA', 2),   // AI高频词/段 ≤
  endClicheTotal: _envInt('KHY_WEIPU_END_CLICHE_TOTAL', 1),         // 段末套句 全文≤
  tripletPerParagraph: _envInt('KHY_WEIPU_TRIPLET_PER_PARA', 1),    // 三元并列/段 ≤
  theoryOpenerRatio: _envFloat('KHY_WEIPU_THEORY_OPENER_RATIO', 0.20), // 理论起笔段落比例 ≤
  boldTotal: _envInt('KHY_WEIPU_BOLD_TOTAL', 5),                    // 正文加粗 ≤
  generalEndingTotal: 0,                                            // 泛化结尾 = 0
  vagueAttributionTotal: 0,                                         // 模糊归因 = 0
  explicitCitationFull: _envInt('KHY_WEIPU_CITATION_FULL', 15),     // 全文显式引用 = 15
  huayongMin: _envFloat('KHY_WEIPU_HUAYONG_MIN', 0.20),            // 化用密度 ≥
  huayongMax: _envFloat('KHY_WEIPU_HUAYONG_MAX', 0.40),            // 化用密度 ≤
  colonPerParagraph: _envInt('KHY_WEIPU_COLON_PER_PARA', 3),       // 冒号/段 ≥ 触发失衡
  dashPerParagraph: _envInt('KHY_WEIPU_DASH_PER_PARA', 4),         // 破折号/段 ≥ 触发失衡
  // 三维评分合格线
  aigcPass: _envInt('KHY_WEIPU_AIGC_PASS', 40),                    // AIGC ≤ 合格
  academicPass: _envInt('KHY_WEIPU_ACADEMIC_PASS', 55),           // 学术质量 ≥ 合格
};

// ── 惰性编译的匹配器缓存 ──────────────────────────────────────────────
let _compiled = null;

/**
 * 返回编译后的模式匹配器（带 sticky/global 标志的 RegExp），结果缓存。
 * @returns {Array<{id,name,priority,atEnd,requiresNoCitation,fix,triggers,re:RegExp|null}>}
 */
function compiledPatterns() {
  if (_compiled) return _compiled;
  _compiled = PATTERNS.map((p) => ({
    id: p.id,
    name: p.name,
    priority: p.priority,
    atEnd: !!p.atEnd,
    requiresNoCitation: !!p.requiresNoCitation,
    fix: p.fix,
    triggers: p.triggers || [],
    re: p.regex ? new RegExp(p.regex, 'g') : null,
  }));
  return _compiled;
}

/** 编译后的 AI 高频词整体匹配器（用于整段计数）。 */
let _hifreqRe = null;
function highFreqRegex() {
  if (!_hifreqRe) {
    _hifreqRe = new RegExp('(' + HIGH_FREQ_WORDS.map(_escape).join('|') + ')', 'g');
  }
  return _hifreqRe;
}

let _colloquialRe = null;
function colloquialRegex() {
  if (!_colloquialRe) {
    _colloquialRe = new RegExp('(' + COLLOQUIAL_BLOCKLIST.map(_escape).join('|') + ')', 'g');
  }
  return _colloquialRe;
}

let _neutralRe = null;
function neutralToneRegex() {
  if (!_neutralRe) {
    _neutralRe = new RegExp('(' + NEUTRAL_TONE_MARKERS.map(_escape).join('|') + ')', 'g');
  }
  return _neutralRe;
}

/** 仅供测试：清编译缓存（阈值随 env 变更后重读）。 */
function _resetCache() {
  _compiled = null;
  _hifreqRe = null;
  _colloquialRe = null;
  _neutralRe = null;
}

module.exports = {
  PRIORITY,
  PATTERNS,
  HIGH_FREQ_WORDS,
  REPLACEMENTS,
  COLLOQUIAL_BLOCKLIST,
  NEUTRAL_TONE_MARKERS,
  thresholds,
  compiledPatterns,
  highFreqRegex,
  colloquialRegex,
  neutralToneRegex,
  _resetCache,
  _escape,
};
