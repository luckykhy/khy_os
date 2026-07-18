'use strict';

/**
 * uninstallRoute.js — 卸载「当前设备某个应用」的**分档路由决策**(纯叶子)。
 *
 * 回答「让 khy 卸载某个 exe/CLI 怎么保证卸干净」的核心:先判该 app 该走哪条**有清单/有卸载器**
 * 的路子,绝不猜删。三档(可靠度从高到低):
 *   T1 pm      —— 该 app 是包管理器可管理的标识(isSafeAppId)且平台有可用包管理器 →
 *                 winget/brew/apt 等按清单精确回收。
 *   T2 native  —— 名字含空格/非包管理器标识(典型「My Editor 1.2」),或包管理器管不到,
 *                 但 Windows 注册表里能匹配到 app **自带卸载器** → 跑其自带卸载器。
 *   T3 refuse  —— 两条路都没有 → 诚实拒绝:没有清单也没有卸载器的东西,任何工具都只能猜,
 *                 khy 宁可不删也不盲删安装目录(承 uninstall/installLedger 的「绝不猜删」红线)。
 *
 * 叶子契约:零 IO(事实由调用方探测后注入)、确定性、绝不抛。
 */

/**
 * @param {object} facts
 * @param {string} facts.query          用户给的卸载目标(包 ID 或应用显示名)
 * @param {boolean} facts.isPmAppId     query 是否是安全的包管理器标识(policy.isSafeAppId 结果)
 * @param {boolean} facts.pmAvailable   当前平台是否有可用包管理器
 * @param {boolean} facts.nativeAvailable  原生卸载器是否可用(Windows 且门开)
 * @param {number}  facts.nativeMatchCount 原生注册表里匹配到的可卸载条目数
 * @returns {{tier:'pm'|'native'|'refuse', reason:string, ambiguous?:boolean}}
 */
function decideUninstallRoute(facts = {}) {
  const query = String(facts.query || '').trim();
  const isPmAppId = !!facts.isPmAppId;
  const pmAvailable = !!facts.pmAvailable;
  const nativeAvailable = !!facts.nativeAvailable;
  const matches = Number.isFinite(facts.nativeMatchCount) ? facts.nativeMatchCount : 0;

  if (!query) {
    return { tier: 'refuse', reason: '未指定卸载目标' };
  }

  // T1:像包管理器标识(无空格/合法字符集)且有可用包管理器 → 走包管理器(有清单最干净)。
  if (isPmAppId && pmAvailable) {
    return { tier: 'pm', reason: '匹配包管理器标识,按包管理器清单精确卸载' };
  }

  // T2:注册表里能匹配到自带卸载器 → 跑其自带卸载器。
  if (nativeAvailable && matches > 0) {
    return {
      tier: 'native',
      reason: matches === 1
        ? '包管理器未覆盖;命中注册表自带卸载器,跑其原生卸载器'
        : `包管理器未覆盖;注册表命中 ${matches} 个同名条目,需选定后再卸`,
      ambiguous: matches > 1,
    };
  }

  // T3:两条路都没有 → 诚实拒绝(绝不猜删)。
  const why = [];
  if (!isPmAppId) why.push('非包管理器标识');
  else if (!pmAvailable) why.push('无可用包管理器');
  if (!nativeAvailable) why.push('原生卸载器不可用(非 Windows 或门关)');
  else if (matches === 0) why.push('注册表未匹配到自带卸载器');
  return {
    tier: 'refuse',
    reason: `未找到清单或自带卸载器(${why.join('、')});拒绝盲删安装目录`,
  };
}

module.exports = { decideUninstallRoute };
