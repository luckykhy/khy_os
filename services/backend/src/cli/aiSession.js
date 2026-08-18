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
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const _chatState = require('./aiChatState');
const _localState = require('./aiLocalState');

// ── Deps (injected by host ai.js via setAiSessionDeps) ──
const _deps = {};
function setAiSessionDeps(d) {
  Object.assign(_deps, d);
}

// ── Constants ──
// 单一真源: constants/chatHistoryDefaults.js (KHY_MAX_HISTORY 可覆盖, 默认 160)。
const { resolveMaxHistory } = require('../constants/chatHistoryDefaults');
const MAX_HISTORY = resolveMaxHistory(process.env);

// Resolve the global conversation dir lazily via the portable-aware app home
// so portable deployments keep conversations inside the install directory.
// Falls back to the legacy user-home location when dataHome is unavailable.
function _globalConvoDir() {
  try {
    const { getAppDataDir } = require('../utils/dataHome');
    return getAppDataDir('conversations');
  } catch {
    return path.join(os.homedir(), '.khyquant', 'conversations');
  }
}
const MAX_SAVED_CONVERSATIONS = 50;
const DEFAULT_AUTO_RESUME_WINDOW_MIN = 180;
const DEFAULT_PROJECT_MEMORY_MAX_CHARS = 5000;
const PROJECT_MEMORY_CONTEXT_TAG = '[ProjectMemoryBootstrap v1]';
const DEFAULT_AUTO_RESUME_SEGMENT_MODE = 'period';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

// Scope-switch soft-timeout: guards skip writes only while switching AND within
// this window. After the window expires the guard degrades gracefully (treats the
// switch as done) so a stuck flag never blocks writes permanently.
const SCOPE_SWITCH_TIMEOUT_MS = 3000;

// ── Session ID ──

function _generateSessionId() {
  try {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fallthrough */
  }
  const tsHex = Date.now().toString(16).slice(-12).padStart(12, '0');
  const rand = crypto.randomBytes(10).toString('hex'); // 20 chars
  return `${tsHex}-${rand.slice(0, 4)}-${rand.slice(4, 8)}-${rand.slice(8, 12)}-${rand.slice(12)}`;
}

function _ensureLiveSessionId() {
  if (!_localState.liveSessionId) {
    _localState.liveSessionId = _generateSessionId();
  }
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
  if (
    process.env.KHY_DISABLE_SESSION_PERSIST === '1' ||
    process.env.KHY_DISABLE_SESSION_PERSIST === 'true'
  ) {
    return;
  }
  // Skip persisting intermediate state during scope switch (soft timeout)
  if (
    _chatState._scopeSwitching &&
    Date.now() - _chatState._scopeSwitchStart < SCOPE_SWITCH_TIMEOUT_MS
  ) {
    return;
  }
  if (!_chatState.messages || _chatState.messages.length === 0) {
    return;
  }
  try {
    const sp = require('../services/sessionPersistence');
    const info = _deps._getModelInfo();
    sp.persistSession(_ensureLiveSessionId(), {
      messages: _chatState.messages,
      model: info.model || '',
      metadata: { cwd: process.cwd(), adapter: info.adapter || '' },
    });
  } catch {
    /* persistence is best-effort */
  }
}

// ── Interruption / Orphan Turn ──

/**
 * Attach optional structured turn artifacts (_timeline/_toolCalls/_turnStats)
 * to the LAST assistant message of the authoritative live history, then
 * re-persist. Present-only: absent/empty inputs leave the message untouched
 * so the persisted output stays byte-identical to the legacy format.
 *
 * Persistence note: the JSONL transcript is append-only — when the assistant
 * line was already appended earlier in the turn (live TUI path), the fields
 * land in the JSON snapshot on re-persist; JSONL rows carry them whenever the
 * fields are present at append time (e.g. fork/materialize via persistSession,
 * or callers that persist after the turn settles). Best-effort, never throws.
 *
 * @param {object} artifacts - { _timeline?, _toolCalls?, _turnStats? }
 * @returns {boolean} whether anything was attached
 */
function attachTurnArtifacts(artifacts) {
  try {
    if (!artifacts || typeof artifacts !== 'object') {
      return false;
    }
    const msgs = _chatState.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) {
      return false;
    }
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || String(m.role || '').toLowerCase() !== 'assistant') {
        continue;
      }
      let attached = false;
      if (Array.isArray(artifacts._timeline) && artifacts._timeline.length > 0) {
        m._timeline = artifacts._timeline;
        attached = true;
      }
      if (Array.isArray(artifacts._toolCalls) && artifacts._toolCalls.length > 0) {
        m._toolCalls = artifacts._toolCalls;
        attached = true;
      }
      if (
        artifacts._turnStats &&
        typeof artifacts._turnStats === 'object' &&
        Object.keys(artifacts._turnStats).length > 0
      ) {
        m._turnStats = artifacts._turnStats;
        attached = true;
      }
      if (attached) {
        _persistLiveSession();
      }
      return attached;
    }
    return false;
  } catch {
    return false;
  }
}

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
  // Skip recording interruption marker during scope switch (soft timeout)
  if (
    _chatState._scopeSwitching &&
    Date.now() - _chatState._scopeSwitchStart < SCOPE_SWITCH_TIMEOUT_MS
  ) {
    return false;
  }
  try {
    const leaf = require('../services/interruptionMarker');
    const content = leaf.buildInterruptedAssistantContent(partialText, env);
    if (content == null) {
      return false;
    } // 门控关 → no-op(逐字节回退)
    const last = _chatState.messages.length
      ? _chatState.messages[_chatState.messages.length - 1]
      : null;
    const lastRole = String((last && last.role) || '').toLowerCase();
    if (lastRole !== 'user' && lastRole !== 'tool') {
      return false;
    } // 非悬空回合 → 不补
    _chatState.messages.push({ role: 'assistant', content });
    if (_chatState.messages.length > MAX_HISTORY) {
      _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);
    }
    try {
      _persistLiveSession();
    } catch {
      /* best effort:持久化失败不影响本次记录 */
    }
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
  if (!committedMsg) {
    return;
  }
  // Skip orphan rollback during scope switch (soft timeout)
  if (
    _chatState._scopeSwitching &&
    Date.now() - _chatState._scopeSwitchStart < SCOPE_SWITCH_TIMEOUT_MS
  ) {
    return;
  }
  if (
    _chatState.messages.length > 0 &&
    _chatState.messages[_chatState.messages.length - 1] === committedMsg
  ) {
    _chatState.messages.pop();
  }
}

// ── Memory Capture ──

/**
 * Deterministically capture a memory from the user's input.
 * Best-effort: never throws into the chat flow. Respects KHY_DISABLE_MEMORY.
 */
function _maybeAutoSaveMemory(userMessage) {
  if (process.env.KHY_DISABLE_MEMORY === '1' || process.env.KHY_DISABLE_MEMORY === 'true') {
    return false;
  }

  let decision;
  try {
    decision = require('../services/memoryTrigger').classify(userMessage);
  } catch {
    return false;
  }
  if (!decision || decision.kind === 'none') {
    return false;
  }

  // instruction candidate → route to the instruction-file review queue (NOT the
  // memory store).
  if (decision.kind === 'instruction') {
    try {
      const note = String(decision.note || '').trim();
      if (!note) {
        return false;
      }
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
  if (!note) {
    return false;
  }

  const title = note.split('\n')[0].slice(0, 40);
  const name =
    decision.name ||
    (
      title
        .toLowerCase()
        .replace(/[^a-z0-9一-龥]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'note'
    ).slice(0, 48);

  try {
    const engine = require('../services/memoryEngine');
    const res = engine.addStructuredMemory({
      type: decision.type || 'user',
      name,
      content: note,
      description: title,
      tier: decision.tier,
    });
    if (!(res && res.success)) {
      return false;
    }
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
  const raw = parseInt(
    String(process.env.KHY_AUTO_RESUME_WINDOW_MIN || DEFAULT_AUTO_RESUME_WINDOW_MIN),
    10
  );
  if (Number.isFinite(raw) && raw <= 0) {
    return 0;
  }
  const mins = Number.isFinite(raw) ? raw : DEFAULT_AUTO_RESUME_WINDOW_MIN;
  return Math.max(5, mins) * 60 * 1000;
}

function _getAutoResumeSegmentMode() {
  const raw = String(process.env.KHY_AUTO_RESUME_SEGMENT_MODE || DEFAULT_AUTO_RESUME_SEGMENT_MODE)
    .trim()
    .toLowerCase();
  if (!raw) {
    return DEFAULT_AUTO_RESUME_SEGMENT_MODE;
  }
  if (['off', 'none', 'disable', 'disabled', 'false', '0'].includes(raw)) {
    return 'none';
  }
  if (['ampm', 'am_pm', 'halfday', 'am-pm'].includes(raw)) {
    return 'ampm';
  }
  if (['period', 'daypart', 'timeslot', 'segment'].includes(raw)) {
    return 'period';
  }
  return DEFAULT_AUTO_RESUME_SEGMENT_MODE;
}

function _localDateKey(date) {
  const parts = _getDatePartsInTimezone(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function _periodBucket(date) {
  const parts = _getDatePartsInTimezone(date);
  const h = parts.hour;
  if (h < 6) {
    return 'late-night';
  }
  if (h < 12) {
    return 'morning';
  }
  if (h < 18) {
    return 'afternoon';
  }
  return 'evening';
}

function _segmentKey(date, mode) {
  if (mode === 'ampm') {
    const parts = _getDatePartsInTimezone(date);
    return parts.hour < 12 ? 'am' : 'pm';
  }
  if (mode === 'period') {
    return _periodBucket(date);
  }
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
    for (const token of tokens) {
      byType[token.type] = token.value;
    }
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
  if (mode === 'none') {
    return true;
  }
  if (_localDateKey(lastDate) !== _localDateKey(nowDate)) {
    return false;
  }
  return _segmentKey(lastDate, mode) === _segmentKey(nowDate, mode);
}

// ── Project Memory ──

function _getProjectMemoryCandidates(cwd = process.cwd()) {
  const files = [];
  // 1. Canonical portable-aware memory dir (memdir resolves portable installs
  //    to <install root>/.khy/memory) — checked FIRST so portable deployments
  //    never lose to the legacy user-home paths below.
  try {
    const memdirPaths = require('../memdir/paths');
    const canonicalDir = memdirPaths.getMemoryDir();
    files.push(path.join(canonicalDir, 'MEMORY.md'));
    files.push(path.join(canonicalDir, 'memory.md'));
  } catch {
    /* ignore */
  }
  // 2. Project-scoped data home memory (<root>/.khy/memory).
  try {
    const { getProjectDataHome } = require('../utils/dataHome');
    files.push(path.join(getProjectDataHome(), 'memory', 'MEMORY.md'));
  } catch {
    /* ignore */
  }
  // 3. Per-cwd project memory store (projectMemoryService).
  try {
    const { getMemoryDir, getProjectDir } = require('../services/projectMemoryService');
    const memoryDir = getMemoryDir(cwd);
    const projectDir = getProjectDir(cwd);
    files.push(path.join(memoryDir, 'memory.md'));
    files.push(path.join(memoryDir, 'MEMORY.md'));
    files.push(path.join(projectDir, 'memory.md'));
    files.push(path.join(projectDir, 'MEMORY.md'));
  } catch {
    /* ignore */
  }
  // 4. Legacy user-home compatibility path (last resort).
  files.push(path.join(os.homedir(), '.khy', 'memory', 'MEMORY.md'));
  return [...new Set(files)];
}

/**
 * Whether the project-memory payload is packed by relevance instead of blindly
 * truncated. Default ON; `KHY_PROJECT_MEMORY_RANKED ∈ {0,false,off,no}` reverts
 * to the original `content.slice(0, maxChars)` behavior byte-for-byte.
 */
function _projectMemoryRankedEnabled() {
  const v = String(process.env.KHY_PROJECT_MEMORY_RANKED || '').trim();
  return !/^(0|false|off|no)$/i.test(v);
}

/** A MEMORY.md pointer line: `- [Title](slug.md) — hook`. */
const _MEMORY_POINTER_RE = /^\s*[-*+]\s+/;

/** Extract the memory filename a pointer line refers to, if any. */
function _pointerTarget(line) {
  const linked = /\(([^)\s]+\.md)\)/.exec(line);
  if (linked) {
    return path.basename(linked[1]);
  }
  const bare = /([A-Za-z0-9_.\-一-鿿]+\.md)/.exec(line);
  return bare ? path.basename(bare[1]) : null;
}

/**
 * Fit a MEMORY.md index into the context budget by dropping the LEAST relevant
 * pointer lines instead of cutting the file mid-character.
 *
 * The defect this replaces: `content.slice(0, maxChars)` keeps whatever happens
 * to be at the top of the file (memdir writes new pointers by append order) and
 * severs the last line mid-word. Once a user accumulates enough memories, their
 * most important ones — permanent-tier identity and standing instructions — are
 * exactly the ones silently cut, because nothing about the byte offset correlates
 * with relevance.
 *
 * There is no query at session bootstrap, so relevance here is the
 * query-independent priming rank (tier × recency × type preference) from the
 * scoring SSOT — the same order the session-priming path uses. No embedding call
 * is made: with nothing to compare against, a vector would rank nothing.
 *
 * Structural lines (headings, prose, blank lines) are always kept — they are the
 * document's skeleton and cost little. Pointer lines compete for the remainder
 * and are emitted in their ORIGINAL file order, so the packed index still reads
 * as an index rather than as a score-ordered list.
 *
 * @param {string} content - the raw MEMORY.md text, already trimmed
 * @param {number} maxChars - character budget for this payload
 * @returns {{text:string, truncated:boolean, kept:number, total:number}|null}
 *          null ⇒ caller must fall back to blind truncation
 */
function _packProjectMemory(content, maxChars) {
  const lines = String(content).split(/\r?\n/);

  const pointers = [];
  const skeleton = [];
  for (let i = 0; i < lines.length; i++) {
    const target = _MEMORY_POINTER_RE.test(lines[i]) ? _pointerTarget(lines[i]) : null;
    if (target) {
      pointers.push({ i, target });
    } else {
      skeleton.push(i);
    }
  }
  if (pointers.length === 0) {
    return null; // not an index we understand ⇒ don't pretend to rank it
  }

  // Priming rank → position. Memories absent from the ranking (deleted, stale,
  // or filtered out) sort after every ranked one but keep their file order.
  const rankOf = new Map();
  try {
    const { scoring } = require('../services/memoryEngine');
    const ranked = scoring.rankForPriming({
      limit: Math.max(pointers.length, 1),
      bodies: false,
    });
    ranked.forEach((m, idx) => rankOf.set(m.filename, idx));
  } catch {
    return null; // ranking unavailable ⇒ blind truncation, unchanged behavior
  }

  const NOTE = '\n\n[Memory truncated for context budget]';
  const keep = new Set(skeleton);
  const lineCost = (i) => lines[i].length + 1; // +1 for the joining newline

  let used = skeleton.reduce((sum, i) => sum + lineCost(i), 0);
  if (used + NOTE.length > maxChars) {
    return null; // skeleton alone busts the budget ⇒ blind truncation
  }

  const order = pointers
    .map((p, seq) => ({ ...p, seq }))
    .sort((a, b) => {
      const ra = rankOf.has(a.target) ? rankOf.get(a.target) : Number.MAX_SAFE_INTEGER;
      const rb = rankOf.has(b.target) ? rankOf.get(b.target) : Number.MAX_SAFE_INTEGER;
      return ra - rb || a.seq - b.seq;
    });

  // Reserve room for the note only once we know something will be dropped.
  let dropped = false;
  for (const p of order) {
    const cost = lineCost(p.i);
    const reserve = dropped ? NOTE.length : 0;
    if (used + cost + reserve > maxChars) {
      dropped = true;
      continue;
    }
    keep.add(p.i);
    used += cost;
  }
  if (dropped && used + NOTE.length > maxChars) {
    // Shed the lowest-ranked kept pointers until the note fits.
    for (let k = order.length - 1; k >= 0 && used + NOTE.length > maxChars; k--) {
      if (keep.delete(order[k].i)) {
        used -= lineCost(order[k].i);
      }
    }
  }

  const text =
    lines
      .filter((_, i) => keep.has(i))
      .join('\n')
      .replace(/\n{3,}$/, '\n') + (dropped ? NOTE : '');

  return {
    text: dropped ? text : content,
    truncated: dropped,
    kept: pointers.filter((p) => keep.has(p.i)).length,
    total: pointers.length,
  };
}

function loadProjectMemoryContext(options = {}) {
  try {
    const alreadyInjected = _chatState.messages.some(
      (m) =>
        String(m?.role || '').toLowerCase() === 'tool' &&
        String(m?.content || '').includes(PROJECT_MEMORY_CONTEXT_TAG)
    );
    if (alreadyInjected && !options.force) {
      return { loaded: false, reason: 'already-loaded' };
    }

    const rawMaxChars = parseInt(
      String(process.env.KHY_PROJECT_MEMORY_MAX_CHARS || DEFAULT_PROJECT_MEMORY_MAX_CHARS),
      10
    );
    const maxChars = Math.max(
      400,
      Number.isFinite(rawMaxChars) ? rawMaxChars : DEFAULT_PROJECT_MEMORY_MAX_CHARS
    );
    const cwd = options.cwd || process.cwd();
    const candidates = _getProjectMemoryCandidates(cwd);

    for (const filePath of candidates) {
      try {
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const content = String(fs.readFileSync(filePath, 'utf-8') || '').trim();
        if (!content) {
          continue;
        }

        // Relevance packing (default on). Only engages when the index actually
        // exceeds the budget; below budget, `summary === content` either way, so
        // the injected payload is byte-identical to before.
        let packed = null;
        if (_projectMemoryRankedEnabled() && content.length > maxChars) {
          try {
            packed = _packProjectMemory(content, maxChars);
          } catch {
            packed = null; // any failure ⇒ blind truncation below
          }
        }

        const truncated = packed ? packed.truncated : content.length > maxChars;
        const summary = packed
          ? packed.text
          : truncated
            ? `${content.slice(0, maxChars)}\n\n[Memory truncated for context budget]`
            : content;
        const payload = [
          PROJECT_MEMORY_CONTEXT_TAG,
          `source: ${filePath}`,
          'Use this memory as background context. User latest explicit instructions always win.',
          '',
          summary,
        ].join('\n');

        if (options.prepend) {
          _chatState.messages = [{ role: 'tool', content: payload }, ..._chatState.messages];
        } else {
          _chatState.messages.push({ role: 'tool', content: payload });
        }
        if (_chatState.messages.length > MAX_HISTORY) {
          _chatState.messages = _chatState.messages.slice(-MAX_HISTORY);
        }

        return {
          loaded: true,
          file: filePath,
          // Legacy path keeps its exact reporting; packing reports what it built.
          chars: packed ? packed.text.length : Math.min(content.length, maxChars),
          truncated,
          // Additive diagnostics; absent when the index was not packed.
          ...(packed ? { packed: true, kept: packed.kept, total: packed.total } : {}),
        };
      } catch {
        /* try next candidate */
      }
    }
  } catch {
    /* ignore */
  }

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
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  } catch {
    return _globalConvoDir();
  }
}

// ── Save / Load / List / Find / Resume ──

function saveConversation() {
  if (_chatState.messages.length === 0) {
    return { success: false, reason: 'empty' };
  }
  try {
    const convoDir = getConvoDir();
    if (!fs.existsSync(convoDir)) {
      fs.mkdirSync(convoDir, { recursive: true });
    }
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

    const files = fs
      .readdirSync(convoDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
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
    if (!fs.existsSync(convoDir)) {
      return null;
    }
    const files = fs
      .readdirSync(convoDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    if (files.length === 0) {
      return null;
    }
    const latest = fs.readFileSync(path.join(convoDir, files[files.length - 1]), 'utf-8');
    return JSON.parse(latest);
  } catch {
    return null;
  }
}

function listConversations() {
  try {
    const convoDir = getConvoDir();
    if (!fs.existsSync(convoDir)) {
      return [];
    }
    const files = fs
      .readdirSync(convoDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    return files.map((file) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(convoDir, file), 'utf-8'));
        const sessionId =
          String(data.sessionId || '').trim() || String(file).replace(/\.json$/i, '');
        return {
          file,
          sessionId,
          timestamp: data.timestamp,
          messageCount: data.messageCount || data.messages?.length || 0,
        };
      } catch {
        return {
          file,
          sessionId: String(file).replace(/\.json$/i, ''),
          timestamp: '',
          messageCount: 0,
        };
      }
    });
  } catch {
    return [];
  }
}

function findConversationByRef(ref) {
  const key = String(ref || '').trim();
  if (!key) {
    return null;
  }
  const convos = listConversations();
  if (convos.length === 0) {
    return null;
  }

  const normalizedFile = key.endsWith('.json') ? key : `${key}.json`;
  const lower = key.toLowerCase();
  const lowerFile = normalizedFile.toLowerCase();

  let match = convos.find(
    (c) => c.file === key || c.file === normalizedFile || c.sessionId === key
  );
  if (match) {
    return match;
  }

  match = convos.find((c) => {
    const sid = String(c.sessionId || '').toLowerCase();
    const file = String(c.file || '').toLowerCase();
    return sid === lower || file === lower || file === lowerFile;
  });
  if (match) {
    return match;
  }

  const sidPrefix = convos.filter((c) =>
    String(c.sessionId || '')
      .toLowerCase()
      .startsWith(lower)
  );
  if (sidPrefix.length === 1) {
    return sidPrefix[0];
  }

  const filePrefix = convos.filter((c) =>
    String(c.file || '')
      .replace(/\.json$/i, '')
      .toLowerCase()
      .startsWith(lower)
  );
  if (filePrefix.length === 1) {
    return filePrefix[0];
  }

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
      // Legacy conversations/*.json can also end mid-turn with an orphan
      // tool_use whose tool_result never landed. Pair them with the same
      // helper the send path uses so restored history never leaks raw tool
      // blocks back to the model / user. Idempotent + fail-soft.
      try {
        const { ensureToolResultPairing } = require('../services/contentBlockUtils');
        ensureToolResultPairing(_chatState.messages);
      } catch {
        /* fail-soft: pairing repair must never block a resume */
      }
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
    if (!last || !last.timestamp || !last.messages || last.messages.length === 0) {
      return null;
    }
    const lastAt = new Date(last.timestamp);
    if (!Number.isFinite(lastAt.getTime())) {
      return null;
    }
    const now = new Date();
    if (!_isSameAutoResumeSegment(lastAt, now)) {
      return null;
    }
    const elapsed = Date.now() - lastAt.getTime();
    const maxAge = _getAutoResumeWindowMs();
    if (maxAge <= 0) {
      return null;
    }
    if (elapsed > maxAge) {
      return null;
    }
    _chatState.messages = last.messages.slice(-MAX_HISTORY);
    // Symmetric with resumeConversation: repair any orphan tool_use left by an
    // interrupted round before restored history reaches the model. Idempotent.
    try {
      const { ensureToolResultPairing } = require('../services/contentBlockUtils');
      ensureToolResultPairing(_chatState.messages);
    } catch {
      /* fail-soft: pairing repair must never block a resume */
    }
    // A5: 标记 session 恢复，防止 contextCompressor 立即重新压缩已压缩内容
    try {
      require('../services/contextCompressor').markSessionResumed();
    } catch {}
    return {
      resumed: true,
      messageCount: _chatState.messages.length,
      timestamp: last.timestamp,
      cwd: last.cwd,
    };
  } catch {
    return null;
  }
}

/**
 * Resume a persisted session from the rich JSONL store (~/.khy/sessions) into the
 * live conversation.
 */
function resumePersistedSession(sessionId, opts = {}) {
  if (!sessionId) {
    return { success: false, error: 'EMPTY_ID' };
  }
  try {
    const sp = require('../services/sessionPersistence');
    const data = sp.restoreSession(sessionId, opts);
    if (!data || !Array.isArray(data.messages) || data.messages.length === 0) {
      return { success: false, error: 'NOT_FOUND' };
    }

    _chatState.messages = data.messages
      .map((m) => {
        const out = { role: m.role, content: m.content };
        try {
          require('../services/rewindResume').carryRewindFields(m, out);
        } catch {
          /* fail-soft */
        }
        return out;
      })
      .slice(-MAX_HISTORY);

    // A resumed transcript can end mid-turn: the interrupted round left an
    // assistant tool_use block whose tool_result never landed. Feeding that
    // orphan straight back to the model leaks raw tool blocks into the reply
    // (they get flattened into user-facing text). Pair them here — the same
    // helper the send path uses — so restored history is always well-formed.
    // Idempotent: the injected placeholders are real tool_result blocks, so a
    // second pass finds no missing ids and never stacks duplicates; persisting
    // the repaired history afterwards is therefore safe.
    try {
      const { ensureToolResultPairing } = require('../services/contentBlockUtils');
      ensureToolResultPairing(_chatState.messages);
    } catch {
      /* fail-soft: pairing repair must never block a resume */
    }

    // Continue the same transcript: future turns append here, not a fresh id.
    _localState.liveSessionId = sessionId;

    // Prevent contextCompressor from immediately re-compacting restored context.
    try {
      require('../services/contextCompressor').markSessionResumed();
    } catch {
      /* optional */
    }

    return {
      success: true,
      sessionId,
      messageCount: _chatState.messages.length,
      title: data.title || '',
      model: data.model || '',
      source: data._source || '',
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : 'ERROR' };
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
    const scoped = all.filter((s) => s && s.cwd === cwd);
    const pick = (scoped.length > 0 ? scoped : all)[0];
    if (!pick || !pick.sessionId) {
      return { success: false, error: 'EMPTY' };
    }
    return resumePersistedSession(pick.sessionId, opts);
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : 'ERROR' };
  }
}

/**
 * 会话作用域私有的「单槽」状态。
 *
 * 这五个字段语义上属于**一次会话**,物理上却是进程级单例(aiChatState)。scopeSession
 * 换掉了 messages,但它们不换的话,跨用户切换会串:
 *   - lastSubstantivePrompt/At — B 发「继续」会接上 A 的任务;
 *   - pendingTaskGuard         — **单槽**待确认任务:B 发「确认」会确认掉 A 挂起的那个,
 *                                这是越权,不只是串台;
 *   - primedSessionId/lastPrimeTopicTokens — 记忆预热基线,错了会漏预热或重复预热。
 *
 * 默认值必须与 aiChatState 的初始值一致,否则「新会话」起步状态和冷启动不一样。
 */
const _SCOPED_FIELD_DEFAULTS = Object.freeze({
  pendingTaskGuard: null,
  lastSubstantivePrompt: '',
  lastSubstantiveAt: 0,
  primedSessionId: null,
  lastPrimeTopicTokens: null,
});

// 上限存在的理由:每个陌生微信用户都会新开一个作用域,不设上限就是一条随使用时长
// 单调增长的内存泄漏。淘汰最久未用的即可 —— 这些字段全都是可重建的短时状态。
const _SCOPED_STASH_MAX = 32;
const _scopedStash = new Map();

/** 把当前进程级单槽状态存进 sessionId 名下(空 id 不存)。 */
function _stashScopedState(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) {
    return;
  }
  const snap = {};
  for (const k of Object.keys(_SCOPED_FIELD_DEFAULTS)) {
    snap[k] = _chatState[k];
  }
  _scopedStash.delete(id); // 删了再插 → 该 id 回到 Map 末位(LRU)
  _scopedStash.set(id, snap);
  while (_scopedStash.size > _SCOPED_STASH_MAX) {
    _scopedStash.delete(_scopedStash.keys().next().value);
  }
}

/** 取回 sessionId 名下的单槽状态;没存过则回落到默认值(等同全新会话)。 */
function _restoreScopedState(sessionId) {
  const snap = _scopedStash.get(String(sessionId || '').trim());
  for (const [k, def] of Object.entries(_SCOPED_FIELD_DEFAULTS)) {
    _chatState[k] = snap && Object.prototype.hasOwnProperty.call(snap, k) ? snap[k] : def;
  }
}

/**
 * 把 live 会话作用域切换到稳定 sessionId(ilink/daemon 多用户修复)。
 *
 * 背景(_chatState.messages 是进程级单例;ilinkDispatcher 传的 opts.sessionId
 * 此前只用于 trace audit,从不影响历史 → 所有微信用户共用一条历史、且守护进程
 * 重启后 `_chatState.messages` 清空 → 「从头开始」)。本函数让每个外部会话有自己
 * 的持久化历史:
 *   - 同 id → no-op(不打断正在进行的会话);
 *   - 异 id → 先把当前单槽状态寄存到旧 id 名下,再尝试 resumePersistedSession
 *     (load 该用户已持久化历史);NOT_FOUND(新用户首条)→ 清空 messages 并把
 *     liveSessionId 钉为该 id,使 _persistLiveSession 之后落到该用户独立文件
 *     (跨守护进程重启存活);最后取回该 id 名下的单槽状态。
 * 绝不抛;任何异常返回 {ok:false} 并保持原状(fail-soft)。
 *
 * @param {string} [sessionId] 稳定的会话作用域 id(如 `ilink:<userId>`)
 * @returns {{ok:boolean, changed?:boolean, restored?:boolean, reason?:string}}
 */
function scopeSession(sessionId) {
  _chatState._scopeSwitching = true;
  _chatState._scopeSwitchStart = Date.now();
  try {
    const target = String(sessionId || '').trim();
    if (!target) {
      return { ok: true, changed: false, reason: 'EMPTY_ID' };
    }
    if (_localState.liveSessionId === target) {
      // Already in this session scope; do not rebuild even if messages are empty.
      return { ok: true, changed: false, reason: 'SAME_ID' };
    }
    // Stash scoped state BEFORE resumePersistedSession rewrites liveSessionId,
    // otherwise the old session's slot state would be recorded under the new id.
    _stashScopedState(_localState.liveSessionId);
    const resumed = resumePersistedSession(target);
    if (resumed && resumed.success) {
      _restoreScopedState(target);
      return { ok: true, changed: true, restored: true, messageCount: _chatState.messages.length };
    }
    // New user / no restorable history — start from empty session and pin
    // liveSessionId to target so _persistLiveSession writes to the correct file.
    _chatState.messages = [];
    _localState.liveSessionId = target;
    _restoreScopedState(target);
    return { ok: true, changed: true, restored: false };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'SCOPE_FAILED' };
  } finally {
    _chatState._scopeSwitching = false;
  }
}

// ── Exports ──
module.exports = {
  setAiSessionDeps,
  _generateSessionId,
  _ensureLiveSessionId,
  scopeSession,
  _persistLiveSession,
  attachTurnArtifacts,
  _uncommitOrphanTurn,
  _maybeAutoSaveMemory,
  recordInterruption,
  getLiveSessionId,
  loadProjectMemoryContext,
  // Exposed for tests: the relevance packer is pure (string + budget in, string
  // out) and is the part worth pinning down independently of session state.
  _packProjectMemory,
  _projectMemoryRankedEnabled,
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
