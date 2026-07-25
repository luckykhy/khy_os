/**
 * appLaunchInterceptor.js (ai-backend 版)
 *
 * Gateway 层统一 app launch intent 拦截。
 * 如果 toolCalling 模块缺少 APP_ALIAS_MAP / _buildAppCandidates，
 * 则 graceful fallback（return null）。
 */

'use strict';

const _OPEN_APP_RE = /^(?:打开|启动|运行|open|launch|start|run)\s*(.+)$/i;

async function tryAppLaunchIntent(prompt, options) {
  const rawUserMessage = String(options?.userMessage || '').trim();
  const text = rawUserMessage || String(prompt || '').trim();
  const m = _OPEN_APP_RE.exec(text);
  if (!m) return null;

  const appQuery = m[1].trim();
  if (!appQuery || appQuery.length > 30) return null;

  let toolCalling;
  try { toolCalling = require('../toolCalling'); } catch { return null; }

  // ai-backend 的 toolCalling 可能缺少 app launching helpers
  if (typeof toolCalling._buildAppCandidates !== 'function' || !toolCalling.APP_ALIAS_MAP) {
    return null;
  }

  const candidates = toolCalling._buildAppCandidates(appQuery);
  if (!candidates || candidates.length === 0) return null;

  const aliasMap = toolCalling.APP_ALIAS_MAP;
  const hasKnownApp = candidates.some(c =>
    aliasMap[c] || Object.values(aliasMap).includes(c)
  );
  if (!hasKnownApp) return null;

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
    return null;
  }
}

module.exports = { tryAppLaunchIntent, _OPEN_APP_RE };
