'use strict';

/**
 * aiManagementServer 的「Web 聊天 REST 处理器」子系统(从上帝文件抽出)。
 *
 * 承载 AIChat.vue 走 HTTP(非 WS)时的聊天代理平面,均经宿主 routeRequest 分派:
 *  - _resolveChatAttachments:把 body.attachments(上传返回的 id)解析为网关就绪材料
 *    (图片 dataUrl 并入 options.images、文本/文档/引用块前置进消息)——服务端解析以让
 *    请求体保持在 1 MB parseBody 上限内。
 *  - handleChatHttp / handleChatStreamHttp:非流式 / SSE 流式聊天补全(_summarizeToolResultForStream
 *    压缩工具结果用于 SSE;该 helper 也被宿主 WS 处理器复用,故按同名 re-import 接回宿主)。
 *  - handlePersonaHttp:人格/努力度快照。_isWebInlineImagePathEnabled:识图内联路径开关(__test__)。
 *
 * **无模块态**:本簇不持有可变模块态(聊天请求序号 _chatRequestSeq 的态留宿主,
 * 经注入的 _genChatRequestId 读写)。
 *
 * **反向边经依赖注入打破**:处理器体调宿主的 sendJson(响应)、parseBody(§3)、
 * authenticateRequest(§5)、getAi / getSecurity(§2 懒加载单例 getter)、
 * _genChatRequestId(§1·态 _chatRequestSeq 留宿主)。宿主加载时调一次 setChatHttpDeps 注入;
 * 被迁函数体仍按**同名**引用,故字节不变。注入目标全为宿主**函数声明**(提升)→ 加载期钉接无 TDZ。
 *
 * **刻意非纯零 IO 叶子**:懒加载网关 / 安全 / 上传解析,读写流。放置为 aiManagementServer.js 的
 * **同目录兄弟**以保懒 require 相对路径字节不变。宿主 routeRequest 分派的处理器 +
 * WS 处理器复用的 _summarizeToolResultForStream 按**同名 re-import** 接回,调用点字节不变。
 */

const os = require('os');
const path = require('path');

// 宿主注入的反向边(聊天请求号 / 认证 / 响应 / 请求体解析 / 懒加载 getter),加载时由 setChatHttpDeps 注入一次。
let _genChatRequestId = null;
let authenticateRequest = null;
let getAi = null;
let getSecurity = null;
let parseBody = null;
let sendJson = null;
function setChatHttpDeps(deps = {}) {
  if (typeof deps._genChatRequestId === 'function') _genChatRequestId = deps._genChatRequestId;
  if (typeof deps.authenticateRequest === 'function') authenticateRequest = deps.authenticateRequest;
  if (typeof deps.getAi === 'function') getAi = deps.getAi;
  if (typeof deps.getSecurity === 'function') getSecurity = deps.getSecurity;
  if (typeof deps.parseBody === 'function') parseBody = deps.parseBody;
  if (typeof deps.sendJson === 'function') sendJson = deps.sendJson;
}

// Resolve body.attachments (an array of { id } or id strings the chat page sent
// after uploading via /api/ai/upload) into gateway-ready material: image dataUrls
// merged into options.images, and text/document/reference blocks prepended to the
// user's message. Keeping resolution server-side is what lets the chat request
// body stay under the 1 MB parseBody cap — only opaque ids travel over the wire.
function _resolveChatAttachments(body, baseMessage) {
  const ids = Array.isArray(body.attachments) ? body.attachments : [];
  let message = String(baseMessage || '');
  let images = Array.isArray(body.images) ? body.images.slice() : [];

  if (ids.length) {
    let resolved;
    try {
      resolved = require('./aiUploadStore').resolveForChat(ids);
    } catch {
      resolved = null;
    }
    if (resolved) {
      if (Array.isArray(resolved.images) && resolved.images.length) {
        images = images.concat(resolved.images);
      }
      if (Array.isArray(resolved.promptBlocks) && resolved.promptBlocks.length) {
        const attachmentText = resolved.promptBlocks.join('\n\n');
        message = message ? `${message}\n\n${attachmentText}` : attachmentText;
      }
    }
  }

  // Inline image-path → attachment parity with the REPL (repl.js:5007). The web/
  // collaboration channel only resolved UPLOADED attachments above; a user who types
  // a local image path (e.g. a clipboard-img2file screenshot path) instead of uploading
  // would otherwise send the raw path as text → a text-only model improvises python/
  // tesseract OCR in a loop. Reuse the same SSOT leaves the REPL uses (no new regex;
  // extractInlineImageIntent only matches png/jpg/jpeg/gif/webp, so it cannot be abused
  // to read .env/.key). Gate KHY_WEB_INLINE_IMAGE_PATH (default on); when off this block
  // is a no-op and the byte-for-byte previous behavior is preserved. Best-effort: any
  // failure (path not found, unreadable, oversized) leaves the message untouched and
  // falls through as text, exactly like repl.js:5020.
  if (_isWebInlineImagePathEnabled() && message) {
    try {
      const { extractInlineImageIntent } = require('../cli/repl/imageIntent');
      const intent = extractInlineImageIntent(message);
      if (intent && intent.filePath) {
        const img = require('./imageService').readImageFromFile(intent.filePath);
        images.push({ base64: img.base64, mimeType: img.mimeType });
        message = intent.prompt || '请分析这张图片的内容';
      }
    } catch { /* leave message as text on any failure (parity with repl.js:5020) */ }
  }

  return { message, images };
}

// Gate for inline image-path extraction in the web/collaboration chat channel.
// Default on; only explicit 0/false/off/no disables it (byte-revert to upload-only).
function _isWebInlineImagePathEnabled() {
  const v = process.env.KHY_WEB_INLINE_IMAGE_PATH;
  return !(v !== undefined && ['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase()));
}

async function handleChatHttp(req, res) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    return sendJson(res, 401, { success: false, message: auth.error || 'Authentication required' });
  }

  const body = await parseBody(req);
  const rawMessage = String(body.message || body.question || '').trim();
  const { message, images } = _resolveChatAttachments(body, rawMessage);
  if (!message && !(images && images.length)) {
    return sendJson(res, 400, { success: false, message: 'message is required' });
  }

  if (rawMessage) {
    try {
      const security = getSecurity();
      const check = security.analyzeInput(rawMessage);
      if (!check.safe) {
        return sendJson(res, 400, { success: false, message: check.refusal || 'Blocked by security policy', blocked: true });
      }
    } catch {
      // best effort security check
    }
  }

  try {
    const result = await getAi().chat(message, {
      effort: body.effort || 'high',
      images: images && images.length ? images : undefined,
      preferredAdapter: body.preferredAdapter || undefined,
      preferredModel: body.preferredModel || body.model || undefined,
    });
    return sendJson(res, 200, {
      success: true,
      reply: result.reply || '',
      provider: result.provider || null,
      adapter: result.adapter || null,
      tokenUsage: result.tokenUsage || null,
      elapsed: result.elapsed || 0,
      effort: result.effort || body.effort || 'high',
    });
  } catch (err) {
    return sendJson(res, 500, { success: false, message: `Chat failed: ${err.message}` });
  }
}

// Condense a tool_result chunk to a short single-line preview for the SSE
// `tool_result` event. Keeps the conversation transparent (the user sees the
// outcome of each tool call) without flooding the stream with raw payloads.
function _summarizeToolResultForStream(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  // Prefer the backend-computed summary (the SSOT one-liner) when present.
  const raw = chunk.text != null ? chunk.text
    : chunk.summary != null ? chunk.summary
    : chunk.content != null ? chunk.content
    : chunk.output != null ? chunk.output
    : chunk.result != null ? chunk.result : '';
  let s;
  if (typeof raw === 'string') {
    s = raw;
  } else {
    // A structured object reached here with no string summary — route it through
    // the SAME SSOT the CLI/TUI use instead of JSON.stringify'ing raw {braces}
    // straight to the web user ("前端看见了，人也难以阅读"). Falls back to a
    // readable field rendering, never braces.
    try {
      const { summarizeToolResult } = require('../cli/toolResultSummary');
      const resultObj = (chunk.result && typeof chunk.result === 'object') ? chunk.result : chunk;
      s = summarizeToolResult(chunk.tool || chunk.name || '', resultObj, chunk.input || {});
    } catch {
      try { s = JSON.stringify(raw); } catch { s = String(raw); }
    }
  }
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

// SSE streaming chat. The AIChat frontend's default transport POSTs here and
// reads Server-Sent Events (start | status | thinking | tool_use | tool_result
// | control_request | chunk | done | error).
//
// Previously this routed through gateway.generate() — a single-shot LLM call
// that never ran the tool loop, so the default web chat could only ever return
// plain text: tool calls were silently dropped and the user saw "only a reply,
// no tools" (or an empty bubble when the model answered purely with tool_use).
// We now route through getAi().chat() — the same agentic path the CLI and the
// /api/ai/chat + WebSocket transports use — so the web chat actually executes
// tools and streams real token-level text. tool_use / tool_result chunks are
// forwarded as their own SSE events so the conversation shows the full flow.
//
// SSE is one-way, so approval-gated tools cannot be answered interactively:
// onControlRequest forwards the prompt for visibility but returns undefined,
// which the tool loop treats as fail-closed deny (read-only tools — search,
// read, list — still run freely). This matches the WebSocket transport.
async function handleChatStreamHttp(req, res) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    return sendJson(res, 401, { success: false, message: auth.error || 'Authentication required' });
  }

  const body = await parseBody(req);
  const rawMessage = String(body.message || body.question || '').trim();
  const { message, images: attachmentImages } = _resolveChatAttachments(body, rawMessage);
  if (!message && !(attachmentImages && attachmentImages.length)) {
    return sendJson(res, 400, { success: false, message: 'message is required' });
  }

  if (rawMessage) {
    try {
      const security = getSecurity();
      const check = security.analyzeInput(rawMessage);
      if (!check.safe) {
        return sendJson(res, 400, { success: false, message: check.refusal || 'Blocked by security policy', blocked: true });
      }
    } catch {
      // best effort security check
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const sendEvent = (data) => {
    if (clientGone) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* connection closed */ }
  };

  // When the client navigates away mid-stream the socket closes. Stop writing
  // and tear down the heartbeat immediately so neither the 15s timer nor the
  // simulated-chunk loop keep pushing into a dead connection.
  let clientGone = false;
  sendEvent({ type: 'start', model: body.preferredModel || body.model || 'auto', timestamp: Date.now() });
  const heartbeatTimer = setInterval(() => sendEvent({ type: 'heartbeat', timestamp: Date.now() }), 15000);
  req.on('close', () => {
    clientGone = true;
    clearInterval(heartbeatTimer);
  });

  // Zero-silent-failure (DESIGN-ARCH-028): every abnormal termination of this
  // stream — empty reply, thrown error, or process death — gets a precise
  // E01–E08 attribution injected as a terminal 'error' event. The frontend must
  // render that, never a bare "未返回有效回复". fail-soft: if the failsafe module
  // is unavailable, fall back to the legacy minimal error event.
  // One requestId per turn — threaded into the chat options so traceAudit stamps
  // every stage (llm.request → tool.call → tool.result → delivery.final) under it,
  // and stamped onto any terminal failsafe error event so the frontend can drill
  // down to the server-side timeline (GET …/monitor/attribution?requestId=…).
  const requestId = _genChatRequestId();
  let failsafe = null;
  try {
    const { StreamFailSafeInjector } = require('./failsafe');
    failsafe = new StreamFailSafeInjector({
      send: sendEvent,
      res,
      context: {
        model: body.preferredModel || body.model || undefined,
        endpoint: 'ai-gateway',
        requestId,
      },
    });
  } catch { failsafe = null; }

  // Tracks how much visible text we streamed and whether any tool ran, so the
  // terminal `done` event and the empty-reply failsafe can reason about whether
  // the turn actually produced output (text and/or tool activity).
  let streamedChars = 0;
  let toolRan = false;
  try {
    const result = await getAi().chat(message, {
      effort: body.effort || 'high',
      requestId,
      images: attachmentImages && attachmentImages.length ? attachmentImages : undefined,
      preferredAdapter: body.preferredAdapter || undefined,
      preferredModel: body.preferredModel || body.model || undefined,
      onChunk: (chunk) => {
        if (!chunk || clientGone) return;
        const t = String(chunk.type || '');
        if (t === 'text') {
          const piece = String(chunk.text || '');
          if (!piece) return;
          streamedChars += piece.length;
          if (failsafe) failsafe.emit({ type: 'chunk', content: piece });
          else sendEvent({ type: 'chunk', content: piece });
        } else if (t === 'reset') {
          // 响应防抖抗拼接：上游判定本轮已流出的文本为废稿（套话拒绝重试），
          // 通知前端丢弃已累积的气泡内容、等待修正内容替换。已流出的字符不再计数，
          // 这样末尾「reply 已流式过」判定不会误把废稿算作已交付。
          streamedChars = 0;
          sendEvent({ type: 'reset', reason: String(chunk.reason || 'retry'), timestamp: Date.now() });
        } else if (t === 'thinking') {
          const text = String(chunk.text || '');
          if (text) sendEvent({ type: 'thinking', text, timestamp: Date.now() });
        } else if (t === 'tool_use') {
          toolRan = true;
          sendEvent({
            type: 'tool_use',
            tool: String(chunk.tool || chunk.name || 'tool'),
            input: chunk.input !== undefined ? chunk.input : {},
            id: String(chunk.id || chunk.toolUseId || ''),
            timestamp: Date.now(),
          });
        } else if (t === 'tool_result') {
          let success;
          if (typeof chunk.success === 'boolean') success = chunk.success;
          else if (typeof chunk.isError === 'boolean') success = !chunk.isError;
          else if (typeof chunk.is_error === 'boolean') success = !chunk.is_error;
          sendEvent({
            type: 'tool_result',
            tool: String(chunk.tool || chunk.name || 'tool'),
            success,
            text: _summarizeToolResultForStream(chunk),
            id: String(chunk.id || chunk.toolUseId || ''),
            timestamp: Date.now(),
          });
        } else if (t === 'status') {
          sendEvent({ type: 'status', text: String(chunk.text || ''), timestamp: Date.now() });
        } else if (t === 'heartbeat') {
          sendEvent({ type: 'heartbeat', text: String(chunk.text || ''), timestamp: Date.now() });
        } else if (t === 'control_request') {
          sendEvent({
            type: 'control_request',
            requestId: String(chunk.requestId || chunk.id || '').trim(),
            request: chunk.request && typeof chunk.request === 'object' ? chunk.request : {},
            timestamp: Date.now(),
          });
        }
      },
      onControlRequest: ({ requestId, request } = {}) => {
        if (clientGone) return undefined;
        sendEvent({
          type: 'control_request',
          requestId: String(requestId || '').trim(),
          request: request && typeof request === 'object' ? request : {},
          timestamp: Date.now(),
        });
        // One-way SSE cannot carry an approval back; the tool loop reads an
        // undefined response as fail-closed deny. Read-only tools are unaffected.
        return undefined;
      },
      onFallback: (info) => {
        sendEvent({
          type: 'status',
          text: `适配器回退：${(info && info.failedAdapter) || '?'} -> ${(info && info.nextAdapter) || '?'}`,
          timestamp: Date.now(),
        });
      },
    });

    let reply = String((result && result.reply) || '').trim();
    // 输出层软 bug 主动监听(goal 2026-06-25):Web/SSE 的最终收口(与 CLI 的
    // normalizeFinal / renderAiResponse 对称)。对**完整 reply**(非流式分片,故可安全闭合
    // 围栏)检测并简单修复乱码 / 未闭合围栏;不可修复落错误日志。render:true 永不抛(抛会让
    // 整条 SSE 回复弄没)。fail-soft:监听器缺失/异常用原 reply 继续。下方模拟分片与 done
    // 信封都消费这个已守护的 reply,使 Web 客户端收到的最终文本干净一致。
    try {
      reply = require('./outputIntegrityMonitor').guardText(reply, { source: 'web-sse-done', render: true }).text.trim();
    } catch { /* monitor absent/erroring — emit raw reply unchanged */ }
    // If the final reply text was not already delivered as token-level `text`
    // chunks (some adapters return the whole answer only in the result), emit it
    // now in simulated chunks so the bubble is never left empty.
    if (reply && streamedChars === 0) {
      const CHUNK_SIZE = 24;
      for (let i = 0; i < reply.length; i += CHUNK_SIZE) {
        const piece = reply.slice(i, i + CHUNK_SIZE);
        if (failsafe) failsafe.emit({ type: 'chunk', content: piece });
        else sendEvent({ type: 'chunk', content: piece });
      }
    }

    if (reply || streamedChars > 0 || toolRan) {
      // Structured turn envelope for web/API parity (我希望Khy-os是结构化输出): derived
      // purely from the chat result's structured fields (toolCallLog/error_code), not
      // from the prose. Additive — `content` stays the human-facing text.
      let structured = null;
      if (process.env.KHY_STRUCTURED_OUTPUT !== '0' && process.env.KHY_STRUCTURED_OUTPUT !== 'false') {
        try {
          structured = require('./structuredResults/turnEnvelope')
            .buildTurnEnvelope(result || {}, { summary: reply });
        } catch { /* best-effort; never block the stream */ }
      }
      sendEvent({
        type: 'done',
        content: reply,
        model: (result && (result.provider || result.adapter)) || 'AI',
        adapter: (result && result.adapter) || null,
        usage: (result && result.tokenUsage) || null,
        ...(structured ? { structured } : {}),
      });
      if (failsafe) failsafe.markDone();
      // Auto-capture: after a genuine reply, judge whether the user's raw prompt
      // is worth saving and, if so, enqueue it for review. Fire-and-forget and
      // fully fail-soft — must never disturb the stream we just completed.
      maybeAutoCapturePrompt(auth.user?.id ?? 0, rawMessage);
    } else if (failsafe) {
      // Empty reply with no tool activity → precise E01 (or E02 if the model
      // stopped on a safety policy). Replaces the vague "未返回有效回复".
      failsafe.fail(
        { errorType: 'empty_reply', model: (result && result.provider) || undefined, finish_reason: result && (result.finish_reason || result.finishReason) },
        { kind: 'llm' },
      );
    } else {
      sendEvent({ type: 'error', message: 'AI 未返回有效回复 — 请重试或检查连接' });
    }
  } catch (err) {
    // Classify the thrown error to E0x (timeout/network→E06, refusal→E02,
    // context→E03, permission→E07, else E04) instead of leaking a raw message.
    if (failsafe) failsafe.fail(err);
    else sendEvent({ type: 'error', message: (err && err.message) ? err.message : 'Internal error' });
  } finally {
    clearInterval(heartbeatTimer);
    // Last-resort: if no terminal event was emitted (unexpected escape), inject
    // the forced fallback so the stream never ends silently. no-op if already
    // finalized via done/fail above.
    if (failsafe) failsafe.finalize();
    try { res.end(); } catch { /* already ended */ }
  }
}

// Read-only persona summary for the AIChat persona card. Mirrors the main
// backend's GET /api/ai/persona so the page's persona fetch resolves on the
// daemon too (previously 404, silently swallowed by the frontend).
function handlePersonaHttp(req, res) {
  try {
    const personaService = require('./personaService');
    const summary = personaService.summarizePersona(process.cwd());
    sendJson(res, 200, { success: true, ...summary });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message, present: false, sections: [] });
  }
}

module.exports = {
  // 宿主 routeRequest 分派 / WS 复用 / __test__ 暴露的处理器(同名 re-import 接回)
  handleChatHttp,
  handleChatStreamHttp,
  handlePersonaHttp,
  _resolveChatAttachments,
  _isWebInlineImagePathEnabled,
  _summarizeToolResultForStream,
  // 依赖注入
  setChatHttpDeps,
};
