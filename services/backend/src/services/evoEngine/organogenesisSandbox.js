'use strict';

/**
 * organogenesisSandbox.js — 宾客沙箱与毒性隔离（§3.3）。
 *
 * 自生成的「新器官」（一段代码）**绝不可**直接污染宿主。本沙箱是宾客原则的执行者：
 *   1. 静态毒性扫描：编译前先正则禁查危险 API（require/process/fs/eval/Function/网络/死循环…），
 *      命中即判毒，连编译都不给。
 *   2. 影子执行：在 `vm.runInNewContext` 的**空冻结上下文 + 超时**里运行新器官，无 require、
 *      无 process、无 global——逃不出沙箱。
 *   3. 差异校验：针对痛点探针逐条跑，验证「是否解决痛点（solved）」与「是否相对基线引入退化
 *      （regressed）」。仅当 solved && !regressed && !toxic 才判 passed。
 *   4. 受控热载凭证：仅在 passed 时签发一枚 HMAC `passToken`（绑定代码哈希 + 判决）。HostPatcher
 *      **必须**校验此凭证方可热载——凭证不可伪造，这是「绝不跳过沙箱直接注入宿主」（防呆①）
 *      的密码学闸门。
 *
 * 纯隔离层：不写盘、不碰宿主注册表。判决交由 engine 编排，热载交由 HostPatcher。
 */

const vm = require('vm');
const crypto = require('crypto');

// 默认影子执行超时（ms）；死循环器官会被 vm 超时打断（毒性之一）。
const DEFAULT_TIMEOUT_MS = 200;

// 静态毒性黑名单：新器官源码中一旦出现，直接判毒（编译前拦截）。
const TOXIC_PATTERNS = Object.freeze([
  { re: /\brequire\s*\(/, label: 'require（禁止越狱取模块）' },
  { re: /\bprocess\b/, label: 'process（禁止访问进程）' },
  { re: /\bglobal(This)?\b/, label: 'global/globalThis（禁止触全局）' },
  { re: /\b(child_process|fs|net|http|https|dgram|cluster|worker_threads|vm)\b/, label: '宿主敏感模块名' },
  { re: /\beval\s*\(/, label: 'eval（禁止动态求值）' },
  { re: /\bFunction\s*\(/, label: 'Function 构造器（禁止动态构造）' },
  { re: /\bimport\s*[(\s]/, label: 'import（禁止动态导入）' },
  { re: /\bwhile\s*\(\s*true\s*\)/, label: 'while(true)（疑似死循环）' },
  { re: /\bfor\s*\(\s*;\s*;\s*\)/, label: 'for(;;)（疑似死循环）' },
  { re: /\b__proto__\b|\bconstructor\s*\[/, label: '原型链逃逸尝试' },
]);

// 每进程沙箱密钥：用于签发/校验 passToken。仅存活于内存，不落盘、不外泄。
let _SECRET = null;
function _secret() {
  if (!_SECRET) _SECRET = crypto.randomBytes(32);
  return _SECRET;
}

function _codeHash(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

/** 静态毒性扫描——返回命中的毒性项（空数组 = 通过）。 */
function scanToxicity(code) {
  const src = String(code || '');
  const hits = [];
  for (const p of TOXIC_PATTERNS) {
    if (p.re.test(src)) hits.push(p.label);
  }
  return hits;
}

/** 签发热载凭证（仅 passed 时调用）。绑定 codeHash + 判决摘要，HMAC 防伪。 */
function _issueToken(codeHash, verdictDigest) {
  return crypto.createHmac('sha256', _secret())
    .update(`${codeHash}|${verdictDigest}`)
    .digest('hex');
}

/**
 * 校验热载凭证是否由本沙箱针对该代码签发（HostPatcher 调用，防呆①）。
 * @returns {boolean}
 */
function verifyToken(token, code, verdictDigest) {
  if (!token) return false;
  const expected = _issueToken(_codeHash(code), verdictDigest);
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 判决摘要：被签进 token，使凭证与具体判决绑定。 */
function _digestVerdict(v) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ solved: v.solved, regressed: v.regressed, toxic: v.toxic, probes: v.probeCount }))
    .digest('hex')
    .slice(0, 16);
}

class OrganogenesisSandbox {
  constructor(opts = {}) {
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  /**
   * 在隔离上下文里编译并取出新器官函数。失败（语法错/毒性）返回 { ok:false }。
   * @returns {{ok:boolean, fn?:function, error?:string}}
   */
  _materialize(code, entry) {
    const sandbox = Object.create(null); // 空上下文：无 require/process/global
    const context = vm.createContext(sandbox);
    try {
      // 包裹：让源码定义 entry 后回吐该函数引用。
      const wrapped = `(function(){ "use strict";\n${code}\n; return typeof ${entry} === 'function' ? ${entry} : null; })()`;
      const fn = vm.runInContext(wrapped, context, { timeout: this.timeoutMs, displayErrors: false });
      if (typeof fn !== 'function') return { ok: false, error: `未定义入口函数 ${entry}` };
      return { ok: true, fn };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /**
   * 影子执行 + 差异校验 + 毒性检测，对一个新器官下判决。
   *
   * @param {object} args
   * @param {string} args.code      新器官源码（须定义入口函数）
   * @param {string} args.entry     入口函数名
   * @param {Array<{input:*, expected:*}>} args.probes  痛点探针（验证 solved）
   * @param {function|Array} [args.baseline]  基线方案：函数（同输入对比）或 期望输出数组（验证 !regressed）
   * @param {function} [args.equals]  自定义相等判定（默认深比较 JSON）
   * @returns {{
   *   passed:boolean, solved:boolean, regressed:boolean, toxic:boolean,
   *   toxicity:string[], probeCount:number, results:Array, error:(string|null),
   *   codeHash:string, verdictDigest:string, passToken:(string|null)
   * }}
   */
  evaluate(args = {}) {
    const { code, entry = 'organ', probes = [] } = args;
    const equals = typeof args.equals === 'function' ? args.equals : _deepEqual;
    const codeHash = _codeHash(code);

    // 1) 静态毒性：命中即否决，连编译都不给（最早的闸门）。
    const toxicity = scanToxicity(code);
    if (toxicity.length) {
      const v = {
        passed: false, solved: false, regressed: false, toxic: true,
        toxicity, probeCount: probes.length, results: [],
        error: `静态毒性命中：${toxicity.join('；')}`, codeHash,
      };
      v.verdictDigest = _digestVerdict(v);
      v.passToken = null;
      return v;
    }

    // 2) 编译取器官（隔离上下文）。
    const mat = this._materialize(code, entry);
    if (!mat.ok) {
      const v = {
        passed: false, solved: false, regressed: false, toxic: false,
        toxicity: [], probeCount: probes.length, results: [],
        error: `器官编译失败：${mat.error}`, codeHash,
      };
      v.verdictDigest = _digestVerdict(v);
      v.passToken = null;
      return v;
    }

    // 3) 影子执行每条探针：solved = 全部命中 expected；regressed = 与基线相比退化。
    const results = [];
    let solved = true;
    let regressed = false;
    let runtimeError = null;

    for (let i = 0; i < probes.length; i++) {
      const probe = probes[i];
      let actual; let threw = null;
      try {
        actual = this._runIsolated(mat.fn, probe.input);
      } catch (e) {
        threw = e && e.message ? e.message : String(e);
      }
      const ok = !threw && ('expected' in probe ? equals(actual, probe.expected) : actual !== undefined);
      if (!ok) solved = false;
      if (threw) runtimeError = runtimeError || threw;

      // 差异校验：有基线则对比是否退化（基线能解而新器官解不了 = 退化）。
      if (args.baseline != null) {
        let baseOut; let baseThrew = false;
        try {
          baseOut = typeof args.baseline === 'function'
            ? args.baseline(probe.input)
            : (Array.isArray(args.baseline) ? args.baseline[i] : undefined);
        } catch { baseThrew = true; }
        const baseOk = !baseThrew && ('expected' in probe ? equals(baseOut, probe.expected) : baseOut !== undefined);
        if (baseOk && !ok) regressed = true; // 基线行、新器官不行 → 退化
      }

      results.push({ index: i, ok, threw, actual: _slim(actual) });
    }

    const toxic = false;
    const passed = solved && !regressed && !toxic && !runtimeError;
    const v = {
      passed, solved, regressed, toxic,
      toxicity: [], probeCount: probes.length, results,
      error: runtimeError, codeHash,
    };
    v.verdictDigest = _digestVerdict(v);
    // 4) 仅 passed 才签发热载凭证（防呆①的密码学闸门）。
    v.passToken = passed ? _issueToken(codeHash, v.verdictDigest) : null;
    return v;
  }

  /** 在隔离上下文里单次调用器官（每次新建上下文，杜绝跨调用状态污染）。 */
  _runIsolated(fn, input) {
    const sandbox = Object.create(null);
    sandbox.__organ = fn;
    sandbox.__input = input;
    const context = vm.createContext(sandbox);
    return vm.runInContext('__organ(__input)', context, { timeout: this.timeoutMs, displayErrors: false });
  }
}

function _deepEqual(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return a === b; }
}

function _slim(v) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s && s.length > 200 ? s.slice(0, 200) + '…' : v;
  } catch { return String(v); }
}

module.exports = {
  OrganogenesisSandbox,
  DEFAULT_TIMEOUT_MS,
  TOXIC_PATTERNS,
  scanToxicity,
  verifyToken,
  _digestVerdict,
};
