/**
 * Grok Protocol Converter — Grok extensions ↔ Canonical
 *
 * Grok uses OpenAI-compatible format with minor extensions:
 * - <tool_call> XML tags in responses
 * - Image/video URL proxying
 * - Custom thinking format
 */
const openai = require('./openai');

/**
 * Convert Grok request to canonical (same as OpenAI with model prefix).
 * @param {object} body
 * @returns {import('./canonical').CanonicalRequest}
 */
function toCanonical(body) {
  return openai.toCanonical(body);
}

/**
 * Convert canonical response to Grok format (OpenAI-compatible).
 * @param {import('./canonical').CanonicalResponse} canonical
 * @returns {object}
 */
function fromCanonical(canonical) {
  return openai.fromCanonical(canonical);
}

module.exports = { toCanonical, fromCanonical };
