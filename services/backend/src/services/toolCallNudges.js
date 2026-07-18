'use strict';

/**
 * Tool-call nudge builders — system follow-up prompts injected when
 * the AI fails to produce tool calls for actionable requests.
 *
 * Extracted from toolUseLoop.js (lines 4977-5064) as part of the
 * industrial-grade modularization (Phase 1B).
 *
 * Dependencies: none (pure string construction).
 */

function buildAppLaunchToolNudge(userMessage, previousReply) {
  return [
    '[System follow-up: app-launch intent detected]',
    'The user is asking to launch an application.',
    'Choose tools based on intent, not command probing.',
    'If launching is feasible, call open_app with the most likely app name inferred from user language.',
    'Use shell_command only after open_app fails and explain why.',
    '',
    '[Required next output]',
    '- Either output at least one <tool_call>...</tool_call> immediately,',
    '- Or explain a concrete runtime blocker (for example: no graphical session) with actionable next step.',
    '',
    `[Original user request]\n${userMessage}`,
    '',
    `[Previous response]\n${previousReply}`,
  ].join('\n');
}

/**
 * Build a nudge when the AI presented choices instead of acting.
 */
function buildChoiceResponseNudge(userMessage) {
  return [
    '[System: 不要列选项，直接执行]',
    '你刚才列出了选项让用户选择，这是错误的。',
    '自己选最合理的方案，立即用 <tool_call> 调用工具。',
    '',
    `[原始请求]\n${userMessage}`,
  ].join('\n');
}

/**
 * Build a one-shot continuation nudge when AI returns no tool calls.
 */
function buildNoToolCallNudge(userMessage, previousReply) {
  return [
    '[System follow-up: continue execution]',
    'The previous response looks like a progress note without tool execution.',
    'Continue immediately.',
    'Choose one path only:',
    '1) If actions are needed, output one or more <tool_call>...</tool_call> now.',
    '   You may also use natural format like: 【调用工具名：参数】.',
    '2) If no tool is needed, output the final complete answer now.',
    'Do not output another progress preface.',
    '',
    `[Original user request]\n${userMessage}`,
    '',
    `[Previous response]\n${previousReply}`,
  ].join('\n');
}

function buildWebSearchToolNudge(userMessage, previousReply) {
  return [
    '[System follow-up: web-search required]',
    'The user request likely needs current external information.',
    'In your next response, choose one path only:',
    '1) Call web_search immediately with a concrete query derived from the user request.',
    '2) If web_search is unavailable, explain the concrete blocker and provide a best-effort answer with uncertainty.',
    'Do not output another progress preface.',
    '',
    '[Required]',
    '- Prefer <tool_call>{"name":"web_search","params":{"query":"..."}}</tool_call>.',
    '- Query must be non-empty and specific.',
    '',
    `[Original user request]\n${userMessage}`,
    '',
    `[Previous response]\n${previousReply}`,
  ].join('\n');
}

function buildScaffoldToolNudge(userMessage, previousReply) {
  return [
    '[System follow-up: project scaffolding required]',
    'The user request is about creating project folders/files quickly.',
    'In your next response, choose one path only:',
    '1) Call scaffoldFiles now with root/directories/files and writeConcurrency.',
    '2) If scaffoldFiles is unavailable, call writeFile/editFile with a concrete ordered plan immediately.',
    'Do not output another progress preface.',
    '',
    '[Required]',
    '- Prefer <tool_call>{"name":"scaffoldFiles","params":{"root":"...","directories":[...],"files":[{"path":"...","content":"..."}],"writeConcurrency":4}}</tool_call>.',
    '- Use batch creation and parallel writes when creating many files.',
    '',
    `[Original user request]\n${userMessage}`,
    '',
    `[Previous response]\n${previousReply}`,
  ].join('\n');
}

module.exports = {
  buildAppLaunchToolNudge,
  buildChoiceResponseNudge,
  buildNoToolCallNudge,
  buildWebSearchToolNudge,
  buildScaffoldToolNudge,
};
