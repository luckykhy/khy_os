'use strict';

/**
 * contentSchema.js — the semantic document AST that the MODEL is allowed to emit.
 *
 * This is the heart of the "content vs. style separation" architecture: the model
 * produces ONLY semantic structure (headings, paragraphs, lists, tables, …) and
 * NEVER any presentation/format code (no \textbf, \vspace, \newpage, no docx XML,
 * no <b>/<font> HTML). All visual formatting is decided later, deterministically,
 * by the style-template layer (styleTemplates.js) + the renderer (docTypeset.py).
 *
 * Two jobs:
 *   1. Describe the AST (block grammar) and expose a JSON Schema for tooling.
 *   2. validateDocument(): structural validation PLUS the 防呆 interception that
 *      rejects raw typesetting/markup codes smuggled inside text — forcing the
 *      caller back onto the structured path.
 *
 * The AST is intentionally small and closed. Adding a block type is a deliberate
 * act: it must also gain a renderer mapping and (ideally) a template style key.
 */

// Block kinds the renderer knows how to typeset. Closed set on purpose.
const BLOCK_TYPES = new Set([
  'heading',     // { level: 1..6, text }
  'paragraph',   // { text }  or  { runs: [{text, bold?, italic?}] }
  'list',        // { ordered: bool, items: [string] }
  'table',       // { header?: [string], rows: [[string]] }
  'quote',       // { text }
  'code',        // { text, lang? }   (monospace, no syntax styling by the model)
  'pagebreak',   // {}  — the ONLY way to force a page break (防呆: never via whitespace)
  'figure',      // { path?, caption? }
  'reference',   // { entries: [string] }  — bibliography list (GB/T 7714 / IEEE numbered)
]);

const MAX_HEADING_LEVEL = 6;
const MAX_BLOCKS = 20000;

/**
 * Raw typesetting / markup codes the model is forbidden to emit inside text.
 * Detected so we can REJECT (force structured input) rather than silently render
 * them as literals or, worse, let them corrupt the document. Kept deliberately
 * focused on real format-control escapes, not ordinary prose punctuation.
 */
const FORMAT_CODE_PATTERNS = [
  // LaTeX formatting / spacing / sectioning / page commands.
  { re: /\\(?:textbf|textit|texttt|emph|underline|textcolor|color|fontsize|font|setlength|vspace|hspace|newpage|clearpage|pagebreak|linebreak|newline|noindent|indent|centering|raggedright|begin|end|section|subsection|subsubsection|chapter|paragraph|bf|it|rm|sf|tt|large|Large|huge|small|footnotesize)\b/, label: 'LaTeX command' },
  // Bare backslash control sequence that looks like a LaTeX macro: \word .
  { re: /\\[a-zA-Z]{2,}\s*\{/, label: 'LaTeX macro' },
  // HTML / XML presentation tags (incl. docx/WordprocessingML w: tags). No space
  // is allowed between "<" (or "</") and the tag name, so ordinary inequality
  // prose like "a < b 与 x > y" is NOT mistaken for a tag.
  { re: /<\/?(?:b|i|u|strong|em|font|span|div|p|br|h[1-6]|style|center|table|tr|td|w:[a-zA-Z]+)\b[^>]*>/i, label: 'HTML/XML tag' },
  // Inline CSS style attribute.
  { re: /\bstyle\s*=\s*["'][^"']*(?:font|color|margin|padding|size)[^"']*["']/i, label: 'inline CSS' },
  // RTF control words.
  { re: /\\(?:rtf1|fonttbl|colortbl|pard|par\b|b0|i0|fs\d+)/, label: 'RTF control word' },
];

/**
 * Scan a text string for forbidden format codes.
 * @param {string} text
 * @returns {{clean: boolean, label?: string, match?: string}}
 */
function scanFormatCodes(text) {
  if (typeof text !== 'string' || !text) return { clean: true };
  for (const { re, label } of FORMAT_CODE_PATTERNS) {
    const m = re.exec(text);
    if (m) return { clean: false, label, match: m[0] };
  }
  return { clean: true };
}

function _err(msg) { return { valid: false, error: msg }; }

/** Pull every user-authored text fragment out of a block for format-code scanning. */
function _blockTexts(block) {
  const out = [];
  if (typeof block.text === 'string') out.push(block.text);
  if (Array.isArray(block.runs)) {
    for (const r of block.runs) if (r && typeof r.text === 'string') out.push(r.text);
  }
  if (Array.isArray(block.items)) {
    for (const it of block.items) if (typeof it === 'string') out.push(it);
  }
  if (Array.isArray(block.entries)) {
    for (const e of block.entries) if (typeof e === 'string') out.push(e);
  }
  if (typeof block.caption === 'string') out.push(block.caption);
  if (Array.isArray(block.header)) {
    for (const h of block.header) if (typeof h === 'string') out.push(h);
  }
  if (Array.isArray(block.rows)) {
    for (const row of block.rows) {
      if (Array.isArray(row)) for (const c of row) if (typeof c === 'string') out.push(c);
    }
  }
  return out;
}

/**
 * Validate a single block's structure. `code` blocks are EXEMPT from format-code
 * scanning of their body (a code listing may legitimately contain backslashes /
 * tags) — but their text is still rendered verbatim into a monospace style, never
 * interpreted, so it cannot affect document formatting.
 * @returns {{valid: boolean, error?: string}}
 */
function validateBlock(block, idx) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return _err(`block[${idx}] must be an object`);
  }
  const { type } = block;
  if (!BLOCK_TYPES.has(type)) {
    return _err(`block[${idx}] has unknown type "${type}"; allowed: ${[...BLOCK_TYPES].join(', ')}`);
  }

  switch (type) {
    case 'heading': {
      if (!Number.isInteger(block.level) || block.level < 1 || block.level > MAX_HEADING_LEVEL) {
        return _err(`block[${idx}] heading.level must be an integer 1..${MAX_HEADING_LEVEL}`);
      }
      if (typeof block.text !== 'string' || !block.text.trim()) {
        return _err(`block[${idx}] heading.text must be a non-empty string`);
      }
      break;
    }
    case 'paragraph': {
      const hasText = typeof block.text === 'string';
      const hasRuns = Array.isArray(block.runs);
      if (!hasText && !hasRuns) return _err(`block[${idx}] paragraph needs "text" or "runs"`);
      if (hasRuns) {
        for (let i = 0; i < block.runs.length; i++) {
          const r = block.runs[i];
          if (!r || typeof r.text !== 'string') return _err(`block[${idx}] runs[${i}].text must be a string`);
        }
      }
      break;
    }
    case 'list': {
      if (!Array.isArray(block.items) || block.items.length === 0) {
        return _err(`block[${idx}] list.items must be a non-empty array`);
      }
      if (!block.items.every((it) => typeof it === 'string')) {
        return _err(`block[${idx}] list.items must all be strings`);
      }
      break;
    }
    case 'table': {
      if (!Array.isArray(block.rows) || block.rows.length === 0) {
        return _err(`block[${idx}] table.rows must be a non-empty array of arrays`);
      }
      if (!block.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string'))) {
        return _err(`block[${idx}] table.rows must be arrays of strings`);
      }
      if (block.header !== undefined && !(Array.isArray(block.header) && block.header.every((c) => typeof c === 'string'))) {
        return _err(`block[${idx}] table.header must be an array of strings`);
      }
      break;
    }
    case 'quote': {
      if (typeof block.text !== 'string' || !block.text.trim()) return _err(`block[${idx}] quote.text must be a non-empty string`);
      break;
    }
    case 'code': {
      if (typeof block.text !== 'string') return _err(`block[${idx}] code.text must be a string`);
      break;
    }
    case 'pagebreak': {
      break; // no payload
    }
    case 'figure': {
      if (block.path !== undefined && typeof block.path !== 'string') return _err(`block[${idx}] figure.path must be a string`);
      if (block.caption !== undefined && typeof block.caption !== 'string') return _err(`block[${idx}] figure.caption must be a string`);
      break;
    }
    case 'reference': {
      if (!Array.isArray(block.entries) || block.entries.length === 0) {
        return _err(`block[${idx}] reference.entries must be a non-empty array`);
      }
      if (!block.entries.every((e) => typeof e === 'string')) return _err(`block[${idx}] reference.entries must all be strings`);
      break;
    }
    default:
      return _err(`block[${idx}] unhandled type "${type}"`);
  }

  // 防呆 interception: no presentation code inside any text — EXCEPT a code
  // block's body, which is rendered verbatim into monospace and never interpreted.
  const texts = type === 'code' ? [] : _blockTexts(block);
  for (const t of texts) {
    const scan = scanFormatCodes(t);
    if (!scan.clean) {
      return _err(
        `block[${idx}] (${type}) contains a forbidden ${scan.label} ("${scan.match}"). ` +
        `The model must emit SEMANTIC structure only; formatting is applied by the ` +
        `style template, not by raw codes. Remove it and rely on block types / the template.`
      );
    }
  }
  return { valid: true };
}

/**
 * Validate a full document AST.
 * @param {object} doc
 * @returns {{valid: boolean, error?: string}}
 */
function validateDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return _err('document must be an object');
  if (doc.type !== undefined && doc.type !== 'document') return _err('document.type, if present, must be "document"');
  if (doc.title !== undefined && typeof doc.title !== 'string') return _err('document.title must be a string');
  if (doc.title) {
    const scan = scanFormatCodes(doc.title);
    if (!scan.clean) return _err(`document.title contains a forbidden ${scan.label} ("${scan.match}")`);
  }
  if (doc.meta !== undefined && (typeof doc.meta !== 'object' || Array.isArray(doc.meta))) {
    return _err('document.meta must be an object');
  }
  if (!Array.isArray(doc.blocks)) return _err('document.blocks must be an array');
  if (doc.blocks.length > MAX_BLOCKS) return _err(`document has too many blocks (>${MAX_BLOCKS})`);

  for (let i = 0; i < doc.blocks.length; i++) {
    const r = validateBlock(doc.blocks[i], i);
    if (!r.valid) return r;
  }
  return { valid: true };
}

/** JSON Schema (advisory; the authoritative check is validateDocument). */
const DOCUMENT_JSON_SCHEMA = {
  type: 'object',
  required: ['blocks'],
  properties: {
    type: { type: 'string', enum: ['document'] },
    title: { type: 'string' },
    meta: {
      type: 'object',
      properties: {
        author: { type: 'string' },
        date: { type: 'string' },
        abstract: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
      },
    },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: [...BLOCK_TYPES] },
          level: { type: 'integer', minimum: 1, maximum: MAX_HEADING_LEVEL },
          text: { type: 'string' },
          ordered: { type: 'boolean' },
          items: { type: 'array', items: { type: 'string' } },
          header: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          entries: { type: 'array', items: { type: 'string' } },
          runs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['text'],
              properties: { text: { type: 'string' }, bold: { type: 'boolean' }, italic: { type: 'boolean' } },
            },
          },
          lang: { type: 'string' },
          path: { type: 'string' },
          caption: { type: 'string' },
        },
      },
    },
  },
};

module.exports = {
  BLOCK_TYPES,
  MAX_HEADING_LEVEL,
  FORMAT_CODE_PATTERNS,
  scanFormatCodes,
  validateBlock,
  validateDocument,
  DOCUMENT_JSON_SCHEMA,
};
