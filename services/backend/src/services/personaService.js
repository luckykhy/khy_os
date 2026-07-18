'use strict';

/**
 * personaService.js — load and merge an executable Persona spec (C1).
 *
 * A `persona.md` file describes HOW the assistant should behave (answer
 * strategy, tone, confirmation strategy, red lines, uncertainty handling) as
 * opposed to project *rules* (KHY/CLAUDE/AGENTS instructions, which describe
 * WHAT the project requires). The two are deliberately kept separate: project
 * instructions win on conflict, persona shapes delivery within those bounds.
 *
 * Discovery (project overrides global, both are merged):
 *   1. Global : <dataHome>/persona.md         (getDataDir('persona.md') parent)
 *   2. Project: <cwd>/.khy/persona.md          (getProjectDataDir)
 *   3. Project: <cwd>/persona.md               (bare, convenience)
 *
 * Safety: the file is untrusted user content injected into the system prompt,
 * so it is run through the SAME `scanForPromptInjection` pipeline + size caps
 * used for instruction files. A flagged persona is dropped (fail-closed) and a
 * warning is logged — it is never injected.
 *
 * `personaStamp(cwd)` returns an `mtimeMs:size` fingerprint of the resolved
 * source files so the system-prompt section cache invalidates on edit.
 */

const fs = require('fs');
const path = require('path');
const { getDataDir, getProjectDataDir } = require('../utils/dataHome');

// Mirror instructionFileService caps; persona is short by design.
const MAX_PERSONA_CHARS = 8000;

// Built-in default persona (trusted, ships out of the box). It is always present
// as the base identity so the assistant has a consistent "小K" persona even with
// zero user configuration; user persona.md files (global/project) are layered on
// top to refine tone/rules. Because it is internal, it bypasses injection
// scanning. Headings use the `## Title` shape that summarizePersona() parses.
const BUILTIN_PERSONA = [
  '# 小K · 人格档案',
  '',
  '## 角色定位',
  '- 我是小K，KHY OS 内置的 AI 助手，擅长股票分析、量化策略与 AI 技术问答。',
  '- 立足实用：先给直接答案，再补关键依据。',
  '',
  '## 回答策略',
  '- 先结论后推理；能给可运行的步骤就不停留在抽象建议。',
  '- 涉及数据或代码时，优先给出可复现的具体示例。',
  '',
  '## 语气',
  '- 简洁、专业、平等协作，不说废话与套话。',
  '',
  '## 确认策略',
  '- 破坏性或不可逆操作先确认再执行；只读或低风险步骤直接进行。',
  '',
  '## 红线（绝不逾越）',
  '- 不泄露密钥或明文凭证；不绕过明确的人工确认关卡。',
  '- 投资有风险：只做分析与说明，不替用户做真实下单等交易决策。',
  '',
  '## 不确定性处理',
  '- 明确说明假设，对低置信度结论主动标注。',
  '- 遇到真正需要用户拍板的问题，只问一个聚焦的问题。',
  '',
].join('\n');

/**
 * Resolve candidate persona.md paths in precedence order (global first, then
 * project; project content is appended so it can refine/override on read).
 * @param {string} cwd
 * @returns {string[]} existing absolute paths
 */
function _personaPaths(cwd) {
  const candidates = [];
  try {
    // getDataDir('persona.md') would create a *directory* named persona.md, so
    // join against the parent data home instead.
    candidates.push(path.join(getDataDir(), 'persona.md'));
  } catch { /* dataHome unavailable */ }
  try {
    // getProjectDataDir() treats args as path *segments*, not a cwd; call it
    // bare (→ <projectRoot>/.khy) and join the filename ourselves.
    candidates.push(path.join(getProjectDataDir(), 'persona.md'));
  } catch { /* project data dir unavailable */ }
  if (cwd) candidates.push(path.join(cwd, 'persona.md'));

  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const resolved = path.resolve(c);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fs.existsSync(resolved)) out.push(resolved);
  }
  return out;
}

function _readSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.length > MAX_PERSONA_CHARS ? raw.slice(0, MAX_PERSONA_CHARS) : raw;
  } catch {
    return '';
  }
}

/**
 * Load + merge persona content for the given cwd. The built-in default is always
 * the base; user persona.md files (injection-scanned) are layered on top.
 * @param {string} [cwd]
 * @returns {string} merged persona text (never null — built-in is always present)
 */
function loadPersona(cwd = process.cwd()) {
  // Built-in default is trusted and always the base identity.
  const blocks = [BUILTIN_PERSONA];

  const paths = _personaPaths(cwd);
  if (paths.length === 0) return blocks.join('\n\n');

  let scanForPromptInjection = null;
  try {
    ({ scanForPromptInjection } = require('./instructionFileService'));
  } catch { /* scanner unavailable — user blocks fail closed below */ }

  for (const p of paths) {
    const content = _readSafe(p).trim();
    if (!content) continue;

    if (scanForPromptInjection) {
      const hits = scanForPromptInjection(content);
      if (hits && hits.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[personaService] Dropping persona "${p}" — prompt-injection patterns: ${hits.map(h => h.pattern).join(', ')}`);
        continue;
      }
    } else {
      // No scanner available → fail closed for untrusted user content (do not
      // inject unscanned), but keep the trusted built-in base.
      // eslint-disable-next-line no-console
      console.warn(`[personaService] Injection scanner unavailable — skipping persona "${p}".`);
      continue;
    }
    blocks.push(content);
  }

  return blocks.join('\n\n');
}

/**
 * Fingerprint of the resolved persona sources for cache invalidation.
 * @param {string} [cwd]
 * @returns {string} `mtimeMs:size` parts joined by `|`, or 'none'
 */
function personaStamp(cwd = process.cwd()) {
  const paths = _personaPaths(cwd);
  if (paths.length === 0) return 'none';
  const parts = [];
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch { parts.push('?'); }
  }
  return parts.join('|');
}

/**
 * Build a short read-only summary for the frontend Persona card (C2):
 * each `## Heading` with the first 1–2 non-empty lines beneath it.
 * @param {string} [cwd]
 * @returns {{ present: boolean, sections: Array<{ title: string, lines: string[] }> }}
 */
function summarizePersona(cwd = process.cwd()) {
  const text = loadPersona(cwd);
  if (!text) return { present: false, sections: [] };

  const sections = [];
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) {
      if (current) sections.push(current);
      current = { title: h[1].trim(), lines: [] };
      continue;
    }
    if (!current) continue;
    if (!line || line.startsWith('#')) continue;
    if (current.lines.length < 2) current.lines.push(line.replace(/^[-*]\s*/, ''));
  }
  if (current) sections.push(current);
  return { present: true, sections };
}

/**
 * The default persona.md template. Documents the five behavior dimensions the
 * loader recognizes. Returned by `khy persona init` and never written silently
 * over an existing file.
 * @returns {string}
 */
function defaultTemplate() {
  return [
    '# Persona',
    '',
    '## Answer Strategy',
    '- Lead with the direct answer, then the reasoning.',
    '- Prefer concrete, runnable steps over abstract advice.',
    '',
    '## Tone',
    '- Concise, technical, collegial. No filler.',
    '',
    '## Confirmation Strategy',
    '- For destructive or irreversible actions, confirm before acting.',
    '- For read-only or low-risk steps, proceed without asking.',
    '',
    '## Red Lines (never cross)',
    '- Never exfiltrate secrets or print unmasked credentials.',
    '- Never bypass an explicit human-gate.',
    '',
    '## Uncertainty Handling',
    '- State assumptions explicitly; flag low-confidence claims.',
    '- When blocked on a genuine user decision, ask one focused question.',
    '',
  ].join('\n');
}

/**
 * Write the default template to a target path, refusing to overwrite an
 * existing file unless `force` is set. Defaults to the global persona path.
 * @param {object} [opts]
 * @param {string} [opts.dest] - explicit destination file
 * @param {boolean} [opts.force=false]
 * @returns {{ dest: string, written: boolean }}
 */
function scaffold(opts = {}) {
  const dest = opts.dest
    ? path.resolve(opts.dest)
    : path.join(getDataDir(), 'persona.md');
  if (fs.existsSync(dest) && !opts.force) {
    return { dest, written: false };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, defaultTemplate(), 'utf-8');
  return { dest, written: true };
}

module.exports = {
  loadPersona,
  personaStamp,
  summarizePersona,
  defaultTemplate,
  scaffold,
  _personaPaths, // exposed for tests
  MAX_PERSONA_CHARS,
};
