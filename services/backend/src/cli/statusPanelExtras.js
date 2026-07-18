'use strict';

/**
 * statusPanelExtras — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让显示背后的**后端逻辑**对齐。」
 * CC 的 `/status` 命令(`commands/status/status.tsx`)自述展示
 * "version, **model**, **account**, API connectivity, and tool statuses"——
 * model 与 account 是其点名的核心内容。khy 的 `/status`(router.js `case 'status'`)
 * 却只印 Provider / Branch / Context / Requests **四行**,漏掉 Model、Account、
 * 以及 git ahead/behind。
 *
 * 而这三样在 khy **早已 live 且已被别处渲染**(half-wired:数据侧已填充,`/status`
 * 这一呈现侧未接):
 *   - `hudState.lastModel` / `lastAdapter`:每轮 `hud.updateModelInfo(...)` 填充
 *     (`cli/ai.js` / `cli/repl.js`),状态栏 `hudRenderer.js:399-405` 已渲染。
 *   - `hudState.accountEmail`:`khy:adapter:account-email` 事件桥接填充,状态栏
 *     `:394-395` 与 `/hud` 面板 `:508-509` 已渲染。
 *   - `hudState.git.ahead/behind`:`refreshGit` 填充,`/hud` 面板 `:517-518` 已渲染。
 * `hud.getState()` 整体 spread 暴露全部字段——`/status` 只是没读它们。→ 接线=零新基础设施。
 *
 * 本叶子只做**纯决策**:从注入的 state 快照挑出这三样、套用注入的 `formatModelLabel`
 * SSOT(模型 slug → 友好显示名,复用 `cli/ccModelName.formatModelLabel`,由壳注入以保
 * 本叶子零依赖),产出无 chalk 的纯字符串片段;渲染(chalk / console.log)留壳 router。
 *
 * 诚实边界:CC status.tsx 还展示 API connectivity 与 tool statuses——这两样 khy
 * **无任何会话级底座**(连通性需实时探测、工具状态需 MCP 注册表,均属净新基础设施)→
 * **不纳入**(与刀92/刀93 无底座字段省略同纪律,绝不臆造)。门控 KHY_STATUS_PANEL_DETAIL
 * 默认开;关 → 三片全空(`{model:null,account:null,gitSuffix:''}`)→ 壳短路不追加任何额外行,
 * 且 Branch 行无 ahead/behind 后缀 → 逐字节回退刀94前的四行 `/status`。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_STATUS_PANEL_DETAIL 默认开;{0,false,off,no} 关。 */
function statusPanelDetailEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_PANEL_DETAIL;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// 收敛到 utils/trimIfString 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/trimIfString');

function _int(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 从 HUD state 快照挑出 `/status` 缺失的三片(model / account / git ahead-behind)。
 * 纯函数、绝不抛。
 *
 * @param {object} state - hud.getState() 快照(spread 后的 hudState)
 * @param {object} [opts]
 * @param {(model:string)=>string} [opts.formatModelLabel] 模型 slug → 友好显示名(壳注入;缺省恒等)
 * @param {object} [env]
 * @returns {{model:(string|null), account:(string|null), gitSuffix:string}}
 *   门控关/坏输入 → 三片全空(model:null, account:null, gitSuffix:'')。
 */
function buildStatusPanelExtras(state, opts = {}, env = process.env) {
  const empty = { model: null, account: null, gitSuffix: '' };
  try {
    if (!statusPanelDetailEnabled(env)) return empty;
    if (!state || typeof state !== 'object') return empty;

    const labelFn = opts && typeof opts.formatModelLabel === 'function'
      ? opts.formatModelLabel
      : (m) => m;

    // ── Model(+adapter 后缀,镜像状态栏 hudRenderer.js:399-405 的语义)──
    let model = null;
    const rawModel = _str(state.lastModel);
    if (rawModel) {
      let friendly;
      try { friendly = String(labelFn(rawModel) || rawModel); } catch { friendly = rawModel; }
      if (!friendly) friendly = rawModel;
      const adapter = _str(state.lastAdapter);
      // 仅当 adapter 存在且与模型名不同才加 `/adapter`(与状态栏一致)。
      model = adapter && adapter !== rawModel && adapter !== friendly
        ? `${friendly}/${adapter}`
        : friendly;
    }

    // ── Account(镜像状态栏 :394-395 / /hud 面板 :508-509)──
    const account = _str(state.accountEmail) || null;

    // ── Git ahead/behind 后缀(镜像 /hud 面板 :517-518 的措辞)──
    const git = state.git && typeof state.git === 'object' ? state.git : {};
    const ahead = _int(git.ahead);
    const behind = _int(git.behind);
    let gitSuffix = '';
    if (ahead > 0) gitSuffix += ` +${ahead} ahead`;
    if (behind > 0) gitSuffix += ` -${behind} behind`;

    return { model, account, gitSuffix };
  } catch {
    return empty;
  }
}

module.exports = { statusPanelDetailEnabled, buildStatusPanelExtras };
