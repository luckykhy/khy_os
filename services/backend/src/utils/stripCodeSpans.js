'use strict';

/**
 * stripCodeSpans.js — single source of truth for blanking fenced code blocks
 * and inline code spans out of a text before scanning it for keywords.
 *
 * The NL config / policy resolvers all scan free text for directives (KHY_xxx,
 * on/off, action verbs). A keyword sitting inside a ``` fenced block ``` or an
 * `inline` code span is an *example*, not a user instruction — treating it as
 * one is a false positive. Six byte-identical private `_stripCode(text)` copies
 * (testWritingPolicy, deliverySummaryFormat, mathSolvePolicy, config/{
 * philosophyDesignResolver, nlActionResolver, nlConfigResolver}) each replaced
 * code with a space before scanning; centralizing keeps that "code is not an
 * instruction" rule in one place.
 *
 * Contract: pure, deterministic, never throws.
 *   - nullish → '' (via String(text || ''))
 *   - ```fenced blocks``` (non-greedy, across lines) → single space
 *   - `inline spans` → single space
 *   Replacement is a space (not '') so adjacent words don't fuse into one token.
 *   Regexes carry the /g flag but are module-scoped literals used only with
 *   String.replace (no lastIndex state to leak).
 *
 * @param {*} text raw text (coerced via String)
 * @returns {string} text with code fences / inline spans blanked to spaces
 */
function stripCodeSpans(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

module.exports = stripCodeSpans;
