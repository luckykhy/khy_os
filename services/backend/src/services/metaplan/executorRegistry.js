'use strict';

/**
 * executorRegistry.js — the global "武器库" of executors the model picks from
 * (目标11 §4). Each executor declares its LANGUAGE BOUNDARY and whether it ships
 * an AST safety net, so the model can compose a toolchain that matches the micro
 * task and the system knows which code interceptor (if any) to mount.
 *
 * 防呆: the model may ONLY choose executors that exist here — `validateToolchain`
 * rejects anything not registered (模型不可凭空捏造执行器). The registry is the
 * single source of truth; `describeForModel` is the exact menu exposed in the
 * meta-plan prompt so the model's universe of choices == this table.
 *
 * Each executor's `validator` names a code interceptor implemented in
 * codeInterceptors.js (or null for a no-AST raw applicator). The registry itself
 * holds NO validation logic — it is pure data + lookups.
 *
 * Pure + side-effect free.
 */

/**
 * @typedef {Object} Executor
 * @property {string}   id            machine id the model selects (e.g. 'js_babel_writer')
 * @property {string}   label         short human label
 * @property {string[]} languages     language ids it may operate on ('*' = any)
 * @property {boolean}  astSafetyNet  true → ships a real AST/syntax safety net
 * @property {(string|null)} validator code-interceptor key, or null (raw, no AST)
 * @property {boolean}  destructive   true → inherently irreversible (e.g. shell exec)
 * @property {string}   summary       what it does
 * @property {string}   risk          one-line risk note shown to the model
 */

/** The closed executor catalog. Ordered safest-first within each role. */
const EXECUTORS = Object.freeze([
  {
    id: 'js_babel_writer',
    label: 'JS/TS AST 写手',
    languages: ['javascript', 'typescript', 'jsx', 'tsx'],
    astSafetyNet: true,
    validator: 'babel',
    destructive: false,
    summary: '用 @babel/parser 解析校验后再落盘，自带语法安全网，适合重构核心逻辑。',
    risk: '低：语法错误会被 AST 拦截打回，绝不写入坏代码。',
  },
  {
    id: 'py_ast_replacer',
    label: 'Python AST 替换器',
    languages: ['python'],
    astSafetyNet: true,
    validator: 'python_ast',
    destructive: false,
    summary: '专供 Python，落盘前用 ast.parse 校验，保障缩进与语法安全。',
    risk: '低：缩进/语法错误会被 ast 校验拦截。',
  },
  {
    id: 'generic_syntax_writer',
    label: '通用语法写手',
    languages: ['*'],
    astSafetyNet: true,
    validator: 'vm_or_native',
    destructive: false,
    summary: '跨语言：JS 走 vm 编译探测、Python 走 ast，其它语言退化为括号/引号配平探测。',
    risk: '中：能力依赖语言；不支持的语言仅做轻量结构探测。',
  },
  {
    id: 'raw_string_injector',
    label: '裸字符串注入器',
    languages: ['*'],
    astSafetyNet: false,
    validator: null,
    destructive: false,
    summary: '跨语言通用，仅做正则/字符串替换，无任何 AST 校验，极快但风险自担。',
    risk: '高（用于代码时）：无语法网；仅适合改注释/文案/字符串常量。',
  },
]);

const _BY_ID = Object.freeze(
  EXECUTORS.reduce((acc, e) => { acc[e.id] = e; return acc; }, {}),
);

/** All executors (copy). */
function listExecutors() {
  return EXECUTORS.map((e) => ({ ...e }));
}

/** The legal executor ids (the universe a toolchain may draw from). */
function executorIds() {
  return EXECUTORS.map((e) => e.id);
}

/** Look up an executor by id, or null. */
function getExecutor(id) {
  return _BY_ID[String(id || '').trim()] || null;
}

/** True iff `id` is a registered executor. */
function isRegistered(id) {
  return Object.prototype.hasOwnProperty.call(_BY_ID, String(id || '').trim());
}

/** Executors that can operate on a given language id (includes the '*' generics). */
function executorsForLanguage(language) {
  const lang = String(language || '').trim().toLowerCase();
  return listExecutors().filter(
    (e) => e.languages.includes('*') || e.languages.includes(lang),
  );
}

/**
 * Validate a model-proposed toolchain against the registry (防呆: no invented
 * executors). Empty/non-array → invalid; any unknown id → invalid with the
 * offending ids listed.
 * @param {string[]} toolchain
 * @returns {{valid:boolean, toolchain?:string[], unknown?:string[], reason?:string}}
 */
function validateToolchain(toolchain) {
  if (!Array.isArray(toolchain) || toolchain.length === 0) {
    return { valid: false, reason: 'toolchain 必须是非空数组（至少选一个执行器）。' };
  }
  const ids = toolchain.map((t) => String(t || '').trim());
  const unknown = ids.filter((id) => !isRegistered(id));
  if (unknown.length) {
    return {
      valid: false,
      unknown,
      reason: `toolchain 含未注册执行器：${unknown.join(', ')}。只能从武器库选取：${executorIds().join(' / ')}。`,
    };
  }
  return { valid: true, toolchain: ids };
}

/**
 * The exact menu string exposed to the model in the meta-plan prompt. Keeping the
 * prompt menu generated FROM the registry guarantees the model's options == the
 * registry (防呆: single source of truth).
 * @returns {string}
 */
function describeForModel() {
  return EXECUTORS
    .map((e) => {
      const langs = e.languages.includes('*') ? '任意语言' : e.languages.join('/');
      const net = e.astSafetyNet ? '有 AST 安全网' : '无 AST 校验';
      return `  - "${e.id}"（${e.label}，${langs}，${net}）：${e.summary} 风险：${e.risk}`;
    })
    .join('\n');
}

/**
 * Does this toolchain include any executor WITHOUT an AST safety net? Used to
 * cross-check a Prompt_Soft choice: a no-AST executor on a code change is exactly
 * what the risk_dissent must justify.
 */
function toolchainHasUnguarded(toolchain) {
  const v = validateToolchain(toolchain);
  if (!v.valid) return true;
  return v.toolchain.some((id) => {
    const e = getExecutor(id);
    return e && e.astSafetyNet === false;
  });
}

module.exports = {
  EXECUTORS,
  listExecutors,
  executorIds,
  getExecutor,
  isRegistered,
  executorsForLanguage,
  validateToolchain,
  describeForModel,
  toolchainHasUnguarded,
};
