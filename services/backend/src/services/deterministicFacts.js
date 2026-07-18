'use strict';

/**
 * deterministicFacts.js — 「不只是计算:凡有确定答案的也用代码/权威知识库给真值,绝不让模型猜」
 * 的单一真源(goal 2026-06-26 续句:「但也不只是计算,我希望其他能算的有确定答案的也是,
 * 本地模式能用,但有模型模式公理与定理也优先使用,不要靠模型的猜测,批判性的参考 GLM5 的建议」)。
 *
 * 动机:groundTruth.js 已把**算术**这类「唯一代码真值」从模型手里收归代码。本叶子把同一思想
 * 扩到**其他有确定答案的领域**——它们同样不该靠模型的参数记忆去猜:
 *   A. 单位换算:闭式精确公式,有唯一真值(5 千米 = 5000 米;100 摄氏度 = 212 华氏度)。
 *   B. 公认常数 / 公理:国际单位制(SI)**定义常数**本身就是不可争辩的绝对真值
 *      (光速 c = 299792458 m/s 按定义精确;普朗克常数、阿伏伽德罗常数自 2019 年起为定义值),
 *      以及数学常数(π、e、√2、黄金分割)的高精度权威值。
 *   C. 标准定理:勾股定理、欧拉恒等式等的**权威陈述**,从策展知识库取而非靠模型背诵(易错位)。
 *
 * 两种模式都覆盖(goal「本地模式能用,但模型模式公理与定理也优先」):
 *   - 模型模式:routeDeterministicFacts → buildFactsDirective 产 [SYSTEM:] 注入**系统提示词**,
 *     模型直接采用权威真值来表达 / 应用,而非自行回忆(对应「结果的处理模型也要能拿到」)。
 *   - 本地模式:localBrainService 把本叶子注册为 cooperative handler——无模型时本地直接作答,
 *     有模型时让路给模型(此时由上面的注入保证真值)。两端共用本叶子这一**单一真源**。
 *
 * 批判性参考 GLM5 的防幻觉分层建议(择其适配本仓「纯叶子 + 注入缝」架构者,非照搬):
 *   - 采纳「把确定性子问题交给确定性系统兜底」——本叶子即此层。
 *   - 采纳「证据标注 / 可溯源」——每条事实带 source(来源),指令要求「不足则说明而非编造」(知识边界)。
 *   - 采纳「公理 / 定理走知识库检索而非参数记忆」——CONSTANTS / THEOREMS 为策展登记表。
 *   - **批判性舍弃**:对这类**闭式绝对真理**,重型 RAG 向量检索 / Reviewer Agent / 温度调参属过度
 *     工程,且模糊检索反会引入不确定性——故简化为「精确求解器 + 确定性查表」,这比相似度召回更可靠。
 *
 * 算术一律复用 groundTruth 的**精确有理数(BigInt)求值器**(单一真源,零浮点误差),本叶子不另写算术。
 *
 * 纯叶子:零 IO、确定性、绝不抛、单一真源、可单测。env 门控 KHY_DETERMINISTIC_FACTS(默认开,
 * 仅显式 0/false/off/no 关闭;关闭后 routeDeterministicFacts 返回空指令,系统提示词字节不变)。
 * 不使用 eval / new Function([MGMT-RPT-020] REQ-2026-005)。
 */

const gt = require('./groundTruth'); // 复用精确有理数求值器(相对叶子依赖,零 IO)

// ── env 门控(默认开,仅 0/false/off/no 关)─────────────────────────────
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_DETERMINISTIC_FACTS;
  return !(v !== undefined && ['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase()));
}

// ── A. 单位换算(精确有理数,经 groundTruth 求值器)──────────────────────
// 每个量纲一组单位;factor = [num, den] 表示「1 个该单位 = num/den 个基准单位」(精确整数比)。
// 温度是仿射变换(非纯比例),单独用 tempKind 标记并以公式串求值。ascii:true 的别名在正则里加
// 词边界(防止在英文单词中误命中,如 transform 里的 m)。
const _UNIT_DEFS = [
  // 长度(基准:米)
  { dim: 'length', canonical: 'm', label: '米', factor: ['1', '1'], aliases: [{ a: '米' }, { a: 'm', ascii: true }] },
  { dim: 'length', canonical: 'km', label: '千米', factor: ['1000', '1'], aliases: [{ a: '千米' }, { a: '公里' }, { a: 'km', ascii: true }] },
  { dim: 'length', canonical: 'dm', label: '分米', factor: ['1', '10'], aliases: [{ a: '分米' }, { a: 'dm', ascii: true }] },
  { dim: 'length', canonical: 'cm', label: '厘米', factor: ['1', '100'], aliases: [{ a: '厘米' }, { a: 'cm', ascii: true }] },
  { dim: 'length', canonical: 'mm', label: '毫米', factor: ['1', '1000'], aliases: [{ a: '毫米' }, { a: 'mm', ascii: true }] },
  { dim: 'length', canonical: 'um', label: '微米', factor: ['1', '1000000'], aliases: [{ a: '微米' }, { a: 'um', ascii: true }, { a: 'μm' }] },
  { dim: 'length', canonical: 'nm', label: '纳米', factor: ['1', '1000000000'], aliases: [{ a: '纳米' }, { a: 'nm', ascii: true }] },
  { dim: 'length', canonical: 'inch', label: '英寸', factor: ['254', '10000'], aliases: [{ a: '英寸' }, { a: 'inch', ascii: true }, { a: 'inches', ascii: true }] },
  { dim: 'length', canonical: 'foot', label: '英尺', factor: ['3048', '10000'], aliases: [{ a: '英尺' }, { a: 'foot', ascii: true }, { a: 'feet', ascii: true }, { a: 'ft', ascii: true }] },
  { dim: 'length', canonical: 'yard', label: '码', factor: ['9144', '10000'], aliases: [{ a: 'yard', ascii: true }, { a: 'yards', ascii: true }, { a: 'yd', ascii: true }] },
  { dim: 'length', canonical: 'mile', label: '英里', factor: ['1609344', '1000'], aliases: [{ a: '英里' }, { a: 'mile', ascii: true }, { a: 'miles', ascii: true }] },
  { dim: 'length', canonical: 'nmi', label: '海里', factor: ['1852', '1'], aliases: [{ a: '海里' }] },
  { dim: 'length', canonical: 'li', label: '里', factor: ['500', '1'], aliases: [{ a: '市里' }] },

  // 质量(基准:千克)
  { dim: 'mass', canonical: 'kg', label: '千克', factor: ['1', '1'], aliases: [{ a: '千克' }, { a: '公斤' }, { a: 'kg', ascii: true }] },
  { dim: 'mass', canonical: 'g', label: '克', factor: ['1', '1000'], aliases: [{ a: '克' }, { a: 'g', ascii: true }] },
  { dim: 'mass', canonical: 'mg', label: '毫克', factor: ['1', '1000000'], aliases: [{ a: '毫克' }, { a: 'mg', ascii: true }] },
  { dim: 'mass', canonical: 't', label: '吨', factor: ['1000', '1'], aliases: [{ a: '吨' }, { a: 'ton', ascii: true }, { a: 'tonne', ascii: true }] },
  { dim: 'mass', canonical: 'lb', label: '磅', factor: ['45359237', '100000000'], aliases: [{ a: '磅' }, { a: 'lb', ascii: true }, { a: 'lbs', ascii: true }, { a: 'pound', ascii: true }, { a: 'pounds', ascii: true }] },
  { dim: 'mass', canonical: 'oz', label: '盎司', factor: ['45359237', '1600000000'], aliases: [{ a: '盎司' }, { a: 'oz', ascii: true }, { a: 'ounce', ascii: true }, { a: 'ounces', ascii: true }] },
  { dim: 'mass', canonical: 'jin', label: '斤', factor: ['1', '2'], aliases: [{ a: '市斤' }, { a: '斤' }] },
  { dim: 'mass', canonical: 'liang', label: '两', factor: ['1', '20'], aliases: [{ a: '市两' }] }, // 「两」=「二」歧义高,只收市两

  // 时间(基准:秒)
  { dim: 'time', canonical: 's', label: '秒', factor: ['1', '1'], aliases: [{ a: '秒' }, { a: 'sec', ascii: true }, { a: 's', ascii: true }] },
  { dim: 'time', canonical: 'ms', label: '毫秒', factor: ['1', '1000'], aliases: [{ a: '毫秒' }, { a: 'ms', ascii: true }] },
  { dim: 'time', canonical: 'us', label: '微秒', factor: ['1', '1000000'], aliases: [{ a: '微秒' }, { a: 'us', ascii: true }, { a: 'μs' }] },
  { dim: 'time', canonical: 'min', label: '分钟', factor: ['60', '1'], aliases: [{ a: '分钟' }, { a: 'min', ascii: true }] },
  { dim: 'time', canonical: 'h', label: '小时', factor: ['3600', '1'], aliases: [{ a: '小时' }, { a: 'hour', ascii: true }, { a: 'hours', ascii: true }, { a: 'hr', ascii: true }] },
  { dim: 'time', canonical: 'day', label: '天', factor: ['86400', '1'], aliases: [{ a: '天' }, { a: 'day', ascii: true }, { a: 'days', ascii: true }] },
  { dim: 'time', canonical: 'week', label: '周', factor: ['604800', '1'], aliases: [{ a: '星期' }, { a: 'week', ascii: true }, { a: 'weeks', ascii: true }] },

  // 数字存储(基准:比特 bit)。SI(1000)用于 KB/MB/GB/TB;二进制(1024)用于 KiB/MiB/GiB/TiB。
  { dim: 'data', canonical: 'bit', label: '比特', factor: ['1', '1'], aliases: [{ a: '比特' }, { a: 'bit', ascii: true }, { a: 'bits', ascii: true }] },
  { dim: 'data', canonical: 'byte', label: '字节', factor: ['8', '1'], aliases: [{ a: '字节' }, { a: 'byte', ascii: true }, { a: 'bytes', ascii: true }] },
  { dim: 'data', canonical: 'KB', label: 'KB', factor: ['8000', '1'], aliases: [{ a: 'KB', ascii: true }, { a: '千字节' }] },
  { dim: 'data', canonical: 'MB', label: 'MB', factor: ['8000000', '1'], aliases: [{ a: 'MB', ascii: true }, { a: '兆字节' }] },
  { dim: 'data', canonical: 'GB', label: 'GB', factor: ['8000000000', '1'], aliases: [{ a: 'GB', ascii: true }] },
  { dim: 'data', canonical: 'TB', label: 'TB', factor: ['8000000000000', '1'], aliases: [{ a: 'TB', ascii: true }] },
  { dim: 'data', canonical: 'KiB', label: 'KiB', factor: ['8192', '1'], aliases: [{ a: 'KiB', ascii: true }] },
  { dim: 'data', canonical: 'MiB', label: 'MiB', factor: ['8388608', '1'], aliases: [{ a: 'MiB', ascii: true }] },
  { dim: 'data', canonical: 'GiB', label: 'GiB', factor: ['8589934592', '1'], aliases: [{ a: 'GiB', ascii: true }] },
  { dim: 'data', canonical: 'TiB', label: 'TiB', factor: ['8796093022208', '1'], aliases: [{ a: 'TiB', ascii: true }] },

  // 温度(仿射,tempKind 标记;无 factor)
  { dim: 'temp', canonical: 'C', label: '摄氏度', tempKind: 'C', aliases: [{ a: '摄氏度' }, { a: '摄氏' }, { a: '℃' }, { a: '°c', ascii: true }] },
  { dim: 'temp', canonical: 'F', label: '华氏度', tempKind: 'F', aliases: [{ a: '华氏度' }, { a: '华氏' }, { a: '℉' }, { a: '°f', ascii: true }] },
  { dim: 'temp', canonical: 'K', label: '开尔文', tempKind: 'K', aliases: [{ a: '开尔文' }, { a: '开氏度' }] },
];

// 收敛到 utils/escapeRegExp 单一真源(逐字节委托,调用点不变)
const _escapeRegex = require('../utils/escapeRegExp');

// 别名 → 单位定义查表(小写键)
const _UNIT_LOOKUP = (() => {
  const map = Object.create(null);
  for (const def of _UNIT_DEFS) {
    for (const al of def.aliases) map[al.a.toLowerCase()] = def;
  }
  return map;
})();

// 单位别名正则片段(ascii 加词边界;按长度降序保证「千米」先于「米」、km 先于 m)
const _UNIT_ALT = (() => {
  const pieces = [];
  for (const def of _UNIT_DEFS) {
    for (const al of def.aliases) {
      const esc = _escapeRegex(al.a);
      pieces.push({ a: al.a, re: al.ascii ? `(?<![a-zA-Z])${esc}(?![a-zA-Z])` : esc });
    }
  }
  pieces.sort((x, y) => y.a.length - x.a.length);
  return '(?:' + pieces.map((p) => p.re).join('|') + ')';
})();

// 换算连接词(ascii to/in 加词边界;按长度降序)
const _CONN_ALT = (() => {
  const conns = [
    '转换成', '转换为', '转换', '转成', '转为', '换算成', '换算为', '换算', '换成', '换为',
    '折合成', '折合', '等于多少', '等于', '是多少', '相当于', '合', '到', '转', '=', '→',
  ];
  const asciiConns = ['to', 'in'];
  const pieces = conns.map((c) => ({ a: c, re: _escapeRegex(c) }))
    .concat(asciiConns.map((c) => ({ a: c, re: `(?<![a-zA-Z])${_escapeRegex(c)}(?![a-zA-Z])` })));
  pieces.sort((x, y) => y.a.length - x.a.length);
  return '(?:' + pieces.map((p) => p.re).join('|') + ')';
})();

// 数值 = 组1,起始单位 = 组2,目标单位 = 组3(连接词非捕获)。
// 前导数值有界 `\d{1,15}` 防 ReDoS:原 `\d+` 贪婪吞完全部数字后,尾部单位/连接词
// 锚点失败会在每个起点回溯 → O(n^2)。本正则(`gi` 全局)经 `routeDeterministicFacts`
// 在**模型模式对 raw userMessage** 直接扫描(cli/ai.js:4784,默认开,早于 inputSanitizer
// 200k 上限),50k 数字串即冻结 ~18s。调用处 try/catch 对 hang 无效(挂死非 throw),
// 故为真 user-reachable DoS。15 位数值覆盖一切真实量纲换算,更长非有意义数值;有界对
// 真实输入逐字节等价(见 deterministicFacts.unitRedos 守卫)。
const _UNIT_RE = new RegExp(
  '(\\d{1,15}(?:\\.\\d{1,15})?)\\s*(' + _UNIT_ALT + ')\\s*' + _CONN_ALT + '\\s*(?:多少\\s*)?(' + _UNIT_ALT + ')',
  'gi',
);

// 把 groundTruth 精确求值结果格式化为人类可读真值串(有限小数给精确值,无限循环给近似+分数)。
function _valueString(expr) {
  const r = gt.computeArithmetic(expr);
  if (!r || !r.ok) return null;
  if (r.terminating) return r.exact;
  return `${r.approx}…(精确值 ${r.fraction})`;
}

// 单一换算:数值串 + from/to 定义 → 真值串(经 groundTruth 求值器,精确)。绝不抛。
function _convertUnit(numStr, from, to) {
  try {
    if (from.dim === 'temp') {
      // 先化到摄氏,再到目标(仿射)。表达式串交给精确有理数求值器。
      const c = from.tempKind === 'C' ? `(${numStr})`
        : from.tempKind === 'F' ? `((${numStr})-32)*5/9`
          : `(${numStr})-273.15`; // K
      const expr = to.tempKind === 'C' ? c
        : to.tempKind === 'F' ? `(${c})*9/5+32`
          : `(${c})+273.15`; // K
      return _valueString(expr);
    }
    const expr = `(${numStr})*(${from.factor[0]}/${from.factor[1]})/(${to.factor[0]}/${to.factor[1]})`;
    return _valueString(expr);
  } catch { return null; }
}

function _detectUnits(raw) {
  const out = [];
  const seen = new Set();
  _UNIT_RE.lastIndex = 0;
  let m;
  while ((m = _UNIT_RE.exec(raw)) !== null) {
    const numStr = m[1];
    const fromTok = m[2];
    const toTok = m[3];
    if (fromTok === undefined || toTok === undefined) continue;
    const from = _UNIT_LOOKUP[fromTok.toLowerCase()];
    const to = _UNIT_LOOKUP[toTok.toLowerCase()];
    if (!from || !to) continue;
    if (from.dim !== to.dim) continue; // 跨量纲不可换 → 强零误报护栏
    if (from.canonical === to.canonical) continue; // 同单位无意义
    const value = _convertUnit(numStr, from, to);
    if (value === null) continue;
    const key = `${numStr}|${from.canonical}|${to.canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: 'unit', dimension: from.dim, label: `${numStr} ${from.label} → ${to.label}`, value });
  }
  return out;
}

// ── B. 公认常数 / 公理(策展登记表;SI 定义常数为绝对真值,数学常数为高精度权威值)──
// 检测需「常数名 + 求值意图」共现,守零误报(「光速很快」不触发,「光速是多少」触发)。
const _FACT_QUERY_RE = /是多少|等于多少|的值|数值|多少|精确值|准确值|准确数值|=|等于|value|exact|precise/i;

const CONSTANTS = [
  // 数学常数(无理数,给高精度权威位数)
  { id: 'pi', match: /圆周率|π|\bpi\b/i, label: '圆周率 π', value: '3.14159265358979323846…', source: '数学常数(无理数,此为前 20 位)' },
  { id: 'e', match: /自然对数的底|自然常数|欧拉数|纳皮尔常数/i, label: '自然常数 e', value: '2.71828182845904523536…', source: '数学常数(无理数,此为前 20 位)' },
  { id: 'sqrt2', match: /根号2|根号二|二的平方根|√2|根二/i, label: '√2', value: '1.41421356237309504880…', source: '数学常数(无理数,此为前 20 位)' },
  { id: 'phi', match: /黄金分割比?|黄金比例|golden ratio/i, label: '黄金分割比 φ', value: '1.61803398874989484820…（=(1+√5)/2）', source: '数学常数(无理数,此为前 20 位)' },
  // 物理常数:SI 定义值(2019 年起精确,无不确定度)
  { id: 'c', match: /真空(中)?光速|光速|speed of light/i, label: '真空光速 c', value: '299792458 m/s', source: 'SI 定义值(精确,按定义)' },
  { id: 'h', match: /普朗克常数|planck/i, label: '普朗克常数 h', value: '6.62607015×10⁻³⁴ J·s', source: 'SI 定义值(精确,2019 起)' },
  { id: 'e_charge', match: /基本电荷|元电荷|电子电荷|elementary charge/i, label: '基本电荷 e', value: '1.602176634×10⁻¹⁹ C', source: 'SI 定义值(精确,2019 起)' },
  { id: 'kB', match: /玻尔兹曼常数|波尔兹曼常数|boltzmann/i, label: '玻尔兹曼常数 k', value: '1.380649×10⁻²³ J/K', source: 'SI 定义值(精确,2019 起)' },
  { id: 'NA', match: /阿伏伽德罗常数|阿佛加德罗常数|avogadro/i, label: '阿伏伽德罗常数 Nₐ', value: '6.02214076×10²³ mol⁻¹', source: 'SI 定义值(精确,2019 起)' },
  { id: 'g0', match: /标准重力加速度|重力加速度|标准重力/i, label: '标准重力加速度 g', value: '9.80665 m/s²', source: 'SI 约定定义值(精确)' },
  // 物理常数:实验测量值(有不确定度,如实标注 → GLM5「证据/知识边界」)
  { id: 'G', match: /万有引力常数|引力常数|gravitational constant/i, label: '万有引力常数 G', value: '6.67430×10⁻¹¹ m³·kg⁻¹·s⁻²', source: 'CODATA 实验测量值(非定义值,有不确定度 ±0.00015)' },
];

// ── C. 标准定理 / 公式(权威陈述;按名检索,名高度特异故名命中即注入)──
const THEOREMS = [
  { id: 'pythagorean', match: /勾股定理|毕达哥拉斯定理|商高定理|pythagorean/i, label: '勾股定理', statement: '直角三角形两直角边的平方和等于斜边的平方:a² + b² = c²', source: '欧氏几何' },
  { id: 'euler_identity', match: /欧拉恒等式|euler'?s identity/i, label: '欧拉恒等式', statement: 'e^(iπ) + 1 = 0', source: '复分析' },
  { id: 'euler_formula', match: /欧拉公式/i, label: '欧拉公式', statement: 'e^(iθ) = cos θ + i·sin θ', source: '复分析' },
  { id: 'fermat_little', match: /费马小定理|fermat'?s little/i, label: '费马小定理', statement: '若 p 为素数且 a 不被 p 整除,则 a^(p−1) ≡ 1 (mod p)', source: '数论' },
  { id: 'binomial', match: /二项式定理|binomial theorem/i, label: '二项式定理', statement: '(a+b)^n = Σ_{k=0}^{n} C(n,k)·a^(n−k)·b^k', source: '代数' },
  { id: 'triangle_sum', match: /三角形(的)?内角和/i, label: '三角形内角和', statement: '平面(欧氏)三角形三内角之和恒为 180°(π 弧度)', source: '欧氏几何' },
];

const _MAX_FACTS = 12;

/**
 * 从文本检测确定性事实(单位换算 / 常数公理 / 定理)。绝不抛,返回 facts 数组(可空)。
 * @param {string} text
 * @returns {Array<{kind:'unit'|'constant'|'theorem', label:string, value:string, source?:string, dimension?:string}>}
 */
function detectDeterministicFacts(text) {
  const facts = [];
  const seen = new Set();
  const raw = String(text || '');
  if (!raw) return facts;

  const push = (f, key) => {
    if (facts.length >= _MAX_FACTS) return;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push(f);
  };

  // A. 单位换算
  for (const u of _detectUnits(raw)) push(u, 'u:' + u.label);

  // B. 常数 / 公理(需求值意图共现)
  if (_FACT_QUERY_RE.test(raw)) {
    for (const c of CONSTANTS) {
      if (c.match.test(raw)) push({ kind: 'constant', label: c.label, value: c.value, source: c.source }, 'c:' + c.id);
    }
  }

  // C. 定理 / 公式(按名检索)
  for (const t of THEOREMS) {
    if (t.match.test(raw)) push({ kind: 'theorem', label: t.label, value: t.statement, source: t.source }, 't:' + t.id);
  }

  return facts;
}

// ── 指令:把权威真值交给模型(注入系统提示词)─────────────────────────
function buildFactsDirective(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return '';
  const lines = facts.map((f) => {
    const head = f.kind === 'theorem' ? `  • ${f.label}:${f.value}` : `  • ${f.label} = ${f.value}`;
    return f.source ? `${head}(来源:${f.source})` : head;
  });
  return [
    '[SYSTEM: 以下事实为确定性真值——单位换算由 khyos 用精确有理数算出,物理常数取国际单位制(SI)',
    '定义值 / 权威测量值,数学常数取高精度权威值,定理取标准陈述,均**非模型记忆**。**请直接采用,',
    '禁止凭记忆改写、四舍五入或质疑**;涉及这些常数、公理、定理与换算时一律以下列为准。若你掌握的',
    '信息与此冲突,以此为准;若超出下列范围而你并不确定,应如实说明「缺少可靠依据」而非编造:',
    ...lines,
    ']',
  ].join('\n');
}

/**
 * 编排(模型模式):从文本取确定性真值并生成注入指令。镜像 routeGroundTruth 的契约。
 * @param {object} args
 * @param {string} args.text
 * @param {object} [args.env]
 * @returns {{facts:Array, directive:string}}
 */
function routeDeterministicFacts({ text = '', env } = {}) {
  if (!isEnabled(env)) return { facts: [], directive: '' };
  const facts = detectDeterministicFacts(text);
  return { facts, directive: buildFactsDirective(facts) };
}

// ── 本地模式适配器(localBrainService Tier-1 handler 契约:match/detect/execute/format)──
// 拆两类以匹配两种 cooperative 策略(见 localBrainService 注册处说明):
//   - 单位换算:闭式精确、且会被 calc handler 退化抢占(它把「5千米等于多少米」错抽成「5」),
//     故须 cooperative:false 且排在 calc 之前,两种模式都由本叶子精确作答。
//   - 常数 / 定理:cooperative:true——无模型本地答,有模型让路给模型(由 cli/ai.js 注入权威真值
//     保证「公理与定理优先、不靠猜测」,同时让模型负责阐释/应用)。
function _detectByKinds(text, kinds) {
  if (!isEnabled()) return [];
  return detectDeterministicFacts(text).filter((f) => kinds.includes(f.kind));
}

function isUnitIntent(text) { return _detectByKinds(text, ['unit']).length > 0; }
function detectUnitFact(text) {
  const facts = _detectByKinds(text, ['unit']);
  if (!facts.length) return null;
  return { type: 'deterministic_unit', category: '单位换算', label: '精确换算', facts };
}

function isKnowledgeIntent(text) { return _detectByKinds(text, ['constant', 'theorem']).length > 0; }
function detectKnowledgeFact(text) {
  const facts = _detectByKinds(text, ['constant', 'theorem']);
  if (!facts.length) return null;
  return { type: 'deterministic_fact', category: '确定性真值', label: '权威真值', facts };
}

// 合并入口(诊断 / 全量检测用):任一类命中。
function isFactIntent(text) {
  if (!isEnabled()) return false;
  return detectDeterministicFacts(text).length > 0;
}

function detectFact(text) {
  const facts = detectDeterministicFacts(text);
  if (!facts.length) return null;
  return { type: 'deterministic_fact', category: '确定性真值', label: '权威真值', facts };
}

function executeFact(plan) {
  const facts = (plan && Array.isArray(plan.facts)) ? plan.facts : [];
  return { type: 'deterministic_fact', success: true, facts };
}

function formatFact(result) {
  const facts = (result && Array.isArray(result.facts)) ? result.facts : [];
  if (!facts.length) return '(无确定性真值)';
  const lines = facts.map((f) => {
    const head = f.kind === 'theorem' ? `${f.label}:${f.value}` : `${f.label} = ${f.value}`;
    return f.source ? `${head}(来源:${f.source})` : head;
  });
  return lines.join('\n');
}

module.exports = {
  isEnabled,
  detectDeterministicFacts,
  buildFactsDirective,
  routeDeterministicFacts,
  // 本地模式 handler 契约
  isUnitIntent,
  detectUnitFact,
  isKnowledgeIntent,
  detectKnowledgeFact,
  isFactIntent,
  detectFact,
  executeFact,
  formatFact,
  // 诊断 / 测试用内部符号
  _convertUnit,
  _UNIT_LOOKUP,
  CONSTANTS,
  THEOREMS,
};
