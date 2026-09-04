'use strict';

/**
 * wire.js — 把审计记录器挂到 khy 既有的 hook 事件上（零侵入接线）。
 *
 * 设计要点：**不改一行现有代码**。khy 的工具循环本来就在三个位置触发 hook：
 *   PrePrompt    { prompt, iteration }
 *   PreToolUse   { toolName, params, iteration }
 *   PostToolUse  { toolName, params, result, elapsed }
 * 这三处正好覆盖「一轮提示词 + 每次工具调用 + 每个工具结果」。于是审计通道只需
 * 注册三个函数式 hook，与 aiSession 的 checkpoint 压缩、sessionPersistence 的
 * transcript 轨完全不相交 —— 互不读写、互不触发、互不影响。
 *
 * 与 sessionPersistence 那条 JSONL 的关键区别：那条是从 `_chatState.messages`
 * 增量推导的（压缩截短 messages 后就停止追加，运行时压缩会反向污染轨迹）；本条
 * 直接在事件发生的当下落盘，压缩发生什么都与它无关。
 *
 * 门控 KHY_AUDIT_TRAJECTORY（默认关，opt-in）：不开 → attach 直接返回未启用，
 * 一个 hook 都不注册，字节级零影响。
 *
 * @module services/auditTrajectory/wire
 */

const fs = require('fs');
const path = require('path');

const diffCapture = require('./diffCapture');
const { AuditTrajectoryRecorder } = require('./recorder');

// ── 工具分类（单一真源） ──

/** 文件修改类工具：结果里必须带 before/after 或 diff。 */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

/** 实跑类工具：其退出码 + 输出构成「运行」证据。 */
const RUN_TOOLS = new Set(['PowerShell', 'Bash', 'Shell', 'REPL']);

/** 截图类工具：其产物构成「截图」证据。 */
const SHOT_TOOLS = new Set(['Snip', 'TerminalCapture', 'ComputerUse', 'DesktopControl', 'WebBrowser']);

const IMAGE_RE = /[A-Za-z]:[\\/][^\s"'<>|]+\.(?:png|jpe?g|webp)|\/[^\s"'<>|]+\.(?:png|jpe?g|webp)/gi;

const _OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * 审计通道是否启用。opt-in：仅 `1/true/on/yes` 开。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const v = String((env && env.KHY_AUDIT_TRAJECTORY) || '').trim().toLowerCase();
  return v !== '' && !_OFF.has(v);
}

/** 从工具参数里抽出被改动的文件路径清单。 */
function targetPaths(toolName, params) {
  const p = params && typeof params === 'object' ? params : {};
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) {
      out.push(v.trim());
    }
  };
  push(p.file_path);
  push(p.notebook_path);
  push(p.path);
  if (toolName === 'apply_patch' && typeof p.patch === 'string') {
    // 从 unified diff 头里取文件名。a//b/ 前缀是可选的（git 带、裸 diff 不带），
    // 新建/删除场景的对端是 /dev/null，必须剔掉否则会去快照一个不存在的伪路径。
    const re = /^(?:---|\+\+\+)[ \t]+(?:[ab][\\/])?(.+?)[ \t]*$/gm;
    let m;
    while ((m = re.exec(p.patch)) !== null) {
      const f = String(m[1]).trim();
      if (f && !/(?:^|[\\/])dev[\\/]null$/.test(f)) {
        push(f);
      }
    }
  }
  return [...new Set(out)];
}

/** 结果文本里出现且真实存在于盘上的图片路径 = 可核查的截图证据。 */
function extractScreenshots(result, cwd) {
  let text = '';
  try {
    if (typeof result === 'string') {
      text = result;
    } else {
      // JSON.stringify 会把 Windows 路径里的单反斜杠转义成双反斜杠，转义后的字符串
      // 在盘上找不到对应文件，截图证据会被静默判成「没有」（Windows 上工具结果几乎
      // 都是对象，等于截图这条证据永久失效）。这里先还原反斜杠再做匹配。
      text = JSON.stringify(result || {}).split('\\\\').join('\\');
    }
  } catch {
    return [];
  }
  const hits = text.match(IMAGE_RE) || [];
  const out = [];
  for (const h of [...new Set(hits)]) {
    const abs = path.isAbsolute(h) ? h : path.resolve(cwd || process.cwd(), h);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).size > 0) {
        out.push(abs);
      }
    } catch {
      /* 判不出来就不算证据 —— 宁可少算，不可编造 */
    }
  }
  return out;
}

function _exitCodeOf(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }
  for (const k of ['exitCode', 'exit_code', 'code', 'status']) {
    const n = Number(result[k]);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return result.success === false ? 1 : result.success === true ? 0 : null;
}

function _commandOf(params) {
  const p = params && typeof params === 'object' ? params : {};
  for (const k of ['command', 'cmd', 'script', 'code']) {
    if (typeof p[k] === 'string' && p[k].trim()) {
      return p[k].trim();
    }
  }
  return '';
}

// ── 接线 ──

/**
 * 把审计记录器挂上 hook 系统。
 *
 * @param {object} opts
 * @param {object} [opts.hookSystem] 注入用（默认 require services/hooks/hookSystem）
 * @param {object} [opts.recorder] 复用已有 recorder（默认按 sessionId/cwd 新建）
 * @param {string} [opts.sessionId]
 * @param {string} [opts.cwd] 轨迹归属目录。**如实记录进程启动时的 cwd**，
 *   进程内后续 process.chdir 不改变已写事件的归属（这是双进程隔离的地基）。
 * @param {string} [opts.dir] 轨迹目录
 * @param {object} [opts.env]
 * @param {function} [opts.originResolver] (prompt) => origin。默认恒返
 *   ai_generated —— 只有真人确认过的提示词才由 confirmDraft 显式盖 human 戳。
 * @returns {{enabled:boolean, reason?:string, recorder?:object, detach?:function}}
 */
function attach(opts = {}) {
  const env = opts.env || process.env;
  if (!isEnabled(env)) {
    return { enabled: false, reason: 'KHY_AUDIT_TRAJECTORY 未开启（opt-in），审计通道未注册任何 hook' };
  }

  let hooks = opts.hookSystem;
  if (!hooks) {
    try {
      hooks = require('../../../../cli/hooks/hookSystem');
    } catch (err) {
      return { enabled: false, reason: `hook 系统不可用: ${(err && err.message) || err}` };
    }
  }
  if (!hooks || typeof hooks.registerFunction !== 'function') {
    return { enabled: false, reason: 'hook 系统缺少 registerFunction，无法注册审计通道' };
  }

  // cwd 在此刻定格：之后进程内 chdir 不再改变轨迹归属。
  const pinnedCwd = String(opts.cwd || process.cwd());

  // hookSystem.trigger() 在未 init 时直接短路返回，注册进去的 hook 一条都不会触发。
  // 工具循环的 _getHookSystem() 虽然会懒初始化，但它按 registry.count 缓存结果，
  // 所以审计通道必须在那一刻之前就把自己挂进注册表 —— 这里主动 init 一次。
  // init 本身不带幂等守卫（每次都会 registry.load），所以由这里的 isInitialized()
  // 判断兜住，绝不重复加载用户 hook 配置。
  try {
    if (typeof hooks.isInitialized === 'function' && !hooks.isInitialized() && typeof hooks.init === 'function') {
      hooks.init(pinnedCwd);
    }
  } catch (err) {
    // init 失败（用户 hook 配置坏了等）不该拖垮审计通道：注册仍然继续，
    // 只是此进程内 trigger 可能短路，由 health() 暴露而不是静默。
    void err;
  }
  const recorder =
    opts.recorder ||
    new AuditTrajectoryRecorder({
      sessionId: opts.sessionId,
      cwd: pinnedCwd,
      dir: opts.dir,
      lang: opts.lang,
      meta: { pinnedCwd, attachedBy: 'auditTrajectory/wire' },
    });

  const originResolver =
    typeof opts.originResolver === 'function' ? opts.originResolver : () => ({ type: 'ai_generated', generator: 'khy-runtime' });

  // toolUseId 由 PreToolUse 生成，PostToolUse 据 (toolName, iteration) 取回配对。
  // 一次迭代里可以并发调用同名工具（并行 tool_use），所以每个 key 下挂一条 FIFO
  // 队列而不是单个槽位 —— 否则第二次 PreToolUse 会覆盖第一次的 before 快照，
  // diff 证据会错配到别的 tool_use_id 上。
  const pending = new Map();
  const keyOf = (ctx) => `${ctx && ctx.toolName}#${(ctx && ctx.iteration) === undefined ? '' : ctx.iteration}`;
  let seq = 0;

  /** 取回配对槽位：先按 key 精确出队，再退到「同名工具的任意待配对槽位」。 */
  const takeSlot = (ctx, toolName) => {
    const k = keyOf(ctx);
    const q = pending.get(k);
    if (q && q.length > 0) {
      const slot = q.shift();
      if (q.length === 0) {
        pending.delete(k);
      }
      return slot;
    }
    // iteration 对不上（适配器不传 / 中途变化）时按工具名兜底，宁可配到同名的
    // 另一次调用，也不要丢掉整份 before 快照。
    for (const [key, queue] of pending) {
      if (key.startsWith(`${toolName}#`) && queue.length > 0) {
        const slot = queue.shift();
        if (queue.length === 0) {
          pending.delete(key);
        }
        return slot;
      }
    }
    return null;
  };

  const onPrompt = (ctx) => {
    try {
      const text = (ctx && ctx.prompt) || '';
      if (!String(text).trim()) {
        return;
      }
      recorder.recordPrompt(text, originResolver(text, ctx));
    } catch {
      /* 审计写盘绝不打断聊天热路径 */
    }
  };

  const onPreTool = (ctx) => {
    try {
      const toolName = String((ctx && ctx.toolName) || '');
      if (!toolName) {
        return;
      }
      seq += 1;
      const toolUseId = `toolu_audit_${seq}_${Date.now().toString(36)}`;
      // 先落 assistant 事件（含 tool_use 块，结构完整保留 input），再落结果。
      recorder.recordAssistant('', [{ id: toolUseId, name: toolName, input: (ctx && ctx.params) || {} }]);
      const befores = FILE_WRITE_TOOLS.has(toolName)
        ? targetPaths(toolName, ctx && ctx.params).map((f) =>
            diffCapture.captureBefore(path.isAbsolute(f) ? f : path.resolve(pinnedCwd, f))
          )
        : [];
      const k = keyOf(ctx);
      if (!pending.has(k)) {
        pending.set(k, []);
      }
      pending.get(k).push({ toolUseId, befores, toolName });
    } catch {
      /* 同上 */
    }
  };

  const onPostTool = (ctx) => {
    try {
      const toolName = String((ctx && ctx.toolName) || '');
      const slot =
        takeSlot(ctx, toolName) || { toolUseId: `toolu_audit_orphan_${++seq}`, befores: [], toolName };

      const result = ctx && ctx.result;
      const isError = !!(result && typeof result === 'object' && result.success === false);
      const evidence = slot.befores.length > 0 ? diffCapture.captureAfterAll(slot.befores) : null;

      recorder.recordToolResult({
        toolUseId: slot.toolUseId,
        name: toolName,
        result,
        isError,
        evidence,
      });

      // 「运行 + 截图」：只在真有命令 / 真有存在于盘上的图片时记录，绝不凭空生成。
      const command = RUN_TOOLS.has(toolName) ? _commandOf(ctx && ctx.params) : '';
      const shots = SHOT_TOOLS.has(toolName) || RUN_TOOLS.has(toolName) ? extractScreenshots(result, pinnedCwd) : [];
      if (command || shots.length > 0) {
        recorder.recordVerification({
          command,
          exitCode: _exitCodeOf(result),
          stdout: typeof result === 'string' ? result : (result && (result.stdout || result.output)) || '',
          screenshots: shots,
        });
      }
    } catch {
      /* 同上 */
    }
  };

  hooks.registerFunction('PrePrompt', onPrompt, { source: 'builtin:AuditTrajectory', priority: 5 });
  hooks.registerFunction('PreToolUse', onPreTool, { source: 'builtin:AuditTrajectory', priority: 5 });
  hooks.registerFunction('PostToolUse', onPostTool, { source: 'builtin:AuditTrajectory', priority: 5 });

  return {
    enabled: true,
    recorder,
    handlers: { onPrompt, onPreTool, onPostTool },
    status: `接线审计轨迹 ${path.basename(recorder.file)}：已挂 PrePrompt/PreToolUse/PostToolUse 三个 hook`,
  };
}

module.exports = {
  attach,
  isEnabled,
  targetPaths,
  extractScreenshots,
  FILE_WRITE_TOOLS,
  RUN_TOOLS,
  SHOT_TOOLS,
};
