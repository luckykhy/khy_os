'use strict';

/**
 * semanticNumberCoerce — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让 CC 前端显示背后的**后端逻辑**对齐。」
 * 工具调用是 LLM 生成的 JSON,模型**偶发把数字加引号**——`{"head_limit":"30"}` 而非
 * `{"head_limit":30}`。CC 源 `src/utils/semanticNumber.ts` 用 z.preprocess 在校验**前**把
 * 这种「合法十进制数字字面量字符串」强制转成 number(对模型仍声明 `{"type":"number"}`,
 * 这只是**客户端隐形容错**),从而工具不会因模型的引号而调用失败。
 *
 * CC 的关键后端逻辑(逐字节移植,不可放宽):
 *   - **只**强制转换匹配 `/^-?\d+(\.\d+)?$/` 的字符串(整数 / 简单小数,可带前导负号)。
 *   - **绝不**用 `Number(v)` 兜底——那会把 `""` / `null` / 空白 / `"0x10"` / `"1e3"` /
 *     `"Infinity"` 也转掉,**掩盖真实 bug**(CC 注释明确反对 z.coerce.number())。
 *   - 不匹配的字符串**原样穿过**,继续被下游类型校验拒绝(诚实报错,模型可据此自纠)。
 *
 * Khy 真缺口(核实属实):`tools/_baseTool.js validateParams` 对 `type:'number'` 形参做
 * `typeof value === 'number'` 严格判定——模型传 `"30"` 时 `actualType='string'≠'number'`→
 * 推 `must be of type number, got string`→**整次工具调用被拒**(toolCalling.js:3385/3410)。
 * 本叶子把 CC `semanticNumber` 的强制转换收敛成单一真源,在校验前对 schema 中
 * `type:'number'` 的形参做同一套「合法字面量才转」的归一,使工具不再因模型引号失败。
 *
 * 门控:KHY_SEMANTIC_NUMBER(默认开)。=0/false/off/no → 关 → `coerceSchemaNumbers`
 * 原样返回入参**同一引用**(逐字节回退,与历史校验口径完全一致)。
 */

function semanticNumberEnabled(env = process.env) {
  const flag = String((env && env.KHY_SEMANTIC_NUMBER) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// CC semanticNumber 的判据:合法十进制数字字面量(整数 / 简单小数,可前导负号)。
// 刻意**不**接受 ""/空白/科学计数/十六进制/Infinity(那些应继续被下游校验拒绝)。
const _DECIMAL_LITERAL = /^-?\d+(\.\d+)?$/;

/**
 * CC `semanticNumber` 的 preprocess 强制转换(单值,纯):
 *   string 且匹配 `/^-?\d+(\.\d+)?$/` 且 Number() 有限 → number;否则原样返回。
 * @param {*} v
 * @returns {*}
 */
function coerceNumericLiteral(v) {
  if (typeof v === 'string' && _DECIMAL_LITERAL.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

/**
 * 按扁平 schema 对 params 中 `type:'number'` 的形参做 CC `semanticNumber` 强制转换。
 * 门控关 → 原样返回入参**同一引用**(零拷贝、逐字节回退)。
 * 门控开 → **仅当确有形参被转换时**才返回一个浅拷贝新对象(否则仍返回原引用),
 * 故「无可转换形参」与门控关在引用与字节上都等价。绝不改动非 number 形参 / 已是 number 的值 /
 * 不匹配字面量的字符串(后者继续被下游 validateParams 拒绝 → 诚实报错)。
 *
 * @param {object} schema  扁平 schema:{ key: { type, ... } }(registry.inputSchema / builtin.parameters)。
 * @param {object} params  待校验/执行的形参对象。
 * @param {object} [env]
 * @returns {object}  原对象(无变化 / 门控关)或浅拷贝(有形参被转换)。
 */
function coerceSchemaNumbers(schema, params, env) {
  if (!semanticNumberEnabled(env)) return params;
  if (!schema || typeof schema !== 'object') return params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;

  let out = null; // 惰性浅拷贝:只在确有转换时才分配 → 无变化时引用恒等。
  for (const [key, rule] of Object.entries(schema)) {
    if (!rule || typeof rule !== 'object' || rule.type !== 'number') continue;
    const value = params[key];
    const coerced = coerceNumericLiteral(value);
    if (coerced !== value) {
      if (!out) out = { ...params };
      out[key] = coerced;
    }
  }
  return out || params;
}

module.exports = {
  semanticNumberEnabled,
  coerceNumericLiteral,
  coerceSchemaNumbers,
};
