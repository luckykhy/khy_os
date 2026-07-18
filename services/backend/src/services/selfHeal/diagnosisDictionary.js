'use strict';

/**
 * selfHeal/diagnosisDictionary.js — 结构化错误诊断字典（**单一真源**）。
 *
 * 把"原始错误"精确映射为「病因 + 修复处方 + 风险级别」，禁止模糊归因。每条处方都是
 * **预定义、可枚举**的；修复处方的"动作字符串"仅供展示，真正的修复执行只能走 fixActions
 * 里受控的代码逻辑（参数补全 / 路径改写 / 依赖安装委派给 dependency 注册表 / 运行时切换映射），
 * **绝不**把字典里的字符串当 shell 直接跑，更不接受模型自由生成命令（防注入，防呆②）。
 *
 * 风险分级（防呆③：L2 禁止进入修复微循环，直接降级）：
 *   L0 自愈   —— 代码级硬修复（参数补全 / 路径修正 / 格式纠错 / 自动降级），零风险，不问用户。
 *   L1 交互   —— 安装依赖 / 切换运行时，必须询问用户，获批后执行。
 *   L2 拒绝   —— 系统核心配置 / 危险命令 / 网络越权，不尝试修复，直接走降级树。
 *
 * fixKind 取值（决定 MicroLoopExecutor 如何处置）：
 *   inject-defaults   L0  按工具 Schema 注入缺省值，修正"参数缺失/格式错"。
 *   retarget-path     L0  把写入路径改到可写区（/tmp），修正只读文件系统。
 *   degrade-direct    L0  不本地修复，直接转降级树（如 403：切 WebFetch / 搜索）。
 *   install-dependency L1 安装缺失依赖（委派给 dependency 子系统，命令来自其受控注册表）。
 *   switch-runtime    L1  在固定候选集内切换运行时（python → python3 / node）。
 *   probe-port        L1  探测端口占用并提示（只读探测，不擅自杀进程）。
 *   refuse            L2  拒绝修复，直接降级。
 */

const RISK = Object.freeze({ L0: 'L0', L1: 'L1', L2: 'L2' });

// 运行时切换的**固定**候选集（防注入：绝不接受模型/报错文本里的任意命令）。
const RUNTIME_FALLBACKS = Object.freeze({
  python: ['python3', 'node'],
  python2: ['python3'],
  node: ['nodejs'],
  pip: ['pip3'],
});

/**
 * 字典条目。每条：
 *   id            稳定标识
 *   cause         病因诊断（中文，固定）
 *   risk          风险级别
 *   needsConfirm  是否需用户确认
 *   fixKind       处置类型（见上）
 *   test(text,code) 命中判定（纯函数，绝不抛错）
 *   capture(text,ctx) 抽取修复所需的关键标识（依赖名/命令/路径/端口），只回受控值
 *   prescribe(cap) 处方动作字符串（**仅展示**）
 */
const ENTRIES = [
  // ── L2 优先拦截：危险/越权，绝不进微循环（必须排在 L0/L1 之前命中）──────
  {
    id: 'dangerous-command',
    cause: '危险命令或系统核心配置改动（删库/全局提权/写系统目录）',
    risk: RISK.L2, needsConfirm: false, fixKind: 'refuse',
    test: (t) => /\brm\s+-rf\s+\/(?:\s|$)|mkfs|dd\s+if=|:\(\)\s*\{|\bchmod\s+-R\s+777\s+\/|\/etc\/(?:passwd|shadow|sudoers)|\bsudo\b.*\b(rm|dd|mkfs)\b/i.test(t),
    capture: () => ({}),
    prescribe: () => '拒绝自动修复：涉及危险命令/系统核心配置，强制降级。',
  },
  {
    id: 'network-egress-violation',
    cause: '网络越权（访问被禁网段/越权外联）',
    risk: RISK.L2, needsConfirm: false, fixKind: 'refuse',
    test: (t) => /egress.*(denied|blocked)|网络越权|blocked by sandbox|outbound.*forbidden/i.test(t),
    capture: () => ({}),
    prescribe: () => '拒绝自动修复：网络越权，强制降级。',
  },

  // ── L0 自愈 ───────────────────────────────────────────────────────
  {
    // 本地模型与内置推理引擎格式不兼容（GGUF 超参/架构不被当前 llama.cpp 支持）。
    // 重试同一引擎无意义，直接降级到其它后端（Ollama/云），不打扰用户（degrade-direct）。
    id: 'local-model-incompatible',
    cause: '本地推理引擎与该模型格式不兼容（GGUF 超参/架构不被当前 llama.cpp 支持，常见于较新模型）',
    risk: RISK.L0, needsConfirm: false, fixKind: 'degrade-direct',
    test: (t) => /dimension_sections|wrong array length|error loading model hyperparameters|unknown\s+model\s+architecture|unsupported\s+model\s+architecture/i.test(t),
    capture: () => ({}),
    prescribe: () => '内置引擎无法解析该模型，自动降级到其它后端（Ollama/云）；可改用 Ollama 或兼容 GGUF。',
  },
  {
    id: 'null-prop-or-missing-arg',
    cause: '模型输出格式错 / 参数缺失（读到 null/undefined 属性）',
    risk: RISK.L0, needsConfirm: false, fixKind: 'inject-defaults',
    test: (t) => /cannot read propert(?:y|ies)\s+(?:of|.*of)\s+(?:null|undefined)|is not defined|missing (?:required )?(?:parameter|argument|field)|required (?:parameter|field).*missing/i.test(t),
    capture: () => ({}),
    prescribe: () => '根据工具 Schema 注入缺省值后重试。',
  },
  {
    id: 'read-only-fs',
    cause: '写入只读文件系统',
    risk: RISK.L0, needsConfirm: false, fixKind: 'retarget-path',
    test: (t, code) => code === 'EROFS' || /\berofs\b|read-only file system/i.test(t),
    capture: (t, ctx) => ({ path: _pickPath(t, ctx) }),
    prescribe: (cap) => `将写入目标改至可写区（/tmp${cap && cap.path ? '/' + _basename(cap.path) : ''}）后重试。`,
  },
  {
    id: 'http-forbidden',
    cause: '权限不足 / 需认证（HTTP 403/401）',
    risk: RISK.L0, needsConfirm: false, fixKind: 'degrade-direct',
    test: (t, code) => code === 'HTTP_403' || code === 'HTTP_401' || /\b40[13]\b\s*forbidden|\bforbidden\b|\bunauthorized\b/i.test(t),
    capture: () => ({}),
    prescribe: () => '切换至 WebFetch / 搜索摘要等降级路径（自动降级，不本地修复）。',
  },

  // ── L1 交互修复 ───────────────────────────────────────────────────
  {
    id: 'module-not-found',
    cause: '依赖缺失（Node 模块 / Python 包未安装）',
    risk: RISK.L1, needsConfirm: true, fixKind: 'install-dependency',
    test: (t, code) => code === 'MISSING_DEPENDENCY'
      || /modulenotfounderror|cannot find module|no module named|\bnot installed\b|install with|\b(?:npm i+|pip3?|apt-get|brew|winget)\s+install\b/i.test(t),
    capture: (t) => ({ dep: _pickDependency(t) }),
    prescribe: (cap) => (cap && cap.dep ? `安装依赖 ${cap.dep}（委派 dependency 注册表，命令来自受控表）。` : '安装缺失依赖（委派 dependency 注册表）。'),
  },
  {
    id: 'command-not-found',
    cause: '运行时缺失（可执行命令不在 PATH）',
    risk: RISK.L1, needsConfirm: true, fixKind: 'switch-runtime',
    test: (t) => /command not found|not recognized as|: not found|\bcommand\b.*\bnot found\b/i.test(t),
    capture: (t) => {
      const cmd = _pickCommand(t);
      return { command: cmd, candidates: (cmd && RUNTIME_FALLBACKS[cmd]) || [] };
    },
    prescribe: (cap) => (cap && cap.candidates && cap.candidates.length
      ? `尝试在固定候选内切换运行时：${cap.candidates.join(' / ')}。`
      : '运行时缺失且无受控候选，转降级。'),
  },
  {
    id: 'conn-refused',
    cause: '端口占用 / 本地服务未启动（ECONNREFUSED）',
    risk: RISK.L1, needsConfirm: true, fixKind: 'probe-port',
    test: (t, code) => code === 'ECONNREFUSED' || /econnrefused|connection refused/i.test(t),
    capture: (t) => ({ hostPort: _pickHostPort(t) }),
    prescribe: (cap) => `探测端口占用（lsof -i:${(cap && cap.hostPort && cap.hostPort.port) || '<port>'}）并提示，不擅自杀进程。`,
  },
];

// ── 抽取助手（纯函数，受控值，绝不抛错）────────────────────────────────

const KNOWN_DEPS = ['puppeteer', 'playwright', 'chromium', 'chrome', 'ffmpeg', 'whisper', 'sox', 'torch', 'huggingface_hub', 'cheerio', 'sharp', 'pdftoppm', 'tar', '7z'];

function _pickDependency(text) {
  const t = String(text || '');
  // 1) 显式 install 子句里的包名
  let m = t.match(/\b(?:npm i+|pip3?|apt-get|brew|winget)\s+install\s+([@a-z0-9._/-]+)/i);
  if (m && _looksSafeIdent(m[1])) return m[1];
  // 2) "No module named 'x'" / "Cannot find module 'x'"（带引号的包名，最稳）
  m = t.match(/(?:cannot find module|no module named)\s+['"]([@a-z0-9._/-]+)['"]/i);
  if (m && _looksSafeIdent(m[1])) return m[1];
  // 3) 同上但无引号（取紧随其后的标识符）
  m = t.match(/(?:cannot find module|no module named)\s+([@a-z0-9._/-]+)/i);
  if (m && _looksSafeIdent(m[1])) return m[1];
  // 4) 已知依赖名直接出现
  const lc = t.toLowerCase();
  for (const d of KNOWN_DEPS) if (lc.includes(d)) return d;
  return null;
}

function _pickCommand(text) {
  const t = String(text || '');
  // 形式一：「... not found: <cmd>」/「... not recognized: <cmd>」（命令在冒号后）
  let m = t.match(/(?:command\s+)?not (?:found|recognized)(?:\s+as[^:]*)?:\s*['"]?([a-z0-9_.+-]+)['"]?/i);
  // 形式二：「<cmd>: command not found」/「<cmd>: not found」/「'<cmd>' is not recognized」（命令在前）
  if (!m) m = t.match(/['"]?([a-z0-9_.+-]+)['"]?\s*:?\s*(?:command )?(?:not found|is not recognized)/i);
  let cmd = m && m[1] ? m[1].toLowerCase() : null;
  if (cmd === 'command') cmd = null; // 防呆：别把字面词 "command" 当成命令名
  return _looksSafeIdent(cmd) ? cmd : null;
}

function _pickHostPort(text) {
  const m = String(text || '').match(/(\d{1,3}(?:\.\d{1,3}){3})?:?(\d{2,5})\b/);
  if (!m) return null;
  return { host: m[1] || '127.0.0.1', port: m[2] };
}

function _pickPath(text, ctx) {
  if (ctx && typeof ctx.path === 'string' && ctx.path) return ctx.path;
  if (ctx && ctx.params && typeof ctx.params.path === 'string' && ctx.params.path) return ctx.params.path;
  if (ctx && ctx.params && typeof ctx.params.file_path === 'string' && ctx.params.file_path) return ctx.params.file_path;
  const m = String(text || '').match(/['"]?(\/[^\s'":]+)['"]?/);
  return m ? m[1] : null;
}

function _basename(p) { return String(p || '').split('/').filter(Boolean).pop() || 'output'; }
function _looksSafeIdent(s) { return !!s && /^[@a-z0-9._/-]+$/i.test(s) && s.length <= 64; }

/**
 * 诊断：原始错误文本 + 归一化码 → 命中的字典条目（含抽取的关键标识）。
 * 未命中返回 null（上层据此走 degrade-direct / refuse，绝不臆造处方）。
 *
 * @param {string} text 失败文本（已由上层抽取/脱敏）
 * @param {string} code 归一化错误码（如 MISSING_DEPENDENCY / HTTP_403 / EROFS / TIMEOUT）
 * @param {object} [ctx] 上下文（params/path 等，供路径类抽取）
 * @returns {object|null} { id, cause, risk, needsConfirm, fixKind, action, capture }
 */
function diagnose(text, code, ctx = {}) {
  const t = String(text || '');
  const c = String(code || '');
  for (const e of ENTRIES) {
    let hit = false;
    try { hit = !!e.test(t, c); } catch { hit = false; }
    if (!hit) continue;
    let capture = {};
    try { capture = e.capture(t, ctx) || {}; } catch { capture = {}; }
    let action = '';
    try { action = e.prescribe(capture); } catch { action = ''; }
    return {
      id: e.id,
      cause: e.cause,
      risk: e.risk,
      needsConfirm: !!e.needsConfirm,
      fixKind: e.fixKind,
      action,
      capture,
    };
  }
  return null;
}

module.exports = {
  RISK,
  RUNTIME_FALLBACKS,
  ENTRIES,
  diagnose,
  // 导出抽取器供测试与 fixActions 复用
  _pickDependency,
  _pickCommand,
  _pickHostPort,
  _pickPath,
};
