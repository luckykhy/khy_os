/**
 * aiConversationOps.js — History manipulation, context compaction, and CLI command handlers.
 *
 * Extracted from the ai.js god-file. Houses clearHistory, compact/snip/rewind/summarize
 * operations, conversation stats, and the AI CLI sub-command handlers (status, config,
 * owner, tech, unrestricted).
 *
 * @module cli/aiConversationOps
 */
'use strict';

// ── Imports ──
const fs = require('fs');
const path = require('path');

let _chalk, _fmt;
const chalk = () => (_chalk ??= require('chalk').default || require('chalk'));
const fmt = () => (_fmt ??= require('./formatters'));

const { resolveMaxHistory } = require('../constants/chatHistoryDefaults');

const _chatState = require('./aiChatState');
const _localState = require('./aiLocalState');

// ── Deps (injected by host ai.js via setAiConversationOpsDeps) ──
const _deps = {};
function setAiConversationOpsDeps(d) {
  Object.assign(_deps, d);
}

// ── Constants ──
// 单一真源: constants/chatHistoryDefaults.js (KHY_MAX_HISTORY 可覆盖, 默认 160)。
// 复杂任务会跑几十轮工具循环, 80 条会把早期任务上下文静默丢弃 → 模型失忆推不动。
const MAX_HISTORY = resolveMaxHistory(process.env);
const ENV_PATH = process.env.KHY_ENV_FILE
  ? path.resolve(process.env.KHY_ENV_FILE)
  : path.resolve(__dirname, '../../.env');
const AI_UNRESTRICTED_ENV = 'KHY_AI_UNRESTRICTED';
const AI_TECH_DETAILS_ENV = 'KHY_AI_TECH_DETAILS';

// ── Env / Switch Helpers ──

function _envToBool(v) {
  const s = String(v || '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes' || s === 'y';
}

function _onOff(v) {
  return v ? chalk().green('ON') : chalk().dim('OFF');
}

function _markFailure() {
  if (!process.exitCode || process.exitCode === 0) {
    process.exitCode = 1;
  }
}

function _setEnvVar(key, value) {
  let envContent = '';
  try {
    envContent = fs.readFileSync(ENV_PATH, 'utf-8');
  } catch {
    /* no .env */
  }
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, line);
  } else {
    envContent = envContent.trimEnd() + '\n' + line + '\n';
  }
  fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
  process.env[key] = String(value);
}

function _getEnvVar(key) {
  const runtimeVal = process.env[key];
  if (runtimeVal !== undefined && String(runtimeVal).trim() !== '') {
    return String(runtimeVal).trim();
  }
  try {
    const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    const regex = new RegExp(`^${key}=(.*)$`, 'm');
    const match = envContent.match(regex);
    if (!match) {
      return '';
    }
    return String(match[1] || '')
      .trim()
      .replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

function _normalizeSwitchInput(options = {}, args = []) {
  const o = { ...options };
  const firstArg = String(args[0] || '').toLowerCase();
  if (firstArg === 'on') {
    o.on = true;
  }
  if (firstArg === 'off') {
    o.off = true;
  }
  if (firstArg === 'status') {
    o.status = true;
  }
  return o;
}

function _readSwitchStates() {
  const techEnabled = _envToBool(_getEnvVar(AI_TECH_DETAILS_ENV));
  const unrestrictedEnabled = _envToBool(_getEnvVar(AI_UNRESTRICTED_ENV));
  return { techEnabled, unrestrictedEnabled };
}

function _readOwnerControlStatus() {
  try {
    const owner = require('../services/ownerControlService');
    return owner.getOwnerControlStatus();
  } catch {
    return { configured: false, updatedAt: null, version: 1 };
  }
}

async function _askSecret(message) {
  const { promptCompat } = require('./uiPrompt');
  const { secret } = await promptCompat([
    {
      type: 'password',
      name: 'secret',
      message,
      mask: '*',
      validate: (v) => String(v || '').trim().length > 0 || 'Secret cannot be empty',
    },
  ]);
  return String(secret || '').trim();
}

async function _requireOwnerSecret(options = {}) {
  const owner = require('../services/ownerControlService');
  if (!owner.isOwnerControlConfigured()) {
    return {
      ok: false,
      error: 'Owner control is not initialized. Run: ai owner init',
    };
  }

  let secret = String(
    options.secret ||
      options.key ||
      options.token ||
      options.ownerSecret ||
      options['owner-secret'] ||
      ''
  ).trim();

  if (!secret && process.stdin.isTTY && process.stdout.isTTY) {
    try {
      secret = await _askSecret('Owner secret:');
    } catch {
      return { ok: false, error: 'Owner secret is required.' };
    }
  }

  if (!secret) {
    return {
      ok: false,
      error: 'Owner secret is required. Use --secret <value> or run in interactive terminal.',
    };
  }

  const verify = owner.verifyOwnerSecret(secret);
  if (!verify.ok) {
    return { ok: false, error: verify.error || 'Owner secret verification failed.' };
  }
  return { ok: true, secret };
}

// ── History / Context Operations ──

function maybeAutoCheckpointProgress(reason, folderNameHint) {
  try {
    let leaf;
    try {
      leaf = require('../services/domain/memory/memoryEngine/sessionCheckpoint.js');
    } catch {
      return false;
    }
    if (!leaf || typeof leaf.buildAutoCheckpoint !== 'function') {
      return false;
    }

    const messages = Array.isArray(_chatState.messages) ? _chatState.messages : [];
    if (messages.length === 0) {
      return false;
    }

    let folderName = '';
    try {
      folderName =
        String(
          folderNameHint !== undefined &&
            folderNameHint !== null &&
            String(folderNameHint).trim() !== ''
            ? folderNameHint
            : path.basename(process.cwd())
        ).trim() || '';
    } catch {
      folderName = '';
    }

    const entry = leaf.buildAutoCheckpoint({
      messages,
      studyMode: _chatState.studyMode === true,
      folderName,
      env: process.env,
    });
    if (!entry || !entry.topic || !entry.covered) {
      return false;
    }

    const sig = `${entry.topic} ${entry.covered}`;
    if (sig === _localState.lastAutoCheckpointSig) {
      return false;
    }

    let memdir;
    try {
      memdir = require('../memdir/memdir');
    } catch {
      return false;
    }
    if (!memdir || typeof memdir.appendProjectProgress !== 'function') {
      return false;
    }
    const res = memdir.appendProjectProgress(entry);
    if (res && res.ok) {
      _localState.lastAutoCheckpointSig = sig;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function clearHistory() {
  // 先于清空历史做「会话结束自动检查点」安全网(蒸馏需要 _chatState.messages 尚在)。
  try {
    maybeAutoCheckpointProgress('clearHistory');
  } catch {
    /* never blocks reset */
  }
  _chatState.messages = [];
  _chatState.gatewayPreflightDone = false;
  _chatState.gatewayPreflightInFlight = null;
  _localState.localWarmupAttemptedAdapters = new Set();
  _localState.localWarmupInFlight = new Map();
  _chatState.pendingTaskGuard = null;
  _chatState.lastSubstantivePrompt = '';
  _chatState.lastSubstantiveAt = 0;
  _localState.liveSessionId = null; // next turn starts a fresh ~/.khy/sessions transcript
  // Drop any ephemeral role overlay (DESIGN-ARCH-059 #3)
  try {
    require('../services/roleService').clearActiveRole();
  } catch {
    /* optional */
  }
  // Forget short-term session memory (layer 1, point 5)
  try {
    require('../services/memoryEngine').sessionMemory.clear();
  } catch {
    /* optional */
  }
}

function _normalizeSummaryText(text = '', maxLen = 220) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
  if (!s) {
    return '';
  }
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, Math.max(16, maxLen - 1))}…`;
}

function getConversationStats() {
  const stats = {
    totalMessages: _chatState.messages.length,
    userMessages: 0,
    assistantMessages: 0,
    toolMessages: 0,
    systemMessages: 0,
    otherMessages: 0,
    effort: _chatState.currentEffort,
    studyMode: _chatState.studyMode,
  };

  let _htMod = null;
  try {
    _htMod = require('./messagePredicates');
  } catch {
    _htMod = null;
  }
  const _htOn = !!_htMod && _htMod.humanTurnCountEnabled(process.env);
  for (const msg of _chatState.messages) {
    const role = String(msg?.role || '').toLowerCase();
    if (role === 'user') {
      if (_htOn) {
        const kind = _htMod.userMessageKind(msg);
        if (kind === 'tool') {
          stats.toolMessages += 1;
        } else if (kind === 'meta') {
          stats.otherMessages += 1;
        } else {
          stats.userMessages += 1;
        }
      } else {
        stats.userMessages += 1;
      }
    } else if (role === 'assistant') {
      stats.assistantMessages += 1;
    } else if (role === 'tool') {
      stats.toolMessages += 1;
    } else if (role === 'system') {
      stats.systemMessages += 1;
    } else {
      stats.otherMessages += 1;
    }
  }

  return stats;
}

function getConversation() {
  return _chatState.messages.map((msg) => ({ ...msg }));
}

// ── Turn history snapshot / writeback (tool-use loop continuity) ──

/**
 * Snapshot the authoritative history tail right before a tool-use loop turn
 * starts (before the loop's first chat() call pushes the user message).
 * The returned token is consumed by reconcileTurnHistory() after the loop ends.
 */
function snapshotHistoryTurn() {
  return {
    length: _chatState.messages.length,
    last:
      _chatState.messages.length > 0 ? _chatState.messages[_chatState.messages.length - 1] : null,
  };
}

/**
 * Ensure the finished tool-loop turn is present in the authoritative history
 * exactly once, so the NEXT turn's initialMessages carry this round.
 *
 * chat() already commits user/assistant pairs on the normal path; this is a
 * repair pass for loop-terminal paths that bypassed those pushes (unexpected
 * chat error, empty-reply un-commit, hook/budget stops before any push):
 *  - an assistant message exists after the snapshot boundary → no-op;
 *  - orphan user (pushed but never paired) → append the assistant reply only;
 *  - no trace of the turn at all → append the user + assistant pair.
 *
 * Duplicate-safe by construction: the snapshot boundary is located by object
 * identity (not text equality — chat() may store a purified variant of the
 * user text), and only provably missing messages are appended.
 *
 * @param {{length:number,last:object|null}} snapshot  token from snapshotHistoryTurn()
 * @param {string} userText       this turn's verbatim user input
 * @param {string} assistantText  the loop's final text reply
 * @returns {{appended:number,reason:string}}
 */
function reconcileTurnHistory(snapshot, userText, assistantText) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { appended: 0, reason: 'no_snapshot' };
  }
  const msgs = _chatState.messages;
  // Locate the snapshot anchor by reference. MAX_HISTORY trims use slice()
  // (references preserved), so a missing anchor means it was trimmed away —
  // fall back to boundary -1, where the pre-existing assistant messages make
  // the check below a safe no-op instead of a duplicate append.
  let boundary = -1;
  if (snapshot.last) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] === snapshot.last) {
        boundary = i;
        break;
      }
    }
  }
  const turnTail = msgs.slice(boundary + 1);
  if (turnTail.some((m) => m && m.role === 'assistant')) {
    return { appended: 0, reason: 'already_committed' };
  }
  const finalAssistant = String(assistantText || '').trim();
  if (!finalAssistant) {
    return { appended: 0, reason: 'empty_final_reply' };
  }
  let appended = 0;
  const hasUser = turnTail.some((m) => m && m.role === 'user');
  if (!hasUser) {
    const cleanUser = String(userText || '').trim();
    if (cleanUser) {
      msgs.push({ role: 'user', content: cleanUser });
      appended += 1;
    }
  }
  msgs.push({ role: 'assistant', content: finalAssistant });
  appended += 1;
  if (_chatState.messages.length > MAX_HISTORY) {
    _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);
  }
  return { appended, reason: hasUser ? 'paired_orphan_user' : 'committed_missing_turn' };
}

function _messageHasToolUse(msg) {
  const c = msg && msg.content;
  return Array.isArray(c) && c.some((b) => b && b.type === 'tool_use');
}

function snipConversation(options = {}) {
  const previousCount = _chatState.messages.length;
  const done = (changed, mode) => ({
    success: true,
    changed,
    previousCount,
    nextCount: _chatState.messages.length,
    removedCount: previousCount - _chatState.messages.length,
    mode,
  });

  if (previousCount === 0) {
    return done(false, 'empty');
  }

  let mode;
  if (Array.isArray(options.range) && options.range.length === 2) {
    const a = Math.floor(Number(options.range[0]));
    const b = Math.floor(Number(options.range[1]));
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) {
      return {
        success: false,
        changed: false,
        previousCount,
        nextCount: previousCount,
        removedCount: 0,
        mode: 'invalid-range',
        error: '无效区间，用法: snip <起>-<止>（1 起始，含端点）',
      };
    }
    const start = a - 1;
    if (start >= previousCount) {
      return done(false, 'out-of-range');
    }
    const end = Math.min(b, previousCount);
    _chatState.messages.splice(start, end - start);
    mode = 'range';
  } else if (Number.isFinite(Number(options.count)) && Number(options.count) > 0) {
    const count = Math.min(Math.floor(Number(options.count)), previousCount);
    _chatState.messages.splice(previousCount - count, count);
    mode = 'count';
  } else {
    let idx = -1;
    for (let i = _chatState.messages.length - 1; i >= 0; i--) {
      if (String(_chatState.messages[i]?.role || '').toLowerCase() === 'user') {
        idx = i;
        break;
      }
    }
    const from = idx >= 0 ? idx : Math.max(0, _chatState.messages.length - 1);
    _chatState.messages.splice(from);
    mode = 'turn';
  }

  // Tidy: drop a now-trailing assistant message that carries unresolved tool_use
  while (
    _chatState.messages.length > 0 &&
    String(_chatState.messages[_chatState.messages.length - 1].role || '').toLowerCase() ===
      'assistant' &&
    _messageHasToolUse(_chatState.messages[_chatState.messages.length - 1])
  ) {
    _chatState.messages.pop();
  }

  return done(_chatState.messages.length !== previousCount, mode);
}

function rewindToUserTurn(nFromEnd) {
  const previousCount = _chatState.messages.length;
  const n = Math.floor(Number(nFromEnd));
  if (!Number.isFinite(n) || n < 1) {
    return {
      success: false,
      changed: false,
      previousCount,
      nextCount: previousCount,
      removedCount: 0,
      mode: 'invalid',
      error: '无效轮次序号,须为 >= 1 的整数(1 = 最近一条用户消息)',
    };
  }
  const userIdx = [];
  for (let i = 0; i < _chatState.messages.length; i++) {
    if (
      String((_chatState.messages[i] && _chatState.messages[i].role) || '').toLowerCase() === 'user'
    ) {
      userIdx.push(i);
    }
  }
  if (n > userIdx.length) {
    return {
      success: false,
      changed: false,
      previousCount,
      nextCount: previousCount,
      removedCount: 0,
      mode: 'out-of-range',
      error: `仅有 ${userIdx.length} 条用户消息,无法回溯到第 ${n} 条`,
    };
  }
  const from = userIdx[userIdx.length - n];
  return snipConversation({ range: [from + 1, _chatState.messages.length] });
}

function _buildSegmentSummary(segment, options = {}) {
  const focus = _normalizeSummaryText(options.instructions || options.focus || '', 300);
  const MAX_POINT_CHARS = 220;
  const MAX_ITEMS = 8;
  const MAX_SUMMARY_CHARS = 4000;
  const toText = (c) => {
    try {
      return require('../services/contentBlockUtils').contentToText(c);
    } catch {
      return String(c || '');
    }
  };
  const userPoints = [];
  const assistantPoints = [];
  const toolPoints = [];
  const pushUnique = (arr, text, limit) => {
    if (!text || arr.length >= limit) {
      return;
    }
    if (arr.includes(text)) {
      return;
    }
    arr.push(text);
  };
  for (const msg of Array.isArray(segment) ? segment : []) {
    const role = String((msg && msg.role) || '').toLowerCase();
    const normalized = _normalizeSummaryText(toText(msg && msg.content), MAX_POINT_CHARS);
    if (!normalized) {
      continue;
    }
    if (role === 'user') {
      pushUnique(userPoints, normalized, MAX_ITEMS);
    } else if (role === 'assistant') {
      pushUnique(assistantPoints, normalized, MAX_ITEMS);
    } else if (role === 'tool') {
      pushUnique(toolPoints, normalized, Math.ceil(MAX_ITEMS / 2));
    }
  }
  const lines = [];
  lines.push(`[SummarizeFromHere @ ${new Date().toISOString()}]`);
  lines.push(
    `Summarized ${Array.isArray(segment) ? segment.length : 0} message(s) from the selected turn onward.`
  );
  if (focus) {
    lines.push(`Focus priority: ${focus}`);
  }
  if (userPoints.length) {
    lines.push('');
    lines.push('User requests in this range:');
    userPoints.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  if (assistantPoints.length) {
    lines.push('');
    lines.push('Assistant actions/conclusions in this range:');
    assistantPoints.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  if (toolPoints.length) {
    lines.push('');
    lines.push('Tool outcomes in this range:');
    toolPoints.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  lines.push('');
  lines.push(
    'Treat this as authoritative memory for the summarized turns; do not re-ask settled points.'
  );
  let summary = lines.join('\n').trim();
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
  }
  return summary;
}

function summarizeFromUserTurn(nFromEnd, options = {}) {
  const previousCount = _chatState.messages.length;
  const n = Math.floor(Number(nFromEnd));
  if (!Number.isFinite(n) || n < 1) {
    return {
      success: false,
      changed: false,
      previousCount,
      nextCount: previousCount,
      summarizedCount: 0,
      mode: 'invalid',
      error: '无效轮次序号,须为 >= 1 的整数(1 = 最近一条用户消息)',
    };
  }
  const userIdx = [];
  for (let i = 0; i < _chatState.messages.length; i++) {
    if (
      String((_chatState.messages[i] && _chatState.messages[i].role) || '').toLowerCase() === 'user'
    ) {
      userIdx.push(i);
    }
  }
  if (n > userIdx.length) {
    return {
      success: false,
      changed: false,
      previousCount,
      nextCount: previousCount,
      summarizedCount: 0,
      mode: 'out-of-range',
      error: `仅有 ${userIdx.length} 条用户消息,无法回溯到第 ${n} 条`,
    };
  }
  const from = userIdx[userIdx.length - n];
  const kept = _chatState.messages.slice(0, from);
  const toSummarize = _chatState.messages.slice(from);
  if (toSummarize.length === 0) {
    return {
      success: true,
      changed: false,
      summarized: false,
      previousCount,
      nextCount: previousCount,
      summarizedCount: 0,
      mode: 'none',
    };
  }

  const summary = _buildSegmentSummary(toSummarize, options);
  const lastKeptRole = String(
    kept.length ? kept[kept.length - 1] && kept[kept.length - 1].role : ''
  ).toLowerCase();
  if (lastKeptRole === 'user') {
    _chatState.messages = [...kept, { role: 'assistant', content: summary }];
  } else {
    _chatState.messages = [
      ...kept,
      { role: 'user', content: summary },
      { role: 'assistant', content: '好的，我已了解此处之后的对话摘要，继续处理你的请求。' },
    ];
  }
  if (_chatState.messages.length > MAX_HISTORY) {
    _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);
  }

  return {
    success: true,
    changed: true,
    summarized: true,
    previousCount,
    nextCount: _chatState.messages.length,
    summarizedCount: toSummarize.length,
    mode: 'summarize',
    summaryChars: summary.length,
  };
}

function getContextLimit(modelHint = '') {
  const hint = String(modelHint || '').trim() || _deps._guessModelHint();
  return _deps._resolveModelContextLimit(hint);
}

function compactConversation(options = {}) {
  return compactHistory(options);
}

function compactHistory(options = {}) {
  const previousCount = _chatState.messages.length;
  const keepRecent = Math.max(
    4,
    Math.min(
      40,
      Number.isFinite(Number(options.keepRecent)) ? Math.floor(Number(options.keepRecent)) : 12
    )
  );
  const focus = _normalizeSummaryText(options.instructions || options.focus || '', 300);

  if (previousCount <= keepRecent + 1) {
    return {
      success: true,
      changed: false,
      previousCount,
      nextCount: previousCount,
      compactedCount: 0,
      keepRecent,
      mode: 'none',
    };
  }

  const modeConfigs = {
    light: {
      maxItems: 4,
      maxToolItems: 2,
      maxPointChars: 160,
      maxSummaryChars: 2400,
      continuityHint: 'Prefer concise continuation and ask for missing details early.',
    },
    balanced: {
      maxItems: 6,
      maxToolItems: 3,
      maxPointChars: 220,
      maxSummaryChars: 3800,
      continuityHint: 'Continue from established decisions and prioritize recent constraints.',
    },
    aggressive: {
      maxItems: 10,
      maxToolItems: 5,
      maxPointChars: 300,
      maxSummaryChars: 6200,
      continuityHint:
        'Retain as much decision history as possible and avoid re-asking settled topics.',
    },
  };

  let mode = String(options.mode || 'balanced')
    .trim()
    .toLowerCase();
  if (mode === 'auto') {
    if (previousCount >= 60 || keepRecent <= 8) {
      mode = 'aggressive';
    } else if (previousCount >= 28) {
      mode = 'balanced';
    } else {
      mode = 'light';
    }
  }
  if (!modeConfigs[mode]) {
    mode = 'balanced';
  }
  const cfg = modeConfigs[mode];

  const boundary = Math.max(0, previousCount - keepRecent);
  const toCompact = _chatState.messages.slice(0, boundary);
  const keepTail = _chatState.messages.slice(boundary);

  const userPoints = [];
  const assistantPoints = [];
  const toolPoints = [];

  const pushUnique = (arr, text, limit) => {
    if (!text || arr.length >= limit) {
      return;
    }
    if (arr.includes(text)) {
      return;
    }
    arr.push(text);
  };

  for (const msg of [...toCompact].reverse()) {
    const role = String(msg?.role || '').toLowerCase();
    const normalized = _normalizeSummaryText(
      (() => {
        try {
          return require('../services/contentBlockUtils').contentToText(msg?.content);
        } catch {
          return String(msg?.content || '');
        }
      })(),
      cfg.maxPointChars
    );
    if (!normalized) {
      continue;
    }

    if (role === 'user') {
      pushUnique(userPoints, normalized, cfg.maxItems);
      continue;
    }
    if (role === 'assistant') {
      pushUnique(assistantPoints, normalized, cfg.maxItems);
      continue;
    }
    if (role === 'tool') {
      pushUnique(toolPoints, normalized, cfg.maxToolItems);
    }
  }

  const latestTailUser = [...keepTail]
    .reverse()
    .find((m) => String(m?.role || '').toLowerCase() === 'user');
  const latestTailAssistant = [...keepTail]
    .reverse()
    .find((m) => String(m?.role || '').toLowerCase() === 'assistant');

  const lines = [];
  lines.push(`[ContextCompact v2 @ ${new Date().toISOString()}]`);
  lines.push(
    `Mode: ${mode}. Compacted: ${toCompact.length}. Kept recent turns: ${keepTail.length}.`
  );
  lines.push(`Continuation rule: ${cfg.continuityHint}`);
  if (focus) {
    lines.push(`Focus priority: ${focus}`);
  }

  if (userPoints.length > 0) {
    lines.push('');
    lines.push('Primary user goals already discussed:');
    userPoints.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
  }

  if (assistantPoints.length > 0) {
    lines.push('');
    lines.push('Established assistant conclusions/actions:');
    assistantPoints.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
  }

  if (toolPoints.length > 0) {
    lines.push('');
    lines.push('Tool outcomes worth retaining:');
    toolPoints.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
  }

  lines.push('');
  lines.push('Pending context to resume immediately:');
  if (latestTailUser) {
    lines.push(
      `- Latest user turn: ${_normalizeSummaryText(
        (() => {
          try {
            return require('../services/contentBlockUtils').contentToText(latestTailUser.content);
          } catch {
            return String(latestTailUser.content || '');
          }
        })(),
        260
      )}`
    );
  }
  if (latestTailAssistant) {
    lines.push(
      `- Latest assistant turn: ${_normalizeSummaryText(
        (() => {
          try {
            return require('../services/contentBlockUtils').contentToText(
              latestTailAssistant.content
            );
          } catch {
            return String(latestTailAssistant.content || '');
          }
        })(),
        260
      )}`
    );
  }
  if (!latestTailUser && !latestTailAssistant) {
    lines.push('- No recent tail content was available.');
  }

  if (_chatState.lastSubstantivePrompt) {
    lines.push('');
    lines.push('Active task anchor (verbatim user request):');
    lines.push(`"${_chatState.lastSubstantivePrompt.slice(0, 400)}"`);
  }

  lines.push('');
  lines.push('Resume instructions:');
  lines.push('1. Treat this compact block as authoritative memory for earlier turns.');
  lines.push('2. Do not re-ask solved questions unless user explicitly reopens them.');
  lines.push('3. Prioritize recent tail turns over older compacted bullets when conflicts appear.');

  let summary = lines.join('\n').trim();
  if (summary.length > cfg.maxSummaryChars) {
    summary = `${summary.slice(0, cfg.maxSummaryChars - 1)}…`;
  }

  const summaryMsg = { role: 'user', content: summary };

  const firstKept = keepTail[0];
  const firstKeptRole = String(firstKept?.role || '').toLowerCase();
  if (firstKeptRole === 'user') {
    _chatState.messages = [
      summaryMsg,
      { role: 'assistant', content: '好的，我已了解上下文，继续处理你的请求。' },
      ...keepTail,
    ];
  } else {
    _chatState.messages = [summaryMsg, ...keepTail];
  }
  if (_chatState.messages.length > MAX_HISTORY) {
    _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);
  }

  return {
    success: true,
    changed: true,
    previousCount,
    nextCount: _chatState.messages.length,
    compactedCount: toCompact.length,
    keepRecent,
    mode,
    summaryChars: summary.length,
  };
}

// ── CLI Command Handlers ──

async function handleAiStatus(options = {}) {
  const { printSuccess, printError, printInfo, withSpinner } = fmt();
  const quick = !!options.quick;
  const status = _deps.getAiStatus();
  const switchStates = _readSwitchStates();
  const ownerStatus = _readOwnerControlStatus();

  if (status.available) {
    printSuccess(`AI 服务可用 — ${status.provider}`);
    if (status.configuredProviders.length > 1) {
      printInfo(
        `已配置 ${status.configuredProviders.length} 个提供商: ${status.configuredProviders.join(', ')}`
      );
    }
    if (!quick) {
      const svc = _deps.getService();
      const test = await withSpinner('测试 AI 连接...', () => svc.testConnection());
      if (test.success) {
        printSuccess(`连接正常 (${test.provider})`);
      } else {
        printError('连接测试失败');
      }
    } else {
      printInfo('快速状态模式：已跳过实时连通性测试');
    }
  } else {
    printError('未配置 AI 密钥');
    printInfo('运行 ai config 配置 API 密钥');
    try {
      const hint = require('../services/gateway/gatewayGuide').guideHintLine();
      if (hint) {
        printInfo(hint);
      }
    } catch {
      /* hint optional */
    }
  }

  console.log('');
  printTable(
    ['开关', '状态'],
    [
      ['技术细节', _onOff(switchStates.techEnabled)],
      ['开放模式', _onOff(switchStates.unrestrictedEnabled)],
      [
        'Owner 控制',
        ownerStatus.configured
          ? chalk().green('CONFIGURED')
          : chalk().yellow('NOT CONFIGURED'),
      ],
      [
        'Owner 更新',
        ownerStatus.updatedAt
          ? new Date(ownerStatus.updatedAt).toLocaleString('zh-CN')
          : '-',
      ],
    ]
  );
  if (!ownerStatus.configured) {
    printInfo('建议先运行 ai owner init 初始化 Owner Secret，再使用 ai tech/ai unrestricted');
  }
}

async function handleAiConfig() {
  fmt().printInfo('此命令已迁移到 khy gateway config，正在跳转...');
  const { handleGatewayConfig } = require('./handlers/gateway');
  await handleGatewayConfig();
}

async function handleAiOwner(action = 'status', options = {}) {
  const { printSuccess, printError, printInfo } = fmt();
  const owner = require('../services/ownerControlService');
  const cmd = String(action || 'status').toLowerCase();

  if (cmd === 'status') {
    const st = owner.getOwnerControlStatus();
    printTable(
      ['指标', '值'],
      [
        [
          'Owner 控制',
          st.configured
            ? chalk().green('CONFIGURED')
            : chalk().yellow('NOT CONFIGURED'),
        ],
        [
          '最近更新',
          st.updatedAt
            ? new Date(st.updatedAt).toLocaleString('zh-CN')
            : '-',
        ],
      ]
    );
    if (!st.configured) {
      printInfo('运行 ai owner init 初始化 Owner Secret');
    }
    return;
  }

  if (cmd === 'init') {
    if (owner.isOwnerControlConfigured()) {
      printError('Owner 控制已初始化。若要更换请使用 ai owner rotate');
      _markFailure();
      return;
    }

    let secret = String(options.secret || options.key || '').trim();
    let confirm = String(options.confirm || '').trim();
    if (!secret) {
      secret = await _askSecret('Set owner secret (at least 8 chars):');
    }
    if (!confirm) {
      confirm = await _askSecret('Confirm owner secret:');
    }
    if (secret !== confirm) {
      printError('Secret confirmation mismatch.');
      _markFailure();
      return;
    }

    const result = owner.initializeOwnerControl(secret);
    if (!result.ok) {
      printError(result.error || 'Owner control initialization failed.');
      _markFailure();
      return;
    }
    printSuccess('Owner control initialized.');
    printInfo('后续敏感开关操作需要 Owner Secret 验证。');
    return;
  }

  if (cmd === 'rotate') {
    const verify = await _requireOwnerSecret(options);
    if (!verify.ok) {
      printError(verify.error);
      _markFailure();
      return;
    }

    let nextSecret = String(options.next || options.new || '').trim();
    let confirm = String(options.confirm || '').trim();
    if (!nextSecret) {
      nextSecret = await _askSecret('New owner secret (at least 8 chars):');
    }
    if (!confirm) {
      confirm = await _askSecret('Confirm new owner secret:');
    }
    if (nextSecret !== confirm) {
      printError('New secret confirmation mismatch.');
      _markFailure();
      return;
    }

    const rotated = owner.rotateOwnerSecret(verify.secret, nextSecret);
    if (!rotated.ok) {
      printError(rotated.error || 'Owner secret rotate failed.');
      _markFailure();
      return;
    }
    printSuccess('Owner secret rotated.');
    return;
  }

  printError('用法: ai owner status | ai owner init | ai owner rotate');
  _markFailure();
}

async function handleAiTech(options = {}, args = []) {
  const { printSuccess, printError, printInfo, printWarn } = fmt();
  const opts = _normalizeSwitchInput(options, args);
  const { techEnabled } = _readSwitchStates();

  if (!!opts.on === !!opts.off) {
    if (opts.status || (!opts.on && !opts.off)) {
      printInfo(`技术细节开关当前状态: ${_onOff(techEnabled)}`);
      if (!techEnabled) {
        printInfo('开启后可回答项目架构与实现细节。');
      }
      return;
    }
    printError('用法: ai tech --on | ai tech --off | ai tech --status');
    _markFailure();
    return;
  }

  const verify = await _requireOwnerSecret(opts);
  if (!verify.ok) {
    printError(verify.error);
    _markFailure();
    return;
  }

  const nextVal = opts.on ? 'true' : 'false';
  _setEnvVar(AI_TECH_DETAILS_ENV, nextVal);
  printSuccess(`技术细节开关已${opts.on ? '开启' : '关闭'} (${AI_TECH_DETAILS_ENV}=${nextVal})`);
  if (opts.on) {
    printWarn('技术细节模式已开启，AI 可回答项目实现细节；上线发布前建议关闭。');
  } else {
    printInfo('生产发布建议：保持技术细节开关关闭。');
  }
}

async function handleAiUnrestricted(options = {}, args = []) {
  const { printSuccess, printError, printInfo, printWarn } = fmt();
  const opts = _normalizeSwitchInput(options, args);
  const { unrestrictedEnabled } = _readSwitchStates();

  if (!!opts.on === !!opts.off) {
    if (opts.status || (!opts.on && !opts.off)) {
      printInfo(`开放模式当前状态: ${_onOff(unrestrictedEnabled)}`);
      return;
    }
    printError('用法: ai unrestricted --on | ai unrestricted --off | ai unrestricted --status');
    _markFailure();
    return;
  }

  const verify = await _requireOwnerSecret(opts);
  if (!verify.ok) {
    printError(verify.error);
    _markFailure();
    return;
  }

  const nextVal = opts.on ? 'true' : 'false';
  _setEnvVar(AI_UNRESTRICTED_ENV, nextVal);
  printSuccess(`开放模式已${opts.on ? '开启' : '关闭'} (${AI_UNRESTRICTED_ENV}=${nextVal})`);
  if (opts.on) {
    printWarn('开放模式会放宽安全拦截，请仅在受控环境临时使用。');
  } else {
    printInfo('标准安全策略已恢复。');
  }
}

// ── Exports ──
module.exports = {
  setAiConversationOpsDeps,
  maybeAutoCheckpointProgress,
  clearHistory,
  getConversationStats,
  getConversation,
  snapshotHistoryTurn,
  reconcileTurnHistory,
  snipConversation,
  rewindToUserTurn,
  summarizeFromUserTurn,
  getContextLimit,
  compactConversation,
  compactHistory,
  handleAiStatus,
  handleAiConfig,
  handleAiOwner,
  handleAiTech,
  handleAiUnrestricted,
};
