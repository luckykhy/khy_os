'use strict';

/**
 * session.js — Browse, resume, and manage conversation history
 *
 * Operates on the rich JSONL transcript store (~/.khy/sessions, via
 * sessionPersistence) so "view history sessions" surfaces what was
 * actually recorded, not the legacy summary store.
 *
 * @module handlers/session
 */

// ── Imports ──

const chalk = require('chalk').default || require('chalk');

const { printInfo, printError, printSuccess, printWarn } = require('../formatters');

// CC 后端口径对齐:字节数 → 人类可读走 CC `formatFileSize` 单一真源(ccFormat SSOT,同
// handlers/workspace|health|storage 已采纳)。门控 KHY_CC_FORMAT(经 ccFormatEnabled)默认
// 开;关 / require 失败 / 非有限输入 → 返回调用方传入的 `legacy` 串(逐字节回退)。仅用于
// **显示** DB Size 行;`dbSizeKB` 等机读 JSON 字段绝不经此(保持原始数值)。
function _ccFileSize(bytes, legacy) {
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../ccFormat');
    if (ccFormatEnabled()) {
      const out = ccFormatFileSize(bytes);
      if (out) {
        return out;
      }
    }
  } catch {
    /* fall through to legacy */
  }
  return legacy;
}

async function handleSessionCommand(subCommand, args, options = {}) {
  switch (subCommand) {
    case 'list':
    case 'ls':
      return handleSessionList(options);
    case 'show':
    case 'view':
      return handleSessionShow(args, options);
    case 'resume':
    case 'load':
    case 'open':
      return handleSessionResume(args, options);
    case 'rename':
    case 'title':
      return handleSessionRename(args, options);
    case 'delete':
    case 'rm':
    case 'remove':
      return handleSessionDelete(args, options);
    case 'export':
    case 'save':
      return handleSessionExport(args, options);
    case 'analyze':
      return handleSessionAnalyze(args, options);
    case 'search':
      return handleSessionSearch(args, options);
    case 'stats':
      return handleSessionStats(options);
    case 'help':
      return _printHelp();
    default:
      // Default (bare `session` / `/sessions`) lists — the most useful entry
      // point for "view history sessions".
      return handleSessionList(options);
  }
}

function _emitJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

// ── Shared helpers ───────────────────────────────────────────────────────

function _persistence() {
  return require('../../services/sessionPersistence');
}

/**
 * Read a session's raw snapshot JSON (the {bucket}/{sessionId}.json file)
 * WITHOUT the restoreSession read-side whitelist, so the optional per-message
 * artifact fields (_timeline/_toolCalls/_turnStats) survive. The path is
 * derived from the persistence layer's own resolver (jsonlPathFor — the SSOT
 * for where a session's files co-locate), never hardcoded. Returns the parsed
 * snapshot object or null; old/missing/corrupt snapshots degrade honestly.
 */
function _readSnapshotRaw(sessionId) {
  try {
    const fs = require('fs');
    const path = require('path');
    const sp = _persistence();
    if (typeof sp.jsonlPathFor !== 'function') {
      return null;
    }
    const jsonl = sp.jsonlPathFor(sessionId);
    if (!jsonl) {
      return null;
    }
    const snapPath = path.join(
      path.dirname(jsonl),
      path.basename(jsonl).replace(/\.jsonl$/, '.json')
    );
    const parsed = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Optional per-message artifact fields persisted by the live TUI turns.
const _ARTIFACT_KEYS = ['_timeline', '_toolCalls', '_turnStats'];

/**
 * Merge the optional artifact fields from raw snapshot messages onto restored
 * (whitelisted) messages. Match by uuid first (authoritative), then fall back
 * to same-index + same-role. Messages without a snapshot counterpart are
 * returned untouched — legacy sessions simply carry no extra fields. Pure.
 */
function _attachArtifacts(messages, snapMessages) {
  if (!Array.isArray(messages)) {
    return messages;
  }
  if (!Array.isArray(snapMessages) || snapMessages.length === 0) {
    return messages;
  }
  const byUuid = new Map();
  for (const m of snapMessages) {
    if (m && m.uuid) {
      byUuid.set(m.uuid, m);
    }
  }
  return messages.map((m, i) => {
    if (!m) {
      return m;
    }
    let src = (m.uuid && byUuid.get(m.uuid)) || null;
    if (!src) {
      const cand = snapMessages[i];
      if (cand && cand.role === m.role) {
        src = cand;
      }
    }
    if (!src) {
      return m;
    }
    const out = { ...m };
    for (const k of _ARTIFACT_KEYS) {
      if (src[k] !== undefined && out[k] === undefined) {
        out[k] = src[k];
      }
    }
    return out;
  });
}

/**
 * Load the scoped, ordered session list (most-recent first). When `all` is
 * falsy the list is restricted to the current working directory's project,
 * matching the bucket the live REPL writes into.
 * @returns {Array<object>}
 */
function _scopedSessions(options = {}) {
  const sp = _persistence();
  const limit = options.limit ? Math.max(1, parseInt(options.limit, 10) || 50) : 200;
  const all = sp.listPersistedSessions({ limit });
  if (options.all) {
    return all;
  }
  const cwd = process.cwd();
  const scoped = all.filter((s) => s.cwd === cwd);
  // Fall back to the full list when nothing matches the cwd — e.g. older
  // sessions persisted before cwd metadata existed — so the user is never
  // shown an empty list while sessions clearly exist.
  return scoped.length > 0 ? scoped : all;
}

/**
 * Resolve a user-supplied reference to a single session from the scoped list.
 * @returns {{ session: object|null, error: string|null, candidates?: object[] }}
 */
function _resolveSessionRef(ref, options = {}) {
  const raw = String(ref == null ? '' : ref).trim();
  if (!raw) {
    return { session: null, error: 'missing_ref' };
  }

  const sessions = _scopedSessions(options);
  if (sessions.length === 0) {
    return { session: null, error: 'empty' };
  }

  // 1-based index: "2" or "#2"。CJK-IME 全角数字「２」/全角空格先经 SSOT 叶子归一
  // (门控 KHY_CJK_INPUT_NORMALIZE,关→原样字节回退),否则 `\d` 不认全角→中文用户
  // 敲 `session show ２` 静默失败。exact/prefix 路仍走 raw(会话 ID 是 ASCII hex)。
  const idxSource = require('../cjkInputNormalize').normalizeNumericInput(raw, options.env);
  const idxMatch = /^#?(\d+)$/.exec(idxSource);
  if (idxMatch) {
    const idx = parseInt(idxMatch[1], 10);
    if (idx >= 1 && idx <= sessions.length) {
      return { session: sessions[idx - 1], error: null };
    }
    return { session: null, error: 'index_out_of_range' };
  }

  // Exact id
  const exact = sessions.find((s) => s.sessionId === raw);
  if (exact) {
    return { session: exact, error: null };
  }

  // Unique prefix
  const prefixed = sessions.filter((s) => String(s.sessionId).startsWith(raw));
  if (prefixed.length === 1) {
    return { session: prefixed[0], error: null };
  }
  if (prefixed.length > 1) {
    return { session: null, error: 'ambiguous', candidates: prefixed };
  }

  return { session: null, error: 'not_found' };
}

// CC 区间 unit → 英文短单位(与既有 "Ns/m/h/d ago" 措辞一致,补 CC 的 week 档)。
const _AGE_UNIT_EN = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w' };

function _relativeTime(ts, env = process.env) {
  const n = Number(ts) || 0;
  if (!n) {
    return 'unknown';
  }
  const diff = Date.now() - n;
  if (diff < 0) {
    return 'just now';
  }
  // CC 后端口径对齐:经 ccFormat SSOT 的 ccRelativeAgeParts(CC `formatRelativeTime`
  // 的 Math.trunc 截断 + 完整区间表)。本地旧实现已用 floor(截断对了),但缺
  // week/month/year 档;走 SSOT 后补上 week(7–29 天 → "Nw ago"),并保留既有「很旧
  // 的会话 → 绝对日期」产品选择(month/year 档落回 toLocaleDateString,比 "3mo ago"
  // 对老会话更有用)。门控 KHY_CC_FORMAT 默认开;关 / require 失败 → 逐字节回退。
  try {
    const { ccFormatEnabled, ccRelativeAgeParts } = require('../ccFormat');
    if (ccFormatEnabled(env)) {
      const parts = ccRelativeAgeParts(diff);
      if (parts) {
        const unit = _AGE_UNIT_EN[parts.unit];
        if (unit) {
          return `${parts.value}${unit} ago`;
        }
        // month / year 档:保留绝对日期回退(与 legacy 的 >=30d 行为一致)。
        return new Date(n).toLocaleDateString('zh-CN');
      }
    }
  } catch {
    /* fall through to legacy */
  }
  const sec = Math.floor(diff / 1000);
  if (sec < 60) {
    return `${sec}s ago`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const day = Math.floor(hr / 24);
  if (day < 30) {
    return `${day}d ago`;
  }
  return new Date(n).toLocaleDateString('zh-CN');
}

function _shortId(id) {
  const s = String(id || '');
  return s.length > 12 ? s.slice(0, 12) : s;
}

// `session show` 的消息角色标签。与 [[project_human_turn_count_ssot]](刀69)同源:
// 工具结果载体([Tool Result]/tool_result 块)与压缩摘要([ContextCompact])都共享
// role:'user',若一律标「用户」会把工具/上下文载体误呈为真人回合(刀69 修的是计数,
// 本刀修同一判据在 `session show` recent 列表的**标签**)。门控 KHY_HUMAN_TURN_COUNT
// (复用同一 SSOT 叶子 messagePredicates,同一语义、同一开关)。门控关 / require 失败
// → 逐字节回退旧标签(role==='user' → 用户)。assistant/其它角色恒不变。
function _roleLabel(m) {
  const role = m && m.role;
  if (role === 'user') {
    try {
      const { humanTurnCountEnabled, userMessageKind } = require('../messagePredicates');
      if (humanTurnCountEnabled(process.env)) {
        const kind = userMessageKind(m);
        if (kind === 'tool') {
          return chalk.yellow('工具');
        }
        if (kind === 'meta') {
          return chalk.dim('上下文');
        }
        // 'human' / 判不出 → 与旧行为一致标「用户」。
      }
    } catch {
      /* fall through to legacy label */
    }
    return chalk.cyan('用户');
  }
  return role === 'assistant' ? chalk.green('助手') : chalk.dim(role || '?');
}

function _previewText(content, max = 80) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((p) => (p && typeof p === 'object' ? p.text || '' : String(p || '')))
      .join(' ');
  } else if (content && typeof content === 'object') {
    text = content.text || JSON.stringify(content);
  }
  text = String(text).replace(/\s+/g, ' ').trim();
  if (text.length > max) {
    return text.slice(0, max - 1) + '…';
  }
  return text;
}

function _refErrorMessage(error) {
  switch (error) {
    case 'missing_ref':
      return '缺少会话引用。用法见 `session help`（可用序号 #n 或会话 ID）。';
    case 'empty':
      return '暂无已保存的会话。';
    case 'index_out_of_range':
      return '序号超出范围，请先运行 `session list` 查看。';
    case 'ambiguous':
      return '会话 ID 前缀不唯一，请提供更长的前缀或完整 ID。';
    case 'not_found':
      return '未找到匹配的会话，请先运行 `session list` 查看。';
    default:
      return '无法解析会话引用。';
  }
}

// ── list ─────────────────────────────────────────────────────────────────

function handleSessionList(options = {}) {
  const sessions = _scopedSessions(options);

  if (options.json) {
    _emitJson({
      ok: true,
      action: 'list',
      scope: options.all ? 'all' : 'project',
      cwd: process.cwd(),
      count: sessions.length,
      sessions: sessions.map((s, i) => ({ index: i + 1, ...s })),
    });
    return;
  }

  if (sessions.length === 0) {
    printInfo('暂无已保存的会话。开始对话后会自动记录。');
    return;
  }

  console.log('');
  const scopeLabel = options.all ? '全部项目' : '当前项目';
  console.log(chalk.bold(`  💬 历史会话 (${sessions.length}) · ${scopeLabel}`));
  console.log('');
  sessions.forEach((s, i) => {
    const num = chalk.dim(`  ${String(i + 1).padStart(2)}.`);
    const title = chalk.white(s.title || '(untitled)');
    const meta = chalk.dim(
      `${s.messageCount} 条 · ${_relativeTime(s.updatedAt)}` +
        (s.model ? ` · ${s.model}` : '') +
        ` · ${_shortId(s.sessionId)}`
    );
    console.log(`${num} ${title}`);
    console.log(`      ${meta}`);
    if (options.all && s.cwd) {
      console.log(`      ${chalk.dim('📁 ' + s.cwd)}`);
    }
  });
  console.log('');
  console.log(
    chalk.dim(
      '  恢复: session resume <序号|ID>   重命名: session rename <序号|ID> <标题>   删除: session delete <序号|ID>'
    )
  );
  if (!options.all) {
    console.log(chalk.dim('  查看全部项目: session list --all'));
  }
  console.log('');
}

// ── show ─────────────────────────────────────────────────────────────────

function handleSessionShow(args, options = {}) {
  const { session, error } = _resolveSessionRef(args[0], options);
  if (!session) {
    if (options.json) {
      _emitJson({ ok: false, action: 'show', error });
      return;
    }
    printError(_refErrorMessage(error));
    return;
  }

  const sp = _persistence();
  const data = sp.restoreSession(session.sessionId);
  const messages = data && Array.isArray(data.messages) ? data.messages : [];
  const limit = options.limit ? Math.max(1, parseInt(options.limit, 10) || 8) : 8;
  const recent = messages.slice(-limit);

  if (options.json) {
    _emitJson({
      ok: true,
      action: 'show',
      sessionId: session.sessionId,
      title: session.title,
      model: session.model,
      messageCount: messages.length,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      messages: recent.map((m) => ({ role: m.role, content: _previewText(m.content, 4000) })),
    });
    return;
  }

  console.log('');
  console.log(chalk.bold(`  ${session.title || '(untitled)'}`));
  console.log(
    chalk.dim(
      `  ID ${session.sessionId} · ${messages.length} 条消息 · ${_relativeTime(session.updatedAt)}`
    ) + (session.model ? chalk.dim(` · ${session.model}`) : '')
  );
  if (session.cwd) {
    console.log(chalk.dim(`  📁 ${session.cwd}`));
  }
  console.log('');
  if (recent.length === 0) {
    printInfo('该会话没有可显示的消息。');
    return;
  }
  for (const m of recent) {
    const role = _roleLabel(m);
    console.log(`  ${role} ${chalk.dim('·')} ${_previewText(m.content, 160)}`);
  }
  console.log('');
  console.log(chalk.dim(`  恢复此会话: session resume ${session.sessionId}`));
  console.log('');
}

// ── resume / load ──────────────────────────────────────────────────────────

function handleSessionResume(args, options = {}) {
  const { session, error } = _resolveSessionRef(args[0], options);
  if (!session) {
    if (options.json) {
      _emitJson({ ok: false, action: 'resume', error });
      return;
    }
    printError(_refErrorMessage(error));
    return;
  }

  const ai = require('../ai');
  const result = ai.resumePersistedSession(session.sessionId);

  if (options.json) {
    _emitJson({ ok: !!result.success, action: 'resume', ...result });
    return;
  }

  if (!result.success) {
    printError(`恢复失败: ${result.error || 'unknown'}`);
    return;
  }

  printSuccess(
    `已恢复会话「${result.title || session.title || session.sessionId}」(${result.messageCount} 条消息)`
  );
  if (process.env.KHY_REPL_ACTIVE === '1') {
    printInfo('AI 已加载该会话的上下文，可直接继续对话；后续消息会追加到同一会话记录。');
  } else {
    printWarn('恢复仅在交互式会话 (REPL) 中生效；请在 `khy` 交互模式下使用 `session resume`。');
  }
}

// ── rename ───────────────────────────────────────────────────────────────

function handleSessionRename(args, options = {}) {
  const { session, error } = _resolveSessionRef(args[0], options);
  if (!session) {
    if (options.json) {
      _emitJson({ ok: false, action: 'rename', error });
      return;
    }
    printError(_refErrorMessage(error));
    return;
  }

  const newTitle = args.slice(1).join(' ').trim();
  if (!newTitle) {
    if (options.json) {
      _emitJson({ ok: false, action: 'rename', error: 'missing_title' });
      return;
    }
    printError('用法: session rename <序号|ID> <新标题>');
    return;
  }

  const sp = _persistence();
  const ok = sp.renameSession(session.sessionId, newTitle);

  if (options.json) {
    _emitJson({
      ok,
      action: 'rename',
      sessionId: session.sessionId,
      title: newTitle.slice(0, 200),
    });
    return;
  }
  if (ok) {
    printSuccess(`已重命名: ${_shortId(session.sessionId)} → 「${newTitle.slice(0, 200)}」`);
  } else {
    printError('重命名失败（会话快照不存在或无法写入）。');
  }
}

// ── delete / rm ────────────────────────────────────────────────────────────

function handleSessionDelete(args, options = {}) {
  const { session, error } = _resolveSessionRef(args[0], options);
  if (!session) {
    if (options.json) {
      _emitJson({ ok: false, action: 'delete', error });
      return;
    }
    printError(_refErrorMessage(error));
    return;
  }

  const sp = _persistence();
  const removed = sp.deleteSession(session.sessionId);

  if (options.json) {
    _emitJson({ ok: removed, action: 'delete', sessionId: session.sessionId });
    return;
  }
  if (removed) {
    printSuccess(`已删除会话: ${session.title || _shortId(session.sessionId)}`);
  } else {
    printError('删除失败（未找到对应文件）。');
  }
}

// ── export / save ──────────────────────────────────────────────────────────

/**
 * Render the readable content of a single message part (string | structured
 * block) to Markdown. Tool calls and tool results are fenced so they survive a
 * round-trip and stay legible. Pure — no I/O.
 */
function _mdContent(content) {
  if (content == null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p == null) {
          return '';
        }
        if (typeof p === 'string') {
          return p;
        }
        if (p.type === 'text' || typeof p.text === 'string') {
          return p.text || '';
        }
        if (p.type === 'tool_use') {
          return '```json\n' + JSON.stringify({ tool: p.name, input: p.input }, null, 2) + '\n```';
        }
        if (p.type === 'tool_result') {
          const body =
            typeof p.content === 'string' ? p.content : JSON.stringify(p.content, null, 2);
          return '> tool_result\n```\n' + String(body) + '\n```';
        }
        return '```json\n' + JSON.stringify(p, null, 2) + '\n```';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  if (typeof content === 'object') {
    return content.text || '```json\n' + JSON.stringify(content, null, 2) + '\n```';
  }
  return String(content);
}

/**
 * Build a human-readable Markdown transcript from a restored session object
 * ({ sessionId, title, model, messages, metadata, updatedAt }). Pure — exported
 * for tests so the document shape is locked without touching the filesystem.
 */
function formatSessionMarkdown(data) {
  const d = data || {};
  const messages = Array.isArray(d.messages) ? d.messages : [];
  const lines = [];
  lines.push(`# ${d.title || '(untitled session)'}`, '');
  lines.push(`- Session ID: ${d.sessionId || ''}`);
  if (d.model) {
    lines.push(`- Model: ${d.model}`);
  }
  lines.push(`- Messages: ${messages.length}`);
  if (d.metadata && d.metadata.cwd) {
    lines.push(`- Project: ${d.metadata.cwd}`);
  }
  if (d.updatedAt) {
    let stamp = String(d.updatedAt);
    try {
      stamp = new Date(Number(d.updatedAt)).toISOString();
    } catch {
      /* keep raw */
    }
    lines.push(`- Updated: ${stamp}`);
  }
  lines.push('', '---', '');
  for (const m of messages) {
    const role =
      m.role === 'user' ? '🧑 User' : m.role === 'assistant' ? '🤖 Assistant' : m.role || 'unknown';
    lines.push(`## ${role}`, '');
    lines.push(_mdContent(m.content));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Export a persisted session (full-fidelity Store B) to a file as Markdown
 * (default) or JSON. With no reference, exports the live session when one is
 * active, otherwise the most-recent session in scope.
 *   session export [<序号|ID>] [--format md|json] [--out <path>]
 */
function handleSessionExport(args, options = {}) {
  const fs = require('fs');
  const path = require('path');

  // Resolve the target session: explicit ref → live → most-recent.
  const ref = (args || []).map((a) => String(a)).find((a) => a && !a.startsWith('-'));
  let session = null;
  let resolveError = null;
  if (ref) {
    const r = _resolveSessionRef(ref, options);
    session = r.session;
    resolveError = r.error;
  } else {
    let liveId = null;
    try {
      liveId = require('../ai').getLiveSessionId && require('../ai').getLiveSessionId();
    } catch {
      /* ok */
    }
    if (liveId) {
      session = { sessionId: liveId, title: '' };
    } else {
      const list = _scopedSessions(options);
      if (list.length === 0) {
        resolveError = 'empty';
      } else {
        session = list[0];
      }
    }
  }

  if (!session) {
    if (options.json) {
      _emitJson({ ok: false, action: 'export', error: resolveError || 'not_found' });
      return;
    }
    printError(_refErrorMessage(resolveError || 'not_found'));
    return;
  }

  const sp = _persistence();
  const data = sp.restoreSession(session.sessionId);
  if (!data || !Array.isArray(data.messages) || data.messages.length === 0) {
    if (options.json) {
      _emitJson({
        ok: false,
        action: 'export',
        sessionId: session.sessionId,
        error: 'no_messages',
      });
      return;
    }
    printError('该会话没有可导出的消息（快照为空或不存在）。');
    return;
  }

  // Format: --format md|json (default md). `--json` is reserved for structured
  // command output, so document format is its own flag.
  const fmt = String(options.format || 'md').toLowerCase();
  const isJson = fmt === 'json';
  const short = _shortId(session.sessionId).replace(/[^\w.-]/g, '_');
  const defaultName = `khy-session-${short}.${isJson ? 'json' : 'md'}`;
  const outPath = options.out
    ? path.resolve(String(options.out))
    : path.join(process.cwd(), defaultName);

  let payload;
  try {
    // --detailed (json format only): re-attach the optional per-message
    // artifacts (_timeline/_toolCalls/_turnStats) that the restore read-side
    // whitelist strips, sourced from the raw snapshot JSON. Without the flag
    // the exported bytes stay identical to the legacy output.
    if (isJson && options.detailed) {
      const snap = _readSnapshotRaw(session.sessionId);
      if (snap && Array.isArray(snap.messages)) {
        data.messages = _attachArtifacts(data.messages, snap.messages);
      }
    }
    payload = isJson ? JSON.stringify(data, null, 2) : formatSessionMarkdown(data);
    fs.writeFileSync(outPath, payload, 'utf-8');
  } catch (e) {
    if (options.json) {
      _emitJson({ ok: false, action: 'export', sessionId: session.sessionId, error: e.message });
      return;
    }
    printError(`导出失败: ${e.message}`);
    return;
  }

  if (options.json) {
    _emitJson({
      ok: true,
      action: 'export',
      sessionId: session.sessionId,
      format: isJson ? 'json' : 'md',
      ...(isJson && options.detailed ? { detailed: true } : {}),
      messageCount: data.messages.length,
      path: outPath,
      bytes: Buffer.byteLength(payload),
    });
    return;
  }
  printSuccess(
    `会话已导出 (${data.messages.length} 条消息 · ${isJson ? 'JSON' : 'Markdown'}) → ${outPath}`
  );
}

// ── analyze ────────────────────────────────────────────────────────────────────────

/**
 * True when a message starts a NEW round — a real human user message, not a
 * tool-result carrier or a compaction meta message (both share role:'user').
 * Shares the messagePredicates SSOT with _roleLabel; gate off / leaf missing
 * → every user message counts (legacy fallback).
 */
function _isHumanUserMessage(m) {
  if (!m || m.role !== 'user') {
    return false;
  }
  try {
    const { humanTurnCountEnabled, userMessageKind } = require('../messagePredicates');
    if (humanTurnCountEnabled(process.env)) {
      const kind = userMessageKind(m);
      return kind !== 'tool' && kind !== 'meta';
    }
  } catch {
    /* fall through to legacy behaviour */
  }
  return true;
}

/**
 * Split raw snapshot messages into rounds (one per human user message) and
 * aggregate the per-round stats from the assistant messages' optional
 * _turnStats/_toolCalls artifacts. Quantities that are not truly available
 * stay null/[] — never zero-filled. Pure; exported for tests.
 * @returns {Array<{index:number, userInput:string, elapsedMs:(number|null), tools:string[], tokens:(number|null), status:('completed'|'unknown')}>}
 */
function _buildAnalysisRounds(messages) {
  const rounds = [];
  let current = null;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) {
      continue;
    }
    if (_isHumanUserMessage(m)) {
      current = {
        index: rounds.length + 1,
        userInput: _previewText(m.content, 120),
        elapsedMs: null,
        tools: [],
        tokens: null,
        status: 'unknown',
      };
      rounds.push(current);
      continue;
    }
    if (!current || m.role !== 'assistant') {
      continue;
    }
    // An assistant reply exists → the round did complete.
    current.status = 'completed';
    const stats = m._turnStats;
    if (stats && typeof stats === 'object') {
      if (Number(stats.elapsedMs) > 0) {
        current.elapsedMs = (current.elapsedMs || 0) + Number(stats.elapsedMs);
      }
      if (Number(stats.tokens) > 0) {
        current.tokens = (current.tokens || 0) + Number(stats.tokens);
      }
    }
    if (Array.isArray(m._toolCalls)) {
      for (const c of m._toolCalls) {
        if (c && c.name) {
          current.tools.push(String(c.name));
        }
      }
    }
  }
  return rounds;
}

/**
 * Aggregate round-level quantities into session metrics. Honest sums: a
 * metric stays null unless at least one round carried a real value.
 * Pure; exported for tests.
 */
function _aggregateRoundMetrics(rounds) {
  const metrics = {
    totalRounds: rounds.length,
    totalElapsedMs: null,
    toolCalls: null,
    totalTokens: null,
  };
  for (const r of rounds) {
    if (r.elapsedMs != null) {
      metrics.totalElapsedMs = (metrics.totalElapsedMs || 0) + r.elapsedMs;
    }
    if (r.tools.length > 0) {
      metrics.toolCalls = (metrics.toolCalls || 0) + r.tools.length;
    }
    if (r.tokens != null) {
      metrics.totalTokens = (metrics.totalTokens || 0) + r.tokens;
    }
  }
  return metrics;
}

/**
 * `session analyze <序号|ID> [--json]` — per-round breakdown of a persisted
 * session: elapsed time, tool usage and token spend, sourced from the RAW
 * snapshot (the restore whitelist would strip the artifact fields). Legacy
 * sessions without artifacts degrade to round splitting only.
 */
function handleSessionAnalyze(args, options = {}) {
  const { session, error } = _resolveSessionRef(args[0], options);
  if (!session) {
    if (options.json) {
      _emitJson({ ok: false, action: 'analyze', error: error || 'not_found' });
      return;
    }
    printError(_refErrorMessage(error));
    return;
  }

  // Raw snapshot first (carries _timeline/_toolCalls/_turnStats); degrade to
  // the whitelisted restore path when no snapshot is readable.
  const snap = _readSnapshotRaw(session.sessionId);
  let messages = snap && Array.isArray(snap.messages) ? snap.messages : null;
  if (!messages) {
    const data = _persistence().restoreSession(session.sessionId);
    messages = data && Array.isArray(data.messages) ? data.messages : [];
  }
  if (messages.length === 0) {
    if (options.json) {
      _emitJson({
        ok: false,
        action: 'analyze',
        sessionId: session.sessionId,
        error: 'no_messages',
      });
      return;
    }
    printError('该会话没有可分析的消息（快照为空或不存在）。');
    return;
  }

  const rounds = _buildAnalysisRounds(messages);
  const metrics = _aggregateRoundMetrics(rounds);

  if (options.json) {
    _emitJson({ ok: true, action: 'analyze', sessionId: session.sessionId, metrics, rounds });
    return;
  }

  const fmtSec = (ms) => `${(ms / 1000).toFixed(1)} 秒`;
  console.log('');
  console.log(chalk.bold(`  会话分析：${session.title || '(untitled)'}`));
  console.log(chalk.dim(`  ID ${session.sessionId} · 共 ${messages.length} 条消息`));
  console.log('');

  const parts = [`共切分出 ${metrics.totalRounds} 个回合`];
  if (metrics.totalElapsedMs != null) {
    parts.push(`累计耗时 ${fmtSec(metrics.totalElapsedMs)}`);
  }
  if (metrics.toolCalls != null) {
    parts.push(`累计调用工具 ${metrics.toolCalls} 次`);
  }
  if (metrics.totalTokens != null) {
    parts.push(`累计消耗 ${metrics.totalTokens} tokens`);
  }
  console.log(`  ${parts.join('，')}。`);
  console.log('');

  for (const r of rounds) {
    console.log(`  ${chalk.cyan(`回合 ${r.index}`)} ${_previewText(r.userInput, 60)}`);
    const detail = [];
    if (r.elapsedMs != null) {
      detail.push(`耗时 ${fmtSec(r.elapsedMs)}`);
    }
    if (r.tools.length > 0) {
      detail.push(`调用工具 ${r.tools.length} 次（${r.tools.join('、')}）`);
    }
    if (r.tokens != null) {
      detail.push(`消耗 ${r.tokens} tokens`);
    }
    detail.push(r.status === 'completed' ? '回合已完成' : '回合状态未知');
    console.log(chalk.dim(`      ${detail.join('，')}`));
  }
  console.log('');

  if (metrics.totalElapsedMs == null && metrics.toolCalls == null && metrics.totalTokens == null) {
    console.log(
      chalk.dim('  该会话缺少耗时与工具统计字段（旧版本记录），以上仅展示回合切分结果。')
    );
    console.log('');
  }
}

// ── search (existing) ──────────────────────────────────────────────────────

function handleSessionSearch(args, options = {}) {
  const query = args.join(' ').trim();
  if (!query) {
    if (options.json) {
      _emitJson({
        ok: false,
        action: 'search',
        error: 'missing_query',
        message: 'Usage: session search <query>',
      });
      return;
    }
    printError('Usage: session search <query>');
    return;
  }

  const searchIndex = require('../../services/sessionSearchIndex');
  searchIndex.init();

  if (!searchIndex.isAvailable()) {
    if (options.json) {
      _emitJson({
        ok: false,
        action: 'search',
        query,
        limit: options.limit ? parseInt(options.limit, 10) : 20,
        error: 'index_unavailable',
        message: 'Search index unavailable (better-sqlite3 not installed).',
      });
      return;
    }
    printError('Search index unavailable (better-sqlite3 not installed).');
    return;
  }

  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const results = searchIndex.searchMessages(query, { limit });

  if (options.json) {
    _emitJson({
      ok: true,
      action: 'search',
      query,
      limit,
      count: results.length,
      results,
    });
    return;
  }

  if (results.length === 0) {
    printInfo(`No results for "${query}".`);
    return;
  }

  console.log('');
  console.log(
    chalk.bold(
      `  Search Results (${results.length} ${require('../ccPlural').pluralOr(results.length, 'match', 'matches')})`
    )
  );
  console.log('');

  for (const r of results) {
    const session = r.title || r.sessionId;
    const snippet = r.content.length > 120 ? r.content.slice(0, 117) + '...' : r.content;
    console.log(`  ${chalk.cyan(session)} ${chalk.dim('[' + r.role + ']')}`);
    console.log(`    ${snippet}`);
    console.log('');
  }
}

function handleSessionStats(options = {}) {
  const searchIndex = require('../../services/sessionSearchIndex');
  searchIndex.init();

  const stats = searchIndex.getStats();

  if (options.json) {
    const dbSizeBytes = Number(stats.dbSizeBytes || 0);
    _emitJson({
      ok: !!stats.available,
      action: 'stats',
      available: !!stats.available,
      totalSessions: Number(stats.totalSessions || 0),
      totalMessages: Number(stats.totalMessages || 0),
      dbSizeBytes,
      dbSizeKB: Number((dbSizeBytes / 1024).toFixed(1)),
    });
    return;
  }

  console.log('');
  console.log(chalk.bold('  Session Search Index'));
  console.log('');
  console.log(`  Available  : ${stats.available ? chalk.green('yes') : chalk.dim('no')}`);
  console.log(`  Sessions   : ${stats.totalSessions}`);
  console.log(`  Messages   : ${stats.totalMessages}`);
  console.log(
    `  DB Size    : ${_ccFileSize(Number(stats.dbSizeBytes), `${(stats.dbSizeBytes / 1024).toFixed(1)} KB`)}`
  );
  console.log('');
}

function _printHelp() {
  console.log('');
  console.log(chalk.bold('  Session — 浏览、恢复与管理历史会话'));
  console.log('');
  console.log('  用法:');
  console.log(
    chalk.dim('    session [list]              列出最近会话（当前项目；--all 显示全部项目）')
  );
  console.log(chalk.dim('    session show <序号|ID>      查看会话元数据与最近消息'));
  console.log(
    chalk.dim('    session resume <序号|ID>    将会话恢复到当前交互上下文（别名: load）')
  );
  console.log(chalk.dim('    session rename <序号|ID> <标题>  重命名会话'));
  console.log(chalk.dim('    session delete <序号|ID>    删除会话（别名: rm）'));
  console.log(
    chalk.dim(
      '    session export [序号|ID]    导出会话到文件（--format md|json，--out <路径>，json 可加 --detailed 附带回合统计字段）'
    )
  );
  console.log(
    chalk.dim(
      '    session analyze <序号|ID>   按回合统计耗时、工具调用与 tokens（--json 输出结构化结果）'
    )
  );
  console.log(chalk.dim('    session search <query>      全文检索历史会话'));
  console.log(chalk.dim('    session stats               检索索引统计'));
  console.log('');
  console.log('  选项: --all (跨项目)  --limit <n>  --json');
  console.log('');
  console.log('  示例:');
  console.log(chalk.dim('    session list'));
  console.log(chalk.dim('    session resume 2'));
  console.log(chalk.dim('    session export 2 --format md'));
  console.log(chalk.dim('    session analyze 2 --json'));
  console.log(chalk.dim('    session rename 1 量化策略回测'));
  console.log(chalk.dim('    session search "backtest strategy"'));
  console.log('');
}

module.exports = {
  handleSessionCommand,
  // Exposed for tests / programmatic callers.
  _resolveSessionRef,
  _scopedSessions,
  formatSessionMarkdown,
  _relativeTime,
  _roleLabel,
  _ccFileSize,
  _readSnapshotRaw,
  _attachArtifacts,
  _buildAnalysisRounds,
  _aggregateRoundMetrics,
};
