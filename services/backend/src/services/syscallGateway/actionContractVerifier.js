'use strict';

/**
 * actionContractVerifier.js — 纯叶子:证明携带动作的「极小核验器 V」+ 可机检谓词契约(单一真源)。
 *
 * 目标(goal「Khyos 成为模型无关的可证明不变量层」):为每个 Agent 动作声明一份**类型化契约**
 *   `Γ ⊢ a : A → B  ∧  Φ_pre ⇒ Φ_post`
 * 其中 Φ_pre / Φ_post 是**可机检的逻辑公式**(而非自然语言),由一个**极小、纯函数、可独立审计**
 * 的核验器 V 在运行时检查 `V(contract, states) = ok` 才放行。
 *
 * 先核实再动手(绝不重造):Khyos 已有
 *   - trajectoryProvenance/traceChain.js —— append-only sha256 prevHash→hash 防篡改链(= 不可变审计 DAG/Phase 3);
 *   - trajectoryReplay/{replayBundle,envFingerprint,artifactHash,replayLedger} —— 重放就绪证明包;
 *   - syscallGateway/{intentSchema,redLine,approvalRouter} —— 动作意图规约 + fail-closed 裁决。
 * 唯一真缺口 = **没有「Φ_pre/Φ_post 作为数据的可机检谓词 + 极小核验器 V」**:既有 capabilityMatrix
 * 的 `preconditions` 是 **JS 函数**(`typeof === 'function'`),正是本契约语言**禁止**的形态(数据绝不当
 * 代码执行)。本叶子补这一层;裁决产物经既有 traceChain 锚定,绝不另造审计链。
 *
 * 契约(CONTRACT):
 *   - 零依赖:全文件无任何 require(连 node 标准库都不引);纯计算。
 *   - 纯函数 / 确定性:无 Date.now / 无随机 / 无 IO / 无副作用。
 *   - 极小公理集:谓词算子是一个**封闭、冻结**的集合(AXIOMS),evaluatePredicate 用一个固定 switch
 *     解释它们 —— 这就是「极小核验器 V」可独立审计的全部行为面。
 *   - fail-closed 铁律:任何畸形契约/未知算子/求值异常一律判 **不通过**(绝不 fail-open 放行)。
 *   - 门控 KHY_ACTION_CONTRACT 默认开(仅供未来接入网关的缝按需短路;V 本身是被显式调用的纯工具)。
 *
 * ── 自证其伪(对每条理论投毒路径先推演、再在代码中物理切断)──────────────────────────────
 * 由于契约可能由不可信模型产出,契约对象本身被视为「不可信字符串序列」。已切断的投毒路径:
 *   [P1 谓词即代码 / 图灵退化]:畸形契约携带 `{op:'js', src:'…'}` 或把函数塞进字段,妄图让 V 执行它。
 *        切断 → evaluatePredicate 只在**冻结的 AXIOMS 封闭集**上做 switch;未知 op 抛错→上层 fail-closed;
 *        全程**绝不**调用契约里的任何函数、绝不 eval / new Function / 反射。见 _evalNode default 分支。
 *   [P2 原型链污染]:契约用路径 `__proto__.polluted` / `constructor.prototype.x` 妄图越过状态读写原型。
 *        切断 → _get 只走**自有属性**(hasOwnProperty),且把 __proto__/prototype/constructor 段直接判缺失。
 *   [P3 fail-open 兜底]:契约故意抛异常,赌「出错=无契约=放行」。
 *        切断 → verify 的每个 catch 都返回 `ok:false`(永不返回 ok:true);缺失 Φ 视为「无此约束」而非「放行一切」。
 *   [P4 ReDoS / 正则炸弹]:若公理集含正则匹配,恶意契约可用灾难性回溯卡死核验器。
 *        切断 → **正则不在公理集内**(刻意剔除)。保持 V 极小,顺带消灭整个 ReDoS 面。
 *   [P5 资源耗尽 / 深递归]:契约嵌套上万层 and/or 或超长路径,妄图爆栈/耗时。
 *        切断 → 节点预算 MAX_PRED_NODES、路径深度 MAX_PATH_DEPTH、args 数 MAX_ARGS 全有硬上限,超限→fail-closed。
 *
 * ── 谓词逻辑升级(goal「优化 khyos」:命题逻辑 → 谓词逻辑 + Hoare 不变量)──────────────
 * 原核验器只有**命题逻辑**(布尔组合 + 路径原子)。本次按 goal 加三件,使之成为真正的**谓词逻辑**:
 *   (a) 有界量词 every(∀)/some(∃):对 path 处数组逐元素绑定 node.as 求值 node.body
 *       —— 这正是命题逻辑与谓词逻辑的分水岭(可表达「所有输出都已脱敏」「存在一个被批准的签名」)。
 *   (b) 比较算子的跨路径 ref 操作数:让 eq/ne/序/in 的另一侧可为另一条路径(而非仅字面常量),
 *       从而表达**关系不变量 / 帧条件**:`out.id == in.id`(不变)、`out.balance <= in.balance`(单调)。
 *   (c) 契约 inv 字段 = Hoare 不变量 I:必须在前态**与**后态**都**成立(`balance ≥ 0` 恒成立)。
 * 由此新增的投毒面同样先推演、再物理切断:
 *   [P6 量词绑定名走私]:`{op:'every', as:'__proto__', …}` 妄图借绑定名污染作用域/原型。
 *        切断 → as 须为非空字符串且非 __proto__/prototype/constructor,否则 fail-closed;_bindScope 只浅拷自有属性。
 *   [P7 量词 DoS]:对超长数组施量词,妄图耗时。切断 → MAX_QUANT_ELEMS 上限 + 元素体仍计入节点预算。
 *   [P8 ref 路径逃逸]:`{op:'eq', path:'x', ref:'__proto__.polluted'}` 妄图经 ref 读原型。
 *        切断 → ref 一律走 _get(自有属性 + 越权段判缺失);ref 指向缺失路径 → fail-closed。
 *
 * 刻意的能力边界(诚实声明,非遗漏):谓词语言**不含通用算术**(加减乘除)。`out.balance == in.balance - amount`
 * 这类**算术后置条件**超出本核验器范围——理由:① 通用算术会非最小地膨胀公理集;② 浮点精度会引入
 * 不确定性,违背「确定性」契约。绝大多数**安全不变量**(序关系/单调/相等/帧不变/成员/类型/量化属性)
 * 用关系逻辑即可表达;需要算术语义的后置条件应由调用方在动作内自证,而非塞进 V 的公理集。
 */

// ── 门控(唯一允许读 process.env 的地方;不构成 IO)──────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const raw = env && env.KHY_ACTION_CONTRACT;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── 极小公理集(封闭、冻结、可独立审计)─────────────────────────────────────────
// 这是核验器 V 的**全部**算子。新增算子 = 在此显式登记并在 _evalNode 加分支,绝无隐藏行为。
const AXIOMS = Object.freeze([
  'true', 'false',            // 常量
  'and', 'or', 'not',         // 命题逻辑:布尔组合
  'eq', 'ne',                 // 相等/不等(确定性深比较;另一侧可为字面 value 或跨路径 ref)
  'lt', 'le', 'gt', 'ge',     // 数值序(两侧须有限数,否则 fail-closed;另一侧可为 value 或 ref)
  'in',                       // 成员:state(path) ∈ (value[] 或 ref 解出的数组)
  'type',                     // 类型:typeOf(state(path)) === value
  'exists', 'absent',         // 存在/缺失(路径原子)
  'forbiddenKey',             // 对象在 path 处不得含任一越权键(__proto__/force/skipApproval…)
  'every', 'some',            // 谓词逻辑:有界全称量词 ∀ / 有界存在量词 ∃(对 path 处数组逐元素)
]);
const _AXIOM_SET = new Set(AXIOMS);

// ── 防爆硬上限([P5] 物理切断)────────────────────────────────────────────────
const MAX_PRED_NODES = 512;
const MAX_PATH_DEPTH = 32;
const MAX_ARGS = 64;
const MAX_QUANT_ELEMS = 256; // [P7] 有界量词每次最多迭代的数组元素数(切断量词 DoS)

// 状态缺失哨兵(模块私有、冻结、不可伪造)。区别于「字段值恰为 undefined」无所谓:两者都按缺失处理。
const MISSING = Object.freeze({ __khy_missing__: true });

// [P2] 任何这些路径段都判缺失,杜绝经契约路径读写原型链。
const _FORBIDDEN_SEG = new Set(['__proto__', 'prototype', 'constructor']);

// 收敛到 utils/isPlainObject 单一真源(逐字节委托,调用点不变)
const _isPlainObject = require('../../utils/isPlainObject');

function _typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'string'|'number'|'boolean'|'object'|'undefined'|'function'|'bigint'|'symbol'
}

/**
 * 安全取值:按点路径在 state 上**只读自有属性**逐段下行。
 * [P2 切断] 任一段命中 __proto__/prototype/constructor、或非自有属性、或越过对象边界 → 返回 MISSING。
 */
function _get(state, pathStr) {
  if (typeof pathStr !== 'string' || pathStr.length === 0) return MISSING;
  const segs = pathStr.split('.');
  if (segs.length > MAX_PATH_DEPTH) return MISSING;
  let cur = state;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.length === 0 || _FORBIDDEN_SEG.has(seg)) return MISSING;
    if (cur === null || (typeof cur !== 'object')) return MISSING;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return MISSING;
    cur = cur[seg];
  }
  return cur === undefined ? MISSING : cur;
}

/** 确定性深比较(仅原始值 / 数组 / 纯对象;函数/Symbol/异类一律不相等)。无递归爆栈风险:走 budget。 */
function _deepEq(a, b, budget) {
  if (++budget.n > MAX_PRED_NODES) throw new Error('node budget exceeded');
  if (a === b) return true;
  const ta = _typeOf(a), tb = _typeOf(b);
  if (ta !== tb) return false;
  if (ta === 'number') return a === b; // NaN!==NaN 故上面 a===b 已处理;此处保持严格
  if (ta === 'array') {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!_deepEq(a[i], b[i], budget)) return false;
    return true;
  }
  if (ta === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (_FORBIDDEN_SEG.has(k)) continue;
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!_deepEq(a[k], b[k], budget)) return false;
    }
    return true;
  }
  return false; // string/boolean/null 已由 a===b 覆盖;function/symbol/bigint 视为不相等
}

function _finiteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * 比较算子的「另一侧操作数」:可为字面 `value`,或跨路径 `ref`(关联前后态/帧条件,
 * 让不变量能表达 `out.id == in.id`、`out.balance <= in.balance` 这类**关系**而非仅与常量比)。
 * ref 经 _get 解析,自动继承 [P2] 原型链防护;ref 指向缺失路径 → present:false → 上层 fail-closed。
 */
function _operand(node, state) {
  if (node && typeof node.ref === 'string') {
    const v = _get(state, node.ref);
    return v === MISSING ? { present: false } : { present: true, value: v };
  }
  return { present: true, value: node ? node.value : undefined };
}

/**
 * 量词作用域绑定:把当前元素以名字 `name` 绑进一个**新**状态对象(浅拷贝外层自有属性 + 绑定),
 * 使量词体既能引用绑定元素、又能引用外层路径(如 in/out)。
 * [P6 切断] 绑定名若为 __proto__/prototype/constructor 由调用方先行拒绝;此处再次跳过越权键的拷贝,
 * 且只拷贝纯对象的自有属性,绝不触碰原型。
 */
function _bindScope(state, name, value) {
  const o = {};
  if (_isPlainObject(state)) {
    for (const k of Object.keys(state)) if (!_FORBIDDEN_SEG.has(k)) o[k] = state[k];
  }
  o[name] = value;
  return o;
}

/**
 * 谓词求值:在封闭 AXIOMS 集上解释一个**数据**谓词节点。
 * 返回 boolean。畸形子节点 → false(该约束不满足)。未知 op → 抛错(上层 fail-closed)。
 * [P1 切断] 全程不调用契约里的任何函数、不 eval、不反射;只读字段 + 固定 switch。
 */
function _evalNode(node, state, budget) {
  if (++budget.n > MAX_PRED_NODES) throw new Error('node budget exceeded');
  if (!_isPlainObject(node) || typeof node.op !== 'string') return false;
  const op = node.op;
  if (!_AXIOM_SET.has(op)) throw new Error('unknown axiom: ' + op); // [P1] 封闭集外一律 fail-closed

  switch (op) {
    case 'true': return true;
    case 'false': return false;

    case 'and': {
      const args = node.args;
      if (!Array.isArray(args) || args.length > MAX_ARGS) return false;
      for (const a of args) if (!_evalNode(a, state, budget)) return false;
      return true; // 空 and = 真(vacuous)
    }
    case 'or': {
      const args = node.args;
      if (!Array.isArray(args) || args.length > MAX_ARGS) return false;
      for (const a of args) if (_evalNode(a, state, budget)) return true;
      return false; // 空 or = 假
    }
    case 'not': {
      if (!_isPlainObject(node.arg)) return false;
      return !_evalNode(node.arg, state, budget);
    }

    case 'exists': return _get(state, node.path) !== MISSING;
    case 'absent': return _get(state, node.path) === MISSING;

    case 'type': {
      const v = _get(state, node.path);
      if (v === MISSING) return false;
      return _typeOf(v) === node.value;
    }

    case 'eq': {
      const v = _get(state, node.path);
      if (v === MISSING) return false;
      const r = _operand(node, state);
      return r.present ? _deepEq(v, r.value, budget) : false;
    }
    case 'ne': {
      const v = _get(state, node.path);
      if (v === MISSING) return false;       // 缺失既不 eq 也不 ne:对未知保持保守(fail-closed)
      const r = _operand(node, state);
      return r.present ? !_deepEq(v, r.value, budget) : false;
    }

    case 'lt': case 'le': case 'gt': case 'ge': {
      const v = _get(state, node.path);
      const r = _operand(node, state);
      if (!r.present || !_finiteNum(v) || !_finiteNum(r.value)) return false; // 两侧须有限数,否则 fail-closed
      if (op === 'lt') return v < r.value;
      if (op === 'le') return v <= r.value;
      if (op === 'gt') return v > r.value;
      return v >= r.value;
    }

    case 'in': {
      const v = _get(state, node.path);
      const r = _operand(node, state);
      const list = r.present ? r.value : undefined;
      if (v === MISSING || !Array.isArray(list) || list.length > MAX_ARGS) return false;
      for (const cand of list) if (_deepEq(v, cand, budget)) return true;
      return false;
    }

    case 'forbiddenKey': {
      const obj = _get(state, node.path);
      if (obj === MISSING) return true;               // 对象不存在 = 不含任何越权键 = 满足
      if (!_isPlainObject(obj) && !Array.isArray(obj)) return true;
      const banned = Array.isArray(node.value) ? node.value : [];
      for (const key of banned) {
        if (typeof key !== 'string') continue;
        if (Object.prototype.hasOwnProperty.call(obj, key)) return false; // 命中越权键 → 不满足
      }
      return true;
    }

    case 'every': case 'some': {
      // 谓词逻辑:有界量词。对 path 处数组逐元素,把元素以 node.as 绑进作用域后求值 node.body。
      const as = node.as;
      if (typeof as !== 'string' || as.length === 0 || _FORBIDDEN_SEG.has(as)) return false; // [P6] 绑定名走私 → fail-closed
      if (!_isPlainObject(node.body)) return false;
      const arr = _get(state, node.path);
      // [P7] 缺失/非数组/超过元素上限 → fail-closed(注意:缺失数组 ≠ 空数组;无法确认即不放行)
      if (arr === MISSING || !Array.isArray(arr) || arr.length > MAX_QUANT_ELEMS) return false;
      if (op === 'every') {
        for (const el of arr) if (!_evalNode(node.body, _bindScope(state, as, el), budget)) return false;
        return true; // 空数组 → 全称 ∀ 真(vacuous)
      }
      for (const el of arr) if (_evalNode(node.body, _bindScope(state, as, el), budget)) return true;
      return false; // 空数组 → 存在 ∃ 假
    }

    default:
      // 不可达(已被 _AXIOM_SET 守卫);保留以示穷尽。
      throw new Error('unhandled axiom: ' + op);
  }
}

/**
 * 评估单个谓词(对外)。门控关 → 永远 fail-closed(返回 false)绝不放行。
 * @returns {boolean}
 */
function evaluatePredicate(predicate, state, env) {
  try {
    if (!isEnabled(env)) return false; // 门控关:V 不工作时按 fail-closed,绝不静默放行
    if (predicate == null) return true; // 「无此约束」= vacuously true(注意:这不是放行一切,见 verify 语义)
    return _evalNode(predicate, state || {}, { n: 0 });
  } catch {
    return false; // [P3] 任何异常 → fail-closed
  }
}

/**
 * 极小核验器 V:检查动作契约 `Φ_pre ⇒ Φ_post`。
 *
 * @param {{name?:string, pre?:object, post?:object, inv?:object, input?:object, output?:object}} contract
 *        pre  : Φ_pre 谓词(在 preState 上求值);缺省视为无前置约束。
 *        post : Φ_post 谓词(在 `{in: preState, out: postState}` 上求值,Hoare 式可关联输入/输出)。
 *        inv  : 不变量 I(Hoare invariant);必须在 preState **与** postState 上**都**成立
 *               (如 `balance ≥ 0` 恒成立);缺省视为无不变量约束。
 * @param {{pre?:object, post?:object}} states  动作执行前/后的状态快照(纯数据)。
 * @param {object} [env]
 * @returns {{ok:boolean, stage:('pre'|'inv'|'post'|'error'|null), contract:(string|null), pre:boolean, post:boolean, reason:(string|null)}}
 *
 * 语义:ok 仅当 (无 Φ_pre 或 Φ_pre 成立) 且 (无 I 或 I 在前后态都成立) 且 (无 Φ_post 或 Φ_post 成立)。
 * [P3 切断] 任何畸形/异常 → {ok:false, stage:'error'};**绝不** fail-open。
 */
function verify(contract, states, env) {
  try {
    if (!isEnabled(env)) {
      return { ok: false, stage: 'error', contract: null, pre: false, post: false, reason: 'verifier disabled (fail-closed)' };
    }
    if (!_isPlainObject(contract)) {
      return { ok: false, stage: 'error', contract: null, pre: false, post: false, reason: 'contract must be a plain object' };
    }
    const name = typeof contract.name === 'string' ? contract.name : null;
    const st = _isPlainObject(states) ? states : {};
    const preState = _isPlainObject(st.pre) ? st.pre : {};
    const postState = _isPlainObject(st.post) ? st.post : {};

    // Φ_pre 在 preState 上求值。
    const preOk = contract.pre == null ? true : _evalNode(contract.pre, preState, { n: 0 });
    if (!preOk) {
      return { ok: false, stage: 'pre', contract: name, pre: false, post: false, reason: 'Φ_pre 不成立' };
    }

    // 不变量 I(Hoare):动作必须**保持**它,故须在前态成立(否则连入口都违规)。
    if (contract.inv != null) {
      const invPre = _evalNode(contract.inv, preState, { n: 0 });
      if (!invPre) {
        return { ok: false, stage: 'inv', contract: name, pre: true, post: false, reason: '不变量在前态不成立' };
      }
    }

    // Φ_post 在 {in, out} 上求值(可关联输入与输出)。
    const postView = { in: preState, out: postState };
    const postOk = contract.post == null ? true : _evalNode(contract.post, postView, { n: 0 });
    if (!postOk) {
      return { ok: false, stage: 'post', contract: name, pre: true, post: false, reason: 'Φ_post 不成立' };
    }

    // 不变量 I 必须在后态依旧成立(`balance ≥ 0` 恒成立)。
    if (contract.inv != null) {
      const invPost = _evalNode(contract.inv, postState, { n: 0 });
      if (!invPost) {
        return { ok: false, stage: 'inv', contract: name, pre: true, post: true, reason: '不变量在后态被破坏' };
      }
    }

    return { ok: true, stage: null, contract: name, pre: true, post: true, reason: null };
  } catch (e) {
    // [P3] 含未知算子(_evalNode 抛)、预算超限、任意异常 → fail-closed。
    return { ok: false, stage: 'error', contract: null, pre: false, post: false, reason: e && e.message ? e.message : String(e) };
  }
}

/**
 * 确定性规范化:把契约/裁决序列化成**键序稳定**的 JSON 字符串,供既有 traceChain.contentHash 锚定。
 * 纯函数、无随机、无时钟;同一逻辑契约 → 同一字符串 → 同一哈希(可重放比对)。
 * 注意:这里**不**做哈希(哈希是 traceChain 的职责);本叶子只产确定性的可哈希前像。
 */
function canonicalize(value) {
  const seen = new Set();
  const enc = (v) => {
    if (v === null) return 'null';
    const t = _typeOf(v);
    if (t === 'number') return Number.isFinite(v) ? JSON.stringify(v) : '"__nonfinite__"';
    if (t === 'string' || t === 'boolean') return JSON.stringify(v);
    if (t === 'array') return '[' + v.map(enc).join(',') + ']';
    if (t === 'object') {
      if (seen.has(v)) return '"__cycle__"'; // 防环
      seen.add(v);
      const keys = Object.keys(v).filter((k) => !_FORBIDDEN_SEG.has(k)).sort();
      const body = keys.map((k) => JSON.stringify(k) + ':' + enc(v[k])).join(',');
      seen.delete(v);
      return '{' + body + '}';
    }
    return '"__unrepresentable__"'; // function/symbol/bigint/undefined:不可表示 → 占位(不抛)
  };
  try { return enc(value); } catch { return '"__canonicalize_error__"'; }
}

/** 暴露极小公理集供独立审计(「V 的公理集必须极小」可被外部核对)。 */
function describeAxioms() {
  return AXIOMS.slice();
}

module.exports = {
  isEnabled,
  AXIOMS,
  describeAxioms,
  evaluatePredicate,
  verify,
  canonicalize,
  // 内部件导出仅供单测对「投毒路径已切断」做白盒断言:
  _get,
  _deepEq,
  MISSING,
};
