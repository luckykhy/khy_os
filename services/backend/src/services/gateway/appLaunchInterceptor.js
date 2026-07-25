/**
 * appLaunchInterceptor.js
 *
 * Gateway 层统一 app launch intent 拦截。
 * 在 adapter cascade 循环之前检测 "打开/启动/open <app>" 意图，
 * 直接通过 KHY 的 open_app 工具执行，跳过 AI 推理。
 *
 * 所有渠道（codex/claude/ollama/kiro/relay/api/trae/windsurf/...）
 * 都经过此拦截点，无需在每个 adapter 内部重复实现。
 */

'use strict';

const _OPEN_APP_RE = /^(?:打开|启动|运行|open|launch|start|run)\s*(.+)$/i;

// 本地优先门控:默认开。关(0/false/off/no)→ 闸门逐字节回退「仅 APP_ALIAS_MAP 白名单」历史行为。
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _localFirstEnabled(env = process.env) {
  return !_FALSY.has(String((env && env.KHY_APP_LOCAL_FIRST) || '').trim().toLowerCase());
}

/**
 * 尝试从用户消息中识别 app launch 意图并直接执行。
 *
 * @param {string} prompt - gateway 收到的完整 prompt（可能含系统提示+历史）
 * @param {object} options - gateway options，需要 options.userMessage 和 options.onChunk
 * @returns {object|null} gateway 标准结果对象，或 null 表示非 app launch 意图
 */
async function tryAppLaunchIntent(prompt, options) {
  // 优先使用原始用户消息（不含系统提示和历史上下文），
  // 否则正则无法匹配 "打开火狐" 这样的短输入
  const rawUserMessage = String(options?.userMessage || '').trim();
  const text = rawUserMessage || String(prompt || '').trim();
  const m = _OPEN_APP_RE.exec(text);
  if (!m) return null;

  const appQuery = m[1].trim();
  if (!appQuery || appQuery.length > 30) return null;

  // 加载 toolCalling 模块（graceful fallback）
  let toolCalling;
  try { toolCalling = require('../toolCalling'); } catch { return null; }

  // 校验是否为已知应用
  const candidates = toolCalling._buildAppCandidates(appQuery);
  if (!candidates || candidates.length === 0) return null;

  const aliasMap = toolCalling.APP_ALIAS_MAP;
  const hasKnownApp = candidates.some(c =>
    aliasMap[c] || Object.values(aliasMap).includes(c)
  );
  // 本地优先:白名单未命中时,若本机确有该应用,也优先拦截走 open_app 启动本地 exe,
  // 而非放行让模型自行编一个 `start <URL>` 打开网页。门控关 → proceed === hasKnownApp(逐字节回退)。
  let proceed = hasKnownApp;
  if (!proceed && _localFirstEnabled(process.env)) {
    try {
      proceed = typeof toolCalling.hasInstalledAppMatch === 'function'
        && toolCalling.hasInstalledAppMatch(appQuery);
    } catch { proceed = false; }
  }
  if (!proceed) return null;

  // 发射 tool_use 事件（流式透传到 UI）
  const { onChunk } = options || {};
  if (typeof onChunk === 'function') {
    try { onChunk({ type: 'tool_use', tool: 'open_app', input: appQuery, id: 'app_launch_0' }); } catch { /* best effort */ }
  }

  try {
    const result = await toolCalling.executeTool('open_app', { name: appQuery });
    const ok = result && result.success;
    const output = ok
      ? (result.output || `已启动 ${appQuery}`)
      : (result.error || `无法启动 ${appQuery}`);

    if (typeof onChunk === 'function') {
      try { onChunk({ type: 'tool_result', id: 'app_launch_0', content: output }); } catch { /* best effort */ }
    }

    return {
      success: ok,
      content: output,
      provider: 'KHY open_app',
      adapter: 'gateway_intercept',
      model: 'native',
      attempts: [{ provider: 'KHY open_app', success: ok }],
    };
  } catch (err) {
    const errMsg = `启动失败: ${err.message}`;
    if (typeof onChunk === 'function') {
      try { onChunk({ type: 'tool_result', id: 'app_launch_0', content: errMsg }); } catch { /* best effort */ }
    }
    return null; // fallback 到正常 adapter cascade
  }
}

module.exports = { tryAppLaunchIntent, _OPEN_APP_RE };
