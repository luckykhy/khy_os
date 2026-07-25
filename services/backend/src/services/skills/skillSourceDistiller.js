'use strict';

/**
 * skillSourceDistiller.js — pure leaf: distill a reusable-skill descriptor from
 * already-gathered source documents (a directory of files, or one web page's text).
 *
 * Reference: Hermes Agent v0.18.0 `/learn` (agent/learn_prompt.py). Hermes lets the
 * live agent gather sources + author a SKILL.md with its own tools (no engine).
 * Khy-OS keeps its deterministic engine model (skillLearningService.learnFrom*),
 * so this leaf does the distillation deterministically from raw text — following
 * the same Hermes skill-authoring HARDLINE rules, and NEVER inventing content:
 * every command / heading it emits appears VERBATIM in the source.
 *
 * PURE-LEAF CONTRACT: zero IO (no fs, no network, no require of IO modules),
 * deterministic (same input → byte-identical output), never throws. All source
 * reading (fs / HTTP) and persistence live in the caller (skillLearningService).
 * The `/learn` dir/url capability is gated upstream by KHY_LEARN_FROM_SOURCE.
 */

// Hermes hardline: the system-prompt skill index truncates description at 60 chars
// and loads it every session, so anything past char 60 is silently cut and never
// routes. Count and clamp to 60 including the trailing period.
const _MAX_DESC = 60;
const _MAX_NAME = 64;
const _MAX_COMMANDS = 40;
const _MAX_HEADINGS = 30;
// Marketing words banned by the Hermes description standard.
const _MARKETING_RE = /\b(powerful|comprehensive|seamless|advanced|robust)\b/gi;

function _str(s) { return String(s == null ? '' : s); }

/**
 * Derive a lowercase-hyphenated skill name (<=64 chars) from the source reference.
 * URLs → hostname + last path segment; directories/paths → basename.
 */
function deriveSkillName(sourceRef, sourceType) {
  try {
    let base = _str(sourceRef).trim();
    if (String(sourceType || '').toLowerCase() === 'url') {
      const stripped = base.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[?#].*$/, '');
      const parts = stripped.split('/').filter(Boolean);
      const host = (parts[0] || '').replace(/^www\./i, '').split('.')[0];
      const last = parts.length > 1 ? parts[parts.length - 1] : '';
      base = [host, last].filter(Boolean).join('-');
    } else {
      base = base.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || base;
    }
    let name = base.toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')     // drop a file extension
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, _MAX_NAME)
      .replace(/-+$/g, '');
    return name || 'learned-skill';
  } catch { return 'learned-skill'; }
}

/**
 * Clamp arbitrary text into a single-sentence description that satisfies the
 * Hermes hardline: <=60 chars including the terminal period, no marketing words.
 */
function clampDescription(text) {
  try {
    let s = _str(text).replace(/\s+/g, ' ').trim();
    s = s.replace(_MARKETING_RE, '').replace(/\s+/g, ' ').trim();
    if (!s) return 'Learned skill from source.';
    // Keep only the first sentence.
    const firstSentence = s.split(/(?<=[.!?])\s/)[0] || s;
    let body = firstSentence.trim().replace(/[.!?]+$/, '');
    if (body.length > _MAX_DESC - 1) body = body.slice(0, _MAX_DESC - 1).trim();
    if (!body) return 'Learned skill from source.';
    return body + '.';
  } catch { return 'Learned skill from source.'; }
}

/**
 * Extract command-looking lines VERBATIM from source text: fenced code blocks and
 * lines that begin with a shell prompt. Deduped, capped. Never invents.
 */
function extractCommands(text) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const line = _str(raw).trim();
    if (!line || line.length > 200) return;
    if (seen.has(line)) return;
    seen.add(line);
    if (out.length < _MAX_COMMANDS) out.push(line);
  };
  try {
    const src = _str(text);
    // Fenced code blocks: capture inner non-empty, non-comment lines.
    const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
    let m;
    while ((m = fenceRe.exec(src)) !== null) {
      for (const raw of _str(m[1]).split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        add(line.replace(/^\$\s+/, ''));
      }
    }
    // Inline shell-prompt lines outside fences.
    for (const raw of src.split('\n')) {
      const line = raw.trim();
      if (/^\$\s+\S/.test(line)) add(line.replace(/^\$\s+/, ''));
    }
  } catch { /* never throws */ }
  return out;
}

/**
 * Extract markdown headings VERBATIM. Deduped, capped.
 */
function extractHeadings(text) {
  const out = [];
  const seen = new Set();
  try {
    // Strip fenced code blocks first: a `#` line inside a code fence is a shell
    // comment, not a markdown heading.
    const src = _str(text).replace(/```[\s\S]*?```/g, '');
    for (const raw of src.split('\n')) {
      const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw);
      if (!m) continue;
      const h = m[1].trim();
      if (!h || seen.has(h)) continue;
      seen.add(h);
      if (out.length < _MAX_HEADINGS) out.push(h);
    }
  } catch { /* never throws */ }
  return out;
}

/**
 * Assemble a SKILL.md body in the Hermes section order, using ONLY content found
 * in the source (sections with no found content are omitted — never invented).
 */
function buildSkillBody({ name, description, sourceType, sourceRef, headings, commands, sources }) {
  const lines = [];
  const title = _str(name).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Learned Skill';
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`${_str(description)} Distilled from ${_str(sourceType) || 'source'}: \`${_str(sourceRef)}\`.`);
  lines.push('This skill is distilled from source material; it invents nothing beyond what the source states.');
  lines.push('');
  if (Array.isArray(sources) && sources.length) {
    lines.push('## Sources');
    for (const s of sources.slice(0, _MAX_HEADINGS)) lines.push(`- \`${_str(s)}\``);
    lines.push('');
  }
  if (Array.isArray(headings) && headings.length) {
    lines.push('## When to Use');
    for (const h of headings) lines.push(`- ${h}`);
    lines.push('');
  }
  if (Array.isArray(commands) && commands.length) {
    lines.push('## Quick Reference');
    lines.push('```');
    for (const c of commands) lines.push(c);
    lines.push('```');
    lines.push('');
  }
  lines.push('## Verification');
  lines.push('- Re-read the source and confirm the commands above still match verbatim.');
  return lines.join('\n');
}

/**
 * Distill a skill descriptor from gathered documents.
 *
 * @param {object} input
 * @param {string} input.sourceType  'directory' | 'url'
 * @param {string} input.sourceRef   the directory path or URL the docs came from
 * @param {Array<{name?:string,text?:string}>} input.documents  already-read source docs
 * @returns {{ok:boolean, reason?:string, name?:string, description?:string,
 *            category?:string, commands?:string[], headings?:string[],
 *            sources?:string[], body?:string, warnings?:string[]}}
 */
function distillSkillFromSources(input) {
  try {
    const { sourceType, sourceRef, documents } = input || {};
    const docs = Array.isArray(documents) ? documents.filter((d) => d && _str(d.text).trim()) : [];
    if (!docs.length) {
      return { ok: false, reason: 'no-source-content' };
    }
    const combined = docs.map((d) => _str(d.text)).join('\n\n');
    const sources = docs.map((d) => _str(d.name || '')).filter(Boolean);
    const headings = extractHeadings(combined);
    const commands = extractCommands(combined);
    const name = deriveSkillName(sourceRef, sourceType);
    // Description source: first heading if present, else first non-empty line.
    const descSeed = headings[0] || (combined.split('\n').map((l) => l.trim()).find(Boolean) || name);
    const description = clampDescription(descSeed);
    const warnings = [];
    if (!headings.length && !commands.length) {
      warnings.push('source had no headings or commands; body is minimal');
    }
    const body = buildSkillBody({ name, description, sourceType, sourceRef, headings, commands, sources });
    return {
      ok: true,
      name,
      description,
      category: 'reference',
      commands,
      headings,
      sources,
      body,
      warnings,
    };
  } catch {
    return { ok: false, reason: 'distill-error' };
  }
}

module.exports = {
  distillSkillFromSources,
  deriveSkillName,
  clampDescription,
  extractCommands,
  extractHeadings,
  buildSkillBody,
  MAX_DESCRIPTION_CHARS: _MAX_DESC,
};
