'use strict';

/**
 * aiChatConsumer — bridge-side consumer that turns WS `chat`/`cancel` messages
 * into aiGateway.generate() calls, and broadcasts chunks back over the bridge
 * WS as the existing `chunk_*` / `turn_*` event family that the mobile
 * collaboration page already understands (see bridgeServer.js:812-821 for the
 * REPLAY_SKIP_TYPES set).
 *
 * PR: merge-khychat-into-bridge. This file is mounted by bridgeServer.js and
 * never touched by anyone else; the Ink TUI side (useQueryBridge.js) still
 * receives the original `input` events untouched.
 *
 * Contract (input WS messages from the browser/mobile client):
 *   { type: 'chat',   turnId?: string, text: string,
 *     attachments?: string[], preferredAdapter?: string, preferredModel?: string }
 *   { type: 'cancel', turnId: string }
 *
 * Contract (output WS messages broadcast to all authenticated clients):
 *   Field names match what bridge/mobilePage.js:693-799 already understands
 *   (chunk_text uses `content` not `delta`; tool_use uses `toolId` not `id`).
 *   { type: 'turn_start',    turnId, input }
 *   { type: 'chunk_text',    turnId, content }
 *   { type: 'chunk_thinking',turnId, content }
 *   { type: 'chunk_tool_use',turnId, tool, input, toolId }
 *   { type: 'chunk_tool_result', turnId, content, tool, success }
 *   { type: 'chunk_status',  turnId, content }
 *   { type: 'turn_complete', turnId, model, cost, cancelled }
 *   { type: 'turn_error',    turnId, error }
 *
 * History is persisted via sessionHistoryStore (per-user JSON file under
 * ~/.khy/chat_history/<userId>.json) — see that module for the schema.
 */

const crypto = require('crypto');

const aiGateway = require('../services/gateway/aiGateway');
const sessionHistoryStore = require('./sessionHistoryStore');

// Per-userId, in-memory map of active turnId → AbortController so a
// `type:'cancel'` from the client can stop the in-flight gateway call.
// Cleared when the turn ends (success, error, or cancel). Process-local;
// not persisted (a reconnect after a process restart can't cancel an old
// turn, which is fine — the server will just finish it).
const _activeTurns = new Map();

function _newTurnId() {
  return 'turn-' + crypto.randomBytes(6).toString('hex');
}

function _userIdOf(clientId, getUserId) {
  try {
    const id = getUserId(clientId);
    return id ? String(id) : 'anon';
  } catch {
    return 'anon';
  }
}

/**
 * Mount the consumer onto a bridge WS message dispatcher.
 *
 * @param {object} deps
 * @param {(clientId: string) => string|number|null} deps.getUserId
 *   Resolve the authed WS clientId → userId (e.g. bridgeAuth.lookupUserId).
 *   If absent or returns null/false, the consumer falls back to "anon".
 * @param {(data: object) => void} deps.broadcastOutput
 *   bridgeServer.broadcastOutput — fans chunks out to all authed clients.
 * @param {object} [deps.gateway]   aiGateway (overridable for tests).
 * @param {object} [deps.history]   sessionHistoryStore (overridable for tests).
 * @returns {{ handleChat: Function, handleCancel: Function, _activeTurns: Map }}
 */
function attach(deps) {
  const getUserId = deps && deps.getUserId ? deps.getUserId : () => null;
  const broadcast = deps && deps.broadcastOutput ? deps.broadcastOutput : () => {};
  const gateway = deps && typeof deps.gateway === 'object' && deps.gateway !== null
    ? deps.gateway
    : aiGateway;
  const history = deps && typeof deps.history === 'object' && deps.history !== null
    ? deps.history
    : sessionHistoryStore;
  // Note: undefined deps.{gateway,history} both fall back to the real module
  // via the `typeof === 'undefined' -> falsy` short-circuit. Tests pass
  // an actual object to override; production code passes nothing.

  /**
   * Handle a `chat` WS message from one client. Returns immediately; the
   * gateway call is async. Errors are surfaced as `turn_error` broadcasts.
   */
  async function handleChat(clientId, msg) {
    const userId = _userIdOf(clientId, getUserId);
    const text = String((msg && msg.text) || '').trim();
    if (!text) {
      return;
    }
    const turnId = String((msg && msg.turnId) || _newTurnId());
    const startedAt = Date.now();
    const ac = new AbortController();
    _activeTurns.set(turnId, ac);

    history.appendTurn(userId, { id: turnId, user: text, startedAt });

    broadcast({ type: 'turn_start', turnId, input: text });

    const collected = { text: '', thinking: '', cancelled: false, error: null, model: null, cost: null };
    let finished = false;

    const onChunk = (chunk) => {
      if (!chunk || ac.signal.aborted) {
        return;
      }
      const t = chunk.type;
      if (t === 'thinking') {
        const d = String(chunk.text || '');
        if (d) {
          collected.thinking += d;
          broadcast({ type: 'chunk_thinking', turnId, content: d });
        }
      } else if (t === 'text' || t === 'chunk' || t === 'assistant_message') {
        const d = String(chunk.text || chunk.content || '');
        if (d) {
          collected.text += d;
          broadcast({ type: 'chunk_text', turnId, content: d });
        }
      } else if (t === 'tool_use') {
        broadcast({
          type: 'chunk_tool_use',
          turnId,
          tool: String(chunk.tool || chunk.name || 'tool'),
          input: chunk.input !== undefined ? chunk.input : {},
          toolId: String(chunk.id || chunk.toolUseId || ''),
        });
      } else if (t === 'tool_result') {
        const success =
          typeof chunk.success === 'boolean'
            ? chunk.success
            : typeof chunk.isError === 'boolean'
              ? !chunk.isError
              : typeof chunk.is_error === 'boolean'
                ? !chunk.is_error
                : true;
        broadcast({
          type: 'chunk_tool_result',
          turnId,
          tool: String(chunk.tool || chunk.name || 'tool'),
          success,
          content: String(chunk.text || chunk.content || ''),
          toolId: String(chunk.id || chunk.toolUseId || ''),
        });
      } else if (t === 'status') {
        broadcast({
          type: 'chunk_status',
          turnId,
          content: String(chunk.text || ''),
        });
      } else if (t === 'cost') {
        collected.cost = chunk;
        broadcast({ type: 'chunk_status', turnId, content: '已记录用量' });
      } else if (t === 'error') {
        collected.error = String(chunk.text || chunk.message || 'AI 错误');
        broadcast({ type: 'chunk_status', turnId, content: collected.error });
      } else if (t === 'model') {
        collected.model = chunk.model || chunk.name || null;
      }
    };

    try {
      const messages = [{ role: 'user', content: text }];
      const result = await gateway.generate(text, {
        system: undefined,
        messages,
        userId,
        sessionId: turnId,
        preferredAdapter: msg && msg.preferredAdapter ? String(msg.preferredAdapter) : undefined,
        preferredModel: msg && msg.preferredModel ? String(msg.preferredModel) : undefined,
        abortSignal: ac.signal,
        onChunk,
      });
      if (ac.signal.aborted) {
        collected.cancelled = true;
      } else if (result && typeof result === 'object') {
        // Non-streaming path: gateway returned the full content in result.content
        if (result.content && !collected.text) {
          collected.text = String(result.content);
          broadcast({ type: 'chunk_text', turnId, delta: collected.text });
        }
        if (result.model || result.provider) {
          collected.model = collected.model || result.model || result.provider;
        }
        if (result.usage || result.tokenUsage) {
          collected.cost = collected.cost || result.usage || result.tokenUsage;
        }
        if (result.error) {
          collected.error = String(result.error.message || result.error);
        }
      }
    } catch (err) {
      collected.error = String((err && (err.message || err)) || 'AI 调用失败');
      broadcast({ type: 'chunk_status', turnId, level: 'error', text: collected.error });
    } finally {
      finished = true;
      _activeTurns.delete(turnId);
      const patch = {
        finishedAt: Date.now(),
        assistant: collected.text,
        cancelled: collected.cancelled,
      };
      history.updateTurn(userId, turnId, patch);
      if (collected.error) {
        broadcast({ type: 'turn_error', turnId, error: collected.error });
      } else {
        broadcast({
          type: 'turn_complete',
          turnId,
          content: collected.text,
          model: collected.model,
          cost: collected.cost,
          cancelled: collected.cancelled,
        });
      }
    }
    // Silence "unused" linter for finished
    return finished;
  }

  /**
   * Handle a `cancel` WS message. Aborts the in-flight gateway call for the
   * turnId; the handleChat finally block will mark the turn cancelled and
   * broadcast turn_complete (cancelled:true). Returns true if a turn was
   * actually aborted, false if no such turnId is active.
   */
  function handleCancel(clientId, msg) {
    const turnId = msg && msg.turnId ? String(msg.turnId) : '';
    if (!turnId) {
      return false;
    }
    const ac = _activeTurns.get(turnId);
    if (!ac) {
      return false;
    }
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
    return true;
  }

  return { handleChat, handleCancel, _activeTurns };
}

module.exports = { attach };
