'use strict';

/**
 * groundTruth.js — 「能靠代码确定性算出的绝对真值,绝不信任模型心算」的单一真源
 * (goal 2026-06-26「比如像十进制中 1+1=2 这样公认的绝对真理,能靠代码实现的绝不
 *  信任模型,但是结果的处理模型也要能拿到」)。
 *
 * 动机:模型(尤其弱模型)的「心算」不可靠——大整数会丢位、小数会算错、进位会出错;
 * 更狠的是连 IEEE-754 浮点本身都不可信(`0.1 + 0.2` 在几乎所有语言里都得到
 * 0.30000000000000004,而非 0.3)。这类问题有**唯一、不可争辩的代码真值**:不该让
 * 模型去猜,而该用确定性代码精确算出,再把结果交给模型去**表达 / 应用**。这正是
 * 「能靠代码实现的绝不信任模型,但结果的处理模型也要能拿到」的字面落地。
 *
 * 与既有 localBrainCalc 的区别(非重复):
 *   - localBrainCalc 是**离线本地大脑的 handler**,直接替模型作答,且用 `parseFloat`/
 *     `Math.pow` 的**浮点**求值器(0.1+0.2 会给 0.30000000000000004,大整数丢精度)。
 *   - 本叶子服务**正常 LLM 路径**:即便由模型来答,也先用**精确有理数(BigInt 分子/
 *     分母)**算出地面真值,注入系统提示词让模型「直接采用、禁止重算」。零浮点误差。
 *
 * 两类绝对真值(零假阳性是底线,judged by 现有用例零误触):
 *   A. 精确算术:`+ - * / ^`、括号、小数、一元负号,全程 BigInt 有理数 → 整数 / 有限
 *      小数给精确值,无限循环小数给**最简分数** + 标注近似小数。绝不出现浮点误差。
 *   B. 进制转换:带前缀字面量 `0x.. / 0b.. / 0o..` 在出现转换意图词时 → 十进制(BigInt)。
 *      (自由中文里的「N 转 K 进制」歧义大、FP 风险高,刻意不做,守零误报底线。)
 *
 * 检测(detectComputableClaims)零假阳性的关键护栏:
 *   - 候选算式必须含二元算符;纯数字 / 版本号 / 日期不触发;
 *   - 形如 `2024-01-01`(日期)、`1.2.3`(版本)被显式排除;
 *   - 仅含弱算符 `+ -` 时必须另有「计算意图」标记(=、等于、多少、计算、结果、equals…)
 *     才触发,以免「page 1-2」「3-5 个」被误算;含强算符 `* / ^ % ()` 则直接触发;
 *   - 候选必须被有理数求值器**干净解析**出有限结果,否则丢弃。
 *
 * 结果如何「交给模型」:buildGroundTruthDirective 产一段 [SYSTEM:] 指令注入**系统提示词**
 * (而非用户消息,避免被当 prompt injection),把每条已验证真值列出并命令模型直接采用、
 * 禁止自行重算;凡浮点 / 心算会出错处额外加附注(如 0.1+0.2 标注浮点会误为 …004)。
 *
 * 纯叶子:零 IO、确定性、绝不抛、单一真源、可单测。env 门控 KHY_GROUND_TRUTH(默认开,
 * 仅显式 0/false/off/no 关闭;关闭后 routeGroundTruth 返回空指令,系统提示词字节不变)。
 * 不使用 eval / new Function([MGMT-RPT-020] REQ-2026-005),纯手写文法求值。
 */

// ── env 门控(默认开,仅 0/false/off/no 关)─────────────────────────────
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_GROUND_TRUTH;
  return !(v !== undefined && ['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase()));
}

// ── BigInt 有理数(分子 n / 正分母 d,始终约分)─────────────────────────
function _gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}
// 有理数分子/分母的十进制位数硬上界。任何算术运算(_add/_sub/_mul/_div)结果的
// |分子| 或 分母 超过约 6000 位即放弃(返回 null)——防「大数连乘链」DoS:用户粘贴
// `99999*99999*…`(数千项)会让 BigInt 无界膨胀,单线程乘法挂死事件循环(实测
// 2000 项 5000 位字面量连乘冻结 ~103 秒)。与 _POW_DIGIT_LIMIT 对齐,是 _pow 之外
// 唯一的另一条大数爆炸路径(裸 _mul 链不经 _pow)。门控关时回退无界旧行为。
const _RAT_DIGIT_LIMIT = 6000;
const _RAT_MAGNITUDE_LIMIT = 10n ** BigInt(_RAT_DIGIT_LIMIT);
function _ratGuardEnabled() {
  return !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_GROUND_TRUTH_RAT_GUARD || '').trim().toLowerCase(),
  );
}
function _rat(n, d) {
  if (d === 0n) return null;
  if (_ratGuardEnabled()) {
    const an = n < 0n ? -n : n;
    const ad = d < 0n ? -d : d;
    if (an >= _RAT_MAGNITUDE_LIMIT || ad >= _RAT_MAGNITUDE_LIMIT) return null;
  }
  if (d < 0n) { n = -n; d = -d; }
  const g = _gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}
function _add(a, b) { return _rat(a.n * b.d + b.n * a.d, a.d * b.d); }
function _sub(a, b) { return _rat(a.n * b.d - b.n * a.d, a.d * b.d); }
function _mul(a, b) { return _rat(a.n * b.n, a.d * b.d); }
function _div(a, b) { if (!b || b.n === 0n) return null; return _rat(a.n * b.d, a.d * b.n); }

// 幂:指数必须是整数有理数;按平方求幂。设上界防 BigInt 爆炸(失败软回 null)。
const _POW_EXP_LIMIT = 4096n;
const _POW_DIGIT_LIMIT = 6000; // 估算结果十进制位数上界,超则放弃
function _pow(base, exp) {
  if (!base || !exp || exp.d !== 1n) return null; // 指数须为整数
  let e = exp.n;
  if (e < 0n) {
    if (base.n === 0n) return null;
    const inv = _div({ n: 1n, d: 1n }, base);
    return inv ? _pow(inv, { n: -e, d: 1n }) : null;
  }
  if (e > _POW_EXP_LIMIT) return null;
  // 位数估算:exp * max(位数(|n|), 位数(d))
  const baseDigits = Math.max(
    (base.n < 0n ? -base.n : base.n).toString().length,
    base.d.toString().length,
  );
  if (Number(e) * baseDigits > _POW_DIGIT_LIMIT) return null;
  let result = { n: 1n, d: 1n };
  let b = base;
  while (e > 0n) {
    if (e & 1n) { result = _mul(result, b); if (!result) return null; }
    e >>= 1n;
    if (e > 0n) { b = _mul(b, b); if (!b) return null; }
  }
  return result;
}

// 小数字面量 → 精确有理数。"12.34" → 1234/100;"0.1" → 1/10。
function _decimalToRat(tok) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(tok);
  if (!m) return null;
  const intPart = m[1];
  const frac = m[2] || '';
  const num = BigInt(intPart + frac);
  const den = 10n ** BigInt(frac.length);
  return _rat(num, den);
}

// ── 受限文法求值器(递归下降,纯手写,零 eval)──────────────────────────
// 归一化:全角括号 / 乘除号 / 一元 Unicode 负号 → ASCII。
function _normalizeExpr(s) {
  return String(s || '')
    // 全角数字 ０-９ → ASCII 0-9
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[×∗·＊]/g, '*')
    .replace(/[÷／]/g, '/')
    .replace(/＋/g, '+')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[−–—－]/g, '-')
    .replace(/[＝]/g, '=')
    .replace(/[．]/g, '.'); // 仅全角小数点 U+FF0E;中文句号 U+3002 不归一(避免跨句误判)
}

function _tokenize(src) {
  const tokens = [];
  const re = /\s*(\d+\.\d+|\d+|\*\*|[-+*/%^()])/g;
  let pos = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index !== pos) return null; // 出现非法字符
    tokens.push(m[1] === '**' ? '^' : m[1]);
    pos = re.lastIndex;
  }
  if (src.slice(pos).trim() !== '') return null;
  return tokens;
}

/**
 * 安全求值受限算术文法,返回有理数 { n, d } 或 null(任何非法/越界/除零)。绝不抛。
 * @param {string} input
 * @returns {{n:bigint,d:bigint}|null}
 */
function _evalRat(input) {
  const tokens = _tokenize(_normalizeExpr(input));
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  let failed = false;
  const peek = () => tokens[i];
  const eat = () => tokens[i++];

  function expr() { // + -
    let left = term();
    while (!failed && (peek() === '+' || peek() === '-')) {
      const op = eat();
      const right = term();
      if (failed || !left || !right) { failed = true; return null; }
      left = op === '+' ? _add(left, right) : _sub(left, right);
      if (!left) { failed = true; return null; }
    }
    return left;
  }
  function term() { // * / %
    let left = power();
    while (!failed && (peek() === '*' || peek() === '/' || peek() === '%')) {
      const op = eat();
      const right = power();
      if (failed || !left || !right) { failed = true; return null; }
      if (op === '*') left = _mul(left, right);
      else if (op === '/') left = _div(left, right);
      else { // 取模:仅对整数有意义
        if (left.d !== 1n || right.d !== 1n || right.n === 0n) { failed = true; return null; }
        left = _rat(((left.n % right.n) + right.n) % right.n, 1n);
      }
      if (!left) { failed = true; return null; }
    }
    return left;
  }
  function power() { // ^ 右结合
    const base = unary();
    if (!failed && peek() === '^') {
      eat();
      const exp = power();
      if (failed || !base || !exp) { failed = true; return null; }
      const r = _pow(base, exp);
      if (!r) { failed = true; return null; }
      return r;
    }
    return base;
  }
  function unary() {
    if (peek() === '-') { eat(); const v = unary(); if (failed || !v) { failed = true; return null; } return _rat(-v.n, v.d); }
    if (peek() === '+') { eat(); return unary(); }
    return primary();
  }
  function primary() {
    const t = peek();
    if (t === undefined) { failed = true; return null; }
    if (t === '(') {
      eat();
      const v = expr();
      if (eat() !== ')') { failed = true; return null; }
      return v;
    }
    if (/^\d/.test(t)) { eat(); return _decimalToRat(t); }
    failed = true;
    return null;
  }

  const value = expr();
  if (failed || i !== tokens.length || !value) return null;
  return value;
}

// 同一表达式的**浮点**求值(IEEE-754),仅用于「浮点会算错」的对照附注。复用同一 token
// 流但以 JS Number 运算,因此 0.1+0.2 这类经典误差会原样浮现(→ 0.30000000000000004)。
// 绝不抛:任何异常 / 越界回 null。
function _evalFloat(input) {
  const tokens = _tokenize(_normalizeExpr(input));
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  let failed = false;
  const peek = () => tokens[i];
  const eat = () => tokens[i++];
  function expr() {
    let left = term();
    while (!failed && (peek() === '+' || peek() === '-')) {
      const op = eat();
      const right = term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function term() {
    let left = power();
    while (!failed && (peek() === '*' || peek() === '/' || peek() === '%')) {
      const op = eat();
      const right = power();
      if (op === '*') left *= right;
      else if (op === '/') left /= right;
      else left %= right;
    }
    return left;
  }
  function power() {
    const base = unary();
    if (!failed && peek() === '^') { eat(); return base ** power(); }
    return base;
  }
  function unary() {
    if (peek() === '-') { eat(); return -unary(); }
    if (peek() === '+') { eat(); return unary(); }
    return primary();
  }
  function primary() {
    const t = peek();
    if (t === undefined) { failed = true; return NaN; }
    if (t === '(') { eat(); const v = expr(); if (eat() !== ')') { failed = true; return NaN; } return v; }
    if (/^\d/.test(t)) { eat(); return parseFloat(t); }
    failed = true;
    return NaN;
  }
  const v = expr();
  if (failed || i !== tokens.length || !Number.isFinite(v)) return null;
  return v;
}

// ── 有理数格式化为人类可读真值 ───────────────────────────────────────
function _formatRat(r) {
  const neg = r.n < 0n;
  const n = r.n < 0n ? -r.n : r.n;
  const d = r.d;
  if (d === 1n) {
    return { exact: (neg ? '-' : '') + n.toString(), isInteger: true, terminating: true, fraction: null, approx: null };
  }
  // 是否有限小数:去掉 d 的所有因子 2 和 5 后是否为 1。
  let dd = d;
  while (dd % 2n === 0n) dd /= 2n;
  while (dd % 5n === 0n) dd /= 5n;
  const terminating = dd === 1n;
  const intPart = n / d;
  let rem = n % d;
  if (terminating) {
    let digits = '';
    let cap = 80;
    while (rem !== 0n && cap-- > 0) { rem *= 10n; digits += (rem / d).toString(); rem %= d; }
    const exact = (neg ? '-' : '') + intPart.toString() + (digits ? '.' + digits : '');
    return { exact, isInteger: false, terminating: true, fraction: null, approx: null };
  }
  const fraction = (neg ? '-' : '') + n.toString() + '/' + d.toString();
  const approx = _decimalApprox(neg, n, d, 12);
  return { exact: fraction, isInteger: false, terminating: false, fraction, approx };
}

// 长除法取 places 位小数并四舍五入(确定性,纯 BigInt)。
function _decimalApprox(neg, n, d, places) {
  const scale = 10n ** BigInt(places + 1);
  const scaled = (n * scale) / d; // 多算一位用于四舍五入
  const rounded = (scaled + 5n) / 10n;
  const s = rounded.toString().padStart(places + 1, '0');
  const intP = s.slice(0, s.length - places) || '0';
  const fracP = s.slice(s.length - places).replace(/0+$/, '');
  return (neg ? '-' : '') + intP + (fracP ? '.' + fracP : '');
}

/**
 * 精确求值一个算术表达式字符串。纯函数、绝不抛。
 * @param {string} expr
 * @returns {{ok:boolean, exact?:string, isInteger?:boolean, fraction?:string|null, approx?:string|null,
 *            floatDiffers?:boolean, bigBeyondSafe?:boolean}}
 */
function computeArithmetic(expr) {
  try {
    const r = _evalRat(expr);
    if (!r) return { ok: false };
    const f = _formatRat(r);
    // 同一表达式的浮点求值是否与精确真值不一致(用于「绝不信任浮点 / 心算」附注)。
    // 关键:对照的是**表达式本身**的浮点结果(故 0.1+0.2→0.30000000000000004 会现形),
    // 而非精确结果再转浮点。
    let floatDiffers = false;
    let floatValue = null;
    try {
      const fv = _evalFloat(expr);
      if (fv !== null) {
        floatValue = String(fv);
        if (f.terminating && floatValue !== f.exact) floatDiffers = true;
      }
    } catch { /* 忽略 */ }
    const absN = r.n < 0n ? -r.n : r.n;
    const bigBeyondSafe = f.isInteger && absN > 9007199254740991n; // > 2^53-1
    return {
      ok: true,
      exact: f.exact,
      isInteger: f.isInteger,
      fraction: f.fraction,
      approx: f.approx,
      terminating: f.terminating,
      floatDiffers,
      floatValue,
      bigBeyondSafe,
    };
  } catch { return { ok: false }; }
}

// ── 变量感知精确求值(供解方程/方程组「代入复核」复用同一精确有理数核)───────
// 动机:answerVerifier 已能复核模型写出的**纯数值**等式;但「解方程/方程组」要复核的是
// 「把模型给的解代回原方程,左右两边是否精确相等」——这需要在表达式里**绑定变量值**。
// 这里只新增一个**变量感知**的文法驱动(identifier → 绑定的有理数),其余算术全程复用上面
// 的同一套 BigInt 有理数算子(_add/_sub/_mul/_div/_pow/_rat/_decimalToRat),零浮点误差。
// 刻意**不改** _evalRat / computeArithmetic / detectComputableClaims(那是零假阳性检测路径,
// 逐字节不动);故文法驱动在此独立一份(仅 ~40 行),算术内核不重造。绝不抛、绝不 eval。

// 绑定值字符串 → 有理数:支持可选符号、小数、简单分数 a/b(如 "2"/"-1.5"/"3/2"/"-7/4")。
function _signedDecToRat(t) {
  let s = String(t == null ? '' : t).trim();
  if (!s) return null;
  let neg = false;
  if (s[0] === '+') s = s.slice(1);
  else if (s[0] === '-') { neg = true; s = s.slice(1); }
  const r = _decimalToRat(s);
  if (!r) return null;
  return neg ? _rat(-r.n, r.d) : r;
}
function _strToRat(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  const fm = /^([+-]?\d+(?:\.\d+)?)\s*\/\s*([+-]?\d+(?:\.\d+)?)$/.exec(t);
  if (fm) {
    const a = _signedDecToRat(fm[1]);
    const b = _signedDecToRat(fm[2]);
    if (!a || !b) return null;
    return _div(a, b);
  }
  return _signedDecToRat(t);
}

// 受限文法 token(在 _tokenize 基础上额外接受标识符 [A-Za-z_]\w*)。其余规则一致。
function _tokenizeWithVars(src) {
  const tokens = [];
  const re = /\s*(\d+\.\d+|\d+|[A-Za-z_][A-Za-z0-9_]*|\*\*|[-+*/%^()])/g;
  let pos = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index !== pos) return null; // 非法字符
    tokens.push(m[1] === '**' ? '^' : m[1]);
    pos = re.lastIndex;
  }
  if (src.slice(pos).trim() !== '') return null;
  return tokens;
}

// 变量感知递归下降求值:identifier → vars[name](有理数),未绑定 → null。绝不抛。
function _evalRatWithVars(input, vars) {
  const tokens = _tokenizeWithVars(_normalizeExpr(input));
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  let failed = false;
  const peek = () => tokens[i];
  const eat = () => tokens[i++];
  function expr() {
    let left = term();
    while (!failed && (peek() === '+' || peek() === '-')) {
      const op = eat();
      const right = term();
      if (failed || !left || !right) { failed = true; return null; }
      left = op === '+' ? _add(left, right) : _sub(left, right);
      if (!left) { failed = true; return null; }
    }
    return left;
  }
  function term() {
    let left = power();
    while (!failed && (peek() === '*' || peek() === '/' || peek() === '%')) {
      const op = eat();
      const right = power();
      if (failed || !left || !right) { failed = true; return null; }
      if (op === '*') left = _mul(left, right);
      else if (op === '/') left = _div(left, right);
      else {
        if (left.d !== 1n || right.d !== 1n || right.n === 0n) { failed = true; return null; }
        left = _rat(((left.n % right.n) + right.n) % right.n, 1n);
      }
      if (!left) { failed = true; return null; }
    }
    return left;
  }
  function power() {
    const base = unary();
    if (!failed && peek() === '^') {
      eat();
      const exp = power();
      if (failed || !base || !exp) { failed = true; return null; }
      const r = _pow(base, exp);
      if (!r) { failed = true; return null; }
      return r;
    }
    return base;
  }
  function unary() {
    if (peek() === '-') { eat(); const v = unary(); if (failed || !v) { failed = true; return null; } return _rat(-v.n, v.d); }
    if (peek() === '+') { eat(); return unary(); }
    return primary();
  }
  function primary() {
    const t = peek();
    if (t === undefined) { failed = true; return null; }
    if (t === '(') {
      eat();
      const v = expr();
      if (eat() !== ')') { failed = true; return null; }
      return v;
    }
    if (/^\d/.test(t)) { eat(); return _decimalToRat(t); }
    if (/^[A-Za-z_]/.test(t)) {
      eat();
      if (!vars || !Object.prototype.hasOwnProperty.call(vars, t)) { failed = true; return null; } // 未绑定变量 → fail
      return vars[t];
    }
    failed = true;
    return null;
  }
  const value = expr();
  if (failed || i !== tokens.length || !value) return null;
  return value;
}

/**
 * 在给定变量绑定下精确求值一个表达式(含变量)。纯函数、绝不抛。
 * @param {string} expr   形如 "2*x + 3*y" / "x^2 - 1"(乘法须显式写 *,零歧义)
 * @param {object} bindings  变量名 → 值(数字或字符串;支持整数/小数/简单分数 a/b)
 * @returns {{ok:boolean, n?:string, d?:string, exact?:string}}
 */
function evaluateRational(expr, bindings) {
  try {
    const vars = {};
    if (bindings && typeof bindings === 'object') {
      for (const k of Object.keys(bindings)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue; // 非法变量名跳过
        const r = _strToRat(bindings[k]);
        if (!r) return { ok: false };                      // 绑定值无法精确表示 → fail-closed
        vars[k] = r;
      }
    }
    const r = _evalRatWithVars(expr, vars);
    if (!r) return { ok: false };
    const f = _formatRat(r);
    return { ok: true, n: r.n.toString(), d: r.d.toString(), exact: f.exact };
  } catch { return { ok: false }; }
}

/**
 * 在变量绑定下判定 `lhsExpr == rhsExpr` 是否**精确**成立(代入复核解方程的核心原语)。
 * 两侧都须能在绑定下精确求值,否则 ok:false(无法确认即不下结论,零假阳性)。
 * @returns {{ok:boolean, equal?:boolean, lhs?:string, rhs?:string}}
 */
function equalsUnderBindings(lhsExpr, rhsExpr, bindings) {
  const a = evaluateRational(lhsExpr, bindings);
  const b = evaluateRational(rhsExpr, bindings);
  if (!a.ok || !b.ok) return { ok: false };
  try {
    const equal = BigInt(a.n) * BigInt(b.d) === BigInt(b.n) * BigInt(a.d);
    return { ok: true, equal, lhs: a.exact, rhs: b.exact };
  } catch { return { ok: false }; }
}

// ── 进制转换(仅带前缀字面量 → 十进制,零歧义)────────────────────────
function convertBase(token) {
  try {
    const t = String(token || '').trim();
    let m;
    if ((m = /^0[xX]([0-9a-fA-F]+)$/.exec(t))) return { ok: true, base: 16, decimal: _parseBigIntRadix(m[1], 16n) };
    if ((m = /^0[bB]([01]+)$/.exec(t))) return { ok: true, base: 2, decimal: _parseBigIntRadix(m[1], 2n) };
    if ((m = /^0[oO]([0-7]+)$/.exec(t))) return { ok: true, base: 8, decimal: _parseBigIntRadix(m[1], 8n) };
    return { ok: false };
  } catch { return { ok: false }; }
}
function _parseBigIntRadix(digits, radix) {
  let acc = 0n;
  for (const ch of String(digits)) {
    const v = BigInt(parseInt(ch, Number(radix)));
    acc = acc * radix + v;
  }
  return acc.toString();
}

// ── 检测:从用户文本抽出确定性可算的真值(零假阳性)──────────────────
const _MATH_RUN_RE = /[0-9.\s()+\-*/^%]+/g;
const _DATE_RE = /\b\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2}\b/;
const _VERSION_RE = /\b\d+\.\d+\.\d+/;
const _STRONG_OP_RE = /[*/^%()]/;
const _BINARY_OP_RE = /[-+*/^%]/;
const _CALC_INTENT_RE = /=|等于|等於|多少|几何|得几|结果|计算|算一下|算算|算出|compute|calculate|equals?/i;
const _BASE_INTENT_RE = /十进制|十六进制|二进制|八进制|进制|decimal|hex(?:adecimal)?|binary|octal|转(?:成|换)?|convert|是多少|等于|=/i;
const _BASE_LITERAL_RE = /\b0[xX][0-9a-fA-F]+\b|\b0[bB][01]+\b|\b0[oO][0-7]+\b/g;
const _MAX_FACTS = 8;

/**
 * 从文本检测确定性可算真值。绝不抛,返回 facts 数组(可空)。
 * @param {string} text
 * @returns {Array<{kind:'arith'|'base', expr:string, value:string, note?:string}>}
 */
function detectComputableClaims(text) {
  const facts = [];
  const seen = new Set();
  const raw = String(text || '');
  if (!raw) return facts;
  const norm = _normalizeExpr(raw);
  const explicitIntent = _CALC_INTENT_RE.test(raw);

  // A. 算术 —— 两段式守零误报:
  //   1) 先收集所有候选 span,排除日期 / 版本号 / 无算符,并求值;
  //   2) 含**强算符** `* / ^ % ()` 的算式直接可信(歧义极低);仅含弱算符 `+ -` 的算式
  //      须满足「同句已有显式计算标记,或已出现至少一条强算符算式(用户明显在计算模式)」
  //      才纳入,以免「page 1-2」「买 3-5 个」这类被误算。
  const candidates = [];
  let m;
  _MATH_RUN_RE.lastIndex = 0;
  while ((m = _MATH_RUN_RE.exec(norm)) !== null) {
    let span = m[0].trim();
    span = span.replace(/^[+*/^%\s]+/, '').replace(/[+\-*/^%\s]+$/, ''); // 去首尾游离算符(留括号)
    if (span.length < 3) continue;
    if (!/\d/.test(span)) continue;
    if (!_BINARY_OP_RE.test(span)) continue;
    if (_DATE_RE.test(span) || _VERSION_RE.test(span)) continue;
    const r = computeArithmetic(span);
    if (!r.ok) continue;
    candidates.push({ span, strong: _STRONG_OP_RE.test(span), r });
  }
  const computational = explicitIntent || candidates.some((c) => c.strong);
  for (const c of candidates) {
    if (facts.length >= _MAX_FACTS) break;
    if (!c.strong && !computational) continue; // 弱算符算式仅在「计算模式」下可信
    const key = 'a:' + c.span.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const r = c.r;
    const fact = { kind: 'arith', expr: c.span.replace(/\s+/g, ' ').trim(), value: r.exact };
    const notes = [];
    if (!r.terminating && r.approx) notes.push(`≈ ${r.approx}(精确值为最简分数 ${r.fraction})`);
    if (r.floatDiffers && r.floatValue) notes.push(`浮点会误为 ${r.floatValue},模型心算与浮点都不可信,以本真值为准`);
    if (r.bigBeyondSafe) notes.push('超出双精度安全整数 2^53,浮点 / 心算极易丢位');
    if (notes.length) fact.note = notes.join(';');
    facts.push(fact);
  }

  // B. 进制字面量 → 十进制(仅在出现转换意图时)
  if (_BASE_INTENT_RE.test(raw)) {
    _BASE_LITERAL_RE.lastIndex = 0;
    while ((m = _BASE_LITERAL_RE.exec(raw)) !== null) {
      if (facts.length >= _MAX_FACTS) break;
      const lit = m[0];
      const conv = convertBase(lit);
      if (!conv.ok) continue;
      const key = 'b:' + lit.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({ kind: 'base', expr: `${lit}(${conv.base} 进制)`, value: `${conv.decimal}(十进制)` });
    }
  }

  return facts;
}

// ── 指令:把已验证真值交给模型(注入系统提示词)─────────────────────
function buildGroundTruthDirective(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return '';
  const lines = facts.map((f) => {
    const base = `  • ${f.expr} = ${f.value}`;
    return f.note ? `${base}(${f.note})` : base;
  });
  return [
    '[SYSTEM: 以下数值已由 khyos 用确定性代码精确算出(精确有理数 / 大整数运算,非浮点近似),',
    '是不可争辩的绝对真值。**请直接采用,禁止自行重算、修改或质疑**——模型的心算乃至浮点运算都',
    '可能出错,而这些结果不会。你的职责是用这些已验证的真值来作答、表达与应用,而非重新计算它们:',
    ...lines,
    ']',
  ].join('\n');
}

/**
 * 编排:从文本算出地面真值并生成注入指令。镜像 routeSearchNecessity 的契约。
 * @param {object} args
 * @param {string} args.text
 * @param {object} [args.env]
 * @returns {{facts:Array, directive:string}}
 */
function routeGroundTruth({ text = '', env } = {}) {
  if (!isEnabled(env)) return { facts: [], directive: '' };
  const facts = detectComputableClaims(text);
  return { facts, directive: buildGroundTruthDirective(facts) };
}

module.exports = {
  isEnabled,
  computeArithmetic,
  evaluateRational,
  equalsUnderBindings,
  convertBase,
  detectComputableClaims,
  buildGroundTruthDirective,
  routeGroundTruth,
};
