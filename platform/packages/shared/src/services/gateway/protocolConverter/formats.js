/**
 * Protocol Format Detection & Constants
 *
 * Supported protocols:
 *   - openai: OpenAI Chat Completions (/v1/chat/completions)
 *   - anthropic: Claude Messages API (/v1/messages)
 *   - gemini: Google Gemini GenerateContent
 *   - grok: Grok (OpenAI-compatible with extensions)
 *   - codex: OpenAI Responses API (/v1/responses)
 */

const PROTOCOLS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
  GROK: 'grok',
  CODEX: 'codex',
};

/**
 * Auto-detect protocol format from a request body.
 * @param {object} body - Parsed request body
 * @param {string} [path] - Request URL path (optional hint)
 * @returns {string} Detected protocol name
 */
function detectProtocol(body, path = '') {
  // Path-based detection (most reliable)
  if (path.includes('/v1/messages')) return PROTOCOLS.ANTHROPIC;
  if (path.includes(':generateContent') || path.includes(':streamGenerateContent')) return PROTOCOLS.GEMINI;
  if (path.includes('/v1/responses')) return PROTOCOLS.CODEX;

  // Body-based heuristics
  if (body.contents && Array.isArray(body.contents)) return PROTOCOLS.GEMINI;
  if (body.system !== undefined && body.messages && !body.model?.startsWith('grok')) return PROTOCOLS.ANTHROPIC;
  if (body.input && Array.isArray(body.input) && body.instructions !== undefined) return PROTOCOLS.CODEX;
  if (body.model?.startsWith('grok')) return PROTOCOLS.GROK;

  // Default: OpenAI format (most common)
  return PROTOCOLS.OPENAI;
}

/**
 * Get list of all supported protocols.
 * @returns {string[]}
 */
function getSupportedProtocols() {
  return Object.values(PROTOCOLS);
}

// ---------------------------------------------------------------------------
// Shared conversion helpers (single source of truth for A/B layers).
// ---------------------------------------------------------------------------

/** Tool-description length limits, mirrored by the backend _toolSchemaConverter. */
const DESC_LIMITS = { openai: 4096, cw: 10000 };

/**
 * Parse tool-call arguments without ever throwing.
 * Accepts already-parsed objects, JSON strings, or malformed/truncated JSON.
 * Returns `{}` for empty input and `{ _raw }` when JSON parsing fails — a hard
 * `JSON.parse` here would crash the entire request conversion.
 *
 * @param {string|object|null|undefined} args
 * @returns {object}
 */
function safeParseToolArgs(args) {
  if (args == null) return {};
  if (typeof args === 'object') return args;
  if (typeof args !== 'string') return {};
  const text = args.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: args };
  }
}

const DATA_URL_HEAD_RE = /^data:([^;,]+)?;base64,(.*)$/is;

/**
 * Normalize an OpenAI-style image_url string into a canonical image source.
 * Data URLs are decoded into `{ type:'base64', data, mediaType }` with the real
 * mime parsed from the header (no longer hardcoded to image/jpeg); http(s)/file
 * URLs become `{ type:'url', data:url }`.
 *
 * @param {string} url
 * @returns {{ type:'base64'|'url', data:string, mediaType:string }}
 */
function parseImageUrl(url) {
  const raw = String(url || '');
  const matched = raw.match(DATA_URL_HEAD_RE);
  if (matched) {
    const mediaType = String(matched[1] || 'image/png').trim() || 'image/png';
    return { type: 'base64', data: String(matched[2] || '').replace(/\s+/g, ''), mediaType };
  }
  return { type: 'url', data: raw, mediaType: 'image/jpeg' };
}

/**
 * Canonical image ContentBlock source → a URL string usable by OpenAI/Codex
 * (`image_url`). base64 sources become data URLs; url sources pass through.
 *
 * @param {{ type:'base64'|'url', data:string, mediaType:string }|null} source
 * @returns {string}
 */
function canonicalImageToUrl(source) {
  if (!source) return '';
  if (source.type === 'url') return source.data || '';
  if (source.data) return `data:${source.mediaType || 'image/png'};base64,${source.data}`;
  return '';
}

/**
 * Canonical image ContentBlock source → native Anthropic image source.
 *
 * @param {{ type:'base64'|'url', data:string, mediaType:string }|null} source
 * @returns {object|null}
 */
function canonicalImageToAnthropicSource(source) {
  if (!source) return null;
  if (source.type === 'url') return { type: 'url', url: source.data || '' };
  return { type: 'base64', media_type: source.mediaType || 'image/png', data: source.data || '' };
}

/**
 * Apply canonical sampling/control params onto a flat (OpenAI-chat or Anthropic)
 * request body using each protocol's native key names. Single source of truth so
 * the A and B layers never drift on which params survive.
 *
 * @param {object} target - Request body to mutate
 * @param {object} metadata - Canonical request metadata
 * @param {string} protocol - 'openai' | 'grok' | 'anthropic'
 * @returns {object} target
 */
function applySamplingParams(target, metadata, protocol) {
  const m = metadata || {};
  const isAnthropic = protocol === PROTOCOLS.ANTHROPIC;
  const isOpenAILike = protocol === PROTOCOLS.OPENAI || protocol === PROTOCOLS.GROK;

  if (m.topP != null) target.top_p = m.topP;
  if (m.stopSequences) target[isAnthropic ? 'stop_sequences' : 'stop'] = m.stopSequences;

  if (isAnthropic) {
    if (m.thinking != null) target.thinking = m.thinking;
  } else if (isOpenAILike) {
    if (m.frequencyPenalty != null) target.frequency_penalty = m.frequencyPenalty;
    if (m.presencePenalty != null) target.presence_penalty = m.presencePenalty;
    if (m.seed != null) target.seed = m.seed;
    if (m.responseFormat != null) target.response_format = m.responseFormat;
    if (m.reasoningEffort != null) target.reasoning_effort = m.reasoningEffort;
  }
  return target;
}

module.exports = {
  PROTOCOLS,
  detectProtocol,
  getSupportedProtocols,
  DESC_LIMITS,
  safeParseToolArgs,
  parseImageUrl,
  canonicalImageToUrl,
  canonicalImageToAnthropicSource,
  applySamplingParams,
};
