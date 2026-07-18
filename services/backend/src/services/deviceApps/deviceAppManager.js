'use strict';

/**
 * deviceAppManager.js — 设备应用管理器的**IO 壳**(list/uninstall/install)。
 *
 * 把 deviceAppsPolicy(纯判定)与真实系统调用桥接:探测包管理器、跑 list 并解析、
 * 执行卸载/安装(argv 直传 execFile,绝不拼 shell)。判定全部委托给 policy 单一真源;
 * 本层只做 IO + fail-soft + 诚实能力回报。
 *
 * 门控:KHY_DEVICE_APPS(父)。关闭 → getManager 返回 { available:false, reason }。
 *
 * 安全:
 *   - 命令一律来自 policy 的 argv 构造器(execFile,无 shell 解释)。
 *   - appId 由 policy.isSafeAppId 守卫;不安全 → 拒绝,不执行。
 *   - 卸载/安装是破坏性/提权操作 → 交互确认与提权决策留给调用方(CLI/工具);
 *     本层只执行,execute() 的 `confirmed` 由调用方负责。
 */

const policy = require('./deviceAppsPolicy');

function _gateEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_DEVICE_APPS', env);
  } catch (_) {
    const raw = env && env.KHY_DEVICE_APPS;
    if (raw === undefined || raw === null) return true;
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

// 默认注入:真实探测/执行。测试可整体替换。
function _defaultDeps() {
  const platformUtils = require('../../tools/platformUtils');
  const { execFile } = require('child_process');
  return {
    platform: process.platform,
    hasExecutable: (bin) => !!platformUtils.searchExecutable(bin),
    // 运行 argv、收集 stdout。仅用于 list(只读)。
    runCapture: (argv, timeoutMs) => new Promise((resolve) => {
      try {
        execFile(argv[0], argv.slice(1), { timeout: timeoutMs || 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
          (err, stdout) => resolve({ ok: !err, stdout: String(stdout || ''), error: err ? String(err.message || err) : null }));
      } catch (e) {
        resolve({ ok: false, stdout: '', error: String(e && e.message || e) });
      }
    }),
    // 运行 argv、继承 stdio(供卸载/安装把包管理器进度直显给用户)。
    runInherit: (argv, timeoutMs) => new Promise((resolve) => {
      try {
        execFile(argv[0], argv.slice(1), { timeout: timeoutMs || 600000, stdio: 'inherit', windowsHide: true },
          (err) => resolve({ ok: !err, error: err ? String(err.message || err) : null }));
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    }),
  };
}

/**
 * 取当前设备的应用管理器句柄。门控关/无可用包管理器 → available:false(诚实回报)。
 * @param {object} [env]
 * @param {object} [deps] 注入点(测试用)
 * @returns {{available:boolean, reason?:string, pm?:object, ...methods}}
 */
function getManager(env = process.env, deps) {
  if (!_gateEnabled(env)) {
    return { available: false, reason: 'KHY_DEVICE_APPS 已关闭' };
  }
  const d = deps || _defaultDeps();
  const pm = policy.detectPackageManager(d.platform, d.hasExecutable);
  if (!pm) {
    return {
      available: false,
      reason: `当前平台(${d.platform})未探测到受支持的包管理器(win32: winget/choco/scoop,darwin: brew,linux: apt/dnf/pacman)`,
    };
  }

  return {
    available: true,
    pm,
    /** 列出已安装应用。→ { ok, apps:[{name,id,version}], error? } */
    async listInstalled() {
      const argv = policy.buildListCommand(pm);
      if (!argv) return { ok: false, apps: [], error: '无法构造列举命令' };
      const res = await d.runCapture(argv, 60000);
      if (!res.ok) return { ok: false, apps: [], error: res.error || '列举失败' };
      return { ok: true, apps: policy.parseListOutput(pm.parse, res.stdout) };
    },
    /**
     * 卸载应用。appId 必安全;confirmed 必为 true(破坏性操作)。
     * @returns {{ok:boolean, error?:string, argv?:string[]}}
     */
    async uninstall(appId, { confirmed = false } = {}) {
      if (!policy.isSafeAppId(appId)) return { ok: false, error: `非法应用标识:${String(appId)}` };
      const argv = policy.buildUninstallCommand(pm, appId);
      if (!argv) return { ok: false, error: '无法构造卸载命令' };
      if (!confirmed) return { ok: false, error: '卸载未确认(需 confirmed:true)', argv };
      const res = await d.runInherit(argv, 600000);
      return { ok: res.ok, error: res.error || undefined, argv };
    },
    /**
     * 安装应用(按包管理器标识)。
     * @returns {{ok:boolean, error?:string, argv?:string[]}}
     */
    async install(appId, { confirmed = false } = {}) {
      if (!policy.isSafeAppId(appId)) return { ok: false, error: `非法应用标识:${String(appId)}` };
      const argv = policy.buildInstallCommand(pm, appId);
      if (!argv) return { ok: false, error: '无法构造安装命令' };
      if (!confirmed) return { ok: false, error: '安装未确认(需 confirmed:true)', argv };
      const res = await d.runInherit(argv, 600000);
      return { ok: res.ok, error: res.error || undefined, argv };
    },
  };
}

module.exports = {
  getManager,
  _gateEnabled,
};
