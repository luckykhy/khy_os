/**
 * Memory Directory Operations — load, save, search, and index memories.
 *
 * Core operations:
 *   loadMemoryPrompt()    — Load MEMORY.md and build the system prompt section
 *   saveMemory()          — Write a memory file with proper frontmatter
 *   updateMemoryIndex()   — Update MEMORY.md index entries
 *   searchMemories()      — Simple text search across all memory files
 *   readMemory()          — Read a specific memory file
 *   deleteMemory()        — Delete a memory file and remove its index entry
 *   listMemories()        — List all memory files with their frontmatter
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  getMemoryDir,
  getMemoryIndexPath,
  getMemoryFilePath,
  ensureMemoryDirExists,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  MEMORY_INDEX_NAME,
} = require('./paths');
const writeSafety = require('../services/memoryWriteSafety');
const staleness = require('../services/memoryStaleness');
// 稳定、非有损的文件名 slug 单一真源(纯叶子,门控 KHY_MEMORY_SLUG_STABLE)。旧
// `_generateFilename` 丢弃非 ASCII → 中文名塌成 `feedback_.md` 互相碰撞 + 无幂等去重;
// 本叶子把 slug 变成 (type,name) 的确定性函数,关闭态逐字节回退旧文件名。
const memorySlug = require('./memorySlug');

// ── Frontmatter parsing ────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown file.
 *
 * @param {string} content - File content
 * @returns {{ frontmatter: object, body: string }}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlBlock = match[1];
  const body = match[2] || '';
  const frontmatter = {};

  // Simple YAML parser (key: value pairs, one per line)
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body: body.trim() };
}

/**
 * Serialize frontmatter + body into a markdown file.
 *
 * @param {object} frontmatter - { name, description, type }
 * @param {string} body        - Memory content
 * @returns {string}
 */
function serializeFrontmatter(frontmatter, body) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined && value !== null) {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '');
  if (body) {
    lines.push(body);
  }
  return lines.join('\n');
}

/**
 * Normalize an optional `tier` save option against the single source of valid
 * tiers (memoryTier.TIER_ORDER). Returns a canonical lowercase tier string, or
 * null when absent/invalid (caller then omits the frontmatter key). Fail-soft:
 * any require/lookup error ⇒ null, so a bad value never blocks a save.
 *
 * @param {*} v
 * @returns {string|null}
 */
function _normalizeTierOption(v) {
  if (v == null || v === '') return null;
  try {
    const { TIER_ORDER } = require('../services/memoryTier');
    const t = String(v).trim().toLowerCase();
    return TIER_ORDER.includes(t) ? t : null;
  } catch {
    return null;
  }
}

// ── Entrypoint truncation ──────────────────────────────────────────────

/**
 * Truncate MEMORY.md content to line and byte caps.
 *
 * Appends a warning if truncation occurred, naming which cap fired.
 * Line-truncates first (natural boundary), then byte-truncates at
 * the last newline before the cap.
 *
 * @param {string} raw
 * @returns {{ content: string, lineCount: number, byteCount: number, wasTruncated: boolean }}
 */
function truncateEntrypoint(raw) {
  const trimmed = raw.trim();
  const lines = trimmed.split('\n');
  const lineCount = lines.length;
  const byteCount = trimmed.length;

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasTruncated: false };
  }

  let truncated = wasLineTruncated
    ? lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed;

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reasons = [];
  if (wasLineTruncated) reasons.push(`${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`);
  if (wasByteTruncated) reasons.push(`${_formatBytes(byteCount)} (limit: ${_formatBytes(MAX_ENTRYPOINT_BYTES)})`);

  return {
    content: truncated + `\n\n> WARNING: ${MEMORY_INDEX_NAME} is ${reasons.join(' and ')}. Only part was loaded. Keep index entries to one line under ~150 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasTruncated: true,
  };
}

function _formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Safe writes (atomic temp+rename, read-back verify, bounded retry) ───
//
// All memory-file writes go through this single seam. The *judgment* (whether
// to retry, how long to back off, whether to read back and verify) lives in the
// pure leaf `memoryWriteSafety.js`; this function performs the actual fs IO it
// prescribes. Gate `KHY_MEMORY_WRITE_SAFETY` off ⇒ byte-identical fallback to a
// bare `fs.writeFileSync` (preserves the historical behavior exactly).
//
// On success the file is replaced atomically (write tmp → rename), so a crash
// mid-write can never leave a half-written memory. On exhaustion of retries the
// last error is thrown, preserving the existing throw-contract of saveMemory /
// updateMemoryIndex (their callers already wrap in try/catch).

/** Synchronous sleep without busy-spinning (deterministic, no IO). */
function _sleepSync(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return;
  try {
    // SharedArrayBuffer-backed wait blocks the thread for `n` ms with no spin.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  } catch {
    // Atomics/SharedArrayBuffer unavailable ⇒ skip the back-off (best-effort).
  }
}

/**
 * Write `content` to `filepath` with retry + atomic rename + read-back verify,
 * as prescribed by the memoryWriteSafety leaf.
 *
 * @param {string} filepath
 * @param {string} content
 */
function _safeWriteFileSync(filepath, content) {
  const plan = writeSafety.planWrite(process.env);

  // Gate off ⇒ exact legacy behavior (single bare write, no temp file).
  if (!plan.enabled) {
    fs.writeFileSync(filepath, content, 'utf-8');
    return;
  }

  const tmpPath = `${filepath}.tmp-${process.pid}`;
  let lastErr = null;

  for (let attempt = 1; attempt <= plan.maxAttempts; attempt++) {
    try {
      fs.writeFileSync(tmpPath, content, 'utf-8');

      if (plan.verify) {
        const readBack = fs.readFileSync(tmpPath, 'utf-8');
        if (!writeSafety.verifyMatches(readBack, content)) {
          throw Object.assign(new Error('memory write verification mismatch'), { code: 'EVERIFY' });
        }
      }

      fs.renameSync(tmpPath, filepath); // atomic replace
      return;
    } catch (err) {
      lastErr = err;
      // Clean up a partial temp file before deciding whether to retry.
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

      const code = err && err.code;
      if (!writeSafety.shouldRetry(code, attempt, plan.maxAttempts)) break;
      _sleepSync(writeSafety.backoffMs(attempt, plan.backoffBaseMs));
    }
  }

  throw lastErr || new Error(`failed to write ${filepath}`);
}

// ── Core operations ────────────────────────────────────────────────────

/**
 * Load the memory prompt for inclusion in the system prompt.
 *
 * Reads MEMORY.md, truncates if needed, and builds a prompt section
 * that includes type descriptions, save instructions, and the current index.
 *
 * @returns {string|null} Memory prompt text, or null if memory is disabled
 */
function loadMemoryPrompt() {
  if (process.env.KHY_DISABLE_MEMORY === '1' || process.env.KHY_DISABLE_MEMORY === 'true') {
    return null;
  }

  const memoryDir = getMemoryDir();
  ensureMemoryDirExists();

  const indexPath = getMemoryIndexPath();
  let indexContent = '';

  try {
    if (fs.existsSync(indexPath)) {
      indexContent = fs.readFileSync(indexPath, 'utf-8');
    }
  } catch {
    // No memory file yet
  }

  const lines = _buildMemoryLines(memoryDir);

  if (indexContent.trim()) {
    const truncated = truncateEntrypoint(indexContent);
    lines.push(`## ${MEMORY_INDEX_NAME}`, '', truncated.content);
  } else {
    lines.push(
      `## ${MEMORY_INDEX_NAME}`,
      '',
      `Your ${MEMORY_INDEX_NAME} is currently empty. When you save new memories, they will appear here.`,
    );
  }

  return lines.join('\n');
}

/**
 * Save a memory to a file with proper frontmatter.
 *
 * @param {string} type     - Memory type (user, feedback, project, reference)
 * @param {string} name     - Memory title
 * @param {string} content  - Memory body content
 * @param {object} [options]
 * @param {string} [options.description] - One-line description for relevance
 * @param {string} [options.filename]    - Custom filename (auto-generated if omitted)
 * @param {string} [options.tier]        - Retention tier (short_term|cross_session|permanent).
 *                                          Omitted ⇒ not written; readers derive it from `type`
 *                                          via memoryTier.classifyTier (backward compatible).
 * @returns {{ filename: string, filepath: string }}
 */
function saveMemory(type, name, content, options = {}) {
  const VALID_TYPES = ['user', 'feedback', 'project', 'reference'];
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid memory type: ${type}. Valid: ${VALID_TYPES.join(', ')}`);
  }

  ensureMemoryDirExists();

  const description = options.description || name;
  // 幂等去重(门控 KHY_MEMORY_SLUG_STABLE):未显式指定 filename 时,先按规范化记忆键
  // 扫描既有文件——若某文件的 frontmatter.name 与本次 (type,name) 规范化后相同,复用它
  // 的文件名(覆盖而非新建),从而把历史遗留的孪生副本收敛到一个文件。best-effort,
  // 任何异常 → 回落到确定性文件名生成,绝不阻断写入。
  let filename = options.filename;
  if (!filename) {
    filename = _findExistingMemoryFilename(type, name);
  }
  if (!filename) {
    filename = _generateFilename(type, name);
  }
  const filepath = getMemoryFilePath(filename);

  // tier 仅在显式提供且合法时写入;否则留空,由读取侧从 type 确定性派生(无迁移)。
  const tier = _normalizeTierOption(options.tier);

  // updated: per-memory 最后更新时间戳(P1.3)。门控关 ⇒ 不写,字节回退到旧行为;
  // 读取侧缺该键时回退到文件 mtime(向后兼容)。允许调用方显式传 updated 覆盖(便于测试)。
  const updated = staleness.isEnabled(process.env)
    ? (options.updated || new Date().toISOString())
    : null;

  const fileContent = serializeFrontmatter(
    { name, description, type, ...(tier ? { tier } : {}), ...(updated ? { updated } : {}) },
    content,
  );

  _safeWriteFileSync(filepath, fileContent);

  return { filename, filepath };
}

/**
 * Read a memory file and parse its frontmatter.
 *
 * @param {string} filename - Memory file name
 * @returns {{ frontmatter: object, body: string, exists: boolean }}
 */
function readMemory(filename) {
  const filepath = getMemoryFilePath(filename);

  try {
    if (!fs.existsSync(filepath)) {
      return { frontmatter: {}, body: '', exists: false };
    }
    const content = fs.readFileSync(filepath, 'utf-8');
    const parsed = parseFrontmatter(content);
    return { ...parsed, exists: true };
  } catch {
    return { frontmatter: {}, body: '', exists: false };
  }
}

/**
 * Delete a memory file and optionally remove its index entry.
 *
 * @param {string} filename
 * @param {object} [options]
 * @param {boolean} [options.updateIndex=true] - Remove entry from MEMORY.md
 * @returns {boolean} true if the file existed and was deleted
 */
function deleteMemory(filename, options = {}) {
  const filepath = getMemoryFilePath(filename);
  const updateIndex = options.updateIndex !== false;

  try {
    if (!fs.existsSync(filepath)) return false;
    fs.unlinkSync(filepath);

    if (updateIndex) {
      _removeFromIndex(filename);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Update the MEMORY.md index file.
 *
 * @param {Array<{title: string, filename: string, description: string}>} entries
 *   New entries to add/update. Existing entries with the same filename are replaced.
 */
function updateMemoryIndex(entries) {
  ensureMemoryDirExists();

  const indexPath = getMemoryIndexPath();
  let existingContent = '';

  try {
    if (fs.existsSync(indexPath)) {
      existingContent = fs.readFileSync(indexPath, 'utf-8');
    }
  } catch {
    existingContent = '';
  }

  // Parse existing entries
  const existingLines = existingContent.split('\n').filter(l => l.trim());
  const existingMap = new Map();

  for (const line of existingLines) {
    const match = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      existingMap.set(match[2], line);
    } else if (line.trim()) {
      // Preserve non-link lines (headers, etc.)
      existingMap.set(`__raw_${existingMap.size}`, line);
    }
  }

  // Add/update entries
  for (const entry of entries) {
    const line = `- [${entry.title}](${entry.filename}) — ${entry.description}`;
    existingMap.set(entry.filename, line);
  }

  // Write back
  const newContent = Array.from(existingMap.values()).join('\n') + '\n';
  _safeWriteFileSync(indexPath, newContent);
}

/**
 * Search across all memory files for a query string.
 *
 * Performs a case-insensitive text search through both frontmatter
 * and body content of all .md files in the memory directory.
 *
 * @param {string} query - Search string
 * @returns {Array<{filename: string, frontmatter: object, matches: string[]}>}
 */
function searchMemories(query) {
  if (!query || typeof query !== 'string') return [];

  const memoryDir = getMemoryDir();
  const results = [];
  const lowerQuery = query.toLowerCase();

  try {
    if (!fs.existsSync(memoryDir)) return [];

    const files = fs.readdirSync(memoryDir)
      .filter(f => f.endsWith('.md') && f !== MEMORY_INDEX_NAME);

    for (const filename of files) {
      try {
        const filepath = path.join(memoryDir, filename);
        const content = fs.readFileSync(filepath, 'utf-8');
        const lowerContent = content.toLowerCase();

        if (!lowerContent.includes(lowerQuery)) continue;

        const parsed = parseFrontmatter(content);
        const lines = content.split('\n');
        const matches = [];

        for (const line of lines) {
          if (line.toLowerCase().includes(lowerQuery)) {
            matches.push(line.trim());
          }
        }

        results.push({
          filename,
          frontmatter: parsed.frontmatter,
          matches,
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory unreadable
  }

  return results;
}

/**
 * List all memory files with their frontmatter metadata.
 *
 * @returns {Array<{filename: string, frontmatter: object, size: number, modifiedAt: Date}>}
 */
function listMemories() {
  const memoryDir = getMemoryDir();
  const results = [];

  try {
    if (!fs.existsSync(memoryDir)) return [];

    const files = fs.readdirSync(memoryDir)
      .filter(f => f.endsWith('.md') && f !== MEMORY_INDEX_NAME);

    for (const filename of files) {
      try {
        const filepath = path.join(memoryDir, filename);
        const stat = fs.statSync(filepath);
        const content = fs.readFileSync(filepath, 'utf-8');
        const parsed = parseFrontmatter(content);

        results.push({
          filename,
          frontmatter: parsed.frontmatter,
          size: stat.size,
          modifiedAt: stat.mtime,
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory unreadable
  }

  return results.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

// ── On-demand relevance recall (load-path #2) ──────────────────────────

/**
 * Tokenize text for keyword-overlap scoring.
 *
 * Latin runs of length >= 2 and individual CJK ideographs become tokens.
 * This keeps the selector dependency-free while remaining usable for the
 * mixed zh/en content KHY-OS memories typically contain.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function _tokenizeForRecall(text) {
  const set = new Set();
  const lower = String(text || '').toLowerCase();
  const latin = lower.match(/[a-z0-9]+/g) || [];
  for (const t of latin) {
    if (t.length >= 2) set.add(t);
  }
  const cjk = lower.match(/[一-鿿]/g) || [];
  for (const c of cjk) set.add(c);
  return set;
}

/** Count how many query tokens appear in a field's token set. */
function _overlapCount(queryTokens, fieldTokens) {
  let n = 0;
  for (const t of queryTokens) {
    if (fieldTokens.has(t)) n++;
  }
  return n;
}

/**
 * Select memory files most relevant to a query, ranked and capped.
 *
 * This is the deterministic keyword-fallback core of the "load relevant
 * memories on demand" path: it scores every memory file by weighted token
 * overlap (name x3, description x2, type x1, body x1), keeps entries scoring
 * at or above `minScore`, and returns at most `limit` of them sorted by score.
 *
 * Pure and side-effect free — suitable for prefetch and unit testing.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=5]    - Maximum number of memories to return
 * @param {number} [opts.minScore=1] - Minimum overlap score to qualify
 * @param {Set<string>|Array<string>} [opts.exclude] - filenames to skip (already
 *   surfaced elsewhere this turn). Default empty ⇒ byte-identical to prior behavior.
 * @returns {Array<{filename: string, frontmatter: object, body: string, score: number}>}
 */
function selectRelevantMemories(query, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 5;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 1;
  const exclude = opts.exclude instanceof Set
    ? opts.exclude
    : (Array.isArray(opts.exclude) ? new Set(opts.exclude) : null);

  const queryTokens = _tokenizeForRecall(query);
  if (queryTokens.size === 0) return [];

  // Symmetric recall-token enrichment (CJK bigrams + canonical alias sentinels):
  // enrich the query and each field with the SAME transform so cross-language /
  // term matches surface, while overlap can only grow (monotonic superset). Gate
  // off / any error ⇒ enrichTokens returns a copy of the base set ⇒ byte-identical
  // to the prior keyword-overlap behavior. Lazy-required (zero-dep pure leaf) so
  // early bootstrap that pulls in memdir never depends on it.
  let _enrich;
  try { _enrich = require('../services/memoryEngine/memoryRecallTokens').enrichTokens; }
  catch { _enrich = (t) => t; }
  const qTokens = _enrich(queryTokens, query);
  const ef = (t) => _enrich(_tokenizeForRecall(t), t);

  const scored = [];
  for (const entry of listMemories()) {
    if (exclude && exclude.has(entry.filename)) continue;
    const parsed = readMemory(entry.filename);
    if (!parsed.exists) continue;
    const fm = parsed.frontmatter || {};
    const score =
      _overlapCount(qTokens, ef(fm.name)) * 3 +
      _overlapCount(qTokens, ef(fm.description)) * 2 +
      _overlapCount(qTokens, ef(fm.type)) * 1 +
      _overlapCount(qTokens, ef(parsed.body)) * 1;
    if (score < minScore) continue;
    scored.push({ filename: entry.filename, frontmatter: fm, body: parsed.body, score });
  }

  scored.sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename));
  return scored.slice(0, limit);
}

/**
 * Build an injectable block of full memory bodies relevant to a query.
 *
 * Loads the top-ranked memories (see selectRelevantMemories) and concatenates
 * their bodies under their titles, bounded by a total character budget so the
 * block cannot blow up the turn. Returns null when memory is disabled, the
 * query is empty, or nothing relevant is found.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit]    - Max memories (default env KHY_MEMORY_RECALL_LIMIT or 5)
 * @param {number} [opts.maxChars] - Total char budget (default env KHY_MEMORY_RECALL_CHARS or 4000)
 * @param {number} [opts.minScore] - Minimum overlap score to qualify
 * @param {Set<string>|Array<string>} [opts.exclude] - filenames to skip (already
 *   surfaced elsewhere this turn). Default empty ⇒ byte-identical to prior behavior.
 * @returns {string|null}
 */
function loadRelevantMemories(query, opts = {}) {
  if (process.env.KHY_DISABLE_MEMORY === '1' || process.env.KHY_DISABLE_MEMORY === 'true') {
    return null;
  }

  const envLimit = parseInt(process.env.KHY_MEMORY_RECALL_LIMIT || '', 10);
  const envChars = parseInt(process.env.KHY_MEMORY_RECALL_CHARS || '', 10);
  const limit = Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.floor(opts.limit)
    : (Number.isFinite(envLimit) && envLimit > 0 ? envLimit : 5);
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0
    ? Math.floor(opts.maxChars)
    : (Number.isFinite(envChars) && envChars > 0 ? envChars : 4000);

  let selected;
  try {
    selected = selectRelevantMemories(query, { limit, minScore: opts.minScore, exclude: opts.exclude });
  } catch {
    return null;
  }
  if (!selected || selected.length === 0) return null;

  const blocks = [];
  let used = 0;
  const nowMs = Date.now();
  for (const mem of selected) {
    const title = String(mem.frontmatter.name || mem.filename);
    const body = String(mem.body || '').trim();
    if (!body) continue;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const clippedBody = body.length > remaining
      ? body.slice(0, remaining).trimEnd() + ' …'
      : body;

    // P1.3 过期标注(非侵入):用 frontmatter.updated,缺失则回退文件 mtime;判定全在纯叶子。
    let staleNote = '';
    try {
      let updatedMs = staleness.parseUpdatedMs(mem.frontmatter.updated);
      if (updatedMs == null) {
        try { updatedMs = fs.statSync(getMemoryFilePath(mem.filename)).mtimeMs; } catch { /* ignore */ }
      }
      const assessment = staleness.assessStaleness(
        { type: mem.frontmatter.type, updatedMs, nowMs }, process.env,
      );
      staleNote = staleness.formatStaleNote(assessment);
    } catch { /* fail-soft: no annotation */ }

    const block = staleNote
      ? `### ${title} (${mem.filename})\n${staleNote}\n${clippedBody}`
      : `### ${title} (${mem.filename})\n${clippedBody}`;
    blocks.push(block);
    used += block.length;
    if (used >= maxChars) break;
  }

  if (blocks.length === 0) return null;
  return blocks.join('\n\n');
}

// ── Internal helpers ───────────────────────────────────────────────────

/**
 * Build the memory prompt lines (without MEMORY.md content).
 * @param {string} memoryDir
 * @returns {string[]}
 */
function _buildMemoryLines(memoryDir) {
  return [
    '# Memory System',
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`.`,
    'This directory already exists — write to it directly (do not run mkdir or check for its existence).',
    '',
    'Build up this memory over time so that future conversations have a complete picture of who the user is,',
    'how they want to collaborate, what behaviors to avoid or repeat, and the context behind the work.',
    '',
    'If the user explicitly asks you to remember something, save it immediately.',
    'If they ask you to forget something, find and remove the relevant entry.',
    '',
    '## Types of memory',
    '',
    '<types>',
    '<type>',
    '    <name>user</name>',
    '    <description>Information about the user\'s role, goals, responsibilities, and knowledge. Tailor future behavior to their preferences and perspective.</description>',
    '    <when_to_save>When you learn details about the user\'s role, preferences, responsibilities, or knowledge.</when_to_save>',
    '</type>',
    '<type>',
    '    <name>feedback</name>',
    '    <description>Guidance about how to approach work — corrections AND confirmations. Record from failure AND success to remain coherent.</description>',
    '    <when_to_save>When the user corrects your approach OR confirms a non-obvious approach worked.</when_to_save>',
    '</type>',
    '<type>',
    '    <name>project</name>',
    '    <description>Non-derivable context about ongoing work, goals, deadlines, and decisions. Not code patterns — those are in the codebase.</description>',
    '    <when_to_save>When you learn who is doing what, why, or by when. Convert relative dates to absolute dates.</when_to_save>',
    '</type>',
    '<type>',
    '    <name>reference</name>',
    '    <description>Pointers to external systems (dashboards, ticket trackers, Slack channels, documentation).</description>',
    '    <when_to_save>When you learn about resources in external systems and their purpose.</when_to_save>',
    '</type>',
    '</types>',
    '',
    '## What NOT to save in memory',
    '',
    '- Code patterns, architecture, file paths — derivable from the codebase.',
    '- Git history — git log / git blame are authoritative.',
    '- Debugging solutions — the fix is in the code.',
    '- Anything in project instruction files (CLAUDE.md / khy.md).',
    '- Ephemeral task details or temporary state.',
    '',
    '## How to save memories',
    '',
    'Saving a memory is a two-step process:',
    '',
    '**Step 1** — Write the memory to its own file with frontmatter:',
    '',
    '```markdown',
    '---',
    'name: {{memory name}}',
    'description: {{one-line description}}',
    'type: {{user, feedback, project, reference}}',
    '---',
    '',
    '{{memory content}}',
    '```',
    '',
    `**Step 2** — Add a pointer in \`${MEMORY_INDEX_NAME}\`. Each entry should be one line, under ~150 chars:`,
    '`- [Title](file.md) — one-line hook`',
    '',
    `\`${MEMORY_INDEX_NAME}\` is always loaded into context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated.`,
    '',
    '## When to access memories',
    '',
    '- When memories seem relevant, or the user references prior-conversation work.',
    '- You MUST access memory when the user explicitly asks.',
    '- Memory records can become stale — verify against current state before acting on them.',
    '',
    '## Before recommending from memory',
    '',
    'A memory that names a specific file, function, or flag is a claim about what existed *when the memory was written*.',
    'Before recommending it: check the file exists, grep for the function, verify the flag.',
    '',
  ];
}

/**
 * Generate a filename from type and name.
 * @param {string} type
 * @param {string} name
 * @returns {string}
 */
function _generateFilename(type, name) {
  // 委托稳定 slug 叶子:纯 ASCII 干净名逐字节等价旧实现;非 ASCII/退化名追加确定性
  // 短哈希避免碰撞;门控关或异常 → 叶子内部回退旧 `${type}_${legacySlug}.md`。
  try {
    return memorySlug.buildMemoryFilename(type, name, { env: process.env });
  } catch {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9_\-\s]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 50);
    return `${type}_${slug}.md`;
  }
}

/**
 * 幂等去重扫描:找一个既有记忆文件,其 frontmatter.name 与本次 (type,name) 规范化后
 * 相同(同一 memoryKey),用于「同一事实再次写入 → 复用同一文件」以收敛历史孪生副本。
 *
 * 门控 KHY_MEMORY_SLUG_STABLE 关 → 返回 null(不介入,保持旧「总是新建」行为)。
 * best-effort:目录不可读 / 无匹配 / 任何异常 → null。绝不抛。
 *
 * @param {string} type
 * @param {string} name
 * @returns {string|null} 匹配到的既有文件名,或 null
 */
function _findExistingMemoryFilename(type, name) {
  try {
    if (!memorySlug.slugGateEnabled(process.env)) return null;
    const wantKey = memorySlug.memoryKey(type, name);
    const memoryDir = getMemoryDir();
    if (!fs.existsSync(memoryDir)) return null;
    const files = fs.readdirSync(memoryDir)
      .filter(f => f.endsWith('.md') && f !== MEMORY_INDEX_NAME);
    for (const filename of files) {
      try {
        const content = fs.readFileSync(path.join(memoryDir, filename), 'utf-8');
        const parsed = parseFrontmatter(content);
        const fm = parsed && parsed.frontmatter ? parsed.frontmatter : {};
        if (!fm.name || !fm.type) continue;
        // 仅在同 type 下比对,避免跨类型误并;键含 type 规范化冗余保护。
        if (memorySlug.memoryKey(fm.type, fm.name) === wantKey) return filename;
      } catch {
        // 跳过不可读文件
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove a filename's entry from MEMORY.md.
 * @param {string} filename
 */
function _removeFromIndex(filename) {
  const indexPath = getMemoryIndexPath();
  try {
    if (!fs.existsSync(indexPath)) return;
    const content = fs.readFileSync(indexPath, 'utf-8');
    const lines = content.split('\n');
    const filtered = lines.filter(line => !line.includes(`(${filename})`));
    if (filtered.length !== lines.length) {
      _safeWriteFileSync(indexPath, filtered.join('\n'));
    }
  } catch {
    // Best effort
  }
}

// ── Project-scoped memory (human-readable MEMORY.md contract) ──────────────
// Thin IO shell over the pure-leaf projectMemoryContract.js. Global/user memory
// already maintains a MEMORY.md; the per-project memory dir (getProjectMemoryDir,
// sha256-hashed by project root) historically had none — these seed/read it.

/**
 * Ensure the project memory dir exists and holds a maintainable MEMORY.md contract.
 * Idempotent: never overwrites an existing index. Honors the KHY_PROJECT_MEMORY
 * gate (off ⇒ no-op, nothing created). Best-effort; never throws.
 *
 * @param {string} [projectRoot] - defaults to cwd (resolved by getProjectMemoryDir)
 * @returns {{ dir:string, indexPath:string, created:boolean, enabled:boolean }}
 */
function ensureProjectMemoryIndex(projectRoot) {
  const { getProjectMemoryDir } = require('./paths');
  const contract = require('./projectMemoryContract');
  const dir = getProjectMemoryDir(projectRoot);
  const indexPath = path.join(dir, MEMORY_INDEX_NAME);
  const enabled = contract.isEnabled(process.env);
  if (!enabled) return { dir, indexPath, created: false, enabled: false };
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(indexPath)) return { dir, indexPath, created: false, enabled: true };
    const seed = contract.buildProjectMemoryIndexContract({
      projectRoot: projectRoot || process.cwd(),
      memoryDir: dir,
    });
    _safeWriteFileSync(indexPath, seed);
    return { dir, indexPath, created: true, enabled: true };
  } catch {
    return { dir, indexPath, created: false, enabled: true };
  }
}

/**
 * Summarize the project memory state (dir, whether the contract exists, entry count).
 * Read-only; never throws.
 *
 * @param {string} [projectRoot]
 * @returns {{ projectRoot:string, memoryDir:string, indexPath:string, indexExists:boolean, entryCount:number }}
 */
function getProjectMemorySummary(projectRoot) {
  const { getProjectMemoryDir } = require('./paths');
  const contract = require('./projectMemoryContract');
  const root = projectRoot || process.cwd();
  const dir = getProjectMemoryDir(root);
  const indexPath = path.join(dir, MEMORY_INDEX_NAME);
  let indexExists = false;
  let entryCount = 0;
  try {
    if (fs.existsSync(indexPath)) {
      indexExists = true;
      entryCount = contract.countIndexEntries(fs.readFileSync(indexPath, 'utf-8'));
    }
  } catch {
    // best effort
  }
  return { projectRoot: root, memoryDir: dir, indexPath, indexExists, entryCount };
}

/**
 * Load the per-project MEMORY.md as a system-prompt section, mirroring the global
 * `loadMemoryPrompt()`. This closes the long-standing asymmetry the user named
 * ("仓库记忆…没把握主动调用的时机"): the project memory dir has full WRITE tooling
 * (`ensureProjectMemoryIndex` seeds a maintainable contract, `/memory project` is the
 * human entry point) but historically had **no automatic recall** — whatever a user
 * curated there never reached the model, while the global MEMORY.md was injected every
 * turn. This is the read side of that contract.
 *
 * Semantics (deliberately conservative — never spends tokens on nothing):
 *   - Honors `KHY_DISABLE_MEMORY` (global master off ⇒ null) and the project gate
 *     `KHY_PROJECT_MEMORY` (off ⇒ null, byte-identical to pre-existing behavior).
 *   - Returns null unless the project MEMORY.md exists AND carries at least one real
 *     pointer entry (`- [..](..)`). A freshly-seeded contract with zero entries is the
 *     empty template — injecting it would waste context and teach nothing, so we skip
 *     it. Only a populated project index is surfaced.
 *   - Truncates with the same `truncateEntrypoint` budget as the global index.
 *   - Never throws (best-effort); any IO error ⇒ null.
 *
 * @param {string} [projectRoot] - defaults to cwd (resolved by getProjectMemoryDir)
 * @returns {string|null} A tagged prompt section, or null when nothing to inject.
 */
function loadProjectMemoryPrompt(projectRoot) {
  if (process.env.KHY_DISABLE_MEMORY === '1' || process.env.KHY_DISABLE_MEMORY === 'true') {
    return null;
  }
  try {
    const { getProjectMemoryDir } = require('./paths');
    const contract = require('./projectMemoryContract');
    if (!contract.isEnabled(process.env)) return null;

    const root = projectRoot || process.cwd();
    const dir = getProjectMemoryDir(root);
    const indexPath = path.join(dir, MEMORY_INDEX_NAME);
    if (!fs.existsSync(indexPath)) return null;

    const raw = String(fs.readFileSync(indexPath, 'utf-8') || '');
    // Only surface an index that actually holds curated pointers; the bare seed
    // (0 entries) is the empty template and must not cost context.
    if (contract.countIndexEntries(raw) < 1) return null;

    const { content } = truncateEntrypoint(raw);
    return [
      '# 项目记忆 (Project Memory)',
      '',
      `This is the **project-scoped** memory for the current working directory (\`${root}\`),`,
      'isolated per project root. It is background context maintained by the user;',
      'the latest explicit user instructions always win. Global/user memory is separate.',
      '',
      content,
    ].join('\n');
  } catch {
    return null; // recall is best-effort — never breaks prompt assembly
  }
}

// ── Project-scoped progress log (append-only checkpoints) ──────────────────
// The write→resume loop the user named ("建考公文件夹让 khy 教我学习,但记不住学到哪,
// 下次又从头开始,无法形成闭环") breaks because (a) auto-save only regexes the user's
// literal message, (b) the model is told NOT to save in-progress state, and (c) project
// memory has recall but no programmatic writer. These two functions are the IO shell over
// the pure-leaf progressLog.js: append a checkpoint, and load the "where you left off"
// recall section. Deliberately a SEPARATE file (PROGRESS.md) from the human-curated
// MEMORY.md, so the anti-noise contract there stays intact.

const PROGRESS_INDEX_NAME = 'PROGRESS.md';

/**
 * Append one progress checkpoint to the per-project PROGRESS.md (append-only, never
 * overwrites history). Honors KHY_DISABLE_MEMORY + KHY_PROGRESS_LOG. Best-effort;
 * never throws. The clock is read HERE (IO layer) and injected into the pure leaf.
 *
 * @param {object} entry
 * @param {string} entry.topic    - learning/work track (e.g. "考公-行测")
 * @param {string} entry.covered  - what was covered/learned this session
 * @param {string} [entry.next]   - the next step to resume from
 * @param {string} [projectRoot]  - defaults to cwd
 * @returns {{ ok:boolean, path:string, enabled:boolean, created:boolean }}
 */
function appendProjectProgress(entry, projectRoot) {
  const { getProjectMemoryDir } = require('./paths');
  const progress = require('../services/memoryEngine/progressLog');
  const dir = getProjectMemoryDir(projectRoot);
  const filePath = path.join(dir, PROGRESS_INDEX_NAME);
  if (!progress.isEnabled(process.env)) {
    return { ok: false, path: filePath, enabled: false, created: false };
  }
  try {
    const o = entry && typeof entry === 'object' ? entry : {};
    const nowIso = new Date().toISOString();
    const block = progress.formatProgressEntry({
      topic: o.topic, covered: o.covered, next: o.next, nowIso,
    });
    if (!block) return { ok: false, path: filePath, enabled: true, created: false };

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let created = false;
    let existing = '';
    if (fs.existsSync(filePath)) {
      try { existing = String(fs.readFileSync(filePath, 'utf-8') || ''); } catch { existing = ''; }
    }
    if (!existing) { existing = progress.PROGRESS_HEADER; created = true; }
    _safeWriteFileSync(filePath, existing + block);
    return { ok: true, path: filePath, enabled: true, created };
  } catch {
    return { ok: false, path: filePath, enabled: true, created: false };
  }
}

/**
 * Load the "where you left off" recall section for session-start injection: the latest
 * checkpoint per topic from the per-project PROGRESS.md. Query-INDEPENDENT (this is the
 * gap priming/keyword recall cannot fill — a fresh session has no query yet). Honors
 * KHY_DISABLE_MEMORY + KHY_PROGRESS_LOG + KHY_PROGRESS_LOG_RECALL. Returns null when the
 * feature is off, the file is missing, or it holds no checkpoints (byte-identical to the
 * prior no-injection behavior). Never throws.
 *
 * @param {string} [projectRoot] - defaults to cwd
 * @returns {string|null}
 */
function loadProjectProgressPrompt(projectRoot) {
  try {
    const progress = require('../services/memoryEngine/progressLog');
    if (!progress.isRecallEnabled(process.env)) return null;
    const { getProjectMemoryDir } = require('./paths');
    const filePath = path.join(getProjectMemoryDir(projectRoot), PROGRESS_INDEX_NAME);
    if (!fs.existsSync(filePath)) return null;
    const raw = String(fs.readFileSync(filePath, 'utf-8') || '');
    const latest = progress.latestPerTopic(progress.parseProgressEntries(raw));
    if (!latest.length) return null;
    return progress.renderProgressRecall(latest);
  } catch {
    return null; // recall is best-effort — never breaks prompt assembly
  }
}

module.exports = {
  loadMemoryPrompt,
  saveMemory,
  readMemory,
  deleteMemory,
  updateMemoryIndex,
  searchMemories,
  selectRelevantMemories,
  loadRelevantMemories,
  listMemories,
  parseFrontmatter,
  serializeFrontmatter,
  truncateEntrypoint,
  ensureProjectMemoryIndex,
  getProjectMemorySummary,
  loadProjectMemoryPrompt,
  appendProjectProgress,
  loadProjectProgressPrompt,
  // Scoring primitives exposed for the proactive memory engine so it reuses the
  // exact same tokenizer/overlap math instead of duplicating it.
  _tokenizeForRecall,
  _overlapCount,
};
