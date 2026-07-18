'use strict';

/**
 * localBrainCalc — 本地大脑「简单计算」子能力（从 localBrainService.js 抽出）。
 *
 * 抽出动机（[DESIGN-ARCH-051] 单人维护者驾驶舱实证）：localBrainService.js 超 2500 行
 * 巨石阈值（R2 架构债）。本簇为纯离线、确定性、无状态的内聚单元——中文数学归一 +
 * 受限算术文法安全求值器（[MGMT-RPT-020] REQ-2026-005，杜绝 `new Function`），
 * 天然可独立成模块并单测，是降巨石的低风险首切口。行为与抽出前**逐字节一致**。
 *
 * 仿 `codeCheckService` 既有先例：localBrainService 的 handler 注册表直接引用本模块导出。
 */

const _PURE_MATH_RE = /^[\d\s+\-*/().%^,]+$/;
const _CALC_INTENT_RE = /(计算|算一下|算算|等于多少|等于几|calculate|eval|compute)/i;

// Chinese-math regex ReDoS guard (KHY_CALC_REGEX_LINEAR, default on).
//
// The Chinese arithmetic-sugar patterns match a greedy number `(\d+)` followed
// by a literal anchor (`的…次方` / `开方`). When the anchor ultimately fails,
// the engine backtracks the greedy `\d+` one digit at a time AT EVERY start
// position, giving O(n^2). Two spots are affected: the `_isCalcIntent` line
// `\d+\s*的\s*\d+\s*次方` and the five `_cnMathMap` entries. A crafted offline
// message like `计算 9…9的` (tens of thousands of digits) reaches this via
// `localReasoning.reason` → `isCalcIntent`/`detectCalc`, which — unlike the
// `detectDeterministic` path — has NO 500-char cap (only `length >= 4`). It is
// user-reachable through the model-less `tryFallback` / `/local` offline path:
// N=20000 freezes ~4.9 s, N=100000 the intent check alone freezes ~22 s. The
// call sites wrap this in try/catch, but a hang never throws (R1 discipline),
// so the guard is useless — this is a real user-reachable DoS.
//
// Fix: bound the digit quantifier to `\d{1,64}` (a 64-digit number is already
// far past IEEE-754 exact range — anything longer is pathological, never a real
// calc). Backtracking is then O(1) per position → linear. Byte-identical on all
// realistic inputs (verified: numbers ≤64 digits produce the same rewrite); the
// only behavior change is that a >64-digit run no longer participates in the
// Chinese-sugar rewrite, which is a non-computation anyway.
// Off -> legacy unbounded `\d+` (identical output on sane input, quadratic).
//
// NOTE: the substring-extraction regex in `_detectCalc` (`([\d…]+(?:的…)?[\d…]*)`)
// and `_PURE_MATH_RE` were probed and are genuinely LINEAR (the `的` anchor is
// outside the char class, so a single occurrence terminates the greedy run with
// no backtracking blow-up) — they are deliberately left unbounded (honest
// negative result: same-shape ≠ same-vulnerable).
const _MAX_CALC_DIGITS = 64;
const _CALC_REGEX_LINEAR_OFF = ['0', 'false', 'off', 'no'];
function _calcRegexLinearEnabled(env = process.env) {
  return !_CALC_REGEX_LINEAR_OFF.includes(
    String((env && env.KHY_CALC_REGEX_LINEAR) || '').trim().toLowerCase());
}
// Digit quantifier fragment: bounded when the linear guard is on, legacy
// unbounded `\d+` when off. Built fresh per call to avoid module-level `/g`
// regex lastIndex reuse hazards across a gate flip.
function _digitQuant() {
  return _calcRegexLinearEnabled() ? `\\d{1,${_MAX_CALC_DIGITS}}` : '\\d+';
}
// Build the Chinese-math rewrite table. Order is load-bearing and preserved
// byte-for-byte from the original (`平方` before `平方根`, etc.).
function _buildCnMathMap() {
  const d = _digitQuant();
  return [
    [new RegExp(`(${d})\\s*的\\s*(${d})\\s*次方`, 'g'), 'Math.pow($1,$2)'],
    [new RegExp(`(${d})\\s*的\\s*平方`, 'g'), 'Math.pow($1,2)'],
    [new RegExp(`(${d})\\s*的\\s*立方`, 'g'), 'Math.pow($1,3)'],
    [new RegExp(`(${d})\\s*的\\s*平方根`, 'g'), 'Math.sqrt($1)'],
    [new RegExp(`(${d})\\s*开方`, 'g'), 'Math.sqrt($1)'],
    [/π|派/g, 'Math.PI'],
    [/×/g, '*'],
    [/÷/g, '/'],
    [/（/g, '('],
    [/）/g, ')'],
  ];
}
// Default (bounded) snapshot preserved as an export for diagnostics/back-compat.
const _CN_MATH_MAP = _buildCnMathMap();

function _isCalcIntent(text) {
  const t = text.trim();
  if (_PURE_MATH_RE.test(t) && /\d/.test(t) && /[+\-*/^%]/.test(t)) return true;
  if (_CALC_INTENT_RE.test(t) && /\d/.test(t)) return true;
  const d = _digitQuant();
  if (new RegExp(`${d}\\s*的\\s*${d}\\s*次方`).test(t)) return true;
  return false;
}

function _detectCalc(text) {
  let expr = text.replace(_CALC_INTENT_RE, '').trim();
  // 尝试提取含数字的表达式部分
  if (!_PURE_MATH_RE.test(expr)) {
    const m = text.match(/([\d\s+\-*/().%^×÷（）]+(?:的\s*\d+\s*次方|的\s*平方根?|的\s*立方|开方)?[\d\s+\-*/().%^×÷（）]*)/);
    if (m) expr = m[1].trim();
  }
  // 中文数学转换（gate-aware：默认有界 `\d{1,64}` 防 ReDoS，off 回退旧无界）
  for (const [re, rep] of _buildCnMathMap()) {
    expr = expr.replace(re, rep);
  }
  // ^ → **
  expr = expr.replace(/\^/g, '**');
  return { type: 'calc', category: '计算', label: expr, expr };
}

/**
 * 安全算术求值器（[MGMT-RPT-020] REQ-2026-005）。
 *
 * 取代 `new Function` 动态执行：以递归下降解析器对**受限算术文法**求值，仅支持
 * 数字、`+ - * / % **`、括号、一元正负，以及白名单函数 `Math.pow` / `Math.sqrt`
 * 与常量 `Math.PI`。任何其它标识符或语法一律抛错。
 *
 * 旧实现以字符级白名单守卫 `new Function`，其字符集合并集含 `constructor` 等标识符
 * 所需字母，构成可穿透的脆弱沙箱。本求值器不做任何动态代码执行，从根上消除该风险。
 *
 * @param {string} input
 * @returns {number}
 */
function _safeEvalArithmetic(input) {
  const src = String(input || '');
  const tokens = [];
  const re = /\s*(Math\.pow|Math\.sqrt|Math\.PI|\*\*|[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|[-+*/%(),])/g;
  let pos = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index !== pos) throw new Error('unexpected token');
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  if (src.slice(pos).trim() !== '') throw new Error('unexpected token');

  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function parseExpr() {
    let left = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function parseTerm() {
    let left = parsePower();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const right = parsePower();
      if (op === '*') left *= right;
      else if (op === '/') left /= right;
      else left %= right;
    }
    return left;
  }
  function parsePower() {
    const base = parseUnary();
    if (peek() === '**') {
      next();
      return base ** parsePower(); // 右结合
    }
    return base;
  }
  function parseUnary() {
    if (peek() === '-') { next(); return -parseUnary(); }
    if (peek() === '+') { next(); return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (t === undefined) throw new Error('unexpected end of expression');
    if (t === '(') {
      next();
      const v = parseExpr();
      if (next() !== ')') throw new Error('missing )');
      return v;
    }
    if (t === 'Math.PI') { next(); return Math.PI; }
    if (t === 'Math.sqrt') {
      next();
      if (next() !== '(') throw new Error('missing (');
      const a = parseExpr();
      if (next() !== ')') throw new Error('missing )');
      return Math.sqrt(a);
    }
    if (t === 'Math.pow') {
      next();
      if (next() !== '(') throw new Error('missing (');
      const a = parseExpr();
      if (next() !== ',') throw new Error('missing ,');
      const b = parseExpr();
      if (next() !== ')') throw new Error('missing )');
      return Math.pow(a, b);
    }
    if (/^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?$/.test(t)) {
      next();
      return parseFloat(t);
    }
    throw new Error(`unexpected token: ${t}`);
  }

  const value = parseExpr();
  if (i !== tokens.length) throw new Error('trailing tokens');
  return value;
}

function _executeCalc(plan) {
  const expr = plan.expr;
  try {
    const result = _safeEvalArithmetic(expr);
    if (typeof result !== 'number' || !isFinite(result)) {
      return { type: 'calc', success: false, error: '计算结果无效' };
    }
    return { type: 'calc', success: true, expr: plan.label || plan.expr, result };
  } catch (e) {
    return { type: 'calc', success: false, error: `计算错误: ${e.message}` };
  }
}

function _formatCalc(result) {
  if (!result.success) return `计算失败: ${result.error}`;
  // 友好格式化大数字
  const val = result.result;
  const formatted = Number.isInteger(val) ? val.toLocaleString() : val.toLocaleString(undefined, { maximumFractionDigits: 10 });
  return `${result.expr} = ${formatted}`;
}

module.exports = {
  // 干净 API（注册表/外部消费）
  isCalcIntent: _isCalcIntent,
  detectCalc: _detectCalc,
  safeEvalArithmetic: _safeEvalArithmetic,
  executeCalc: _executeCalc,
  formatCalc: _formatCalc,
  // 内部符号（测试/诊断）
  _CN_MATH_MAP,
  _calcRegexLinearEnabled,
  _buildCnMathMap,
  _MAX_CALC_DIGITS,
};
