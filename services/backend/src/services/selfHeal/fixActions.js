'use strict';

/**
 * selfHeal/fixActions.js — 受控修复执行器（处方 → 真实动作）。
 *
 * **防注入铁律**：本模块是字典处方落地为真实动作的**唯一**出口。每个 fixKind 对应一段
 * 写死的代码逻辑；安装/运行命令一律来自 dependency 注册表或固定候选集，**绝不**取自
 * 报错文本、模型输出或诊断里的自由字符串。诊断只提供"受控标识"（依赖名/命令名/路径/端口），
 * 不提供可执行命令。
 *
 * 风险与是否需确认由诊断（字典）决定；本模块只负责"已获批后如何安全地执行"。
 * 所有动作 fail-safe：任何异常都收敛为 { ok:false, reason }，绝不抛错、绝不静默吞掉。
 *
 * 返回统一形状：
 *   { ok:boolean, params?:object, reason?:string, info?:object }
 *   - ok=true 且带 params  → 修复产生了新的入参，原工具应以新 params 重试一次。
 *   - ok=false             → 修复未成功（含 probe-only / 无候选 / 安装失败），上层应降级。
 */

const { RUNTIME_FALLBACKS } = require('./diagnosisDictionary');

/** 在 params 上打一个稳定的"已自愈"标记——用于让"环境级修复（如装依赖）"
 *  在重试时构成有效的入参变化（满足降级执行器 detector.changed 的重试前置），
 *  同时绝不引入随机性（可复现）。工具会忽略此未知字段。 */
const HEAL_MARKER = '__khy_self_heal__';

function _withHealMarker(params, tag) {
  const next = { ...(params && typeof params === 'object' ? params : {}) };
  next[HEAL_MARKER] = String(tag || 'healed');
  return next;
}

// ── 默认依赖安装器（委派给 dependency 子系统；命令来自 registry）─────────
// 可注入纯内存桩做测试（零网络、零真实安装）。

function _defaultDependencyInstaller() {
  return {
    /**
     * 安装一个依赖。dep 可以是 registry 的 depId，或一个可被 detectFromError 命中的名字。
     * @returns {Promise<{ ok:boolean, reason?:string, depId?:string }>}
     */
    async install(dep, { control } = {}) {
      let dependency = null;
      try { dependency = require('../dependency'); } catch { return { ok: false, reason: 'dependency-subsystem-unavailable' }; }
      try {
        // 1) 解析为受控 depId：先直查 registry，再回溯文本匹配。
        let depId = null;
        if (dependency.getDependency(dep)) depId = dep;
        if (!depId) {
          const hit = dependency.detectFromError(`Cannot find module '${dep}'`);
          if (hit) depId = hit.depId;
        }
        if (!depId) return { ok: false, reason: `dependency-not-in-registry:${dep}` };

        // 2) 构建受控安装计划（argv 来自 registry，绝不来自外部文本）。
        const plan = dependency.buildInstallPlan(depId);
        if (!plan) return { ok: false, reason: `no-install-plan:${depId}`, depId };

        // 3) 获批后隔离执行（installRunner execFile 无 shell）。
        const res = await dependency.runInstall(plan, { control });
        const ok = !!(res && (res.ok || res.success || res.installed));
        return { ok, reason: ok ? undefined : ((res && (res.reason || res.error)) || 'install-failed'), depId };
      } catch (err) {
        return { ok: false, reason: (err && err.message) || 'install-error' };
      }
    },
  };
}

/**
 * 把写入类参数的路径改写到可写区 /tmp（L0，零风险）。只改已知路径字段。
 */
function _retargetToTmp(params, capture) {
  const next = { ...(params && typeof params === 'object' ? params : {}) };
  const orig = (capture && capture.path)
    || next.path || next.file_path || next.output || next.dest || null;
  const base = String(orig || 'output').split('/').filter(Boolean).pop() || 'output';
  const target = `/tmp/${base}`;
  let touched = false;
  for (const field of ['path', 'file_path', 'output', 'dest', 'target']) {
    if (typeof next[field] === 'string' && next[field]) { next[field] = target; touched = true; }
  }
  if (!touched) { next.path = target; touched = true; }
  return { changed: touched, params: next };
}

/**
 * 按工具 Schema/上下文注入缺省值，修正"参数缺失/格式错"（L0，零风险）。
 * 无显式 schema 时做保守兜底：把已知为 null/undefined 的常见字段补默认空值，
 * 并打上自愈标记保证入参确有变化。
 */
function _injectDefaults(params, context) {
  const next = { ...(params && typeof params === 'object' ? params : {}) };
  const schema = context && context.schema && typeof context.schema === 'object' ? context.schema : null;
  let touched = false;
  if (schema && schema.properties && typeof schema.properties === 'object') {
    for (const [key, spec] of Object.entries(schema.properties)) {
      if (next[key] === undefined || next[key] === null) {
        if (spec && 'default' in spec) { next[key] = spec.default; touched = true; }
        else if (Array.isArray(schema.required) && schema.required.includes(key)) {
          next[key] = _zeroValue(spec); touched = true;
        }
      }
    }
  }
  // 清除值为 null/undefined 的字段（常见"读到 null 属性"诱因）。
  for (const k of Object.keys(next)) {
    if (next[k] === undefined) { delete next[k]; touched = true; }
  }
  return { changed: touched, params: next };
}

function _zeroValue(spec) {
  const t = spec && spec.type;
  if (t === 'string') return '';
  if (t === 'number' || t === 'integer') return 0;
  if (t === 'boolean') return false;
  if (t === 'array') return [];
  if (t === 'object') return {};
  return '';
}

/**
 * 在固定候选集内切换运行时（L1）：把 params 里的命令字段从缺失命令换成受控候选之一。
 */
function _switchRuntime(params, capture) {
  const next = { ...(params && typeof params === 'object' ? params : {}) };
  const from = capture && capture.command;
  const candidates = (capture && capture.candidates && capture.candidates.length)
    ? capture.candidates
    : (from && RUNTIME_FALLBACKS[from]) || [];
  if (!candidates.length) return { changed: false, params: next };
  const to = candidates[0];
  let touched = false;
  for (const field of ['command', 'cmd', 'executable', 'interpreter', 'runtime', 'bin']) {
    if (typeof next[field] === 'string' && from && next[field].includes(from)) {
      next[field] = next[field].replace(from, to); touched = true;
    }
  }
  if (!touched && from) { next.command = to; touched = true; }
  return { changed: touched, params: next, info: { from, to } };
}

class FixActions {
  /**
   * @param {object} [opts]
   * @param {object} [opts.installer]  依赖安装器（默认委派 dependency 子系统）
   * @param {Function} [opts.probePort] 端口探测器 async ({host,port})=>info（默认只读 lsof 提示，不杀进程）
   */
  constructor(opts = {}) {
    this.installer = opts.installer || _defaultDependencyInstaller();
    this.probePort = typeof opts.probePort === 'function' ? opts.probePort : null;
  }

  /**
   * 执行一条诊断对应的受控修复。**仅**按 fixKind 分派到写死逻辑，绝不执行字典外命令。
   * @param {object} diagnosis  ErrorDiagnostician 产物（含 fixKind/capture/risk）
   * @param {object} ctx        { params, toolName, context, control }
   * @returns {Promise<{ok:boolean, params?:object, reason?:string, info?:object}>}
   */
  async apply(diagnosis, ctx = {}) {
    const { params = {}, control = null, context = {} } = ctx;
    const fixKind = diagnosis && diagnosis.fixKind;
    const capture = (diagnosis && diagnosis.capture) || {};
    try {
      switch (fixKind) {
        case 'inject-defaults': {
          const r = _injectDefaults(params, context);
          return r.changed ? { ok: true, params: r.params } : { ok: false, reason: 'no-defaults-to-inject' };
        }
        case 'retarget-path': {
          const r = _retargetToTmp(params, capture);
          return r.changed ? { ok: true, params: r.params } : { ok: false, reason: 'no-writable-retarget' };
        }
        case 'switch-runtime': {
          const r = _switchRuntime(params, capture);
          return r.changed ? { ok: true, params: r.params, info: r.info } : { ok: false, reason: 'no-runtime-candidate' };
        }
        case 'install-dependency': {
          const dep = capture.dep;
          if (!dep) return { ok: false, reason: 'no-dependency-resolved' };
          const res = await this.installer.install(dep, { control });
          if (res && res.ok) return { ok: true, params: _withHealMarker(params, `dep:${dep}`), info: { depId: res.depId || dep } };
          return { ok: false, reason: (res && res.reason) || 'install-failed' };
        }
        case 'probe-port': {
          // 只读探测，不擅自杀进程 → 不构成"修复"，记录后降级。
          let info = null;
          if (this.probePort) { try { info = await this.probePort(capture.hostPort || {}); } catch { info = null; } }
          return { ok: false, reason: 'probe-only', info: info || { hostPort: capture.hostPort || null } };
        }
        default:
          return { ok: false, reason: `unsupported-fixkind:${fixKind || 'none'}` };
      }
    } catch (err) {
      return { ok: false, reason: (err && err.message) || 'fix-action-error' };
    }
  }
}

module.exports = {
  FixActions,
  HEAL_MARKER,
  // 透出纯函数便于单测
  _retargetToTmp,
  _injectDefaults,
  _switchRuntime,
  _withHealMarker,
  _defaultDependencyInstaller,
};
