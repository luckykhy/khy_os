/**
 * desktopIntentInterceptor.js
 *
 * Gateway 层「自然语言 → 桌面窗口操控」意图拦截（DESIGN-ARCH-056 续）。
 *
 * 在 adapter cascade 之前识别 "关闭火狐 / 激活 VS Code / 最小化浏览器 / 列出窗口"
 * 这类窗口管理意图，直接走 DesktopControl 门面的窗口原语，跳过 AI 推理。
 *
 * 与 appLaunchInterceptor 并列：那个管「打开应用」，这个管「激活/关闭/最小化/列窗口」。
 * 真实操控仍受 safetyGate（KHY_DESKTOP_CONTROL）裁决——闸门关闭时返回如何开启的明确指引，
 * 绝不在拦截层绕过保护（「只增不减保护」）。
 *
 * 所有渠道都经过此拦截点，无需在每个 adapter 内部重复实现。
 */

'use strict';

// 动作动词 → 窗口原语。最小化要排在「关闭」之前匹配以免「关」吞掉。
// 形如：<动词> [窗口/应用] <名称> ；名称允许为空（针对当前/最前窗口）。
const _ACTIVATE_RE = /^(?:激活|切到|切换到|聚焦|前置|呼出|唤起|activate|focus|switch\s+to|raise|bring\s+(?:up|to\s+front))\s*(?:窗口|应用|程序|window|app)?\s*(.*)$/i;
const _MINIMIZE_RE = /^(?:最小化|缩小|最小|minimi[sz]e|hide)\s*(?:窗口|应用|程序|window|app)?\s*(.*)$/i;
const _CLOSE_RE = /^(?:关闭|关掉|退出|结束|close|quit|kill)\s*(?:窗口|应用|程序|window|app)?\s*(.*)$/i;
const _LIST_RE = /^(?:列出|列举|显示|查看|有哪些|list)\s*(?:当前|所有|全部|open)?\s*(?:窗口|应用|程序|windows?|apps?)\s*$/i;

const _MAX_NAME = 40;

/**
 * 把用户口语里的应用别名（火狐/浏览器/谷歌…）规整为可被窗口后端识别的名称。
 * 复用 toolCalling.APP_ALIAS_MAP；命中别名时返回规范名，否则原样返回（去掉「窗口」等尾缀已在正则完成）。
 */
function _canonicalizeName(raw, toolCalling) {
  const name = String(raw || '').trim();
  if (!name) return '';
  if (!toolCalling || !toolCalling.APP_ALIAS_MAP) return name;
  try {
    const candidates = toolCalling._buildAppCandidates(name);
    const aliasMap = toolCalling.APP_ALIAS_MAP;
    // 直接别名命中：优先返回规范英文名（窗口标题/进程名通常用英文）。
    for (const c of candidates) {
      if (aliasMap[c]) return aliasMap[c];
    }
  } catch { /* best effort — fall through to raw */ }
  return name;
}

/**
 * 解析一段文本，返回 { action, name } 或 null。
 * action ∈ activate | closeWindow | minimizeWindow | listWindows
 */
function _parseDesktopIntent(text, toolCalling) {
  const t = String(text || '').trim();
  if (!t) return null;

  // 列窗口：纯只读，最先识别（无名称）。
  if (_LIST_RE.test(t)) return { action: 'listWindows', name: '' };

  // 顺序：最小化 → 关闭 → 激活（避免「关闭」误吞「最小化」等）。
  let m = _MINIMIZE_RE.exec(t);
  if (m) return { action: 'minimizeWindow', name: _extractName(m[1], toolCalling) };

  m = _CLOSE_RE.exec(t);
  if (m) return { action: 'closeWindow', name: _extractName(m[1], toolCalling) };

  m = _ACTIVATE_RE.exec(t);
  if (m) {
    const name = _extractName(m[1], toolCalling);
    // 「激活」必须带目标名，否则语义太泛（避免误吞普通对话）。
    if (!name) return null;
    return { action: 'activate', name };
  }

  return null;
}

function _extractName(rawTail, toolCalling) {
  let tail = String(rawTail || '').trim();
  // 去掉常见尾缀助词：的窗口 / 这个应用 / 它 等。
  tail = tail.replace(/(?:的)?(?:窗口|应用|程序|window|app)\s*$/i, '').trim();
  if (tail.length > _MAX_NAME) return ''; // 过长→不像应用名，放弃拦截
  return _canonicalizeName(tail, toolCalling);
}

/**
 * 尝试从用户消息中识别窗口操控意图并直接执行。
 *
 * @param {string} prompt - gateway 收到的完整 prompt
 * @param {object} options - gateway options，需要 options.userMessage 和 options.onChunk
 * @returns {object|null} gateway 标准结果对象，或 null 表示非窗口操控意图
 */
async function tryDesktopIntent(prompt, options) {
  const rawUserMessage = String(options?.userMessage || '').trim();
  const text = rawUserMessage || String(prompt || '').trim();
  if (!text || text.length > 80) return null; // 长文本不是命令式短指令

  let toolCalling = null;
  try { toolCalling = require('../toolCalling'); } catch { /* alias map optional */ }

  const intent = _parseDesktopIntent(text, toolCalling);
  if (!intent) return null;

  const { action, name } = intent;

  // 加载桌面门面（graceful fallback）。
  let desktop;
  try { desktop = require('../desktopControl').create(); } catch { return null; }

  const id = 'desktop_intent_0';
  const { onChunk } = options || {};
  const toolInput = name ? `${action}: ${name}` : action;
  if (typeof onChunk === 'function') {
    try { onChunk({ type: 'tool_use', tool: 'DesktopControl', input: toolInput, id }); } catch { /* best effort */ }
  }

  try {
    let result;
    switch (action) {
      case 'activate': result = await desktop.activate(name); break;
      case 'closeWindow': result = await desktop.closeWindow(name); break;
      case 'minimizeWindow': result = await desktop.minimizeWindow(name); break;
      case 'listWindows': result = await desktop.listWindows(); break;
      default: return null;
    }

    const ok = !!(result && result.success);
    let output;
    if (ok) {
      if (action === 'listWindows') {
        output = (result.stdout && String(result.stdout).trim()) || '（没有可见窗口）';
      } else {
        const label = name || '当前窗口';
        const verb = { activate: '已激活', closeWindow: '已关闭', minimizeWindow: '已最小化' }[action] || '已执行';
        output = `${verb} ${label}`;
      }
    } else if (result && result.denied) {
      // 闸门关闭：给出开启指引，绝不绕过保护。
      output = `桌面操控当前已禁用（${result.reason || '安全闸门关闭'}）。`
        + `\n请先开启：在 CLI 输入 /desktop on（自主）| /desktop ask（每会话批一次）| /desktop strict（每次批），`
        + `或设置环境变量 KHY_DESKTOP_CONTROL=on。`;
    } else {
      const hints = result && Array.isArray(result.installHints) && result.installHints.length
        ? `\n可安装更完整的后端：${result.installHints.map(h => h.hint || `${h.manager || ''} ${h.package || ''}`.trim()).filter(Boolean).join('；')}`
        : '';
      output = `${action} 失败：${(result && (result.error || result.reason)) || '未知原因'}${hints}`;
    }

    if (typeof onChunk === 'function') {
      try { onChunk({ type: 'tool_result', id, content: output }); } catch { /* best effort */ }
    }

    return {
      success: ok,
      content: output,
      provider: 'KHY DesktopControl',
      adapter: 'gateway_intercept',
      model: 'native',
      attempts: [{ provider: 'KHY DesktopControl', success: ok }],
    };
  } catch (err) {
    const errMsg = `桌面操控失败: ${err.message}`;
    if (typeof onChunk === 'function') {
      try { onChunk({ type: 'tool_result', id, content: errMsg }); } catch { /* best effort */ }
    }
    return null; // fallback 到正常 adapter cascade
  }
}

module.exports = {
  tryDesktopIntent,
  _parseDesktopIntent,
  _canonicalizeName,
  _ACTIVATE_RE,
  _MINIMIZE_RE,
  _CLOSE_RE,
  _LIST_RE,
};
