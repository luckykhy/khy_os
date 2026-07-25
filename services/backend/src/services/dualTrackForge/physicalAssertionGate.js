'use strict';

/**
 * physicalAssertionGate.js — 物理断言网关（§3.1 主干 / 物理熔断）。
 *
 * 「不可逾越的客观定律」：把一次执行的现场（输出 / 工具名 / 行为 / 资源）拿去跑**纯代码可
 * 计算**的硬校验，命中即判定为某个物理异常码（见 `physicalCodes`）。零模型、确定性、无 I/O。
 *
 * 判别有两路，先显式后兜底：
 *   1) 显式信号——调用方直接给出结构化事实（toolName ∉ knownTools、denied、used>budget、
 *      schema 校验返回 false…）。最可靠。
 *   2) 错误签名兜底——只拿到一个 Error/字符串时，用关键字签名把它归到最贴近的物理码。
 *
 * 多命中时按 `gateOrder` 取**优先级最高**者为主异常（越权/安全优先），其余并入 `also`。
 *
 * 设计上故意**不抛**：`assert()` 返回 PhysicalException 值或 null，让门面把「先发保底需求」
 * 的顺序攥在自己手里（防呆③）。另给 `assertOrThrow()` 与 `wrap()`（物理网关包裹执行器）供
 * 需要异常语义的调用点使用。
 */

const { PHYSICAL_CODES, mappingFor } = require('./physicalCodes');

/** 物理异常：可被客观计算判定的硬伤。携带定位 finding，供确定性升维直接查表。 */
class PhysicalException extends Error {
  constructor(code, finding, detail = {}) {
    super(`${code}: ${finding}`);
    this.name = 'PhysicalException';
    this.code = code;
    this.finding = finding;       // 人读定位，如 "调用了不存在的工具 tool_x"
    this.detail = detail;         // 结构化现场 { toolName, used, budget, ... }
    this.physical = true;
  }
}

function _text(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return `${err.message || ''} ${err.code || ''}`;
  if (typeof err === 'object') {
    const msg = err.message || err.error || err.reason || '';
    return `${typeof msg === 'string' ? msg : JSON.stringify(msg)} ${err.code || ''}`;
  }
  return String(err);
}

function _toSet(x) {
  if (!x) return null;
  if (x instanceof Set) return x;
  if (Array.isArray(x)) return new Set(x.map(String));
  return null;
}

// 错误签名 → 物理码（兜底；显式信号缺失时启用）。顺序即优先级。
const _SIGNATURES = [
  { code: PHYSICAL_CODES.ERR_BEHAVIOR_FORBIDDEN, re: /(forbidden|eperm|denied|越权|拒绝执行|权限不足|behavior_forbidden|审批未过|越界访问)/i },
  { code: PHYSICAL_CODES.ERR_TOOL_HALLUCINATION, re: /(unknown tool|hallucinat|不存在的工具|no such tool|tool not found|未注册工具|tool_unavailable)/i },
  { code: PHYSICAL_CODES.ERR_RESOURCE_OVERFLOW, re: /(overflow|max_tokens|资源越界|上下文溢出|预算超限|budget exceeded|resource_overflow|context.*meltdown|频繁熔断)/i },
  { code: PHYSICAL_CODES.ERR_SCHEMA_VIOLATION, re: /(schema|json.*parse|parse.*json|格式校验|结构化校验|validation failed|invalid format|schema_violation|不是合法json)/i },
];

class PhysicalAssertionGate {
  /**
   * 断言一次执行现场，返回首要物理异常（或 null = 物理上无硬伤）。
   *
   * @param {object} obs
   * @param {*}        [obs.output]        实际输出（喂给 schema 校验 / JSON 解析）
   * @param {function|object} [obs.schema] 校验器：fn(output)->bool 或 { validate: fn }；返回 false 即违例
   * @param {boolean}  [obs.expectJson]    要求 output 可解析为 JSON
   * @param {string}   [obs.toolName]      模型试图调用的工具名
   * @param {string[]|Set} [obs.knownTools] 合法工具白名单；toolName 不在其中 → 幻觉
   * @param {boolean}  [obs.denied] [obs.forbidden] [obs.gatewayBlocked]  行为越权显式标志
   * @param {number}   [obs.resourceUsed] [obs.budget]  资源用量/预算；used>budget → 越界
   * @param {boolean}  [obs.resourceOverflow]  资源越界显式标志
   * @param {Error|object|string} [obs.error]  原始失败信号（显式信号缺失时走签名兜底）
   * @returns {PhysicalException|null}
   */
  assert(obs = {}) {
    const hits = this._detectAll(obs);
    if (!hits.length) return null;
    hits.sort((a, b) => (mappingFor(a.code).gateOrder) - (mappingFor(b.code).gateOrder));
    const primary = hits[0];
    const ex = new PhysicalException(primary.code, primary.finding, primary.detail);
    if (hits.length > 1) ex.also = hits.slice(1).map((h) => ({ code: h.code, finding: h.finding }));
    return ex;
  }

  /** 命中即抛 PhysicalException；无硬伤返回 undefined。 */
  assertOrThrow(obs = {}) {
    const ex = this.assert(obs);
    if (ex) throw ex;
  }

  /**
   * 物理网关包裹执行器：跑 fn，对其结果/抛错做物理断言。
   * 返回 { ok, result?, physical? }——本网关从不让物理异常逃逸为未捕获错误。
   * @param {function} fn         待执行（同步或异步）
   * @param {function} [project]  (result)=>observation，把执行产物投影成断言现场
   */
  async wrap(fn, project) {
    let result, threw = null;
    try { result = await fn(); }
    catch (e) { threw = e; }
    const obs = threw
      ? { error: threw }
      : (typeof project === 'function' ? (project(result) || {}) : { output: result });
    const physical = this.assert(obs);
    if (threw && !physical) {
      // 抛了错但物理上判不出硬伤——保留原错误语义，交由旁路/上层处理。
      return { ok: false, result: undefined, physical: null, error: threw };
    }
    return { ok: !physical && !threw, result, physical: physical || null, error: threw || null };
  }

  _detectAll(obs) {
    const hits = [];

    // —— 1) 行为越权（显式） ——
    if (obs.denied === true || obs.forbidden === true || obs.gatewayBlocked === true) {
      hits.push({ code: PHYSICAL_CODES.ERR_BEHAVIOR_FORBIDDEN, finding: '行为越权被守卫/网关阻断', detail: { surface: obs.surface } });
    }

    // —— 2) 工具调用幻觉（显式） ——
    const known = _toSet(obs.knownTools);
    if (obs.toolName && known && !known.has(String(obs.toolName))) {
      hits.push({ code: PHYSICAL_CODES.ERR_TOOL_HALLUCINATION, finding: `调用了不存在的工具 ${obs.toolName}`, detail: { toolName: obs.toolName } });
    }

    // —— 3) 资源越界（显式） ——
    if (obs.resourceOverflow === true) {
      hits.push({ code: PHYSICAL_CODES.ERR_RESOURCE_OVERFLOW, finding: '资源越界（显式标志）', detail: {} });
    } else if (Number.isFinite(obs.resourceUsed) && Number.isFinite(obs.budget) && obs.resourceUsed > obs.budget) {
      hits.push({ code: PHYSICAL_CODES.ERR_RESOURCE_OVERFLOW, finding: `资源越界：用量 ${obs.resourceUsed} > 预算 ${obs.budget}`, detail: { used: obs.resourceUsed, budget: obs.budget } });
    }

    // —— 4) Schema 违例（显式：校验器 / JSON 解析） ——
    if (obs.schema != null && obs.output !== undefined) {
      const validate = typeof obs.schema === 'function' ? obs.schema
        : (obs.schema && typeof obs.schema.validate === 'function' ? obs.schema.validate : null);
      if (validate) {
        let ok = false;
        try { ok = validate(obs.output) === true; } catch { ok = false; }
        if (!ok) hits.push({ code: PHYSICAL_CODES.ERR_SCHEMA_VIOLATION, finding: '输出未通过 Schema 校验器', detail: {} });
      }
    }
    if (obs.expectJson === true && obs.output !== undefined && !this._parsesAsJson(obs.output)) {
      hits.push({ code: PHYSICAL_CODES.ERR_SCHEMA_VIOLATION, finding: '输出无法解析为 JSON', detail: {} });
    }

    // —— 5) 错误签名兜底（仅当显式路一无所获时启用，避免重复计码） ——
    if (!hits.length && obs.error != null) {
      const blob = _text(obs.error);
      for (const sig of _SIGNATURES) {
        if (sig.re.test(blob)) {
          hits.push({ code: sig.code, finding: `由错误签名归类：${blob.trim().slice(0, 160)}`, detail: { fromSignature: true } });
          break;
        }
      }
    }
    return hits;
  }

  _parsesAsJson(output) {
    if (output && typeof output === 'object') return true; // 已是对象
    if (typeof output !== 'string') return false;
    try { JSON.parse(output); return true; } catch { return false; }
  }
}

module.exports = { PhysicalAssertionGate, PhysicalException };
