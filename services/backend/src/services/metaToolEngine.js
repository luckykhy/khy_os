'use strict';

/**
 * metaToolEngine.js — khyos 生态底座「元工具系统」引擎（设计见
 * docs/03_DESIGN_设计/[DESIGN-ARCH-017] 元工具系统设计.md）。
 *
 * 职责：当现有工具无法满足需求时，按任务描述经注入的 LLM 动态生成一个**纯计算**
 * 工具定义，经多道安全闸（复杂度 / 静态黑名单 / 沙箱冒烟）后，用工具注册表的
 * **公开 API**（register / defineTool）注册，供后续 Agent 步骤即时调用。
 *
 * 安全核心不变量（设计 §4 G4）：生成工具的 execute **始终**经 toolSandbox.sandboxedExec
 *   运行——即便注册后，运行期也跑在 require/process/global/setTimeout 全封的 vm 里。
 *   因此生成工具在任何时刻都**不可能**触达宿主文件系统/进程/网络。
 *
 * 边界（防呆）：本模块**只**新增元工具能力，**不改**任何业务算法、Prompt 或调度循环；
 *   仅以懒 require 复用 tools/index.js、toolSandbox.js、safeJsonParse.js 的既有公开能力。
 *   未就绪的宿主接入点以 `# TODO: [MetaTool-*-Unresolved]` 标注并优雅降级。
 *
 * 默认关闭：仅当 `KHY_ENABLE_META_TOOL` ∈ {1,true,yes,on} 时启用（与 executeCode 同纪律）。
 *
 * 零外部依赖（仅 Node 内置 + 本仓内既有模块）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 可调阈值（全部 env 可覆盖，零硬编码红线）────────────────────────────────
function _int(name, def) {
  const n = parseInt(String(process.env[name] || ''), 10);
  return Number.isInteger(n) && n > 0 ? n : def;
}
const LIMITS = {
  get maxCodeChars() { return _int('KHY_META_TOOL_MAX_CODE', 4000); },
  get maxParams() { return _int('KHY_META_TOOL_MAX_PARAMS', 8); },
  get maxPerSession() { return _int('KHY_META_TOOL_MAX_PER_SESSION', 5); },
  get maxRetries() {
    const n = parseInt(String(process.env.KHY_META_TOOL_MAX_RETRIES || ''), 10);
    return Number.isInteger(n) && n >= 0 ? n : 1;
  },
  get timeoutMs() { return Math.min(_int('KHY_META_TOOL_TIMEOUT_MS', 2000), 5000); },
};

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,39}$/;

/** 是否启用元工具系统（设计 §0，默认关闭）。布尔解析走 parseBoolean 单一真源。 */
function isEnabled() {
  return require('../utils/parseBoolean')(process.env.KHY_ENABLE_META_TOOL, false, { extended: false });
}

// ── 静态安全扫描黑名单（设计 §4 G2）────────────────────────────────────────
// 命中任一即拒绝。覆盖：模块系统、进程/文件/网络、动态执行、原型逃逸、定时器、
// 无界循环、以及防止「工具造工具」递归的元工具自身标识。
const DANGER_PATTERNS = [
  { re: /\brequire\b/, why: 'require' },
  { re: /\bprocess\b/, why: 'process' },
  { re: /\bmodule\b/, why: 'module' },
  { re: /\bexports\b/, why: 'exports' },
  { re: /\bglobalThis\b/, why: 'globalThis' },
  { re: /\bglobal\b/, why: 'global' },
  { re: /\beval\b/, why: 'eval' },
  { re: /\bFunction\s*\(/, why: 'Function constructor' },
  { re: /\bconstructor\b/, why: 'constructor (prototype escape)' },
  { re: /__proto__/, why: '__proto__' },
  { re: /\bimport\b/, why: 'import' },
  { re: /\bchild_process\b/, why: 'child_process' },
  { re: /\bfs\b/, why: 'fs' },
  { re: /\bnet\b/, why: 'net' },
  { re: /\bdns\b/, why: 'dns' },
  { re: /\bhttps?\b/, why: 'http/https' },
  { re: /\bfetch\b/, why: 'fetch' },
  { re: /\bXMLHttpRequest\b/, why: 'XMLHttpRequest' },
  { re: /\bWebSocket\b/, why: 'WebSocket' },
  { re: /\bBuffer\b/, why: 'Buffer' },
  { re: /\bvm\b/, why: 'vm' },
  { re: /\bsetTimeout\b/, why: 'setTimeout' },
  { re: /\bsetInterval\b/, why: 'setInterval' },
  { re: /\bsetImmediate\b/, why: 'setImmediate' },
  { re: /while\s*\(\s*true\s*\)/, why: 'while(true) infinite loop' },
  { re: /for\s*\(\s*;\s*;\s*\)/, why: 'for(;;) infinite loop' },
  // 防递归：生成工具严禁调用元工具自身
  { re: /\bcreateTool\b/, why: 'createTool (recursion)' },
  { re: /\bmetaTool/i, why: 'metaTool (recursion)' },
];

/**
 * 静态安全扫描（白盒拒绝）。
 * @param {string} code
 * @returns {{ ok: boolean, reason?: string }}
 */
function staticSafetyScan(code) {
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, reason: 'empty code' };
  }
  for (const { re, why } of DANGER_PATTERNS) {
    if (re.test(code)) return { ok: false, reason: `forbidden token: ${why}` };
  }
  return { ok: true };
}

/**
 * 结构与复杂度校验（设计 §4 G1 + §3 name/schema 规约）。
 * @param {object} def
 * @param {Set<string>} [existingNames]
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateDefinition(def, existingNames = new Set()) {
  if (!def || typeof def !== 'object') return { ok: false, reason: 'not an object' };
  const { name, description, code, inputSchema } = def;
  if (!NAME_RE.test(String(name || ''))) {
    return { ok: false, reason: 'invalid name (need ^[a-zA-Z][a-zA-Z0-9_]{2,39}$)' };
  }
  if (existingNames.has(name)) {
    return { ok: false, reason: `name already exists: ${name}` };
  }
  if (typeof description !== 'string' || description.trim().length < 4) {
    return { ok: false, reason: 'description too short' };
  }
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, reason: 'missing code' };
  }
  if (code.length > LIMITS.maxCodeChars) {
    return { ok: false, reason: `code too long (>${LIMITS.maxCodeChars})` };
  }
  if (inputSchema != null && typeof inputSchema !== 'object') {
    return { ok: false, reason: 'inputSchema must be an object' };
  }
  const paramCount = inputSchema ? Object.keys(inputSchema).length : 0;
  if (paramCount > LIMITS.maxParams) {
    return { ok: false, reason: `too many params (>${LIMITS.maxParams})` };
  }
  return { ok: true };
}

// ── 沙箱运行（设计 §4 G3/G4）──────────────────────────────────────────────
/**
 * 把生成的函数体包成可在受限 vm 里运行的程序。
 * 约定：code 是一个以 `params` 为入参、用 `return` 产出结果的函数体。
 * @param {string} code
 * @param {object} params
 * @returns {string}
 */
function buildSandboxProgram(code, params) {
  let json = '{}';
  try { json = JSON.stringify(params || {}); } catch { json = '{}'; }
  // IIFE 的返回值即 vm.Script 的求值结果，被 sandboxedExec 序列化为 result。
  return `(function(params){\n${code}\n})(${json});`;
}

/**
 * 在沙箱里以样例输入跑一次（冒烟测试）。
 * @param {string} code
 * @param {object} sampleParams
 * @returns {{ ok: boolean, reason?: string, elapsed?: number }}
 */
function sandboxSmokeTest(code, sampleParams) {
  let sandboxedExec;
  try { ({ sandboxedExec } = require('./toolSandbox')); } catch (e) {
    return { ok: false, reason: `sandbox unavailable: ${e.message}` };
  }
  const program = buildSandboxProgram(code, sampleParams);
  let res;
  try {
    res = sandboxedExec(program, { timeoutMs: LIMITS.timeoutMs });
  } catch (e) {
    return { ok: false, reason: `sandbox threw: ${e.message}` };
  }
  if (!res || !res.success) {
    return { ok: false, reason: `sandbox error: ${(res && res.error) || 'unknown'}` };
  }
  return { ok: true, elapsed: res.elapsed };
}

/**
 * 由 inputSchema 推导样例参数（用于冒烟测试）。
 * @param {object} inputSchema
 * @returns {object}
 */
function deriveSampleParams(inputSchema) {
  const out = {};
  if (!inputSchema || typeof inputSchema !== 'object') return out;
  for (const [key, rule] of Object.entries(inputSchema)) {
    const r = rule && typeof rule === 'object' ? rule : {};
    if (Array.isArray(r.enum) && r.enum.length) { out[key] = r.enum[0]; continue; }
    switch (String(r.type || 'string')) {
      case 'number': out[key] = typeof r.min === 'number' ? r.min : 1; break;
      case 'boolean': out[key] = false; break;
      case 'array': out[key] = []; break;
      case 'object': out[key] = {}; break;
      default: out[key] = 'test';
    }
  }
  return out;
}

/**
 * 构造一个「运行期始终沙箱化」的 execute 函数（设计 §4 G4 核心不变量）。
 * @param {string} code
 * @param {object} inputSchema
 * @returns {Function} async (params) => normalized tool result
 */
function makeSandboxedExecute(code, inputSchema) {
  return async function execute(params = {}) {
    let sandboxedExec;
    try { ({ sandboxedExec } = require('./toolSandbox')); } catch (e) {
      return { success: false, error: `sandbox unavailable: ${e.message}`, content: '工具运行环境不可用。' };
    }
    const program = buildSandboxProgram(code, params);
    const res = sandboxedExec(program, { timeoutMs: LIMITS.timeoutMs });
    if (!res || !res.success) {
      const msg = (res && res.error) || 'execution failed';
      return { success: false, error: msg, content: `工具执行失败：${msg}` };
    }
    const data = res.result;
    let content;
    try {
      content = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      content = String(data);
    }
    if (res.output && res.output.trim()) content = `${content}\n${res.output}`.trim();
    return { success: true, data, content: content || '(空结果)' };
  };
}

// ── LLM 生成（设计 §3）──────────────────────────────────────────────────
function _buildGenPrompt({ purpose, name, inputHint }) {
  return [
    '你是 khyos 工具铸造器。请根据下面的需求，生成**一个** JSON 对象来定义一个**纯计算**工具。',
    '',
    `需求：${purpose}`,
    name ? `建议工具名（可调整）：${name}` : '',
    inputHint ? `输入提示：${inputHint}` : '',
    '',
    '严格要求：',
    '1. 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块外的内容。',
    '2. 字段：{ "name", "description", "category", "risk", "inputSchema", "code" }。',
    '   - name: ^[a-zA-Z][a-zA-Z0-9_]{2,39}$，用 camelCase。',
    '   - description: 一句话用途（中文/英文皆可）。',
    '   - category: 固定填 "custom"。',
    '   - risk: 固定填 "safe"。',
    '   - inputSchema: { 参数名: { "type": "string|number|boolean|array|object", "required": true|false, "description": "..." } }，最多 8 个参数。',
    '   - code: 一段**纯 JavaScript 函数体**，以 `params` 为入参、用 `return` 返回结果。',
    '3. code 严禁出现：require、process、module、import、fs、net、http、fetch、eval、Function、',
    '   setTimeout、setInterval、while(true)、constructor、__proto__、Buffer、vm。',
    '   只允许纯计算：Math、JSON、字符串、数组、对象、正则、Date。',
    '',
    '示例输出：',
    '{"name":"celsiusToFahrenheit","description":"摄氏转华氏","category":"custom","risk":"safe","inputSchema":{"celsius":{"type":"number","required":true,"description":"摄氏温度"}},"code":"return { fahrenheit: params.celsius * 9/5 + 32 };"}',
  ].filter(Boolean).join('\n');
}

/**
 * 经注入的 LLM 生成工具定义并容错解析（设计 §3）。
 * @param {{purpose:string, name?:string, inputHint?:string}} spec
 * @param {{ llm: Function }} deps - llm: async (message) => string
 * @returns {Promise<{ ok: boolean, def?: object, reason?: string }>}
 */
async function generateToolDefinition(spec, deps) {
  const llm = deps && deps.llm;
  if (typeof llm !== 'function') return { ok: false, reason: 'no llm injected' };
  const { extractFirstJson } = require('./gateway/safeJsonParse');
  const prompt = _buildGenPrompt(spec);

  for (let attempt = 0; attempt <= LIMITS.maxRetries; attempt++) {
    let raw;
    try {
      raw = await llm(prompt);
    } catch (e) {
      return { ok: false, reason: `llm error: ${e.message}` };
    }
    const def = extractFirstJson(String(raw == null ? '' : raw), null);
    if (def && typeof def === 'object' && def.name && def.code) {
      // 规约固定字段（设计 §3：强制 safe/custom）
      def.category = 'custom';
      def.risk = 'safe';
      return { ok: true, def };
    }
  }
  return { ok: false, reason: 'llm did not return a valid tool JSON' };
}

// ── 持久化（设计 §5）──────────────────────────────────────────────────────
function _generatedDir() {
  return process.env.KHY_META_TOOL_DIR || path.join(os.homedir(), '.khy', 'generated_tools');
}

function persistGeneratedTool(def) {
  try {
    const dir = _generatedDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${def.name}.json`);
    const record = {
      name: def.name,
      description: def.description,
      category: 'custom',
      risk: 'safe',
      inputSchema: def.inputSchema || {},
      code: def.code,
      forgedAt: new Date().toISOString(),
      purpose: def.purpose || '',
    };
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    return file;
  } catch {
    return null; // 持久化失败不影响本会话可用性（防呆）
  }
}

/**
 * 从磁盘恢复历史生成的工具（设计 §5）。不自动接入核心启动流程，由调用方按需触发。
 * @param {{ register?: Function, existingNames?: Set<string> }} [deps]
 * @returns {{ loaded: string[], skipped: string[] }}
 */
function loadPersistedGeneratedTools(deps = {}) {
  const out = { loaded: [], skipped: [] };
  let files;
  try {
    files = fs.readdirSync(_generatedDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return out; // 目录不存在 → 无历史，静默
  }
  const register = deps.register || _defaultRegister;
  const existing = deps.existingNames || _registryNames();
  for (const f of files) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(_generatedDir(), f), 'utf8'));
    } catch { out.skipped.push(f); continue; }
    // 复跑全部安全闸：磁盘文件可能被篡改，绝不无条件信任。
    const v = validateDefinition(record, existing);
    const s = staticSafetyScan(record.code);
    if (!v.ok || !s.ok || existing.has(record.name)) { out.skipped.push(f); continue; }
    try {
      register(_toRegisterable(record));
      existing.add(record.name);
      out.loaded.push(record.name);
    } catch { out.skipped.push(f); }
  }
  return out;
}

// ── 注册表桥接（公开 API，设计 §5）──────────────────────────────────────────
function _registry() {
  return require('../tools');
}

function _registryNames() {
  try {
    const reg = _registry();
    const all = typeof reg.getAll === 'function' ? reg.getAll() : null;
    if (all && typeof all.keys === 'function') return new Set([...all.keys()]);
    if (Array.isArray(all)) return new Set(all.map((t) => t && t.name).filter(Boolean));
  } catch { /* fall through */ }
  return new Set();
}

function _defaultRegister(toolDef) {
  return _registry().register(toolDef);
}

function _toRegisterable(def) {
  return {
    name: def.name,
    description: def.description,
    category: 'custom',
    risk: 'safe',
    inputSchema: def.inputSchema || {},
    isReadOnly: true,          // 纯计算，无副作用
    isConcurrencySafe: true,   // 沙箱内无共享状态
    isDestructive: false,
    execute: makeSandboxedExecute(def.code, def.inputSchema || {}),
  };
}

// ── 会话铸造预算（设计 §7 防无限生成）──────────────────────────────────────
const _sessionCounts = new Map(); // sessionId → count

function _sessionId(session) {
  return String((session && (session.id || session.sessionId)) || 'default');
}

function _bump(session) {
  const id = _sessionId(session);
  const cur = (_sessionCounts.get(id) || 0) + 1;
  _sessionCounts.set(id, cur);
  return cur;
}

function _peek(session) {
  return _sessionCounts.get(_sessionId(session)) || 0;
}

// ── 主编排：铸造一个工具（设计 §1 全流程）─────────────────────────────────
/**
 * 铸造并注册一个新工具。任何一步失败都返回结构化结果，绝不抛出（防呆）。
 *
 * @param {{purpose:string, name?:string, inputHint?:string}} spec
 * @param {{ llm: Function, register?: Function, existingNames?: Set<string>, session?: object }} deps
 * @returns {Promise<{ status:'created'|'reused'|'rejected'|'disabled', toolName?:string, message:string, reason?:string }>}
 */
async function forgeTool(spec, deps = {}) {
  if (!isEnabled()) {
    return { status: 'disabled', message: '元工具系统未启用（设置 KHY_ENABLE_META_TOOL=1 以开启）。' };
  }
  const purpose = String((spec && spec.purpose) || '').trim();
  if (!purpose) {
    return { status: 'rejected', reason: 'empty purpose', message: '未提供工具用途描述，已跳过。' };
  }

  const existing = deps.existingNames || _registryNames();

  // 去重：建议名已存在 → 直接复用（设计 §7）
  if (spec.name && existing.has(spec.name)) {
    return { status: 'reused', toolName: spec.name, message: `已存在工具「${spec.name}」，直接复用。` };
  }

  // 会话铸造数上限（设计 §7 防无限生成）
  if (_peek(deps.session) >= LIMITS.maxPerSession) {
    return {
      status: 'rejected',
      reason: 'session cap reached',
      message: `本次会话新建工具已达上限（${LIMITS.maxPerSession} 个），已改用现有能力继续。`,
    };
  }

  // ① LLM 生成
  const gen = await generateToolDefinition(spec, deps);
  if (!gen.ok) {
    return { status: 'rejected', reason: gen.reason, message: '未能生成可用的工具定义，已改用现有能力继续。' };
  }
  const def = gen.def;
  def.purpose = purpose;

  // ② 结构 + 复杂度校验（G1）
  const v = validateDefinition(def, existing);
  if (!v.ok) {
    return { status: 'rejected', reason: v.reason, message: '生成的工具未通过结构校验，已跳过。' };
  }

  // ③ 静态安全扫描（G2，白盒拒绝）
  const s = staticSafetyScan(def.code);
  if (!s.ok) {
    return { status: 'rejected', reason: s.reason, message: '生成的工具涉及受限操作，未通过安全扫描，已跳过。' };
  }

  // ④ 沙箱冒烟测试（G3）
  const smoke = sandboxSmokeTest(def.code, deriveSampleParams(def.inputSchema));
  if (!smoke.ok) {
    return { status: 'rejected', reason: smoke.reason, message: '生成的工具未通过沙箱测试，已跳过。' };
  }

  // ⑤ 注册（公开 API；运行期 execute 始终沙箱化 = G4）
  const register = deps.register || _defaultRegister;
  try {
    register(_toRegisterable(def));
  } catch (e) {
    return { status: 'rejected', reason: `register failed: ${e.message}`, message: '工具注册失败，已跳过。' };
  }
  existing.add(def.name);
  _bump(deps.session);

  // ⑥ 持久化（失败不影响本会话）
  persistGeneratedTool(def);

  return {
    status: 'created',
    toolName: def.name,
    message: `🛠️ 已为你新建工具「${def.name}」：${def.description}。已通过安全扫描与沙箱测试，现在可直接使用。`,
  };
}

/**
 * 程序化触发建议（设计 §2 次级触发，预留）。
 * 当前**不接入**调度循环，以遵守「不碰核心业务逻辑」。
 * # TODO: [MetaTool-Trigger-Unresolved] 未来由「未知工具名」路径调用以建议铸造。
 * @param {string} unknownToolName
 * @returns {boolean}
 */
function shouldForge(unknownToolName) {
  return isEnabled() && typeof unknownToolName === 'string' && unknownToolName.length > 0;
}

/** 测试缝：复位会话计数。 */
function _resetForTest() {
  _sessionCounts.clear();
}

module.exports = {
  isEnabled,
  staticSafetyScan,
  validateDefinition,
  buildSandboxProgram,
  sandboxSmokeTest,
  deriveSampleParams,
  makeSandboxedExecute,
  generateToolDefinition,
  persistGeneratedTool,
  loadPersistedGeneratedTools,
  forgeTool,
  shouldForge,
  LIMITS,
  NAME_RE,
  DANGER_PATTERNS,
  _resetForTest,
};
