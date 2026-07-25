'use strict';

/**
 * intentSchema.js — 系统调用网关的「意图声明」单一真源。
 *
 * 设计哲学（能力隔离）：模型/执行器只能 **声明意图**，不能 **执行动作**。每一次
 * 触达宿主系统的工具调用，进入网关时都被规约成一个不可变的结构化 Intent：它描述
 * 「想对什么资源做什么」，而非「怎么做」。网关只对 Intent 做裁决，从不替模型放行
 * 一个它没如实声明的副作用。
 *
 * 本模块是纯函数、零副作用、零外部依赖（仅 node:path）。任何解析异常都降级成
 * 「未知高危」而非放行——fail-closed 是贯穿整条网关的铁律。
 *
 * 防呆①（旁路标记探测）：模型若在参数里夹带 `force:true` / `--yes` / `skipApproval`
 * 等「硬编码跳过审批」的标记，validateIntent 直接判定为旁路企图（bypass），上层据此
 * 熔断。审批权只属于用户，参数里永远不存在能跳过审批的合法开关。
 */

const path = require('path');

// 旁路标记：任何试图在「数据层」携带「免审/强制」语义的键或值，都是越权信号。
// 键名匹配（不区分大小写、去分隔符）+ 命令行 flag 字面量匹配 双管齐下。
const _BYPASS_KEY_PATTERNS = [
  /^force$/, /^yes$/, /^assumeyes$/, /^skipapproval$/, /^skipconfirm$/,
  /^noconfirm$/, /^noprompt$/, /^autoapprove$/, /^bypass$/, /^overrideguard$/,
  /^dangerouslyskip/, /^nocheck$/,
];
// 「跳过审批」命令行 flag——**只**保留语义上直指「跳过 *网关自己的* 审批 / 权限」的开关。
// 关键范畴区分：`npx --yes` / `apt -y` / `npm i --force` / `git push --no-confirm` 里的
// `--yes` / `--force` / `--no-confirm` / `--assume-yes` 是 **子进程自身** 的「免交互确认」
// 开关——子进程位于网关**下方**，它的确认 flag 既管不到、也绕不过上方的 Khy 审批闸。把它们
// 当旁路注入零容忍熔断，是把「子进程 CLI 语义」误当「越权跳过 Khy 审批」。这些命令的真实
// 风险（INSTALL / DELETE / force-push…）由动作分级层照常按风险走审批，绝不因一个子进程确认
// flag 就锁死整个会话。误判史：`Write(...prompt.md)` 含裸 `-f` 被熔断（已修）；`npx --yes
// asar ls` / `python ... --yes` 触发「检测到旁路注入标记 flag:--yes」锁死整会话（本次修）。
// 只有下面这两个 flag 的字面语义就是「跳过审批/权限校验」本身（指向智能体运行时的审批系统，
// 而非某个子进程），才作零容忍旁路红线保留。真正的数据层旁路注入（force:true /
// skipApproval / autoApprove 等键）由 _BYPASS_KEY_PATTERNS 在任意层级照旧一次即命中。
const _BYPASS_FLAG_LITERALS = [
  '--skip-approval', '--dangerously-skip-permissions',
];
// 门控关（KHY_GATEWAY_BYPASS_SCOPED=off）时逐字节回退到旧行为：含裸 -f/-y、全字符串无差别扫描。
const _BYPASS_FLAG_LITERALS_LEGACY = [
  '--yes', '-y', '--force', '-f', '--no-confirm', '--assume-yes',
  '--skip-approval', '--dangerously-skip-permissions', '--no-prompt',
];

// 承载「命令 / 参数」语义的字段——只有这些字段里的字符串才按 CLI flag 扫描旁路标记。
// （键名经 _norm 归一：去 `-`/`_`/空白并小写后比对。）
const _COMMAND_KEYS = new Set([
  'command', 'cmd', 'script', 'shell', 'args', 'argv', 'arguments', 'flags',
  'exec', 'run', 'commandline',
]);
// 数据载荷字段——写入内容 / 编辑串 / 提示词 / 补丁等，是**数据不是命令**，绝不按 flag 扫描，
// 也不下钻其值（否则文件内容里合法出现的 `-f`/`--force` 会被误判成旁路注入并熔断）。
const _DATA_KEYS = new Set([
  'content', 'contents', 'newstring', 'oldstring', 'text', 'body', 'data',
  'prompt', 'input', 'message', 'patch', 'diff', 'source', 'payload', 'filecontent',
]);

const _FALSY = new Set(['0', 'false', 'off', 'no']);
/** 旁路探测「字段作用域化」门控——默认开；off → 回退旧的全字符串无差别扫描。 */
function _bypassScopeEnabled(env) {
  const raw = (env && env.KHY_GATEWAY_BYPASS_SCOPED != null)
    ? env.KHY_GATEWAY_BYPASS_SCOPED
    : process.env.KHY_GATEWAY_BYPASS_SCOPED;
  return !_FALSY.has(String(raw == null ? '' : raw).trim().toLowerCase());
}

/** 规约动作类别——网关裁决只认这几类语义，不认工具名本身。 */
const ACTIONS = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  NETWORK: 'network',
  PROCESS: 'process',   // 起子进程 / 执行命令
  KILL: 'kill',         // 杀进程
  ENV: 'env',           // 改宿主环境变量
  INSTALL: 'install',   // 安装包（尤其全局）
  LISTEN: 'listen',     // 监听物理端口
  EXEC_CODE: 'exec',    // 执行任意代码
  SANDBOX_ESCAPE: 'sandbox_escape', // 在 OS 沙箱外 / 全权执行（跳出沙箱）
  UNKNOWN: 'unknown',
});

/** 资源作用域——决定影响半径。 */
const SCOPES = Object.freeze({
  PROJECT: 'project',   // 项目工作目录内
  HOME: 'home',         // 用户家目录内（项目外）
  SYSTEM: 'system',     // 系统级路径 / 宿主环境
  NETWORK: 'network',
  PROCESS: 'process',
  NA: 'na',
});

const _norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/[\s_-]/g, '');

/**
 * 由一次工具调用推导规约动作。纯启发式 + 工具自身的行为声明，绝不臆造副作用：
 * 不确定时归为 UNKNOWN（后续分级会按高危处理）。
 */
function _deriveAction(toolName, params, { isReadOnly, isDestructive } = {}) {
  const n = _norm(toolName);
  const cmd = _norm(params && (params.command || params.cmd || params.script || ''));

  // 显式命令型工具：从命令文本里读语义（最强信号）。
  if (/(shell|bash|command|exec|powershell|terminal|run)/.test(n) || cmd) {
    const raw = String((params && (params.command || params.cmd || params.script)) || '');
    if (/\b(rm|rmdir|del|unlink|rd)\b|\brimraf\b|\bmkfs\b|\bdd\b\s+if=/.test(raw)) return ACTIONS.DELETE;
    if (/\b(kill|killall|pkill|taskkill)\b/.test(raw)) return ACTIONS.KILL;
    // 注意 `-g` 前不可用 \b（空格与 '-' 均非单词字符，二者间无边界）——改用空白/行界定。
    if (/\bnpm\s+i(?:nstall)?\b.*(?:\s|^)(?:-g|--global)(?:\s|$)|\b(?:yarn\s+global|pnpm\s+add\s+-g|pip\s+install|apt(?:-get)?\s+install|brew\s+install|cargo\s+install)\b/.test(raw)) return ACTIONS.INSTALL;
    if (/\b(export|setx|set)\b\s+\w+=|\benv\b/.test(raw)) return ACTIONS.ENV;
    if (/\b(listen|nc\s+-l|ncat\s+-l|socat)\b|--port\b|:\d{2,5}\b.*(listen|serve)/.test(raw)) return ACTIONS.LISTEN;
    return ACTIONS.PROCESS;
  }

  if (/(deletefile|removefile|rm|unlink|fileop.*delete)/.test(n)) return ACTIONS.DELETE;
  if (/(executecode|evalcode|pyexec|runcode)/.test(n)) return ACTIONS.EXEC_CODE;
  if (/(managedeps|installdeps|adddependency|npminstall)/.test(n)) return ACTIONS.INSTALL;
  if (/(fetch|http|request|webfetch|websearch|download|curl|api)/.test(n)) return ACTIONS.NETWORK;
  if (/(listen|serve|server|bind|socket)/.test(n)) return ACTIONS.LISTEN;
  if (/(write|edit|create|patch|scaffold|notebook|append|mkdir|move|rename|chmod|deploy)/.test(n)) {
    return isDestructive ? ACTIONS.WRITE : ACTIONS.WRITE;
  }
  // Git write tools (gitCommit / gitPush / gitMerge…) are repo/remote mutations →
  // WRITE class (confirm once, L1). A tool's own isDestructive (e.g. force-push)
  // still escalates to the L2 red line via resourceClassifier. Read-only git tools
  // (gitStatus / gitDiff / gitLog) carry isReadOnly:true and fall through to READ.
  if (/^git/.test(n) && isReadOnly !== true) return ACTIONS.WRITE;
  if (/(read|glob|grep|list|stat|cat|view|search|get|ls)/.test(n) || isReadOnly === true) return ACTIONS.READ;
  return ACTIONS.UNKNOWN;
}

/** 提取目标资源字符串（路径 / URL / 包名 / pid），用于影响范围展示与作用域判定。 */
function _deriveResource(params) {
  if (!params || typeof params !== 'object') return '';
  return String(
    params.path || params.file_path || params.filePath || params.file ||
    params.notebook_path || params.url || params.target ||
    params.command || params.cmd || params.script || params.package || params.pid || ''
  );
}

/** 判定作用域：项目内 / 家目录 / 系统级。路径不可解析时按 SYSTEM（最保守）。 */
function _deriveScope(action, resource, cwd, home) {
  if (action === ACTIONS.NETWORK) return SCOPES.NETWORK;
  if (action === ACTIONS.KILL || action === ACTIONS.LISTEN || action === ACTIONS.PROCESS) return SCOPES.PROCESS;
  if (action === ACTIONS.ENV || action === ACTIONS.INSTALL) return SCOPES.SYSTEM;
  if (!resource) return action === ACTIONS.READ ? SCOPES.PROJECT : SCOPES.NA;

  // 仅当 resource 看起来是个路径时才做路径作用域判定。
  const looksPath = /[\\/]/.test(resource) || /^[~.]/.test(resource) || /\.\w+$/.test(resource);
  if (!looksPath) return SCOPES.NA;
  try {
    let p = resource;
    if (p.startsWith('~')) p = path.join(home, p.slice(1));
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
    const relToProject = path.relative(cwd, abs);
    if (relToProject && !relToProject.startsWith('..') && !path.isAbsolute(relToProject)) return SCOPES.PROJECT;
    const relToHome = path.relative(home, abs);
    if (relToHome && !relToHome.startsWith('..') && !path.isAbsolute(relToHome)) return SCOPES.HOME;
    return SCOPES.SYSTEM;
  } catch {
    return SCOPES.SYSTEM; // fail-closed
  }
}

/**
 * 构造意图声明。永不抛错——失败降级成 UNKNOWN/SYSTEM 的高危意图。
 * @returns {{tool,action,scope,resource,risk,isReadOnly,isDestructive,raw}}
 */
function buildIntent(call = {}) {
  const cwd = call.cwd || process.env.KHYQUANT_CWD || process.cwd();
  const home = call.home || require('os').homedir();
  let action = ACTIONS.UNKNOWN;
  let resource = '';
  let scope = SCOPES.SYSTEM;
  try {
    const params = call.params || {};
    action = _deriveAction(call.tool, params, { isReadOnly: call.isReadOnly, isDestructive: call.isDestructive });
    resource = _deriveResource(params);
    scope = _deriveScope(action, resource, cwd, home);
  } catch { /* keep fail-closed UNKNOWN/SYSTEM */ }
  // 「跳出沙箱执行」是工具级声明的最高危副作用：一旦置位，覆盖派生动作为 SANDBOX_ESCAPE
  // 并锁系统级作用域——分级层据此恒红灯（L2，键入 YES，不可旁路）。逃逸信号只来自工具自身
  // 声明，绝不取自模型参数（参数里的免审/强制标记仍由 detectBypassMarkers 熔断）。
  const sandboxEscape = call.sandboxEscape === true;
  if (sandboxEscape) {
    action = ACTIONS.SANDBOX_ESCAPE;
    scope = SCOPES.SYSTEM;
  }
  return Object.freeze({
    tool: String(call.tool || 'unknown'),
    action,
    scope,
    resource,
    risk: String(call.risk || 'medium'),
    isReadOnly: call.isReadOnly === true,
    isDestructive: call.isDestructive === true,
    sandboxEscape,
    raw: { params: call.params || {} },
  });
}

/**
 * 扫描参数对象，探测「免审/强制」旁路标记（递归一层，含数组与命令字面量）。
 *
 * 作用域化（门控 KHY_GATEWAY_BYPASS_SCOPED 默认开）：
 *   - **键探测**（force:true / skipApproval…）在任意层级照旧生效——参数键名夹带免审语义
 *     永远是越权信号，与字段是不是命令无关。
 *   - **CLI flag 字面量探测**（--skip-approval / --dangerously-skip-permissions）**只**在命令
 *     承载字段（command/cmd/script/args…）里进行；数据载荷字段（content/new_string/text…）
 *     既不扫也不下钻。注意：子进程自有确认 flag（--yes/--force/--no-confirm）**不在**此名单——
 *     它们是子进程语义，由动作分级按风险走审批，不当旁路熔断（见 _BYPASS_FLAG_LITERALS）。
 * 门控关 → 逐字节回退旧行为：全字符串无差别扫描、且 flag 集含裸 `-f`/`-y`（连同 --yes/--force）。
 */
function detectBypassMarkers(params, env) {
  const scoped = _bypassScopeEnabled(env);
  const literals = scoped ? _BYPASS_FLAG_LITERALS : _BYPASS_FLAG_LITERALS_LEGACY;
  const hits = [];
  const scanFlags = (str) => {
    const low = String(str).toLowerCase();
    const tokens = low.split(/\s+/);
    for (const flag of literals) {
      if (tokens.includes(flag)) hits.push(`flag:${flag}`);
    }
  };
  const visit = (obj, depth, scannable) => {
    if (obj == null || depth > 3) return;
    if (Array.isArray(obj)) { obj.forEach((v) => visit(v, depth + 1, scannable)); return; }
    if (typeof obj === 'string') {
      // 门控开：仅命令承载字段扫 flag；门控关：全字符串无差别扫描（旧行为）。
      if (!scoped || scannable) scanFlags(obj);
      return;
    }
    if (typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const nk = _norm(k);
      if (_BYPASS_KEY_PATTERNS.some((re) => re.test(nk)) && v !== false && v != null && v !== '' && v !== 'false') {
        hits.push(`key:${k}`);
      }
      // 数据载荷字段：键探测已在上一行做过，其值绝不下钻扫 flag。
      if (scoped && _DATA_KEYS.has(nk)) continue;
      visit(v, depth + 1, scoped ? _COMMAND_KEYS.has(nk) : true);
    }
  };
  try { visit(params, 0, true); } catch { /* ignore */ }
  return hits;
}

/**
 * 校验意图。返回 { ok, bypass:[], errors:[] }。bypass 非空 == 探测到旁路企图。
 */
function validateIntent(intent) {
  const errors = [];
  if (!intent || typeof intent !== 'object') {
    return { ok: false, bypass: [], errors: ['意图缺失'] };
  }
  const bypass = detectBypassMarkers(intent.raw && intent.raw.params);
  if (!Object.values(ACTIONS).includes(intent.action)) errors.push('未知动作类别');
  return { ok: errors.length === 0 && bypass.length === 0, bypass, errors };
}

module.exports = {
  ACTIONS,
  SCOPES,
  buildIntent,
  validateIntent,
  detectBypassMarkers,
};
