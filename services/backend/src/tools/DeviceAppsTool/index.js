/**
 * DeviceAppsTool — 下载 / 卸载 / 管理当前设备的应用(系统包管理器桥接)。
 *
 * 背景(goal「khy 要能下载、卸载和管理当前设备所有应用,下载要有进度条」):khy 此前
 * 只能装/卸自身注册的子应用(appRegistry),无法碰系统层已装应用。本工具经
 * deviceAppManager(IO 壳)+ deviceAppsPolicy(纯判定)桥接系统包管理器
 * (win32: winget/choco/scoop,darwin: brew,linux: apt/dnf/pacman),支持:
 *   - list   列出已安装应用
 *   - search 在已装列表里按关键字过滤(诚实:本地过滤,不查远端仓库)
 *   - install / uninstall  经包管理器安装/卸载(**破坏性/提权**,需显式 confirm)
 *   - download  经 SSRF 守卫的进度式下载(字节级进度在 `khy device` CLI 显示为进度条)
 *
 * 安全:install/uninstall/download-执行 默认只回 **计划(argv)** 并要求 params.confirm===true
 * 才真正执行 —— 防止模型静默改动设备。命令全部是 argv(execFile,无 shell)。appId 过白名单。
 *
 * 门控 KHY_DEVICE_APPS_TOOL(经 flagRegistry 声明式注册,默认开;父 KHY_DEVICE_APPS)。
 * 关 → 本模块导出 benign 非工具对象,自动发现跳过 → 工具不注册。
 */
const { BaseTool } = require('../_baseTool');

function _gateEnabled(env = process.env) {
  try {
    return require('../../services/flagRegistry').isFlagEnabled('KHY_DEVICE_APPS_TOOL', env);
  } catch {
    const raw = env && env.KHY_DEVICE_APPS_TOOL;
    if (raw === undefined || raw === null) return true;
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

const READONLY_ACTIONS = new Set(['list', 'search']);

class DeviceAppsTool extends BaseTool {
  static toolName = 'DeviceApps';
  static category = 'system';
  static risk = 'high'; // 可安装/卸载系统应用;approval 层按此把关(叠加工具自身的 confirm 门)
  static aliases = ['device_apps', 'app_manager', 'manage_apps', 'system_apps'];
  static searchHint = 'list, search, install, uninstall or download applications on this device';

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }
  isDestructive(input) {
    const a = input && input.action;
    return a === 'uninstall' || a === 'install';
  }

  prompt() {
    return `- Manage applications installed on THIS device via the system package manager (winget/choco/scoop on Windows, brew on macOS, apt/dnf/pacman on Linux)
- Actions: "list" (installed apps), "search" (filter installed apps by keyword), "install"/"uninstall" (by package id), "download" (fetch a URL to disk, SSRF-guarded)
- install/uninstall/download DO NOT run unless you pass confirm:true — without it you get the exact command that WOULD run, for the user to approve. Never pass confirm:true unless the user clearly asked to install/uninstall/download that specific app
- appId must be a package-manager identifier (e.g. winget "Microsoft.VisualStudioCode", apt "python3-pip", brew "gnu-tar"), validated against a safe charset
- Returns honest capability info: if no supported package manager exists on this platform, it says so rather than pretending`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'install', 'uninstall', 'download'],
          description: 'What to do. Default "list".',
        },
        appId: {
          type: 'string',
          description: 'Package identifier for install/uninstall, or keyword for search.',
        },
        url: { type: 'string', description: 'For action "download": the http(s) URL to fetch.' },
        dest: { type: 'string', description: 'For action "download": destination file path.' },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually run install/uninstall/download. Without it, only the plan is returned.',
        },
      },
      required: [],
    };
  }

  getActivityDescription(input) {
    const a = (input && input.action) || 'list';
    const target = input && (input.appId || input.url);
    return `设备应用管理:${a}${target ? ' ' + target : ''}`;
  }

  async execute(params, _context) {
    try {
      const action = (params && params.action) || 'list';
      const env = process.env;
      const { getManager } = require('../../services/deviceApps/deviceAppManager');
      const mgr = getManager(env);

      if (action === 'download') {
        return await this._download(params, env);
      }

      if (!mgr.available) {
        return { success: false, error: mgr.reason || '设备应用管理器不可用' };
      }

      if (action === 'list' || action === 'search') {
        const res = await mgr.listInstalled();
        if (!res.ok) return { success: false, error: res.error };
        let apps = res.apps;
        const kw = String((params && params.appId) || '').trim().toLowerCase();
        if (action === 'search' && kw) {
          apps = apps.filter(a => (a.name + ' ' + a.id).toLowerCase().includes(kw));
        }
        return {
          success: true,
          packageManager: mgr.pm.id,
          count: apps.length,
          apps: apps.slice(0, 500), // 防超大列表淹没上下文
          truncated: apps.length > 500,
        };
      }

      if (action === 'install' || action === 'uninstall') {
        const appId = params && params.appId;
        const confirmed = params && params.confirm === true;
        if (action === 'uninstall') {
          return await this._uninstallRouted(appId, confirmed, mgr, env);
        }
        const fn = mgr.install.bind(mgr);
        const res = await fn(appId, { confirmed });
        if (!confirmed) {
          // 只回计划,要求用户确认。
          if (res.argv) {
            return {
              success: true,
              plan: { action, packageManager: mgr.pm.id, command: res.argv.join(' '), argv: res.argv },
              requiresConfirm: true,
              message: `将安装 ${appId}。确认后重发并带 confirm:true 才会执行。`,
            };
          }
          return { success: false, error: res.error };
        }
        return res.ok
          ? { success: true, action, appId, packageManager: mgr.pm.id, command: (res.argv || []).join(' ') }
          : { success: false, error: res.error, command: (res.argv || []).join(' ') };
      }

      return { success: false, error: `未知 action:${action}` };
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 卸载分档路由:T1 包管理器 → T2 原生自带卸载器 → T3 诚实拒绝(绝不猜删)。
   * 未确认只回计划(argv)要求 confirm;确认才执行。
   */
  async _uninstallRouted(appId, confirmed, mgr, env) {
    if (!appId) return { success: false, error: 'uninstall 需要 appId' };
    const { decideUninstallRoute } = require('../../services/deviceApps/uninstallRoute');
    const policy = require('../../services/deviceApps/deviceAppsPolicy');
    const { getNativeUninstaller } = require('../../services/deviceApps/nativeUninstaller');

    const native = getNativeUninstaller(env);
    let matches = [];
    if (native.available) {
      const found = native.findByName(appId);
      if (found.ok) matches = found.matches;
    }
    const route = decideUninstallRoute({
      query: appId,
      isPmAppId: policy.isSafeAppId(appId),
      pmAvailable: !!(mgr && mgr.available),
      nativeAvailable: !!native.available,
      nativeMatchCount: matches.length,
    });

    if (route.tier === 'refuse') {
      return { success: false, tier: 'refuse', error: `无法安全卸载「${appId}」:${route.reason}`, note: 'khy 只在能找到包管理器清单或应用自带卸载器时才卸载,绝不猜删安装目录。' };
    }

    if (route.tier === 'pm') {
      const res = await mgr.uninstall(appId, { confirmed });
      if (!confirmed) {
        return res.argv
          ? { success: true, tier: 'pm', plan: { packageManager: mgr.pm.id, command: res.argv.join(' '), argv: res.argv }, requiresConfirm: true, message: `将经包管理器卸载 ${appId}。确认后重发并带 confirm:true 才会执行。` }
          : { success: false, error: res.error };
      }
      return res.ok
        ? { success: true, tier: 'pm', action: 'uninstall', appId, packageManager: mgr.pm.id, command: (res.argv || []).join(' ') }
        : { success: false, error: res.error, command: (res.argv || []).join(' ') };
    }

    // T2 native
    if (route.ambiguous) {
      return {
        success: true, tier: 'native', requiresDisambiguation: true,
        matches: matches.slice(0, 20).map(r => ({ displayName: r.displayName, version: r.version, publisher: r.publisher })),
        message: `注册表命中 ${matches.length} 个同名条目,请用更精确的名称重发。`,
      };
    }
    const rec = matches[0];
    const res = await native.uninstall(rec, { confirmed });
    if (!confirmed) {
      return res.argv
        ? { success: true, tier: 'native', plan: { command: res.plan, argv: res.argv }, requiresConfirm: true, message: `将跑「${rec.displayName}」自带卸载器。确认后重发并带 confirm:true 才会执行。` }
        : { success: false, error: res.error };
    }
    return res.ok
      ? { success: true, tier: 'native', action: 'uninstall', appId: rec.displayName, command: res.plan }
      : { success: false, error: res.error, command: res.plan };
  }

  async _download(params, env) {
    const url = params && params.url;
    const dest = params && params.dest;
    if (!url || !dest) return { success: false, error: 'download 需要 url 与 dest' };
    if (params.confirm !== true) {
      return {
        success: true,
        plan: { action: 'download', url, dest },
        requiresConfirm: true,
        message: `将从 ${url} 下载到 ${dest}。确认后重发并带 confirm:true 才会执行。`,
      };
    }
    const { downloadWithProgress, formatBytes } = require('../../services/deviceApps/deviceAppsDownloader');
    try {
      const res = await downloadWithProgress(url, dest, null, {});
      return { success: true, action: 'download', url, path: res.path, bytes: res.bytes, size: formatBytes(res.bytes) };
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }
}

if (!_gateEnabled(process.env)) {
  module.exports = { _khyDeviceAppsDisabled: true };
} else {
  module.exports = new DeviceAppsTool();
  module.exports.DeviceAppsTool = DeviceAppsTool;
}
