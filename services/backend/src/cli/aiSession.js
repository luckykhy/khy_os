/**
 * aiSession.js — Session persistence, conversation save/load/resume, and project memory.
 *
 * Extracted from the ai.js god-file. Houses the JSONL session transcript,
 * the legacy per-folder JSON conversation store, auto-resume time-segment
 * logic, project memory bootstrap, and the deterministic memory-capture
 * trigger.
 *
 * @module cli/aiSession
 */
'use strict';

// ── Imports ──
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const _chatState = require('./aiChatState');
const _localState = require('./aiLocalState');

// ── Deps (injected by host ai.js via setAiSessionDeps) ──
let _deps = {};
function setAiSessionDeps(d) { Object.assign(_deps, d); }

// ── Constants ──
const MAX_HISTORY = 80;
const GLOBAL_CONVO_DIR = path.join(os.homedir(), '.khyquant', 'conversations');
const MAX_SAVED_CONVERSATIONS = 50;
const DEFAULT_AUTO_RESUME_WINDOW_MIN = 180;
const DEFAULT_PROJECT_MEMORY_MAX_CHARS = 5000;
const PROJECT_MEMORY_CONTEXT_TAG = '[ProjectMemoryBootstrap v1]';
const DEFAULT_AUTO_RESUME_SEGMENT_MODE = 'period';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

// ── Session ID ──

function _generateSessionId() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fallthrough */ }
  const tsHex = Date.now().toString(16).slice(-12).padStart(12, '0');
  const rand = crypto.randomBytes(10).toString('hex'); // 20 chars
  return `${tsHex}-${rand.slice(0, 4)}-${rand.slice(4, 8)}-${rand.slice(8, 12)}-${rand.slice(12)}`;
}

function _ensureLiveSessionId() {
  if (!_localState.liveSessionId) _localState.liveSessionId = _generateSessionId();
  return _localState.liveSessionId;
}

function getLiveSessionId() {
  return _localState.liveSessionId;
}

// ── Persist Live Session ──

/**
 * Persist the live conversation to ~/.khy/sessions via sessionPersistence.
 * Writes an append-only JSONL transcript + JSON snapshot and refreshes the
 * search index. Best-effort: never throws into the chat flow.
 * Disable with KHY_DISABLE_SESSION_PERSIST=1.
 */
function _persistLiveSession() {
  if (process.env.KHY_DISABLE_SESSION_PERSIST === '1' || process.env.KHY_DISABLE_SESSION_PERSIST === 'true') {
    return;
  }
  if (!_chatState.messages || _chatState.messages.length === 0) return;
  try {
    const sp = require('../services/sessionPersistence');
    const info = _deps._getModelInfo();
    sp.persistSession(_ensureLiveSessionId(), {
      messages: _chatState.messages,
      model: info.model || '',
      metadata: { cwd: process.cwd(), adapter: info.adapter || '' },
    });
  } catch { /* persistence is best-effort */ }
}

// ── Interruption / Orphan Turn ──

/**
 * 刀105:把「本轮回复被用户中断」记进模型可见历史(_chatState.messages),对齐 CC 的
 * [Request interrupted by user]。ESC/`/i` 中断时 chat() 抛 AbortError 冒出、跳过结尾的
 * assistant push → 历史停在悬空 user 且无中断标记;下一句「改用 X」进来会成两条连续 user、
 * 模型无从得知上一轮被打断。本函数由 abort 检测点(useQueryBridge 的 aborted 分支等)调用,
 * 补一条 assistant 回合(部分回复 + 中断标记 / 仅标记)。
 *
 * 文案与门控由纯叶子 services/interruptionMarker 单一真源。fail-soft:任何异常都不抛。
 * 门控 KHY_INTERRUPT_MARKER 关 → 叶子返 null → 本函数 no-op(逐字节回退今日:不记录标记)。
 *
 * 竞态守卫:仅当历史最后一条是悬空的 user/tool 回合(本轮 assistant 从未落)才补标记,
 * 避免正常完成后误加或重复补标记。
 * @param {string} [partialText] 中断时已生成的部分回复(调用方从 liveRef 抓取注入)
 * @param {object} [env]
 * @returns {boolean} 是否记录了标记
 */
function recordInterruption(partialText, env = process.env) {
  try {
    const leaf = require('../services/interruptionMarker');
    const content = leaf.buildInterruptedAssistantContent(partialText, env);
    if (content == null) return false; // 门控关 → no-op(逐字节回退)
    const last = _chatState.messages.length ? _chatState.messages[_chatState.messages.length - 1] : null;
    const lastRole = String((last && last.role) || '').toLowerCase();
    if (lastRole !== 'user' && lastRole !== 'tool') return false; // 非悬空回合 → 不补
    _chatState.messages.push({ role: 'assistant', content });
    if (_chatState.messages.length > MAX_HISTORY) _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);
    try { _persistLiveSession(); } catch { /* best effort:持久化失败不影响本次记录 */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * Surgically un-commit the single message a failed `chat()` invocation appended
 * to the authoritative `_chatState.messages` history (DESIGN-ARCH-046).
 */
function _uncommitOrphanTurn(committedMsg) {
  if (!committedMsg) return;
  if (_chatState.messages.length > 0 && _chatState.messages[_chatState.messages.length - 1] === committedMsg) {
    _chatState.messages.pop();
  }
}

// ── Memory Capture ──

/**
 * Deterministically capture a memory from the user's input.
 * Best-effort: never throws into the chat flow. Respects KHY_DISABLE_MEMORY.
 */
function _maybeAutoSaveMemory(userMessage) {
  if (process.env.KHY_DISABLE_MEMORY === '1' || process.env.KHY_DISABLE_MEMORY === 'true') return false;

  let decision;
  try {
    decision = require('../services/memoryTrigger').classify(userMessage);
  } catch {
    return false;
  }
  if (!decision || decision.kind === 'none') return false;

  // instruction candidate → route to the instruction-file review queue (NOT the
  // memory store).
  if (decision.kind === 'instruction') {
    try {
      const note = String(decision.note || '').trim();
      if (!note) return false;
      const store = require('../services/instructionReviewStore');
      const res = store.enqueue({
        note,
        target: decision.target || 'khy',
        scope: decision.scope || 'project',
        source: 'auto',
      });
      return !!(res && res.success && !res.skipped);
    } catch {
      return false;
    }
  }

  const note = String(decision.note || '').trim();
  if (!note) return false;

  const title = note.split('\n')[0].slice(0, 40);
  const name = decision.name
    || (title.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '') || 'note').slice(0, 48);

  try {
    const engine = require('../services/memoryEngine');
    const res = engine.addStructuredMemory({
      type: decision.type || 'user',
      name,
      content: note,
      description: title,
      tier: decision.tier,
    });
    if (!(res && res.success)) return false;
    return {
      kind: 'memory',
      success: true,
      name,
      type: decision.type || 'user',
      tier: decision.tier,
      action: res.action,
      ephemeral: res.ephemeral === true,
    };
  } catch {
    return false;
  }
}

// ── Auto-Resume Time Helpers ──

function _getAutoResumeWindowMs() {
  const raw = parseInt(String(process.env.KHY_AUTO_RESUME_WINDOW_MIN || DEFAULT_AUTO_RESUME_WINDOW_MIN), 10);
  if (Number.isFinite(raw) && raw <= 0) return 0;
  const mins = Number.isFinite(raw) ? raw : DEFAULT_AUTO_RESUME_WINDOW_MIN;
  return Math.max(5, mins) * 60 * 1000;
}

function _getAutoResumeSegmentMode() {
  const raw = String(process.env.KHY_AUTO_RESUME_SEGMENT_MODE || DEFAULT_AUTO_RESUME_SEGMENT_MODE).trim().toLowerCase();
  if (!raw) return DEFAULT_AUTO_RESUME_SEGMENT_MODE;
  if (['off', 'none', 'disable', 'disabled', 'false', '0'].includes(raw)) return 'none';
  if (['ampm', 'am_pm', 'halfday', 'am-pm'].includes(raw)) return 'ampm';
  if (['period', 'daypart', 'timeslot', 'segment'].includes(raw)) return 'period';
  return DEFAULT_AUTO_RESUME_SEGMENT_MODE;
}

function _localDateKey(date) {
  const parts = _getDatePartsInTimezone(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function _periodBucket(date) {
  const parts = _getDatePartsInTimezone(date);
  const h = parts.hour;
  if (h < 6) return 'late-night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function _segmentKey(date, mode) {
  if (mode === 'ampm') {
    const parts = _getDatePartsInTimezone(date);
    return parts.hour < 12 ? 'am' : 'pm';
  }
  if (mode === 'period') return _periodBucket(date);
  return 'all';
}

function _getTimezoneForSession() {
  const tz = String(process.env.KHY_TIMEZONE || DEFAULT_TIMEZONE).trim();
  return tz || DEFAULT_TIMEZONE;
}

function _getDatePartsInTimezone(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const fallback = {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    hour: date.getHours(),
  };

  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: _getTimezoneForSession(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    const tokens = fmt.formatToParts(date);
    const byType = {};
    for (const token of tokens) byType[token.type] = token.value;
    const hour = parseInt(String(byType.hour || fallback.hour), 10);
    return {
      year: String(byType.year || fallback.year),
      month: String(byType.month || fallback.month).padStart(2, '0'),
      day: String(byType.day || fallback.day).padStart(2, '0'),
      hour: Number.isFinite(hour) ? hour : fallback.hour,
    };
  } catch {
    return fallback;
  }
}

function _isSameAutoResumeSegment(lastDate, nowDate) {
  const mode = _getAutoResumeSegmentMode();
  if (mode === 'none') return true;
  if (_localDateKey(lastDate) !== _localDateKey(nowDate)) return false;
  return _segmentKey(lastDate, mode) === _segmentKey(nowDate, mode);
}

// ── Project Memory ──

function _getProjectMemoryCandidates(cwd = process.cwd()) {
  const files = [];
  try {
    const { getMemoryDir, getProjectDir } = require('../services/projectMemoryService');
    const memoryDir = getMemoryDir(cwd);
    const projectDir = getProjectDir(cwd);
    files.push(path.join(memoryDir, 'memory.md'));
    files.push(path.join(memoryDir, 'MEMORY.md'));
    files.push(path.join(projectDir, 'memory.md'));
    files.push(path.join(projectDir, 'MEMORY.md'));
  } catch { /* ignore */ }
  try {
    const { getProjectDataHome } = require('../utils/dataHome');
    files.push(path.join(getProjectDataHome(), 'memory', 'MEMORY.md'));
  } catch {
    files.push(path.join(os.homedir(), '.khy', 'memory', 'MEMORY.md'));
  }
  return [...new Set(files)];
}

function loadProjectMemoryContext(options = {}) {
  try {
    const alreadyInjected = _chatState.messages.some((m) => (
      String(m?.role || '').toLowerCase() === 'tool'
      && String(m?.content || '').includes(PROJECT_MEMORY_CONTEXT_TAG)
    ));
    if (alreadyInjected && !options.force) {
      return { loaded: false, reason: 'already-loaded' };
    }

    const rawMaxChars = parseInt(String(process.env.KHY_PROJECT_MEMORY_MAX_CHARS || DEFAULT_PROJECT_MEMORY_MAX_CHARS), 10);
    const maxChars = Math.max(400, Number.isFinite(rawMaxChars) ? rawMaxChars : DEFAULT_PROJECT_MEMORY_MAX_CHARS);
    const cwd = options.cwd || process.cwd();
    const candidates = _getProjectMemoryCandidates(cwd);

    for (const filePath of candidates) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const content = String(fs.readFileSync(filePath, 'utf-8') || '').trim();
        if (!content) continue;

        const truncated = content.length > maxChars;
        const summary = truncated ? `${content.slice(0, maxChars)}\n\n[Memory truncated for context budget]` : content;
        const payload = [
          PROJECT_MEMORY_CONTEXT_TAG,
          `source: ${filePath}`,
          'Use this memory as background context. User latest explicit instructions always win.',
          '',
          summary,
        ].join('\n');

        if (options.prepend) _chatState.messages = [{ role: 'tool', content: payload }, ..._chatState.messages];
        else _chatState.messages.push({ role: 'tool', content: payload });
        if (_chatState.messages.length > MAX_HISTORY) _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);

        return {
          loaded: true,
          file: filePath,
          chars: Math.min(content.length, maxChars),
          truncated,
        };
      } catch { /* try next candidate */ }
    }
  } catch { /* ignore */ }

  return { loaded: false, reason: 'not-found' };
}

// ── Conversation Directory ──

/**
 * Get the per-folder conversation directory.
 */
function getConvoDir(cwd) {
  try {
    const { getProjectDir } = require('../services/projectMemoryService');
    const projDir = getProjectDir(cwd || process.cwd());
    const dir = path.join(projDir, 'conversations');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return GLOBAL_CONVO_DIR;
  }
}

// ── Save / Load / List / Find / Resume ──

function saveConversation() {
  if (_chatState.messages.length === 0) return { success: false, reason: 'empty' };
  try {
    const convoDir = getConvoDir();
    if (!fs.existsSync(convoDir)) fs.mkdirSync(convoDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const suffix = Math.random().toString(36).slice(2, 6);
    const filename = `${timestamp}-${suffix}.json`;
    const sessionId = _generateSessionId();

    const snapshotMessages = _chatState.messages.slice();
    const originalCount = snapshotMessages.length;
    let savedMessages = snapshotMessages;

    if (originalCount > 6) {
      const liveMessages = _chatState.messages;
      _chatState.messages = snapshotMessages;
      try {
        _deps.compactHistory({
          keepRecent: Math.min(6, Math.max(2, Math.floor(originalCount * 0.2))),
          mode: 'aggressive',
        });
        savedMessages = _chatState.messages;
      } finally {
        _chatState.messages = liveMessages;
      }
    }

    const data = {
      sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      messages: savedMessages,
      messageCount: savedMessages.length,
      originalMessageCount: originalCount,
    };
    const filePath = path.join(convoDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    const files = fs.readdirSync(convoDir).filter(f => f.endsWith('.json')).sort();
    while (files.length > MAX_SAVED_CONVERSATIONS) {
      fs.unlinkSync(path.join(convoDir, files.shift()));
    }
    _persistLiveSession();
    return {
      success: true,
      sessionId,
      file: filename,
      filePath,
      timestamp: data.timestamp,
      messageCount: data.messageCount,
    };
  } catch {
    return { success: false, reason: 'write_failed' };
  }
}

function loadLastConversation() {
  try {
    const convoDir = getConvoDir();
    if (!fs.existsSync(convoDir)) return null;
    const files = fs.readdirSync(convoDir).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) return null;
    const latest = fs.readFileSync(path.join(convoDir, files[files.length - 1]), 'utf-8');
    return JSON.parse(latest);
  } catch {
    return null;
  }
}

function listConversations() {
  try {
    const convoDir = getConvoDir();
    if (!fs.existsSync(convoDir)) return [];
    const files = fs.readdirSync(convoDir).filter(f => f.endsWith('.json')).sort().reverse();
    return files.map(file => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(convoDir, file), 'utf-8'));
        const sessionId = String(data.sessionId || '').trim() || String(file).replace(/\.json$/i, '');
        return {
          file,
          sessionId,
          timestamp: data.timestamp,
          messageCount: data.messageCount || data.messages?.length || 0,
        };
      } catch {
        return { file, sessionId: String(file).replace(/\.json$/i, ''), timestamp: '', messageCount: 0 };
      }
    });
  } catch {
    return [];
  }
}

function findConversationByRef(ref) {
  const key = String(ref || '').trim();
  if (!key) return null;
  const convos = listConversations();
  if (convos.length === 0) return null;

  const normalizedFile = key.endsWith('.json') ? key : `${key}.json`;
  const lower = key.toLowerCase();
  const lowerFile = normalizedFile.toLowerCase();

  let match = convos.find(c => c.file === key || c.file === normalizedFile || c.sessionId === key);
  if (match) return match;

  match = convos.find(c => {
    const sid = String(c.sessionId || '').toLowerCase();
    const file = String(c.file || '').toLowerCase();
    return sid === lower || file === lower || file === lowerFile;
  });
  if (match) return match;

  const sidPrefix = convos.filter(c => String(c.sessionId || '').toLowerCase().startsWith(lower));
  if (sidPrefix.length === 1) return sidPrefix[0];

  const filePrefix = convos.filter(c => String(c.file || '').replace(/\.json$/i, '').toLowerCase().startsWith(lower));
  if (filePrefix.length === 1) return filePrefix[0];

  return null;
}

function resumeConversation(file) {
  try {
    let data;
    if (file) {
      const convoDir = getConvoDir();
      data = JSON.parse(fs.readFileSync(path.join(convoDir, file), 'utf-8'));
    } else {
      data = loadLastConversation();
    }
    if (data && data.messages && data.messages.length > 0) {
      const rawMessages = data.messages.slice(-MAX_HISTORY);
      const originalCount = rawMessages.length;

      _chatState.messages = rawMessages;
      const compactResult = _deps.compactHistory({
        keepRecent: Math.min(4, Math.max(2, Math.floor(rawMessages.length * 0.15))),
        mode: 'aggressive',
      });

      return {
        success: true,
        messageCount: _chatState.messages.length,
        originalCount,
        compacted: compactResult.changed,
        timestamp: data.timestamp,
      };
    }
  } catch {}
  return { success: false };
}

function autoResumeLastSession() {
  try {
    const last = loadLastConversation();
    if (!last || !last.timestamp || !last.messages || last.messages.length === 0) return null;
    const lastAt = new Date(last.timestamp);
    if (!Number.isFinite(lastAt.getTime())) return null;
    const now = new Date();
    if (!_isSameAutoResumeSegment(lastAt, now)) return null;
    const elapsed = Date.now() - lastAt.getTime();
    const maxAge = _getAutoResumeWindowMs();
    if (maxAge <= 0) return null;
    if (elapsed > maxAge) return null;
    _chatState.messages = last.messages.slice(-MAX_HISTORY);
    // A5: 标记 session 恢复，防止 contextCompressor 立即重新压缩已压缩内容
    try { require('../services/contextCompressor').markSessionResumed(); } catch {}
    return { resumed: true, messageCount: _chatState.messages.length, timestamp: last.timestamp, cwd: last.cwd };
  } catch {
    return null;
  }
}

/**
 * Resume a persisted session from the rich JSONL store (~/.khy/sessions) into the
 * live conversation.
 */
function resumePersistedSession(sessionId, opts = {}) {
  if (!sessionId) return { success: false, error: 'EMPTY_ID' };
  try {
    const sp = require('../services/sessionPersistence');
    const data = sp.restoreSession(sessionId, opts);
    if (!data || !Array.isArray(data.messages) || data.messages.length === 0) {
      return { success: false, error: 'NOT_FOUND' };
    }

    _chatState.messages = data.messages
      .map((m) => {
        const out = { role: m.role, content: m.content };
        try { require('../services/rewindResume').carryRewindFields(m, out); } catch { /* fail-soft */ }
        return out;
      })
      .slice(-MAX_HISTORY);

    // Continue the same transcript: future turns append here, not a fresh id.
    _localState.liveSessionId = sessionId;

    // Prevent contextCompressor from immediately re-compacting restored context.
    try { require('../services/contextCompressor').markSessionResumed(); } catch { /* optional */ }

    return {
      success: true,
      sessionId,
      messageCount: _chatState.messages.length,
      title: data.title || '',
      model: data.model || '',
      source: data._source || '',
    };
  } catch (e) {
    return { success: false, error: (e && e.message) ? e.message : 'ERROR' };
  }
}

/**
 * Resume the most-recent FULL persisted session (Store B / JSONL transcript)
 * for the current working directory.
 */
function resumeLastPersistedSession(opts = {}) {
  try {
    const sp = require('../services/sessionPersistence');
    const all = sp.listPersistedSessions({ limit: 200 });
    if (!Array.isArray(all) || all.length === 0) {
      return { success: false, error: 'EMPTY' };
    }
    const cwd = process.cwd();
    const scoped = all.filter(s => s && s.cwd === cwd);
    const pick = (scoped.length > 0 ? scoped : all)[0];
    if (!pick || !pick.sessionId) return { success: false, error: 'EMPTY' };
    return resumePersistedSession(pick.sessionId, opts);
  } catch (e) {
    return { success: false, error: (e && e.message) ? e.message : 'ERROR' };
  }
}

// ── Exports ──
module.exports = {
  setAiSessionDeps,
  _generateSessionId,
  _ensureLiveSessionId,
  _persistLiveSession,
  _uncommitOrphanTurn,
  _maybeAutoSaveMemory,
  recordInterruption,
  getLiveSessionId,
  loadProjectMemoryContext,
  getConvoDir,
  saveConversation,
  loadLastConversation,
  listConversations,
  findConversationByRef,
  resumeConversation,
  autoResumeLastSession,
  resumePersistedSession,
  resumeLastPersistedSession,
};
