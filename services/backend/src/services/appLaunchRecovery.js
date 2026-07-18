'use strict';

/**
 * App launch recovery — fallback logic when shell commands fail
 * for app-launch or web-search intents.
 *
 * Extracted from toolUseLoop.js (lines 4057-4404, 4509-4551,
 * 4849-4975) as part of the industrial-grade modularization (Phase 1I).
 *
 * Dependencies: intentHeuristics (same package).
 */

const {
  isShellToolName,
  looksLikeAppLaunchRequest,
  looksLikeInfoSearchRequest,
  looksLikeShellAppProbeCommand,
  extractAppTargetFromUserMessage,
  extractUserToolConstraints,
} = require('./intentHeuristics');

// ── App target normalization ─────────────────────────────────────────

function normalizeAppTarget(target = '') {
  let text = String(target || '').trim();
  if (!text) return '';

  text = text
    .replace(/^(请|帮我|麻烦|能否|可以|帮忙)\s*/g, '')
    .replace(/^(打开|启动|运行)\s*/g, '')
    .replace(/^(一个|一款|一下|下)\s*/g, '')
    .replace(/(应用|程序|软件|工具|客户端|浏览器|app|application|program|tool|client|browser)$/ig, '')
    .replace(/^(能|可以)\s*/g, '')
    .replace(/^编辑\s*/g, '')
    .replace(/^用于\s*/g, '')
    .replace(/的$/g, '')
    .trim();

  if (/pdf/i.test(text) && text.length > 12) return 'pdf';
  return text;
}

// ── Error/result helpers ─────────────────────────────────────────────

function extractErrorTextFromResult(result = {}) {
  const err = result?.error;
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') return [err.code, err.message, err.hint].filter(Boolean).join(' ');
  return String(err);
}

function isShellExecutorUnavailableResult(result = {}) {
  if (!result || result.success) return false;
  const err = result.error;
  if (err && typeof err === 'object' && String(err.code || '').toLowerCase() === 'executor_unavailable') return true;
  const text = `${extractErrorTextFromResult(result)} ${String(result.hint || '')}`.toLowerCase();
  return /fork:\s*retry:\s*resource temporarily unavailable/.test(text)
    || /cannot fork subprocess/.test(text)
    || /executor[_\s-]*unavailable/.test(text);
}

// ── Shell command target extraction ──────────────────────────────────

function extractAppTargetFromShellCommand(command = '') {
  const raw = String(command || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\s+/g, ' ');

  const launchLike = normalized.match(/^(?:nohup\s+)?([a-z0-9._+-]+)/i);
  if (launchLike) {
    const bin = String(launchLike[1] || '').toLowerCase();
    const probeBins = new Set(['which', 'whereis', 'command', 'type', 'ps', 'pgrep', 'pidof', 'grep', 'bash', 'sh', 'zsh', 'env', 'nohup']);
    if (bin && !probeBins.has(bin)) return normalizeAppTarget(bin);
  }

  const whichMatch = normalized.match(/\bwhich\s+(.+)$/i);
  if (whichMatch) {
    const tokens = whichMatch[1].split(/\s+/).filter(Boolean);
    for (const tokenRaw of tokens) {
      const token = String(tokenRaw || '').replace(/^['"`]+|['"`]+$/g, '');
      if (!token) continue;
      if (/^[|;&]/.test(token) || token.includes('||') || token.includes('&&') || token.includes(';')) break;
      if (/^\d+>/.test(token) || /^2>/.test(token) || /^1>/.test(token)) break;
      if (token.startsWith('-')) continue;
      if (/^[a-z0-9._+-]+$/i.test(token)) return normalizeAppTarget(token.toLowerCase());
    }
  }

  const grepMatch = normalized.match(/\bgrep\s+(?:-[^\s]+\s+)*['"]?([a-z0-9._+-]{2,})['"]?/i);
  if (grepMatch) return normalizeAppTarget(String(grepMatch[1] || '').toLowerCase());

  return '';
}

function extractAppCandidatesFromShellCommand(command = '') {
  const out = [];
  const raw = String(command || '').trim();
  if (!raw) return out;
  const normalized = raw.replace(/\s+/g, ' ');

  const whichMatch = normalized.match(/\bwhich\s+(.+)$/i);
  if (whichMatch) {
    const tokens = whichMatch[1].split(/\s+/).filter(Boolean);
    for (const tokenRaw of tokens) {
      const token = String(tokenRaw || '').replace(/^['"`]+|['"`]+$/g, '');
      if (!token) continue;
      if (/^[|;&]/.test(token) || token.includes('||') || token.includes('&&') || token.includes(';')) break;
      if (/^\d+>/.test(token) || /^2>/.test(token) || /^1>/.test(token)) break;
      if (token.startsWith('-')) continue;
      if (/^[a-z0-9._+-]+$/i.test(token)) out.push(normalizeAppTarget(token.toLowerCase()));
    }
  }

  const first = extractAppTargetFromShellCommand(command);
  if (first) out.unshift(first);

  return [...new Set(out.filter(Boolean))];
}

// ── Recovery functions ───────────────────────────────────────────────

async function recoverOpenAppAfterShellFailure(call, result, userMessage, toolCalling, execContext = {}) {
  if (!call || !isShellToolName(call.name)) return result;
  const shellCommand = String(call.params?.command || '').trim();
  if (!shellCommand) return result;
  if (!isShellExecutorUnavailableResult(result)) return result;
  if (!looksLikeAppLaunchRequest(userMessage) && !looksLikeShellAppProbeCommand(shellCommand)) return result;

  const candidates = extractAppCandidatesFromShellCommand(shellCommand);
  const msgTarget = extractAppTargetFromUserMessage(userMessage);
  if (msgTarget) candidates.push(msgTarget);
  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  if (uniqueCandidates.length === 0) return result;

  let fallback = null;
  let usedTarget = '';
  for (const appName of uniqueCandidates) {
    usedTarget = appName;
    try {
      fallback = await toolCalling.executeTool('open_app', { name: appName }, execContext);
    } catch (err) {
      fallback = { success: false, error: err.message || 'open_app failed' };
    }
    if (fallback && fallback.success) {
      const out = String(fallback.output || '').trim();
      return {
        ...fallback,
        success: true,
        output: out || `Recovered via open_app("${appName}")`,
        _autoRecovered: true, _autoRecoveredFrom: 'shell_command', _autoRecoveredTarget: appName,
      };
    }
  }

  const fallbackErr = String(extractErrorTextFromResult(fallback) || fallback?.hint || 'open_app failed').trim();
  const previousHint = String(result?.hint || '').trim();
  const failHint = `Auto-recovery open_app("${usedTarget}") failed: ${fallbackErr}`;
  return { ...result, hint: previousHint ? `${previousHint} ${failHint}` : failHint };
}

async function recoverWebSearchAfterShellFailure(call, result, userMessage, toolCalling, execContext = {}) {
  if (!call || !isShellToolName(call.name)) return result;
  const shellCommand = String(call.params?.command || '').trim();
  if (!shellCommand) return result;
  if (!isShellExecutorUnavailableResult(result)) return result;
  if (!looksLikeInfoSearchRequest(userMessage)) return result;

  const previousHint = String(result?.hint || '').trim();
  const normalizedQuery = String(userMessage || '').trim() || 'latest news';
  let fallback = null;
  let recoveredTarget = '';

  const _tryTool = async (toolName, params) => {
    try {
      const r = await toolCalling.executeTool(toolName, params, execContext);
      if (r && r.success) {
        recoveredTarget = toolName;
        return { ...r, success: true, _autoRecovered: true, _autoRecoveredFrom: 'shell_command', _autoRecoveredTarget: toolName };
      }
      fallback = r;
      return null;
    } catch (err) {
      fallback = { success: false, error: err.message || `${toolName} failed` };
      return null;
    }
  };

  const webRecovered = await _tryTool('web_search', { query: normalizedQuery });
  if (webRecovered) return webRecovered;

  const searchRecovered = await _tryTool('search', { keyword: normalizedQuery });
  if (searchRecovered) return searchRecovered;

  if (/(工具|命令|command|tool)/i.test(normalizedQuery)) {
    const toolRecovered = await _tryTool('toolSearch', { query: normalizedQuery });
    if (toolRecovered) return toolRecovered;
  }

  const fallbackErr = String(extractErrorTextFromResult(fallback) || fallback?.hint || 'web_search/search fallback failed').trim();
  const failHint = `Auto-recovery web_search/search fallback failed: ${fallbackErr}`;
  return { ...result, hint: previousHint ? `${previousHint} ${failHint}` : failHint, _autoRecoveredTarget: recoveredTarget || null };
}

// ── Tool call log scanning ───────────────────────────────────────────

function findLatestSuccessfulOpenAppEntry(toolCallLog = []) {
  if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) return null;
  for (let i = toolCallLog.length - 1; i >= 0; i--) {
    const entry = toolCallLog[i];
    const tool = String(entry?.tool || '').trim().toLowerCase();
    if (!entry?.result?.success) continue;
    if (tool === 'open_app' || tool === 'openapp') return entry;
    if (isShellToolName(tool) && entry.result?._autoRecoveredTarget) return entry;
  }
  return null;
}

function findLatestFailedOpenAppEntry(toolCallLog = []) {
  if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) return null;
  for (let i = toolCallLog.length - 1; i >= 0; i--) {
    const entry = toolCallLog[i];
    const tool = String(entry?.tool || '').trim().toLowerCase();
    if (tool !== 'open_app' && tool !== 'openapp') continue;
    if (entry?.result?.success) continue;
    return entry;
  }
  return null;
}

function findLatestShellExecutorUnavailableEntry(toolCallLog = []) {
  if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) return null;
  for (let i = toolCallLog.length - 1; i >= 0; i--) {
    const entry = toolCallLog[i];
    if (!entry || !isShellToolName(entry.tool)) continue;
    if (isShellExecutorUnavailableResult(entry.result)) return entry;
  }
  return null;
}

function buildAppLaunchRecoveryCandidates(userMessage = '', shellEntry = null) {
  const candidates = [];
  const msgTarget = extractAppTargetFromUserMessage(userMessage);
  if (msgTarget) candidates.push(msgTarget);
  const shellCommand = String(shellEntry?.params?.command || '').trim();
  if (shellCommand) candidates.push(...extractAppCandidatesFromShellCommand(shellCommand));
  return [...new Set(candidates.map(v => String(v || '').trim()).filter(Boolean))];
}

async function recoverOpenAppAfterAiInterruption(aiResult = {}, userMessage = '', toolCallLog = [], execContext = {}) {
  const errorType = String(aiResult?.errorType || '').trim().toLowerCase();
  if (!['process', 'cancelled', 'timeout', 'network', 'unknown'].includes(errorType)) return null;
  if (!looksLikeAppLaunchRequest(userMessage)) return null;

  const interruptionText = `AI 通道在结果整理阶段中断（${errorType || 'unknown'}）。`;
  const succeededEntry = findLatestSuccessfulOpenAppEntry(toolCallLog);
  if (succeededEntry) {
    const output = String(succeededEntry.result?.output || '').trim();
    if (output) return `${output}\n\n${interruptionText}`;
    const appName = String(
      succeededEntry.params?.name || succeededEntry.result?._autoRecoveredTarget
      || extractAppTargetFromUserMessage(userMessage) || '目标应用'
    ).trim();
    return `已执行打开应用：${appName}。\n\n${interruptionText}`;
  }

  const failedOpenAppEntry = findLatestFailedOpenAppEntry(toolCallLog);
  if (failedOpenAppEntry) {
    const appName = String(failedOpenAppEntry.params?.name || extractAppTargetFromUserMessage(userMessage) || '目标应用').trim();
    const failureText = String(extractErrorTextFromResult(failedOpenAppEntry.result) || failedOpenAppEntry.result?.hint || 'open_app failed').trim();
    return `打开应用 ${appName} 失败：${failureText}\n\n${interruptionText}`;
  }

  const shellEntry = findLatestShellExecutorUnavailableEntry(toolCallLog);
  if (!shellEntry) return null;
  const candidates = buildAppLaunchRecoveryCandidates(userMessage, shellEntry);
  if (candidates.length === 0) return null;

  let toolCalling = null;
  try { toolCalling = require('./toolCalling'); } catch { return null; }

  let fallback = null;
  for (const appName of candidates) {
    try {
      fallback = await toolCalling.executeTool('open_app', { name: appName }, execContext);
    } catch (err) {
      fallback = { success: false, error: err.message || 'open_app failed' };
    }
    if (fallback && fallback.success) {
      const output = String(fallback.output || '').trim();
      return (output || `已执行打开应用：${appName}。`) + `\n\n${interruptionText}`;
    }
  }

  const candidateText = candidates[0];
  const failureText = String(extractErrorTextFromResult(fallback) || fallback?.hint || 'open_app fallback failed').trim();
  return `打开应用 ${candidateText} 失败：${failureText}\n\n${interruptionText}`;
}

// ── Shell-to-app rewriting ───────────────────────────────────────────

function rewriteShellCallsForAppLaunch(toolCalls = [], userMessage = '') {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return toolCalls;
  if (!looksLikeAppLaunchRequest(userMessage)) return toolCalls;

  return toolCalls.map((call) => {
    if (!call || call.legacy) return call;
    if (!isShellToolName(call.name)) return call;
    const command = String(call.params?.command || '').trim();
    if (!command || !looksLikeShellAppProbeCommand(command)) return call;

    const appName = extractAppTargetFromShellCommand(command) || extractAppTargetFromUserMessage(userMessage);
    if (!appName) return call;

    return { ...call, name: 'open_app', params: { name: appName }, _compatRewritten: true, _originalShellCommand: command };
  });
}

// ── Intent-based tool filtering ──────────────────────────────────────

function _matchBlockedToolConstraint(normalizedToolName = '', constraints = {}) {
  if (!normalizedToolName || !constraints) return '';
  if (constraints.disallowAllTools) return 'all_tools';
  const searchTools = new Set(['websearch', 'webfetch', 'search', 'searchweb']);
  if (constraints.disallowSearch && searchTools.has(normalizedToolName)) return 'search';
  const fileReadTools = new Set(['read', 'readfile', 'grep', 'glob', 'ls', 'gitstatus', 'gitdiff', 'gitlog', 'find', 'findfiles', 'explore', 'searchcontent']);
  if (constraints.disallowFileRead && fileReadTools.has(normalizedToolName)) return 'file_read';
  return '';
}

function filterToolCallsByIntent(toolCalls = [], userMessage = '', userConstraints = null) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { kept: toolCalls, removed: [], removedByConstraint: [], removedByIntent: [] };
  }

  const constraints = userConstraints && typeof userConstraints === 'object'
    ? userConstraints : extractUserToolConstraints(userMessage);
  const allowOpenApp = looksLikeAppLaunchRequest(userMessage);

  const kept = [];
  const removed = [];
  const removedByConstraint = [];
  const removedByIntent = [];
  for (const call of toolCalls) {
    const normalized = String(call?.name || '').toLowerCase().replace(/[\s_-]/g, '');
    const blockedReason = _matchBlockedToolConstraint(normalized, constraints);
    if (blockedReason) {
      const blocked = { ...call, _constraintReason: blockedReason };
      removed.push(blocked);
      removedByConstraint.push(blocked);
      continue;
    }
    if (!allowOpenApp && normalized === 'openapp' && !call._compatRewritten && !call._structured) {
      removed.push(call);
      removedByIntent.push(call);
    } else {
      kept.push(call);
    }
  }

  return { kept, removed, removedByConstraint, removedByIntent, constraints };
}

function buildConstraintRespectNudge(userMessage, previousReply, constraints = {}, blockedCalls = []) {
  const blockedTools = [...new Set((blockedCalls || []).map(call => String(call?.name || '').trim()).filter(Boolean))];
  const lines = [
    '[System follow-up: respect explicit user constraints]',
    'The previous response attempted blocked tool use.',
    'Respect the user constraint in the next response.',
  ];

  if (constraints.disallowAllTools) {
    lines.push('Do not emit any <tool_call> or tool_use blocks. Answer directly in natural language only.');
  } else {
    if (constraints.disallowSearch) lines.push('Do not use search or browsing tools.');
    if (constraints.disallowFileRead) lines.push('Do not read or scan files/directories.');
    lines.push('If another non-blocked tool is truly necessary, use only an allowed tool. Otherwise answer directly.');
  }

  lines.push('If the constraint prevents certainty, explain that limitation briefly and give the best direct answer.');
  if (blockedTools.length > 0) { lines.push(''); lines.push(`[Blocked tools]\n${blockedTools.join(', ')}`); }
  lines.push(''); lines.push(`[Original user request]\n${userMessage}`);
  lines.push(''); lines.push(`[Previous response]\n${previousReply}`);
  return lines.join('\n');
}

function buildConstraintFallbackReply(constraints = {}, blockedCalls = []) {
  const blockedTools = [...new Set((blockedCalls || []).map(call => String(call?.name || '').trim()).filter(Boolean))];
  const bans = [];
  if (constraints.disallowAllTools) bans.push('禁止调用任何工具');
  if (constraints.disallowSearch) bans.push('禁止搜索');
  if (constraints.disallowFileRead) bans.push('禁止读取文件');
  const banText = bans.length > 0 ? bans.join('、') : '存在显式工具限制';
  const toolText = blockedTools.length > 0 ? `（已拦截: ${blockedTools.join(', ')}）` : '';
  return `已按你的约束停止违规工具调用：${banText}${toolText}。当前回复未提供可直接展示的正文，因此无法在不违反约束的前提下继续自动展开。`;
}

module.exports = {
  normalizeAppTarget,
  extractErrorTextFromResult,
  isShellExecutorUnavailableResult,
  extractAppTargetFromShellCommand,
  extractAppCandidatesFromShellCommand,
  recoverOpenAppAfterShellFailure,
  recoverWebSearchAfterShellFailure,
  findLatestSuccessfulOpenAppEntry,
  findLatestFailedOpenAppEntry,
  findLatestShellExecutorUnavailableEntry,
  buildAppLaunchRecoveryCandidates,
  recoverOpenAppAfterAiInterruption,
  rewriteShellCallsForAppLaunch,
  filterToolCallsByIntent,
  buildConstraintRespectNudge,
  buildConstraintFallbackReply,
};
