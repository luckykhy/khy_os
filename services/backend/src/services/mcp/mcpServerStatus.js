'use strict';

/**
 * mcpServerStatus — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让显示背后的**后端逻辑**对齐。」
 * CC 的 `/mcp`(`components/mcp/MCPListPanel.tsx:165-195`)把每台服务器的
 * `client.type` 映射成逐台状态图标 + 标签:connected / connecting / pending→
 * "reconnecting (n/m)…" / needs-auth / 其余→"failed",并展示 `client.error`。
 * khy 的 `/mcp`(`router.js` `case 'mcp'`)却把一切塌成一列布尔 `Connected: yes/no`——
 * 一台 **failed** 的服务器与一台 **pending** 的无从区分,失败原因(`_lastError`)永不显示。
 *
 * 而这些在 khy **早已 live**(half-wired:数据侧已填充,`/mcp` 呈现侧塌成布尔丢弃):
 *   - `MCPClient.state` 在每条失败路径转 `ConnectionState.FAILED`、`_lastError` 记原因
 *     (`services/mcp/index.js:110/135/190/345/372/475`)。
 *   - `toConnectionObject()`(index.js:302-315)带 `type`+`error`;`getState()`→
 *     `buildCliState(_connections)`(index.js:1215 · types.js:180-201)把每台 `{name,type,error}`
 *     spread 暴露。`_connections` 由 `ensureMcpConnected` 每轮在工具循环填充
 *     (`toolUseLoop.js:1972`)且 `/mcp` 处理器已读它(经 `getConnectedServers` router.js:1542),
 *     只是 filter 到 CONNECTED、丢弃其余态与原因。→ 接线=零新基础设施。
 *
 * 本叶子只做**纯决策**:把一台服务器的原始连接态 `{disabled,connected,type,error,
 * reconnectAttempt,maxReconnectAttempts}` 解析成可显示的 `{state, detail}`;渲染(printTable /
 * chalk)留壳 router。
 *
 * 诚实边界:khy 的 `ConnectionState` 枚举(types.js:30-34)只有 connected/connecting/failed/
 * pending/disabled——**无 CC 的 needs-auth 态**→ 不映射不臆造该标签。门控
 * KHY_MCP_SERVER_STATUS 默认开;关 → 返回 legacy 布尔口径 `{state:connected?'yes':'no',detail:''}`
 * 供壳逐字节回退刀95前的 `Connected` 列。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_MCP_SERVER_STATUS 默认开;{0,false,off,no} 关。 */
function mcpServerStatusEnabled(env = process.env) {
  const raw = env && env.KHY_MCP_SERVER_STATUS;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ConnectionState(types.js)→ 显示标签。只映射 khy 实际存在的状态;
// CC 的 pending 在 MCPListPanel 渲染为 "reconnecting (n/m)…",此处 state='reconnecting'
// 由壳附带 (n/m) detail。needs-auth khy 枚举无 → 不列(honest-NA)。
const _STATE_LABEL = {
  connected: 'connected',
  connecting: 'connecting',
  pending: 'reconnecting',
  failed: 'failed',
  disabled: 'disabled',
};

function _clip(s, max) {
  const str = typeof s === 'string' ? s.trim() : '';
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * 从一台 MCP 服务器的原始连接态解析出可显示的 {state, detail}。纯函数、绝不抛。
 *
 * @param {object} info { disabled?, connected?, type?, error?, reconnectAttempt?, maxReconnectAttempts? }
 * @param {object} [env]
 * @returns {{state:string, detail:string}}
 *   门控关 → legacy 布尔口径 {state: connected?'yes':'no', detail:''}(供壳逐字节回退)。
 */
function resolveMcpServerState(info = {}, env = process.env) {
  try {
    const connected = !!(info && info.connected);
    if (!mcpServerStatusEnabled(env)) {
      return { state: connected ? 'yes' : 'no', detail: '' };
    }
    // disabled 优先(即便配置里也标了别的态,禁用是最终事实)。
    if (info && info.disabled) return { state: 'disabled', detail: '' };

    const type = info && typeof info.type === 'string' ? info.type.trim().toLowerCase() : '';
    let state = _STATE_LABEL[type];
    if (!state) {
      // 无连接记录(配置但未尝试)/未知态 → 由 connected 布尔兜底(honest:未接触=pending)。
      state = connected ? 'connected' : 'pending';
    }

    let detail = '';
    if (state === 'reconnecting') {
      // 镜像 CC "reconnecting (n/m)…":仅当尝试计数可用才附带。
      const a = Number(info && info.reconnectAttempt);
      const m = Number(info && info.maxReconnectAttempts);
      if (Number.isFinite(a) && a > 0 && Number.isFinite(m) && m > 0) detail = `${a}/${m}`;
    } else if (state === 'failed') {
      // failed → 展示 _lastError 原因(裁剪,避免撑破表格)。
      detail = _clip(info && info.error, 60);
    }
    return { state, detail };
  } catch {
    return { state: (info && info.connected) ? 'yes' : 'no', detail: '' };
  }
}

module.exports = { mcpServerStatusEnabled, resolveMcpServerState };
