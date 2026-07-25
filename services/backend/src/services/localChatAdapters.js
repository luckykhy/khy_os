'use strict';

/**
 * localChatAdapters — bridge a weak LOCAL model (Ollama / llama.cpp) into the
 * one true tool-use loop (`runToolUseLoop`).
 *
 * Background: the loop-collapse work routes weak local models through the SAME
 * `runToolUseLoop` as cloud models, over the TEXT tool-call protocol
 * (`<tool_call>…</tool_call>`) instead of native `tool_use` blocks. The loop
 * calls an injected `chat(message, opts) -> aiResult`; this module builds that
 * `chat` over `gateway.generateWithSubModel`.
 *
 * Two responsibilities the wrapper owns (deliberately kept OUT of the loop so
 * the loop's only protocol seams stay PARSE + FORMAT):
 *
 *   1. System prompt + tool whitelist. The weak model is TOLD, via the text
 *      adapter's system addendum, which curated tools it may emit and in what
 *      `<tool_call>` shape. This only shapes what the model attempts — the
 *      executeTool funnel remains the real enforcement boundary (the syscall
 *      gateway / permission layer is never relaxed here).
 *
 *   2. Conversation history. The main loop REPLACES its `currentMessage` with
 *      each turn's tool-result text, so a stateless wrapper would forget the
 *      original goal after iteration 1. The wrapper keeps its own running
 *      `messages` history (closure state) and feeds the FULL transcript to the
 *      local adapter, which consumes `messages` and ignores the bare prompt.
 *
 * aiResult contract (what the loop reads back):
 *   - `.reply`  — assistant text; the TEXT protocol parses `<tool_call>` from it.
 *                 `generateWithSubModel` returns `.content`, so we MUST remap.
 *   - NO `.toolUseBlocks` — that is the native path; setting it would make the
 *                 loop treat the turn as structured tool_use.
 *   - NO `.errorType`, ever — a failed local generation degrades to plain
 *                 `.reply` text. An `.errorType` would route the loop into its
 *                 transient-recovery path (designed for cloud channel blips),
 *                 which is wrong for a weak local model: nothing is transient.
 */

/**
 * Best-effort full tool definitions, with a safe empty fallback when the
 * registry is unavailable (e.g. in a minimal test harness).
 * @returns {Array}
 */
function _safeToolDefinitions() {
  try {
    return require('./toolCalling').getToolDefinitions() || [];
  } catch {
    return [];
  }
}

/**
 * Build a `chat(message, opts)` function over a local sub-model adapter, shaped
 * for `runToolUseLoop` driven on the TEXT tool-call protocol.
 *
 * @param {object} gateway   the AI gateway (must expose generateWithSubModel)
 * @param {string} localKey  the local adapter key (e.g. 'ollama')
 * @param {object} [opts]
 * @param {boolean} [opts.writeEnabled=false] include the opt-in write/shell
 *        delivery tier in the advertised whitelist + persona. The caller
 *        (dispatch) decides this from whether an approval channel is wired;
 *        the executeTool gate still fail-closes every high-risk call.
 * @param {Array} [opts.toolDefinitions] override the full tool defs (tests).
 * @param {object} [opts.adapter] override the text protocol adapter (tests).
 * @returns {(message: string, chatOpts?: object) => Promise<{reply:string, provider:string, tokenUsage:(object|null)}>}
 */
function makeLocalModelChat(gateway, localKey, opts = {}) {
  if (!gateway || typeof gateway.generateWithSubModel !== 'function') {
    throw new TypeError('makeLocalModelChat: gateway.generateWithSubModel is required');
  }

  const textAdapter = (opts.adapter && typeof opts.adapter.buildSystemAddendum === 'function')
    ? opts.adapter
    : require('./toolProtocolAdapter').textAdapter;

  // Resolve the advertised tool surface ONCE — it is stable across the turns of
  // a single request. selectTools curates a read-only base tier plus, when
  // writeEnabled, the write/shell delivery tier; buildSystemAddendum renders the
  // text-protocol instructions + persona for exactly that surface.
  const allDefs = Array.isArray(opts.toolDefinitions) ? opts.toolDefinitions : _safeToolDefinitions();
  const writeEnabled = !!opts.writeEnabled;
  const defs = textAdapter.selectTools(allDefs, { writeEnabled }) || [];
  const system = textAdapter.buildSystemAddendum(defs, { writeEnabled }) || '';

  // Per-request running history. history[0] keeps the original user goal alive
  // even after the loop rewrites currentMessage into tool-result text.
  const history = [];

  return async function localModelChat(message, chatOpts = {}) {
    const userTurn = String(message == null ? '' : message);
    history.push({ role: 'user', content: userTurn });

    let r;
    try {
      r = await gateway.generateWithSubModel(userTurn, localKey, {
        cwd: (chatOpts && chatOpts.cwd) || process.cwd(),
        system,
        // Full transcript: local adapters consume `messages` and ignore the
        // bare prompt when messages is non-empty, so there is no double-turn.
        messages: history.slice(),
      });
    } catch (e) {
      // A THROWN generation surfaces as plain reply text — never an errorType
      // (see contract above). Keep the transcript consistent for the next turn.
      const msg = `本地模型生成失败：${e && e.message ? e.message : String(e)}`;
      history.push({ role: 'assistant', content: msg });
      return { reply: msg, provider: localKey, tokenUsage: null };
    }

    // success:false returns its diagnostic in `.content` — we forward it as
    // plain reply text (still no errorType), matching the throw branch.
    const reply = r && r.content != null ? String(r.content) : '';
    history.push({ role: 'assistant', content: reply });

    return {
      reply,
      provider: (r && r.provider) || localKey,
      tokenUsage: (r && r.tokenUsage) || null,
      // Intentionally NO toolUseBlocks (text protocol, not native).
      // Intentionally NO errorType (degrade to reply text, never transient path).
    };
  };
}

module.exports = { makeLocalModelChat };
