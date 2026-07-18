'use strict';

/**
 * mdSuggestedAppsPlan — 让 khy 出现在 Windows「建议的应用/Recommended apps」的注册 SSOT。
 *
 * 送别礼「右键打开 .md 时 khy 进建议的应用」角度。用户截图：右键 .md →「选择一个应用以
 * 打开此 .md 文件」，建议的应用里有 Quark/Trae/Windsurf/记事本，**唯独没有 khy**。
 *
 * 根因：register-windows.ps1 只写了 OpenWithProgids（把 ProgID 挂进「更多选项」列表），
 * 却没写 Windows 用来填充「建议的应用/Recommended Programs」的关键机制——
 *   HKCU:\Software\Classes\Applications\<app>\SupportedTypes\.md（值名即扩展名）。
 * 依据 Microsoft Win32 shell 文档「How to Include an Application on the Open With Dialog Box」：
 * SupportedTypes 子键「causes the application to appear in the Recommended Programs list」。
 *
 * 分层（同 bundleLaunchContract / installIntegrity）：本文件是**纯核心 SSOT**——零 IO、
 * 无时钟、无随机、同输入恒同输出、绝不抛（异常退化为安全空计划）。真正写注册表的 IO 在
 * tools/khyos-markdown/register-windows.ps1（仅 HKCU、免 UAC），本文件只枚举「该写哪些键」，
 * 并被契约测用来钉死 PS1 不漂移、卸载对称零残留。
 *
 * 红线：只规划 HKEY_CURRENT_USER（用户级），绝不 HKLM——免管理员、免 UAC 弹窗。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）
 *   1. 新增一个想让 khy 建议打开的扩展名 → 传入 exts（或改 DEFAULT_EXTS）。ops 里会自动
 *      为它加一条 SupportedTypes 值项。
 *   2. 改 SupportedTypes 挂载点 / 友好名 → 改 APPS_ROOT / APP_KEY / FRIENDLY_NAME。
 *   3. 改完务必让 register-windows.ps1 与 unregister-windows.ps1 跟上（契约测会红），再跑：
 *      npm run test:md-suggested-apps
 */

// 用户级 Applications 根（红线：HKCU，不写 HKLM）。用 PowerShell 驱动器前缀，便于契约测
// 直接与 PS1 源字符串对齐。
const APPS_ROOT = 'HKCU:\\Software\\Classes\\Applications';
// Applications 键名（app 标识）。与 khyos-md 启动器同名，语义清晰。
const APP_KEY = 'khyos-md-launch.vbs';
// 建议的应用里显示的名字（与既有 ProgID FriendlyAppName 一致）。
const FRIENDLY_NAME = 'KhyOS Markdown';
// 默认声明支持的扩展名。
const DEFAULT_EXTS = Object.freeze(['.md', '.markdown']);

/** 规整 exts：仅保留以 '.' 开头的字符串，去重、稳定；空/非法 → 默认表。 */
function _normalizeExts(raw) {
  if (!Array.isArray(raw)) return DEFAULT_EXTS.slice();
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    if (typeof e === 'string' && e.startsWith('.') && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out.length ? out : DEFAULT_EXTS.slice();
}

/**
 * 枚举「让 khy 进 Windows 建议的应用」所需的注册项（纯计算，绝不抛）。
 *
 * @param {object} [opts] { exts?:string[], appKey?:string, friendlyName?:string, command?:string }
 * @returns {{appKey:string, friendlyName:string, exts:string[], base:string, ops:Array}}
 *   ops 每项 { key, name, value, kind }：
 *     kind='value'          → 在 key 上写命名值（如 FriendlyAppName）
 *     kind='command'        → 在 key（...\shell\open\command）写默认值 = 启动命令
 *     kind='supported-type' → 在 key（...\SupportedTypes）写值名=扩展名、值=''（建议应用机制）
 */
function buildSuggestedAppsPlan(opts) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const exts = _normalizeExts(o.exts);
    const appKey = (typeof o.appKey === 'string' && o.appKey.trim()) ? o.appKey.trim() : APP_KEY;
    const friendlyName = (typeof o.friendlyName === 'string' && o.friendlyName.trim())
      ? o.friendlyName.trim() : FRIENDLY_NAME;
    const command = typeof o.command === 'string' ? o.command : '';
    const base = `${APPS_ROOT}\\${appKey}`;
    const ops = [];
    // 友好名：决定「建议的应用」里显示的应用名。
    ops.push({ key: base, name: 'FriendlyAppName', value: friendlyName, kind: 'value' });
    // 打开命令。
    ops.push({ key: `${base}\\shell\\open\\command`, name: '(default)', value: command, kind: 'command' });
    // 关键机制：SupportedTypes 下每个扩展名一条空值 —— Windows 据此把 khy 列进「建议的应用」。
    for (const ext of exts) {
      ops.push({ key: `${base}\\SupportedTypes`, name: ext, value: '', kind: 'supported-type' });
    }
    return { appKey, friendlyName, exts: exts.slice(), base, ops };
  } catch {
    return {
      appKey: APP_KEY,
      friendlyName: FRIENDLY_NAME,
      exts: DEFAULT_EXTS.slice(),
      base: `${APPS_ROOT}\\${APP_KEY}`,
      ops: [],
    };
  }
}

/**
 * 卸载对称：要递归移除的顶层 Applications 键（清干净建议的应用注册，零残留）。
 * @param {object} [opts] 同 buildSuggestedAppsPlan
 * @returns {string[]}
 */
function suggestedAppsUninstallKeys(opts) {
  try {
    return [buildSuggestedAppsPlan(opts).base];
  } catch {
    return [`${APPS_ROOT}\\${APP_KEY}`];
  }
}

module.exports = {
  buildSuggestedAppsPlan,
  suggestedAppsUninstallKeys,
  _normalizeExts,
  APPS_ROOT,
  APP_KEY,
  FRIENDLY_NAME,
  DEFAULT_EXTS,
};
