'use strict';

/**
 * device.js — `khy device` CLI:管理当前设备的应用(系统包管理器桥接)。
 *
 * 子命令(对应 goal「下载、卸载和管理当前设备所有应用,下载要有进度条」):
 *   khy device list                      列出已安装应用
 *   khy device search <关键字>            在已装列表里过滤(本地过滤,不查远端仓库)
 *   khy device install <包ID>            经包管理器安装(确认后执行)
 *   khy device uninstall <包ID>          经包管理器卸载(确认后执行,破坏性)
 *   khy device download <url> <目标路径>  SSRF 守卫的**进度条**下载
 *
 * 判定全部委托 deviceAppsPolicy(单一真源);本层做 IO + 交互确认 + 进度条渲染。
 * 命令来自 policy 的 argv 构造器(execFile,无 shell)。破坏性操作前必 promptCompat 确认。
 */

const { printSuccess, printError, printInfo, printTable } = require('../formatters');

/**
 * @param {string} subCommand
 * @param {string[]} args 已剥离子命令后的位置参数
 * @param {object} options
 */
async function handleDevice(subCommand, args, options = {}) {
  const env = process.env;
  const { getManager } = require('../../services/deviceApps/deviceAppManager');

  const sub = subCommand || 'list';

  // download 不依赖包管理器,单独处理。
  if (sub === 'download') {
    return _handleDownload(args, options, env);
  }

  const mgr = getManager(env);
  if (!mgr.available) {
    printError(`设备应用管理器不可用:${mgr.reason || '未知原因'}`);
    return;
  }

  switch (sub) {
    case 'list':
    case 'search': {
      const res = await mgr.listInstalled();
      if (!res.ok) { printError(`列举失败:${res.error}`); return; }
      let apps = res.apps;
      const kw = String(args[0] || '').trim().toLowerCase();
      if (sub === 'search' && kw) {
        apps = apps.filter(a => (a.name + ' ' + a.id).toLowerCase().includes(kw));
      }
      printInfo(`包管理器:${mgr.pm.label} — 共 ${apps.length} 个已安装应用${sub === 'search' && kw ? `(过滤:${kw})` : ''}`);
      const rows = apps.slice(0, 500).map(a => [a.name || a.id, a.id, a.version || '-']);
      printTable(['名称', '标识', '版本'], rows);
      if (apps.length > 500) printInfo(`(仅显示前 500 个,共 ${apps.length} 个)`);
      return;
    }

    case 'install':
    case 'uninstall': {
      const appId = args[0];
      if (!appId) { printError(`用法: khy device ${sub} <包ID>`); return; }
      const verb = sub === 'install' ? '安装' : '卸载';

      // 卸载走分档路由(T1 包管理器 → T2 原生自带卸载器 → T3 诚实拒绝);安装仍走包管理器。
      if (sub === 'uninstall') {
        return _handleUninstallRouted(appId, options, env, mgr);
      }

      // 先取计划(未确认),向用户展示确切命令。
      const planFn = mgr.install.bind(mgr);
      const plan = await planFn(appId, { confirmed: false });
      if (!plan.argv) { printError(plan.error || `无法构造${verb}命令`); return; }
      printInfo(`将执行:${plan.argv.join(' ')}`);

      let go = options.yes === true || options.y === true;
      if (!go) {
        // 非交互环境(无 TTY / 管道 / CI)不弹交互提示,诚实取消并提示用 --yes。
        if (!process.stdin || !process.stdin.isTTY) {
          printInfo(`非交互环境:已跳过${verb}。如需执行,请加 --yes 重跑。`);
          return;
        }
        const { promptCompat } = require('../uiPrompt');
        const ans = await promptCompat([{
          type: 'confirm', name: 'ok',
          message: `确认${verb} ${appId}?`,
          default: false,
        }]);
        go = ans && ans.ok;
      }
      if (!go) { printInfo('已取消。'); return; }

      const res = await planFn(appId, { confirmed: true });
      if (res.ok) printSuccess(`${verb}完成:${appId}`);
      else printError(`${verb}失败:${res.error || '未知错误'}`);
      return;
    }

    default:
      printError('用法: khy device list | search <kw> | install <id> | uninstall <id> | download <url> <dest>');
  }
}

/**
 * 卸载分档路由:T1 包管理器 → T2 原生自带卸载器 → T3 诚实拒绝(绝不猜删)。
 * @param {string} appId 用户给的卸载目标(包 ID 或应用显示名)
 */
async function _handleUninstallRouted(appId, options, env, mgr) {
  const { decideUninstallRoute } = require('../../services/deviceApps/uninstallRoute');
  const policy = require('../../services/deviceApps/deviceAppsPolicy');
  const { getNativeUninstaller } = require('../../services/deviceApps/nativeUninstaller');

  const native = getNativeUninstaller(env);
  let nativeMatches = [];
  if (native.available) {
    const found = native.findByName(appId);
    if (found.ok) nativeMatches = found.matches;
  }

  const route = decideUninstallRoute({
    query: appId,
    isPmAppId: policy.isSafeAppId(appId),
    pmAvailable: !!(mgr && mgr.available),
    nativeAvailable: !!native.available,
    nativeMatchCount: nativeMatches.length,
  });

  // T3:诚实拒绝——没有清单也没有卸载器,不盲删。
  if (route.tier === 'refuse') {
    printError(`无法安全卸载「${appId}」:${route.reason}`);
    printInfo('提示:khy 只在能找到「包管理器清单」或「应用自带卸载器」时才卸载,绝不猜删安装目录。');
    return;
  }

  // T1:包管理器按清单精确卸载。
  if (route.tier === 'pm') {
    const plan = await mgr.uninstall(appId, { confirmed: false });
    if (!plan.argv) { printError(plan.error || '无法构造卸载命令'); return; }
    printInfo(`将执行(包管理器):${plan.argv.join(' ')}`);
    if (!(await _confirmDestructive(`确认卸载 ${appId}?`, options))) { printInfo('已取消。'); return; }
    const res = await mgr.uninstall(appId, { confirmed: true });
    if (res.ok) printSuccess(`卸载完成:${appId}`);
    else printError(`卸载失败:${res.error || '未知错误'}`);
    return;
  }

  // T2:跑应用自带卸载器。
  if (route.ambiguous) {
    printInfo(`注册表命中 ${nativeMatches.length} 个同名条目,请指定更精确的名称:`);
    for (const r of nativeMatches.slice(0, 20)) {
      printInfo(`  - ${r.displayName}${r.version ? ' (' + r.version + ')' : ''}${r.publisher ? ' — ' + r.publisher : ''}`);
    }
    return;
  }
  const rec = nativeMatches[0];
  const plan = await native.uninstall(rec, { confirmed: false });
  if (!plan.argv) { printError(plan.error || '无法构造原生卸载命令'); return; }
  printInfo(`将执行(自带卸载器):${plan.plan}`);
  if (!(await _confirmDestructive(`确认卸载 ${rec.displayName}?`, options))) { printInfo('已取消。'); return; }
  const res = await native.uninstall(rec, { confirmed: true });
  if (res.ok) printSuccess(`卸载完成:${rec.displayName}`);
  else printError(`卸载失败:${res.error || '未知错误'}`);
}

// 破坏性操作确认:--yes 直过;非 TTY 诚实取消提示 --yes;否则交互确认。
async function _confirmDestructive(message, options) {
  if (options.yes === true || options.y === true) return true;
  if (!process.stdin || !process.stdin.isTTY) {
    printInfo('非交互环境:已跳过。如需执行,请加 --yes 重跑。');
    return false;
  }
  const { promptCompat } = require('../uiPrompt');
  const ans = await promptCompat([{ type: 'confirm', name: 'ok', message, default: false }]);
  return !!(ans && ans.ok);
}

async function _handleDownload(args, options, env) {
  const url = args[0];
  const dest = args[1];
  if (!url || !dest) { printError('用法: khy device download <url> <目标路径>'); return; }

  const { downloadWithProgress, formatBytes } = require('../../services/deviceApps/deviceAppsDownloader');
  let progressEnabled = true;
  try {
    progressEnabled = require('../../services/flagRegistry').isFlagEnabled('KHY_DEVICE_APPS_PROGRESS', env);
  } catch (_) { /* 默认开 */ }

  const isTTY = !!(process.stdout && process.stdout.isTTY);
  let drewBar = false;
  const onProgress = (p) => {
    if (!progressEnabled || !isTTY) return;
    let label;
    if (p.known) {
      label = `${formatBytes(p.downloaded)} / ${formatBytes(p.total)}`;
    } else {
      label = `${formatBytes(p.downloaded)} / 未知总量`;
    }
    try {
      const { ProgressBar } = require('../ui/inkComponents');
      process.stdout.write('\r' + ProgressBar({ value: p.percent, label }));
      drewBar = true;
    } catch (_) { /* 渲染失败不影响下载 */ }
  };

  printInfo(`开始下载:${url}`);
  try {
    const res = await downloadWithProgress(url, dest, onProgress, {});
    if (drewBar) console.log(''); // 收尾换行,避免进度条残留
    printSuccess(`下载完成:${res.path}(${formatBytes(res.bytes)})`);
  } catch (err) {
    if (drewBar) console.log('');
    printError(`下载失败:${err && err.message ? err.message : String(err)}`);
  }
}

module.exports = { handleDevice };
