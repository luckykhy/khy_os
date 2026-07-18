'use strict';

/**
 * serviceLifecyclePolicy.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * /goal「对 khyos 来说有的功能需要后台常驻,有的功能只有需要时加载,需要做清边界」。
 *
 * 本叶子是 khyos「后台常驻 vs 一次性启动 vs 按需加载」层级的**单一真源(SSoT)**。
 * 每个后台子系统的生命周期层级过去是**隐式**的——散落在 `bootstrap/prefetch.js` 的硬编码
 * setTimeout、daemon 内部 start 点、以及各自的 `KHY_*` 门里,没有集中声明、也没有守卫防漂移。
 * 这里把「决定」提到一张冻结表 + 一组纯查询函数;`bootstrap/prefetch.js` 由 `listStartupSchedule`
 * 驱动(操作化,不只是文档),`scripts/check-lifecycle-policy.js` 守卫防漂移。
 *
 * 三层 tier:
 *   - 'resident'        —— 起长生命 timer / watcher / server(常驻),需 shutdown 取消。
 *   - 'startup-oneshot' —— 启动后跑一次即返回(一次性),不常驻。
 *   - 'on-demand'       —— 首次使用才惰性载入(按需),从不进同步冷启动路径。
 * process 维度:'cli-startup'(deferredPrefetch 里跑)| 'daemon'(daemonEntry 独立进程)| 'lazy'。
 *
 * 契约(leaf-contract):零 IO、确定性(同输入同输出)、fail-soft 绝不抛、返回值与冻结表隔离
 * (调用方改返回值不污染 SSoT)。主门 `KHY_LIFECYCLE_POLICY` 默认开(flagRegistry-first + 注册表
 * 关时本地 CANON 回退)。per-id 覆盖 `KHY_LIFECYCLE_<ID_UPPER>=off|0|false` 是动态约定名
 * (不逐个进 flagRegistry),仅当主门开时生效。
 *
 * **绝不落盘、绝不发网**:本层只声明与查询,真正的 start/stop 仍由各服务自身承担。
 *
 * @module services/serviceLifecyclePolicy
 */

const flagRegistry = require('./flagRegistry');

/** 关闭词表(对齐仓库既有门控约定)。注册表关时的 OFF-fallback 路径。 */
const _OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * 生命周期条目冻结表 —— 唯一真源。
 *
 * 字段:
 *   id           —— 稳定标识(cli-startup 条目必须与 prefetch.js 的 RUNNERS 键一一对应)。
 *   tier         —— 'resident' | 'startup-oneshot' | 'on-demand'。
 *   process      —— 'cli-startup' | 'daemon' | 'lazy'。
 *   mode         —— cli-startup 专用:'khyquant'(完整模式)| 'khy'(轻量模式);其它条目 null。
 *   gate         —— 控制它的 `KHY_*` flag 名(或 null)。
 *   gateInverted —— true 表示 gate 是「禁用式」flag(置真=关闭,如 KHY_DISABLE_*)。
 *   delayMs      —— cli-startup 条目的 staggered 延迟(与 prefetch 现值逐条一致);其余 null。
 *   immediate    —— cli-startup 专用:true 表示 setImmediate(非 setTimeout,不进 timers 数组)。
 *   unref        —— 期望该条目的 timer 已 .unref()(声明,守卫可选校验)。
 *   shutdownHook —— 期望注册 shutdown 取消(声明)。
 *   startSymbol  —— daemon 条目的启动符号(供守卫在 daemonEntry/aiManagementServer 源码 grep 验在)。
 *   note         —— 人读说明。
 */
const LIFECYCLE = Object.freeze([
  // ── cli-startup(deferredPrefetch 完整模式 khyquant)──────────────────────────
  Object.freeze({
    id: 'hardwareProfileNotice', tier: 'startup-oneshot', process: 'cli-startup', mode: 'khyquant',
    gate: null, gateInverted: false, delayMs: 2000, immediate: false, unref: false, shutdownHook: true,
    startSymbol: null, note: '探测硬件档并在轻量机上打一条提示(limits 已同步前置应用),跑完即返回',
  }),
  Object.freeze({
    id: 'cleanupService', tier: 'resident', process: 'cli-startup', mode: 'khyquant',
    gate: null, gateInverted: false, delayMs: 3000, immediate: false, unref: true, shutdownHook: true,
    startSymbol: null, note: 'runCleanup 一次 + startPeriodicCleanup 起周期清理 timer(常驻)',
  }),
  Object.freeze({
    id: 'resourceGuard', tier: 'resident', process: 'cli-startup', mode: 'khyquant',
    gate: null, gateInverted: false, delayMs: 4000, immediate: false, unref: true, shutdownHook: true,
    startSymbol: null, note: 'startMemoryMonitor 起内存监视 timer(常驻)',
  }),
  Object.freeze({
    id: 'projectMemoryPrune', tier: 'startup-oneshot', process: 'cli-startup', mode: 'khyquant',
    gate: null, gateInverted: false, delayMs: 4000, immediate: false, unref: false, shutdownHook: true,
    startSymbol: null, note: 'pruneProjects 修剪一次即返回',
  }),
  Object.freeze({
    id: 'fileIntegrity', tier: 'startup-oneshot', process: 'cli-startup', mode: 'khyquant',
    gate: null, gateInverted: false, delayMs: 5000, immediate: false, unref: false, shutdownHook: true,
    startSymbol: null, note: 'verifyOnStartup 文件完整性校验一次',
  }),
  Object.freeze({
    id: 'versionUpdateNotice', tier: 'startup-oneshot', process: 'cli-startup', mode: 'khyquant',
    gate: null, gateInverted: false, delayMs: 5000, immediate: false, unref: false, shutdownHook: true,
    startSymbol: null, note: 'getUpdateNotice 取更新提示一次',
  }),
  Object.freeze({
    id: 'ideAdapterRecovery', tier: 'startup-oneshot', process: 'cli-startup', mode: 'khyquant',
    gate: null, gateInverted: false, delayMs: 6000, immediate: false, unref: false, shutdownHook: true,
    startSymbol: null, note: 'recoverIdeAdapters 异步恢复一次',
  }),
  Object.freeze({
    id: 'skillLearning', tier: 'startup-oneshot', process: 'cli-startup', mode: 'khyquant',
    gate: null, gateInverted: false, delayMs: 8000, immediate: false, unref: false, shutdownHook: true,
    startSymbol: null, note: 'getSuggestedLearning 取学习建议一次',
  }),
  Object.freeze({
    id: 'immediateServices', tier: 'resident', process: 'cli-startup', mode: 'khyquant',
    gate: null, gateInverted: false, delayMs: null, immediate: true, unref: true, shutdownHook: true,
    startSymbol: null, note: 'setImmediate:cloudSync flush + adminTelemetry(一次)+ startSecurityMonitor(常驻)',
  }),

  // ── cli-startup(deferredPrefetch 轻量模式 khy)──────────────────────────────
  Object.freeze({
    id: 'gatewayWarmup', tier: 'startup-oneshot', process: 'cli-startup', mode: 'khy',
    gate: 'KHY_GATEWAY_WARMUP_ON_BOOT', gateInverted: false, delayMs: 300, immediate: false,
    unref: false, shutdownHook: true, startSymbol: null,
    note: '轻量模式 +300ms 触发 aiGateway.init() 预热一次(门判定仍在 runner 体内,逐字节保留原 !==false 语义)',
  }),

  // ── daemon 常驻(daemonEntry.js 独立进程)──────────────────────────────────
  Object.freeze({
    id: 'aiManagementServer', tier: 'resident', process: 'daemon', mode: null,
    gate: null, gateInverted: false, delayMs: null, immediate: false, unref: false, shutdownHook: true,
    startSymbol: '_server.listen', note: 'AI 管理面 http+ws 服务(常驻,daemon 主体)',
  }),
  Object.freeze({
    id: 'daemonHeartbeat', tier: 'resident', process: 'daemon', mode: null,
    gate: null, gateInverted: false, delayMs: null, immediate: false, unref: true, shutdownHook: true,
    startSymbol: '_heartbeatTimer = setInterval', note: 'daemon GC 心跳扫描 timer(常驻)',
  }),
  Object.freeze({
    id: 'apiKeyPoolWatcher', tier: 'resident', process: 'daemon', mode: null,
    gate: 'KHY_DISABLE_KEYPOOL_WATCH', gateInverted: true, delayMs: null, immediate: false,
    unref: true, shutdownHook: true, startSymbol: "require('./apiKeyPoolWatcher').start",
    note: 'api_keys.json fs.watch + 轮询(常驻);禁用式门 KHY_DISABLE_KEYPOOL_WATCH 置真则不起',
  }),
  Object.freeze({
    id: 'changeWatch', tier: 'resident', process: 'daemon', mode: null,
    gate: 'KHY_CHANGE_WATCH', gateInverted: false, delayMs: null, immediate: false,
    unref: true, shutdownHook: true, startSymbol: 'changeWatch.start',
    note: '变更监视器(常驻);gate-before-start 干净模式,门 KHY_CHANGE_WATCH',
  }),

  // ── gated 常驻(repl/lazy,门开才起)────────────────────────────────────────
  Object.freeze({
    id: 'selfEditWatcher', tier: 'resident', process: 'lazy', mode: null,
    gate: 'KHY_SELF_EDIT_WATCH', gateInverted: false, delayMs: null, immediate: false,
    unref: true, shutdownHook: true, startSymbol: null,
    note: '外部编辑器监视器(常驻);门 KHY_SELF_EDIT_WATCH(子闸)开才起,repl 内启动',
  }),
  Object.freeze({
    id: 'cronScheduler', tier: 'resident', process: 'lazy', mode: null,
    gate: null, gateInverted: false, delayMs: null, immediate: false, unref: true, shutdownHook: true,
    startSymbol: null, note: '计划任务调度器(常驻);KHY_CRON_* 家族门,首次注册任务时 lazy start',
  }),

  // ── on-demand 目录(按需,从不进同步冷启动路径;声明 + 守卫防回退)──────────────
  Object.freeze({
    id: 'toolsRegistry', tier: 'on-demand', process: 'lazy', mode: null,
    gate: null, gateInverted: false, delayMs: null, immediate: false, unref: false, shutdownHook: false,
    startSymbol: null, note: '107 个工具首次 getAll/get 时批量载入;KHY_DEFER_TOOLS 控制惰性(守卫断言门在)',
  }),
  Object.freeze({
    id: 'aiGateway', tier: 'on-demand', process: 'lazy', mode: null,
    gate: null, gateInverted: false, delayMs: null, immediate: false, unref: false, shutdownHook: false,
    startSymbol: null,
    note: 'aiGateway + 17 adapter:construct+_doInit 需全部 adapter,故顶部 require 改惰性是 no-op;'
      + '仅在首次 chat 或 +300ms warmup 后载入,守卫禁其回退到 bin/khy.js/bootstrap.js 同步冷路径',
  }),
  Object.freeze({
    id: 'routerHandlers', tier: 'on-demand', process: 'lazy', mode: null,
    gate: null, gateInverted: false, delayMs: null, immediate: false, unref: false, shutdownHook: false,
    startSymbol: null, note: 'router 全部 handler 每 case 内联 require(按需)',
  }),
  Object.freeze({
    id: 'providerConnectivityTester', tier: 'on-demand', process: 'lazy', mode: null,
    gate: 'KHY_PROVIDER_CONNECTIVITY_TEST', gateInverted: false, delayMs: null, immediate: false,
    unref: false, shutdownHook: false, startSymbol: null,
    note: 'khy test-key 连通性自检:仅命令触发(按需),门 KHY_PROVIDER_CONNECTIVITY_TEST',
  }),
  Object.freeze({
    id: 'deviceApps', tier: 'on-demand', process: 'lazy', mode: null,
    gate: 'KHY_DEVICE_APPS_TOOL', gateInverted: false, delayMs: null, immediate: false,
    unref: false, shutdownHook: false, startSymbol: null,
    note: 'khy device 设备应用管理:仅命令/工具触发(按需)',
  }),
  Object.freeze({
    id: 'mcpClients', tier: 'on-demand', process: 'lazy', mode: null,
    gate: null, gateInverted: false, delayMs: null, immediate: false, unref: false, shutdownHook: true,
    startSymbol: null, note: 'MCP 客户端子进程:首次使用才连(按需),退出时清理',
  }),
  Object.freeze({
    id: 'lspClients', tier: 'on-demand', process: 'lazy', mode: null,
    gate: null, gateInverted: false, delayMs: null, immediate: false, unref: false, shutdownHook: true,
    startSymbol: null, note: 'LSP 客户端子进程:首次使用才起(按需),退出时清理',
  }),
  Object.freeze({
    id: 'localLLM', tier: 'on-demand', process: 'lazy', mode: null,
    gate: null, gateInverted: false, delayMs: null, immediate: false, unref: false, shutdownHook: true,
    startSymbol: null, note: '本地 LLM / tlsSidecar 子进程:首次需要才起(按需),退出时清理',
  }),
]);

const _CLI_STARTUP_MODES = new Set(['khy', 'khyquant']);

/** 找到条目(纯查找)。 */
function _find(id) {
  const needle = String(id || '');
  for (const e of LIFECYCLE) if (e.id === needle) return e;
  return null;
}

/** 浅拷贝条目,与冻结表隔离(调用方改返回值不污染 SSoT)。 */
function _copy(e) {
  return e ? { ...e } : null;
}

/**
 * 主门:生命周期策略是否启用。默认开;仅当 KHY_LIFECYCLE_POLICY 显式置关闭词才禁用。
 * flagRegistry-first + 注册表关时本地 CANON 回退(逐字节等价)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isPolicyEnabled(env = process.env) {
  try {
    if (flagRegistry.isRegistryEnabled(env)) {
      return flagRegistry.isFlagEnabled('KHY_LIFECYCLE_POLICY', env);
    }
    const raw = String((env && env.KHY_LIFECYCLE_POLICY) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

/**
 * 列出某 tier 的全部条目(深隔离拷贝)。
 * @param {'resident'|'startup-oneshot'|'on-demand'} tier
 * @returns {Array<object>}
 */
function listByTier(tier) {
  try {
    const t = String(tier || '');
    return LIFECYCLE.filter((e) => e.tier === t).map(_copy);
  } catch { return []; }
}

/**
 * 列出某 process 维度的全部条目(深隔离拷贝)。
 * @param {'cli-startup'|'daemon'|'lazy'} proc
 * @returns {Array<object>}
 */
function listByProcess(proc) {
  try {
    const p = String(proc || '');
    return LIFECYCLE.filter((e) => e.process === p).map(_copy);
  } catch { return []; }
}

/**
 * 该条目的 gate 是否开(无 gate 恒 true)。per-entry 门多为直读 env 的既有 flag(含禁用式),
 * 故用本地 CANON 判定而非 flagRegistry(仅主门走注册表)。
 * @param {string} id
 * @param {object} [env]
 * @returns {boolean}
 */
function gateEnabled(id, env = process.env) {
  try {
    const e = _find(id);
    if (!e || !e.gate) return true;
    const raw = String((env && env[e.gate]) || '').trim().toLowerCase();
    if (e.gateInverted) {
      // 禁用式 flag(KHY_DISABLE_*):置真=关闭 → 未置 / 关闭词 时服务启用。
      return !raw || _OFF.has(raw);
    }
    // 默认开式 flag:未置 或 非关闭词 → 启用。
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

/**
 * per-id 覆盖:读 `KHY_LIFECYCLE_<ID_UPPER>`(off/0/false 关)。仅当主门开时生效。
 * 返回:true(用户显式开)| false(用户显式关)| null(未设覆盖)。
 * @param {string} id
 * @param {object} [env]
 * @returns {boolean|null}
 */
function perIdOverride(id, env = process.env) {
  try {
    if (!isPolicyEnabled(env)) return null; // 主门关 → 忽略 per-id 覆盖。
    const e = _find(id);
    if (!e) return null;
    const key = `KHY_LIFECYCLE_${String(e.id).toUpperCase()}`;
    const raw = String((env && env[key]) || '').trim().toLowerCase();
    if (!raw) return null;
    return !_OFF.has(raw);
  } catch { return null; }
}

/**
 * 该条目是否应作为「常驻」启用:存在 ∧ tier==='resident' ∧ gate 开 ∧ 未被 per-id 覆盖关。
 * 主门关时忽略 per-id 覆盖(escape hatch)。
 * @param {string} id
 * @param {object} [env]
 * @returns {boolean}
 */
function isResident(id, env = process.env) {
  try {
    const e = _find(id);
    if (!e || e.tier !== 'resident') return false;
    if (!gateEnabled(id, env)) return false;
    if (perIdOverride(id, env) === false) return false;
    return true;
  } catch { return false; }
}

/**
 * deferredPrefetch 消费的唯一入口:返回给定 mode 下应调度的 cli-startup 条目。
 * 主门开:剔除被 per-id 覆盖关的条目;主门关:返回全部(忽略 per-id 覆盖)≈ 原始行为(escape hatch)。
 * 按 delayMs 升序稳定排序(immediate 条目排末尾,与原始 setImmediate 在 setTimeout 之后一致)。
 * @param {object} [env]
 * @param {'khy'|'khyquant'} [mode]
 * @returns {Array<object>}
 */
function listStartupSchedule(env = process.env, mode = 'khyquant') {
  try {
    const m = _CLI_STARTUP_MODES.has(String(mode)) ? String(mode) : 'khyquant';
    const policyOn = isPolicyEnabled(env);
    const rows = LIFECYCLE
      .filter((e) => e.process === 'cli-startup' && e.mode === m)
      .filter((e) => (policyOn ? perIdOverride(e.id, env) !== false : true))
      .map(_copy);
    // 稳定排序:immediate → +Infinity 排末;等延迟保留声明顺序。
    return rows
      .map((e, i) => ({ e, i, key: e.immediate ? Number.POSITIVE_INFINITY : Number(e.delayMs) || 0 }))
      .sort((a, b) => (a.key - b.key) || (a.i - b.i))
      .map((x) => x.e);
  } catch { return []; }
}

/**
 * 单条目描述(深隔离拷贝),未知 id → null。
 * @param {string} id
 * @returns {object|null}
 */
function describe(id) {
  try { return _copy(_find(id)); } catch { return null; }
}

/**
 * 列出全部条目声明的非空 gate(去重)。守卫用:校验每个 gate 是真实存在的 flag。
 * @returns {Array<string>}
 */
function allGates() {
  try {
    const set = new Set();
    for (const e of LIFECYCLE) if (e.gate) set.add(e.gate);
    return Array.from(set);
  } catch { return []; }
}

/** 全部条目 id(深隔离):守卫做覆盖比对用。 */
function allIds() {
  try { return LIFECYCLE.map((e) => e.id); } catch { return []; }
}

module.exports = {
  isPolicyEnabled,
  listByTier,
  listByProcess,
  gateEnabled,
  perIdOverride,
  isResident,
  listStartupSchedule,
  describe,
  allGates,
  allIds,
};
