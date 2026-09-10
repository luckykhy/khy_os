'use strict';

/**
 * tasteService.js — user "taste" preferences (cmdc taste protocol).
 *
 * Mirrors the on-disk shape and progressive-disclosure rules of the Command
 * Code taste system:
 *   ~/.khyos/taste/
 *     taste.md                      main file, inline (≤5 items per category)
 *     <category>/taste.md           overflow file when a category exceeds 5
 *
 * Each item is a single line of the form
 *     - <preference text>. Confidence: 0.xx
 * Confidence is a 0..1 number bumped/dropped by user feedback. When the system
 * prompt reads taste in, items below the threshold are filtered out (default
 * 0.6) so weakly-attested preferences don't steer the model.
 *
 * Pure leaf module — no env, no module state, no IO at import time. File I/O
 * happens only on demand. The injection scanner reuses
 * instructionFileService.scanForPromptInjection to fail-closed on any flagged
 * line; matches mirror personaService's pattern.
 *
 * Concurrency: writes are atomic (tmp + rename, single-volume) and preceded by
 * a single .bak rotation. There is no in-process cache, so reads always see
 * the latest disk state — important for the CLI and the prompt assembler
 * reading the same files in the same turn.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────────

const TASTE_VERSION = 1;

// 8000 chars matches personaService's MAX_PERSONA_CHARS — keeps the system
// prompt section bounded and predictable for downstream injection.
const MAX_TASTE_FILE_CHARS = 8000;
const MAX_ITEM_CHARS = 500;
const MAX_CATEGORIES = 50;
// Progressive disclosure: each category keeps ≤5 items inline. The 6th
// triggers automatic relocation to <category>/taste.md.
const INLINE_ITEMS_PER_CATEGORY = 5;
// Confidence filter applied at read time. Items below this are dropped from
// the system-prompt section; they remain on disk so the user can still see
// them via `khy taste list`.
const DEFAULT_CONFIDENCE_FLOOR = 0.6;

// ── Path resolution (lazy, portable-aware) ───────────────────────────────

function _tasteDir() {
  // Taste belongs to the khyos base layer (alongside learningProfile, vault,
  // memory) — use getBaseDataDir so it resolves to ~/.khyos/taste and
  // survives a pip install / wheel upgrade.
  try {
    const { getBaseDataDir } = require('../utils/dataHome');
    return getBaseDataDir('taste');
  } catch {
    return path.join(os.homedir(), '.khyos', 'taste');
  }
}

function _mainFile() {
  return path.join(_tasteDir(), 'taste.md');
}

function _categoryDir(category) {
  return path.join(_tasteDir(), _safeCategorySegment(category));
}

function _categoryFile(category) {
  return path.join(_categoryDir(category), 'taste.md');
}

// ── Command Code 项目级 taste 路径（双向共享）──────────────────────────
// Command Code 存储在 .commandcode/taste/（项目级），khy-os 存储在 ~/.khyos/taste/（用户级）。
// 两者格式完全相同（`- <text>. Confidence: 0.xx`），可互相读写。

/**
 * 获取 Command Code 项目级 taste 目录。
 * 查找当前工作目录向上遍历的 .commandcode/taste/ 目录。
 * @returns {string|null} 项目级 taste 目录路径，未找到返回 null
 */
function _projectTasteDir() {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.commandcode', 'taste');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function _projectMainFile() {
  const dir = _projectTasteDir();
  return dir ? path.join(dir, 'taste.md') : null;
}

function _projectCategoryFile(category) {
  const dir = _projectTasteDir();
  return dir ? path.join(dir, _safeCategorySegment(category), 'taste.md') : null;
}

function _safeCategorySegment(category) {
  // Filenames only — no traversal, no separators, no unicode surprises.
  const cleaned = String(category || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'general';
}

function _ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
}

function _nowIso() {
  return new Date().toISOString();
}

// ── Parsing ──────────────────────────────────────────────────────────────

// Match: "- <text>. Confidence: 0.xx"
// The on-disk protocol uses a single ASCII "." as the anchor (added by
// serializeTasteText). addPreference strips any trailing sentence
// terminator before persisting, so we keep parse strict here.
const ITEM_RE = /^-\s+(.+?)\.\s+Confidence:\s*([0-9](?:\.[0-9]+)?)\s*$/i;
// Category reference (progressive disclosure): "## <name>" header in main
// (inline section) or "See [path]" line (overflow ref). The leading "##"
// keeps the header a Markdown H2 so the file renders cleanly in viewers.
const CATEGORY_HEADER_RE = /^##\s+([a-z0-9][a-z0-9_-]*)\s*$/i;
const CATEGORY_SEE_RE = /^See\s+\[.*?\]\(\.\/(.+?)\/taste\.md\)\s*$/i;
// Comment / blank lines are ignored at parse time.
const COMMENT_RE = /^\s*(?:<!--.*?-->)?\s*$/;

/**
 * Parse a taste.md file. Returns items grouped by category plus overflow
 * refs. Items before any `## <cat>` header live in 'general' (preserves
 * the legacy single-pool format).
 *
 * @param {string} text
 * @returns {{ items: Array<{category: string, text: string, confidence: number}>, refs: string[] }}
 */
function parseTasteText(text) {
  const items = [];
  const refs = [];
  if (typeof text !== 'string' || !text) {
    return { items, refs };
  }
  let currentCat = 'general';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (COMMENT_RE.test(line)) {
      continue;
    }
    if (line.startsWith('## ')) {
      const m = CATEGORY_HEADER_RE.exec(line);
      if (m) {
        currentCat = m[1];
      }
      continue;
    }
    if (line.startsWith('# ')) {
      // Top-level title — ignored but consumed so it doesn't fall through.
      continue;
    }
    if (line.startsWith('See ')) {
      const m = CATEGORY_SEE_RE.exec(line);
      if (m) {
        refs.push(m[1]);
      }
      continue;
    }
    if (line.startsWith('- ')) {
      const m = ITEM_RE.exec(line);
      if (m) {
        const txt = m[1].trim().slice(0, MAX_ITEM_CHARS);
        const conf = Number.parseFloat(m[2]);
        if (txt && Number.isFinite(conf) && conf >= 0 && conf <= 1) {
          items.push({ category: currentCat, text: txt, confidence: conf });
        }
      }
    }
  }
  return { items, refs };
}

/**
 * Serialize items + categories into a taste.md body. Trims the inline list
 * to at most INLINE_ITEMS_PER_CATEGORY items and emits a "See [path]"
 * reference for overflow categories.
 *
 * @param {Map<string, Array<{text: string, confidence: number}>>} byCategory
 * @returns {string}
 */
function serializeTasteText(byCategory) {
  const lines = [];
  // For overflow cats, addPreference sets the entry to a single object
  // `{ __overflow: true, head: Array }` so the main file can still show
  // the strongest 5 inline (with a "See" line to the full <cat>/taste.md).
  // For pure-inline cats, the entry is a plain array of items.
  const inlineCats = [];
  const overflowCats = [];
  for (const [cat, value] of byCategory.entries()) {
    if (value && typeof value === 'object' && value.__overflow) {
      overflowCats.push(cat);
    } else if (Array.isArray(value) && value.length > 0) {
      inlineCats.push(cat);
    }
  }
  const sortAlpha = (a, b) => a.localeCompare(b);
  inlineCats.sort(sortAlpha);
  overflowCats.sort(sortAlpha);

  for (const cat of inlineCats) {
    const items = byCategory.get(cat) || [];
    // Inline items get a `## <cat>` header so parseTasteText can recover the
    // category. We skip the header for the implicit "general" category when
    // it's the only category (single-pool case) to keep the file visually
    // clean.
    if (cat !== 'general' || inlineCats.length + overflowCats.length > 1) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(`## ${cat}`);
    }
    for (const it of items) {
      // Protocol: `- <text>. Confidence: <0.xx>`. addPreference strips any
      // trailing sentence terminator before persisting, so we can safely
      // re-add a single ASCII "." here.
      lines.push(`- ${it.text}. Confidence: ${it.confidence.toFixed(2)}`);
    }
  }
  for (const cat of overflowCats) {
    const { head } = byCategory.get(cat);
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(`## ${cat}`);
    for (const it of head) {
      lines.push(`- ${it.text}. Confidence: ${it.confidence.toFixed(2)}`);
    }
    lines.push(`See [${cat}/taste.md](./${cat}/taste.md)`);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/**
 * Serialize a category file: just the items, no inline limit (the file is the
 * "overflow" home so the 6th+ item lives here, not in main).
 */
function serializeCategoryText(items) {
  return (items || [])
    .map((it) => `- ${it.text}. Confidence: ${it.confidence.toFixed(2)}`)
    .join('\n') + ((items || []).length ? '\n' : '');
}

// ── IO helpers ───────────────────────────────────────────────────────────

function _readSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Atomic write: write to a unique tmp file in the same directory, fsync
 * (best-effort), then rename. A single .bak rotation precedes the write so
 * a torn rename still leaves a recoverable previous version. Mirrors the
 * pattern in learningProfile.setLevel.
 */
function _atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  _ensureDir(dir);
  try {
    if (fs.existsSync(filePath)) {
      const bak = `${filePath}.bak`;
      try {
        fs.copyFileSync(filePath, bak);
      } catch {
        /* best-effort */
      }
    }
    const tmp = path.join(dir, `.taste.${process.pid}.${Date.now()}.tmp`);
    const data =
      typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(tmp, data, 'utf-8');
    try {
      const fd = fs.openSync(tmp, 'r+');
      try {
        fs.fsyncSync(fd);
      } catch {
        /* not supported on every FS — best-effort */
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* best-effort */
    }
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'write_failed' };
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Add or update a preference. If the text already exists (case-insensitive,
 * whitespace-collapsed) the existing item is updated in place; otherwise a
 * new item is appended. If the resulting category exceeds
 * INLINE_ITEMS_PER_CATEGORY, the overflow is moved to <category>/taste.md.
 *
 * @param {object} opts
 * @param {string} opts.category
 * @param {string} opts.text
 * @param {number} [opts.confidence=0.7]
 * @returns {{ ok: true, category: string, text: string, confidence: number, location: 'inline' | 'overflow' } | { ok: false, error: string }}
 */
function addPreference({ category, text, confidence } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'empty_text' };
  }
  if (typeof category !== 'string' || !category.trim()) {
    return { ok: false, error: 'empty_category' };
  }
  const safeCat = _safeCategorySegment(category);
  let cleanText = text.trim().replace(/\s+/g, ' ').slice(0, MAX_ITEM_CHARS);
  let conf = Number(confidence);
  if (!Number.isFinite(conf)) {
    conf = 0.7;
  }
  conf = Math.max(0, Math.min(1, conf));

  // Reject prompt-injection patterns in the preference text. Fail closed.
  try {
    const { scanForPromptInjection } = require('./instructionFileService');
    const hits = scanForPromptInjection(cleanText);
    if (Array.isArray(hits) && hits.length > 0) {
      return {
        ok: false,
        error: `rejected_by_injection_scan: ${hits.map((h) => h.pattern).join(',')}`,
      };
    }
  } catch {
    /* scanner unavailable — fail-closed: refuse to write */
    return { ok: false, error: 'injection_scanner_unavailable' };
  }

  // Strip any trailing sentence terminator from the user text. The on-disk
  // protocol re-adds a single ASCII "." before "Confidence:" in serialize,
  // so storing the body without a trailing terminator guarantees we never
  // emit double punctuation ("…。。. Confidence:") and the regex parser
  // always sees a single `.` anchor.
  cleanText = cleanText.replace(/[.。!?！？]+\s*$/u, '');

  _ensureDir(_tasteDir());

  // Read main + category file, then merge.
  const mainText = _readSafe(_mainFile());
  const { items: mainItems, refs: mainRefs } = parseTasteText(mainText);

  // Build byCategory from main inline items + the existing category file.
  const byCategory = new Map();
  for (const it of mainItems) {
    if (!byCategory.has(it.category)) {
      byCategory.set(it.category, []);
    }
    byCategory.get(it.category).push({ text: it.text, confidence: it.confidence });
  }
  for (const ref of mainRefs) {
    const refText = _readSafe(_categoryFile(ref));
    const { items: refItems } = parseTasteText(refText);
    if (refItems.length > 0) {
      byCategory.set(ref, refItems.map((it) => ({ text: it.text, confidence: it.confidence })));
    } else {
      byCategory.set(ref, []); // keep ref even if empty
    }
  }
  // Make sure the user's category is present in the map.
  if (!byCategory.has(safeCat)) {
    byCategory.set(safeCat, []);
  }

  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, '')
      .trim();
  const list = byCategory.get(safeCat);
  const normText = norm(cleanText);
  const existingIdx = list.findIndex((it) => norm(it.text) === normText);
  if (existingIdx >= 0) {
    // Update existing — keep highest confidence to avoid regression.
    const existing = list[existingIdx];
    const merged = Math.max(existing.confidence, conf);
    list[existingIdx] = { text: cleanText, confidence: Number(merged.toFixed(2)) };
  } else {
    list.push({ text: cleanText, confidence: Number(conf.toFixed(2)) });
  }

  // Sort each category by confidence desc so the strongest preferences lead.
  for (const items of byCategory.values()) {
    items.sort((a, b) => b.confidence - a.confidence);
  }

  // Serialize main file: any category with more than INLINE_ITEMS_PER_CATEGORY
  // items is written in full to <category>/taste.md (overflow file), and
  // the main file keeps the top INLINE_ITEMS_PER_CATEGORY items inline
  // followed by a `See` link. We pack the overflow marker so serializeTasteText
  // can distinguish "overflow cat" from "empty cat" and emit the right shape.
  const trimmedByCategory = new Map(byCategory);
  for (const [cat, items] of byCategory.entries()) {
    if (items.length > INLINE_ITEMS_PER_CATEGORY) {
      const overflow = serializeCategoryText(items);
      const writeRes = _atomicWrite(_categoryFile(cat), overflow);
      if (writeRes !== true) {
        return { ok: false, error: `category_write_failed: ${writeRes.error}` };
      }
      trimmedByCategory.set(cat, {
        __overflow: true,
        head: items.slice(0, INLINE_ITEMS_PER_CATEGORY),
      });
    }
  }
  const mainOut = serializeTasteText(trimmedByCategory);
  const writeMain = _atomicWrite(_mainFile(), mainOut);
  if (writeMain !== true) {
    return { ok: false, error: `main_write_failed: ${writeMain.error}` };
  }

  // 双向共享：同时写入 .commandcode/taste/（Command Code 可读取）
  try {
    const projDir = _projectTasteDir();
    if (projDir) {
      const projMainPath = path.join(projDir, 'taste.md');
      const projText = _readSafe(projMainPath);
      const { items: projItems } = parseTasteText(projText);
      const projNorm = (s) => s.toLowerCase().replace(/[\s\p{P}]+/gu, '').trim();
      const existsInProj = projItems.some((it) => projNorm(it.text) === projNorm(cleanText));
      if (!existsInProj) {
        // 追加到项目级 taste
        const newLine = `- ${cleanText}. Confidence: ${conf.toFixed(2)}`;
        const updated = projText.trim() ? projText.trim() + '\n' + newLine + '\n' : newLine + '\n';
        _atomicWrite(projMainPath, updated);
      }
    }
  } catch {
    /* best-effort: 项目级写入失败不影响主流程 */
  }

  const location = list.length > INLINE_ITEMS_PER_CATEGORY ? 'overflow' : 'inline';
  return {
    ok: true,
    category: safeCat,
    text: cleanText,
    confidence: existingIdx >= 0 ? list[existingIdx].confidence : list[list.length - 1].confidence,
    location,
  };
}

/**
 * Bump (or set) the confidence of a preference. Matches by normalized text
 * across all categories. Returns the updated confidence, or null if not
 * found.
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {number} [opts.delta=0.05] - additive bump (positive for accept, negative for reject)
 * @param {string} [opts.category] - restrict to one category
 * @returns {{ ok: true, confidence: number, category: string } | { ok: false, error: string }}
 */
function adjustConfidence({ text, delta = 0.05, category } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'empty_text' };
  }
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, '')
      .trim();
  const normText = norm(text);
  const safeCat = category ? _safeCategorySegment(category) : null;
  _ensureDir(_tasteDir());
  const mainText = _readSafe(_mainFile());
  const { items: mainItems, refs: mainRefs } = parseTasteText(mainText);

  const byCategory = new Map();
  for (const it of mainItems) {
    if (!byCategory.has(it.category)) {
      byCategory.set(it.category, []);
    }
    byCategory.get(it.category).push({ text: it.text, confidence: it.confidence });
  }
  for (const ref of mainRefs) {
    if (safeCat && ref !== safeCat) {
      continue;
    }
    const refText = _readSafe(_categoryFile(ref));
    const { items: refItems } = parseTasteText(refText);
    if (refItems.length > 0) {
      byCategory.set(ref, refItems.map((it) => ({ text: it.text, confidence: it.confidence })));
    }
  }
  if (safeCat && !byCategory.has(safeCat)) {
    return { ok: false, error: 'category_not_found' };
  }

  let hit = null;
  for (const [cat, items] of byCategory.entries()) {
    if (safeCat && cat !== safeCat) {
      continue;
    }
    for (let i = 0; i < items.length; i++) {
      if (norm(items[i].text) === normText) {
        const next = Math.max(0, Math.min(1, items[i].confidence + Number(delta || 0)));
        items[i] = { text: items[i].text, confidence: Number(next.toFixed(2)) };
        hit = { category: cat, confidence: items[i].confidence };
        break;
      }
    }
    if (hit) {
      break;
    }
  }
  if (!hit) {
    return { ok: false, error: 'not_found' };
  }

  // Persist back — same overflow rules as add.
  const trimmed = new Map(byCategory);
  for (const [cat, items] of byCategory.entries()) {
    if (items.length > INLINE_ITEMS_PER_CATEGORY) {
      const writeRes = _atomicWrite(_categoryFile(cat), serializeCategoryText(items));
      if (writeRes !== true) {
        return { ok: false, error: `category_write_failed: ${writeRes.error}` };
      }
      trimmed.set(cat, {
        __overflow: true,
        head: items.slice(0, INLINE_ITEMS_PER_CATEGORY),
      });
    }
  }
  const writeMain = _atomicWrite(_mainFile(), serializeTasteText(trimmed));
  if (writeMain !== true) {
    return { ok: false, error: `main_write_failed: ${writeMain.error}` };
  }
  return { ok: true, confidence: hit.confidence, category: hit.category };
}

/**
 * Remove a preference by text (and optional category). If the removal empties
 * a category, the overflow file is deleted and the main "See" reference
 * pruned.
 */
function removePreference({ text, category } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'empty_text' };
  }
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, '')
      .trim();
  const normText = norm(text);
  const safeCat = category ? _safeCategorySegment(category) : null;
  _ensureDir(_tasteDir());
  const mainText = _readSafe(_mainFile());
  const { items: mainItems, refs: mainRefs } = parseTasteText(mainText);
  const byCategory = new Map();
  for (const it of mainItems) {
    if (!byCategory.has(it.category)) {
      byCategory.set(it.category, []);
    }
    byCategory.get(it.category).push({ text: it.text, confidence: it.confidence });
  }
  for (const ref of mainRefs) {
    const refText = _readSafe(_categoryFile(ref));
    const { items: refItems } = parseTasteText(refText);
    byCategory.set(ref, refItems.map((it) => ({ text: it.text, confidence: it.confidence })));
  }
  let removed = false;
  for (const [cat, items] of byCategory.entries()) {
    if (safeCat && cat !== safeCat) {
      continue;
    }
    const idx = items.findIndex((it) => norm(it.text) === normText);
    if (idx >= 0) {
      items.splice(idx, 1);
      removed = true;
    }
  }
  if (!removed) {
    return { ok: false, error: 'not_found' };
  }
  // Persist + clean up empty overflow files.
  for (const [cat, items] of byCategory.entries()) {
    const overflow = path.join(_tasteDir(), cat, 'taste.md');
    if (items.length === 0) {
      try {
        if (fs.existsSync(overflow)) {
          fs.unlinkSync(overflow);
        }
      } catch {
        /* best-effort */
      }
    } else if (items.length > INLINE_ITEMS_PER_CATEGORY) {
      const writeRes = _atomicWrite(overflow, serializeCategoryText(items));
      if (writeRes !== true) {
        return { ok: false, error: `category_write_failed: ${writeRes.error}` };
      }
    }
  }
  // Rebuild main (no empty refs).
  const trimmed = new Map();
  for (const [cat, items] of byCategory.entries()) {
    if (items.length > INLINE_ITEMS_PER_CATEGORY) {
      trimmed.set(cat, {
        __overflow: true,
        head: items.slice(0, INLINE_ITEMS_PER_CATEGORY),
      });
    } else if (items.length > 0) {
      trimmed.set(cat, items);
    }
  }
  const writeMain = _atomicWrite(_mainFile(), serializeTasteText(trimmed));
  if (writeMain !== true) {
    return { ok: false, error: `main_write_failed: ${writeMain.error}` };
  }
  return { ok: true };
}

/**
 * Read every taste file on disk into a normalized structure. Always returns
 * an array (possibly empty) so callers can `.map()` / `.filter()` freely.
 *
 * @param {object} [opts]
 * @param {number} [opts.confidenceFloor=DEFAULT_CONFIDENCE_FLOOR]
 * @returns {Array<{ category: string, text: string, confidence: number, source: 'main' | 'overflow' }>}
 */
function readAll({ confidenceFloor = DEFAULT_CONFIDENCE_FLOOR } = {}) {
  const out = [];
  const norm = (s) => s.toLowerCase().replace(/[\s\p{P}]+/gu, '').trim();
  const seen = new Set(); // 去重：同一偏好只保留最高 confidence

  /**
   * 从一个 taste 目录读取所有条目，合并到 out（去重，保留最高 confidence）。
   * overflow 文件（<category>/taste.md）不受 MAX_TASTE_FILE_CHARS 限制——
   * 它们是 large-by-design 的溢出存储，限制会导致大部分条目被跳过。
   */
  function _mergeFromDir(mainPath, categoryDirFn, source) {
    const mainText = _readSafe(mainPath);
    if (!mainText) return;
    // 主文件受大小限制（控制注入系统提示词的 token 预算）
    const mainToParse = mainText.length <= MAX_TASTE_FILE_CHARS ? mainText : '';
    const { items: mainItems, refs } = mainToParse
      ? parseTasteText(mainToParse)
      : { items: [], refs: [] };
    for (const it of mainItems) {
      if (it.confidence < confidenceFloor) continue;
      const key = norm(it.text);
      if (seen.has(key)) {
        const existing = out.find((o) => norm(o.text) === key);
        if (existing && it.confidence > existing.confidence) {
          existing.confidence = it.confidence;
          existing.source = `${existing.source}+${source}`;
        }
        continue;
      }
      seen.add(key);
      out.push({ category: it.category, text: it.text, confidence: it.confidence, source });
    }
    // overflow 文件：无大小限制（它们是 large-by-design 的溢出存储）
    for (const ref of refs) {
      const refText = _readSafe(categoryDirFn(ref));
      if (!refText) continue;
      const { items: refItems } = parseTasteText(refText);
      for (const it of refItems) {
        if (it.confidence < confidenceFloor) continue;
        const key = norm(it.text);
        if (seen.has(key)) {
          const existing = out.find((o) => norm(o.text) === key);
          if (existing && it.confidence > existing.confidence) {
            existing.confidence = it.confidence;
          }
          continue;
        }
        seen.add(key);
        out.push({ category: ref, text: it.text, confidence: it.confidence, source: `${source}-overflow` });
      }
    }
    // 无 ref 的主文件：如果主文件超限，直接解析全部条目（不做系统提示词注入，仅合并）
    if (refs.length === 0 && mainText.length > MAX_TASTE_FILE_CHARS) {
      const { items: allItems } = parseTasteText(mainText);
      for (const it of allItems) {
        if (it.confidence < confidenceFloor) continue;
        const key = norm(it.text);
        if (seen.has(key)) {
          const existing = out.find((o) => norm(o.text) === key);
          if (existing && it.confidence > existing.confidence) {
            existing.confidence = it.confidence;
          }
          continue;
        }
        seen.add(key);
        out.push({ category: it.category, text: it.text, confidence: it.confidence, source });
      }
    }
  }

  // Level 1: 用户级（~/.khyos/taste/）
  _mergeFromDir(_mainFile(), _categoryFile, 'khyos');
  // Level 2: 项目级（.commandcode/taste/）— Command Code 共享
  const projMain = _projectMainFile();
  if (projMain) {
    _mergeFromDir(projMain, _projectCategoryFile, 'commandcode');
  }

  // Sort by confidence desc — strongest preferences lead the prompt.
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

/**
 * Render taste items as a system-prompt section. Empty if no items meet the
 * confidence floor. Wrapped in <user_taste> tags so the model can recognize
 * the section boundary and downstream tools can grep for it.
 *
 * @param {object} [opts]
 * @param {number} [opts.confidenceFloor=DEFAULT_CONFIDENCE_FLOOR]
 * @returns {string}
 */
function renderTasteSection({ confidenceFloor = DEFAULT_CONFIDENCE_FLOOR } = {}) {
  const budget = MAX_TASTE_FILE_CHARS;
  // 预算分配：CC 原文 60% + khy-os 自有 40%（保证两边都有空间）
  const ccBudget = Math.floor(budget * 0.6);
  const khyBudget = budget - ccBudget;
  const parts = [];
  let used = 0;

  // ── Part 1: Command Code 项目级 taste（原文注入，与 CC 消费方式对齐）──
  const projMain = _projectMainFile();
  if (projMain) {
    const projText = _readSafe(projMain);
    if (projText) {
      const trimmed = projText.length <= ccBudget ? projText : projText.slice(0, ccBudget);
      parts.push(trimmed);
      used += trimmed.length;
    }
  }

  // ── Part 2: khy-os 用户级 taste（readAll 合并去重，<user_taste> 标签）──
  const items = readAll({ confidenceFloor });
  if (items.length > 0) {
    // 过滤掉已在 Part 1 中注入的 CC 条目（避免重复）
    const projNorm = new Set();
    if (projMain) {
      const projText = _readSafe(projMain);
      if (projText) {
        const { items: projItems } = parseTasteText(projText);
        const norm = (s) => s.toLowerCase().replace(/[\s\p{P}]+/gu, '').trim();
        for (const it of projItems) projNorm.add(norm(it.text));
      }
    }
    const khyOnly = items.filter((it) => {
      const norm = (s) => s.toLowerCase().replace(/[\s\p{P}]+/gu, '').trim();
      return !projNorm.has(norm(it.text));
    });
    if (khyOnly.length > 0) {
      const header = '\n<user_taste>';
      const footer = '</user_taste>';
      const lines = [header];
      let sectionUsed = header.length + 1;
      for (const it of khyOnly) {
        const tag = it.category === 'general' ? '' : ` [${it.category}]`;
        const line = `-${tag} ${it.text}. (confidence ${it.confidence.toFixed(2)})`;
        if (sectionUsed + line.length + 1 + footer.length + 5 > khyBudget) break;
        lines.push(line);
        sectionUsed += line.length + 1;
      }
      lines.push(footer);
      parts.push(lines.join('\n'));
    }
  }

  return parts.join('\n');
}

/**
 * Lint every taste file: detect malformed lines, oversized files, suspicious
 * (injection-flagged) items, and orphaned category files (no matching main
 * "See" reference). Returns a structured report suitable for `khy taste lint`.
 *
 * @returns {{ ok: boolean, warnings: string[], errors: string[] }}
 */
function lint() {
  const warnings = [];
  const errors = [];
  const mainPath = _mainFile();
  if (!fs.existsSync(mainPath)) {
    return { ok: true, warnings, errors };
  }
  let mainText = '';
  try {
    mainText = fs.readFileSync(mainPath, 'utf-8');
  } catch (e) {
    errors.push(`cannot read main: ${(e && e.message) || 'read_failed'}`);
    return { ok: false, warnings, errors };
  }
  if (mainText.length > MAX_TASTE_FILE_CHARS) {
    errors.push(`main exceeds ${MAX_TASTE_FILE_CHARS} chars (${mainText.length})`);
  }
  const lines = mainText.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('See ')) {
      return;
    }
    if (line.startsWith('- ')) {
      if (!ITEM_RE.test(line)) {
        warnings.push(`main:${idx + 1}: malformed item "${line.slice(0, 60)}"`);
      } else {
        // Re-run injection scan on the text body.
        const m = ITEM_RE.exec(line);
        if (m) {
          try {
            const { scanForPromptInjection } = require('./instructionFileService');
            const hits = scanForPromptInjection(m[1]);
            if (Array.isArray(hits) && hits.length > 0) {
              errors.push(
                `main:${idx + 1}: prompt-injection pattern: ${hits[0].pattern}`
              );
            }
          } catch {
            /* scanner unavailable — skip */
          }
        }
      }
    }
  });
  // Cross-check category files against main refs.
  const { refs } = parseTasteText(mainText);
  const dir = _tasteDir();
  let onDiskCats = [];
  try {
    onDiskCats = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    onDiskCats = [];
  }
  for (const c of onDiskCats) {
    if (!refs.includes(c)) {
      warnings.push(`orphan category dir: ${c}/ (no "See" reference in main)`);
    }
  }
  for (const r of refs) {
    if (!onDiskCats.includes(r)) {
      errors.push(`broken reference: ${r} (category dir missing)`);
    }
  }
  return { ok: errors.length === 0, warnings, errors };
}

/**
 * Return the list of categories and their item counts (for `khy taste list`).
 */
function listCategories() {
  const out = [];
  const mainText = _readSafe(_mainFile());
  if (!mainText) {
    return out;
  }
  const { items: mainItems, refs } = parseTasteText(mainText);
  // Categories that have a "See [cat/taste.md]" ref are overflow cats — the
  // head shown in main is part of the overflow file's content, not a separate
  // inline pool. So we attribute mainItems to overflow when their cat has a
  // ref, and to inline otherwise.
  const overflowCats = new Set(refs);
  const inlineCounts = new Map();
  const overflowInline = new Map();
  for (const it of mainItems) {
    if (overflowCats.has(it.category)) {
      overflowInline.set(it.category, (overflowInline.get(it.category) || 0) + 1);
    } else {
      inlineCounts.set(it.category, (inlineCounts.get(it.category) || 0) + 1);
    }
  }
  // Render inline-only categories first (alphabetic), then overflow cats.
  for (const cat of Array.from(inlineCounts.keys()).sort()) {
    out.push({ category: cat, inline: inlineCounts.get(cat), overflow: 0 });
  }
  for (const r of Array.from(overflowCats).sort()) {
    const refText = _readSafe(_categoryFile(r));
    const { items } = parseTasteText(refText);
    out.push({
      category: r,
      inline: overflowInline.get(r) || 0, // head in main
      overflow: items.length, // total on disk
    });
  }
  return out;
}

/**
 * 从 Command Code 项目级 taste 同步到 khy-os 用户级 taste。
 * 读取 .commandcode/taste/ 中的条目，合并到 ~/.khyos/taste/（去重，保留最高 confidence）。
 *
 * @returns {{ synced: number, skipped: number, error?: string }}
 */
function syncFromCommandCode() {
  const projDir = _projectTasteDir();
  if (!projDir) {
    return { synced: 0, skipped: 0, error: 'no .commandcode/taste/ found' };
  }
  const projMainPath = path.join(projDir, 'taste.md');
  const projText = _readSafe(projMainPath);
  if (!projText) {
    return { synced: 0, skipped: 0 };
  }
  const { items: projItems, refs: projRefs } = parseTasteText(projText);
  const norm = (s) => s.toLowerCase().replace(/[\s\p{P}]+/gu, '').trim();

  // 读取 khy-os 现有条目
  const existing = readAll({ confidenceFloor: 0 });
  const existingNorm = new Set(existing.map((it) => norm(it.text)));

  let synced = 0;
  let skipped = 0;

  // 合并主文件条目
  for (const it of projItems) {
    if (existingNorm.has(norm(it.text))) {
      skipped++;
      continue;
    }
    const result = addPreference({
      category: it.category,
      text: it.text,
      confidence: it.confidence,
    });
    if (result.ok) synced++;
  }

  // 合并 overflow 条目
  for (const ref of projRefs) {
    const refPath = path.join(projDir, ref, 'taste.md');
    const refText = _readSafe(refPath);
    if (!refText) continue;
    const { items: refItems } = parseTasteText(refText);
    for (const it of refItems) {
      if (existingNorm.has(norm(it.text))) {
        skipped++;
        continue;
      }
      const result = addPreference({
        category: ref,
        text: it.text,
        confidence: it.confidence,
      });
      if (result.ok) synced++;
    }
  }

  return { synced, skipped };
}

module.exports = {
  TASTE_VERSION,
  MAX_TASTE_FILE_CHARS,
  INLINE_ITEMS_PER_CATEGORY,
  DEFAULT_CONFIDENCE_FLOOR,
  addPreference,
  adjustConfidence,
  removePreference,
  readAll,
  renderTasteSection,
  lint,
  listCategories,
  syncFromCommandCode,
  // Exposed for tests / introspection
  parseTasteText,
  serializeTasteText,
  serializeCategoryText,
  _tasteDir,
  _mainFile,
  _categoryFile,
  _projectTasteDir,
  _projectMainFile,
  _safeCategorySegment,
  _atomicWrite,
};
