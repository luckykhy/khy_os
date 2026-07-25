'use strict';

/**
 * Request-parsing / stream-interception helpers (extracted from cli/ai.js).
 *
 * Owns a cohesive, conversation-state-free cluster used on the way in/out of a gateway request:
 * (1) inline tool-call marker detection + the streaming tool interceptor (_TOOL_CALL_MARKERS /
 * _partialToolMarkerTailLen / _resolveToolBlockInput / _createStreamToolInterceptor); (2) gateway
 * error classification (_classifyGatewayThrownError / _isFirstTokenSignalChunk /
 * _isTransientGatewayErrorType); (3) task-scale sizing (_resolveTaskScale); (4) ReDoS-guarded file
 * reference extraction (_extractFileReferences + FILEREF_MAX_TOKEN); (5) lightweight-input / greeting
 * detection; and (6) requested/user input language detection + the language fallback directive.
 *
 * Relocated verbatim (byte-identical bodies) into a same-directory sibling leaf so in-body relative
 * require() paths resolve identically; the host re-imports the entry points by the same names. The
 * bodies touch no mutable conversation/session state — the only module dependency is the shared
 * khyUpgradeRuntime singleton (re-required here).
 */

const runtime = require('../services/khyUpgradeRuntime');

// Inline tool-call markers the stream interceptor must catch before they reach
// the user as visible text. Used both to detect a completed marker and to size
// the smallest tail we must withhold (a partial marker that could still grow).
const _TOOL_CALL_MARKERS = ['<tool_call>', '【调用'];

// Longest trailing substring of `s` that is a NON-EMPTY proper prefix of any
// tool-call marker — i.e. the only bytes we must hold back because the next
// chunk could complete a marker. In the common case (no '<' / '【' near the
// end) this is 0, so every byte streams through with zero added latency. This
// replaces a blunt fixed-size tail buffer: the old code always withheld the
// last N chars of every flush (and the final N until finalize), needlessly
// holding generated tokens in the pipe ("憋大招").
function _partialToolMarkerTailLen(s) {
  if (!s) return 0;
  let retain = 0;
  for (const m of _TOOL_CALL_MARKERS) {
    const maxK = Math.min(s.length, m.length - 1);
    for (let k = maxK; k >= 1; k--) {
      if (s.endsWith(m.slice(0, k))) { if (k > retain) retain = k; break; }
    }
  }
  return retain;
}

/**
 * Whether the stream tool interceptor should collect the REAL structured tool
 * arguments (chunk.rawInput) rather than the truncated display summary
 * (chunk.input) into the authoritative, to-be-executed tool block.
 *
 * Dogfood root cause: every streaming adapter (_streamProcessor / cliToolAdapter)
 * emits each tool_use chunk with BOTH `input` (a short human-readable summary,
 * e.g. `command=echo hi`) and `rawInput` (the real object `{command:"echo hi"}`).
 * The interceptor historically pushed `chunk.input || {}` into
 * collectedToolUseBlocks — so a shell command round-tripped into a bare summary
 * string (which the tool loop JSON.parse-fails to `{}`) or — when the chunk was
 * emitted at content_block_start before any input_json_delta arrived — into `{}`,
 * dropping the command entirely. An empty command reaches the syscall gateway,
 * classifies critical (L2) and — in a non-interactive headless `khy -p`/pipe/
 * background run — fail-closes, so echo/node/sleep/timeout could never actually
 * run. Local gate (mirrors changeWatchService/_repoRootAnchorEnabled precedent so
 * ai.js keeps its dependency direction); gate off → byte-reverts to the summary.
 */
const _STREAM_TOOL_RAWINPUT_OFF = ['0', 'false', 'off', 'no'];
function _streamToolRawInputEnabled(env = process.env) {
  const v = String((env && env.KHY_STREAM_TOOL_RAW_INPUT) || '').trim().toLowerCase();
  return !_STREAM_TOOL_RAWINPUT_OFF.includes(v);
}

/**
 * Resolve the authoritative (executable) input object for a streamed tool_use
 * chunk, preferring the structured rawInput. Gate off → byte-identical to the
 * historical `chunk.input || {}`.
 *
 * @param {object} chunk - streamed tool_use chunk ({ input, rawInput, ... })
 * @param {object} [env] - environment (for the local gate; defaults to process.env)
 * @returns {object} the input object to execute with
 */
function _resolveToolBlockInput(chunk, env = process.env) {
  const inp = (chunk && chunk.input) || {};
  if (!_streamToolRawInputEnabled(env)) return inp; // byte-revert
  const raw = chunk && chunk.rawInput;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0) {
    return raw;
  }
  if (inp && typeof inp === 'object' && !Array.isArray(inp)) return inp;
  if (typeof inp === 'string' && inp.trim()) {
    try {
      const p = JSON.parse(inp);
      if (p && typeof p === 'object' && !Array.isArray(p)) return p;
    } catch { /* summary string is not JSON — no reliable structured args */ }
  }
  return {};
}

function _createStreamToolInterceptor(onChunk, options = {}) {
  // Keep a tail long enough to catch both "【调用" (4 chars) and "<tool_call>" (11 chars)
  const PASS_TAIL = 12;
  const suppressPrefixOnToolCall = options.suppressPrefixOnToolCall === true;
  const routeToolPrefaceToNarration = options.routeToolPrefaceToNarration === true;
  // Phase 7: Optional StreamingToolExecutor — pre-execute tools during streaming
  const streamingExecutor = options.streamingExecutor || null;
  const rawProbeChars = parseInt(String(process.env.KHY_TOOL_PREFIX_PROBE_CHARS || '72'), 10);
  const prefixProbeChars = Number.isFinite(rawProbeChars)
    ? Math.max(PASS_TAIL, Math.min(240, rawProbeChars))
    : 72;
  let pending = '';
  let toolCallDetected = false;
  const collectedToolUseBlocks = []; // Collect structured tool_use from API

  const safeEmit = (chunk) => {
    if (typeof onChunk === 'function') onChunk(chunk);
  };

  const summarizeToolChunkInput = (input) => {
    if (!input) return '';
    if (typeof input === 'string') return input.slice(0, 120);
    if (typeof input !== 'object') return String(input).slice(0, 120);

    const preferred = input.file_path
      || input.filePath
      || input.path
      || input.command
      || input.pattern
      || input.query
      || input.q
      || input.url
      || input.name;
    if (typeof preferred === 'string' && preferred.trim()) {
      return preferred.trim().slice(0, 120);
    }

    try {
      return Object.entries(input)
        .map(([k, v]) => `${k}=${String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 40)}`)
        .join(', ')
        .slice(0, 120);
    } catch {
      return '';
    }
  };

  const emitToolPreface = (text) => {
    const cleaned = String(text || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!cleaned) return;
    safeEmit({ type: 'assistant_preface', text: cleaned });
  };

  const pushText = (text) => {
    pending += String(text || '');
    if (!pending) return;

    if (toolCallDetected) return;

    // Check for both tool call formats
    const cnIdx = pending.indexOf('【调用');
    const xmlIdx = pending.indexOf('<tool_call>');
    const hitIdx = cnIdx >= 0 && xmlIdx >= 0
      ? Math.min(cnIdx, xmlIdx)
      : cnIdx >= 0 ? cnIdx : xmlIdx;

    if (hitIdx >= 0) {
      if (hitIdx > 0 && !suppressPrefixOnToolCall) {
        if (routeToolPrefaceToNarration) emitToolPreface(pending.slice(0, hitIdx));
        else safeEmit({ type: 'text', text: pending.slice(0, hitIdx) });
      }
      pending = '';
      toolCallDetected = true;
      return;
    }

    // suppressPrefixOnToolCall is an explicit opt-in to HIDE a short preface
    // when a tool call follows: keep withholding within the probe window so we
    // can still drop it if a marker/tool_use arrives next. This path is off by
    // default (KHY_TOOL_LOOP_SUPPRESS_TOOL_PREFACE) and is the only case that
    // deliberately holds visible text.
    if (suppressPrefixOnToolCall && pending.length <= prefixProbeChars) return;

    // Default + narration paths: stream every byte immediately, withholding ONLY
    // a trailing partial-marker candidate (usually 0 chars). No fixed tail lag,
    // no "hold the first N chars" buffer — generated tokens punch straight
    // through the pipe so the user sees them in real time. The final tail is
    // released by finalize() once the stream ends.
    const retain = _partialToolMarkerTailLen(pending);
    if (pending.length > retain) {
      const out = pending.slice(0, pending.length - retain);
      if (out) {
        if (routeToolPrefaceToNarration) emitToolPreface(out);
        else safeEmit({ type: 'text', text: out });
      }
      pending = retain ? pending.slice(pending.length - retain) : '';
    }
  };

  const onInterceptChunk = (chunk) => {
    if (!chunk || typeof chunk !== 'object') return;

    // 流式重置帧（响应防抖抗拼接）：上游判定本轮已流出的文本是废稿（套话拒绝重试）。
    // 丢弃本拦截器仍扣留的尾巴 pending，并把 reset 原样透传给下游消费端，让其丢弃
    // 已累积的废稿、等待修正内容替换——而非把修正内容追加在废稿后面。
    if (chunk.type === 'reset') {
      pending = '';
      safeEmit(chunk);
      return;
    }

    let normalizedChunk = chunk;

    // Collect structured tool_use blocks from adapters that emit them.
    // Adapters emit different shapes:
    //   claudeAdapter/_streamProcessor/codexAdapter: { type:'tool_use', tool, input, id }
    //   relayApiAdapter:                             { type:'tool_use', name, input, id }
    //   kiroAdapter:                                 { type:'tool_use_end', name, input, toolUseId }
    const isToolUseChunk = chunk.type === 'tool_use' || chunk.type === 'tool_use_end';
    const toolName = chunk.tool || chunk.name;
    if (isToolUseChunk && toolName) {
      // Flush any buffered text before marking tool call detected.
      // The PASS_TAIL buffer may hold real response text that must not be lost.
      if (!toolCallDetected && pending) {
        const isArtifact = /^[【<]/.test(pending) || /^<\/?tool/.test(pending);
        if (!suppressPrefixOnToolCall && !isArtifact) {
          if (routeToolPrefaceToNarration) emitToolPreface(pending);
          else safeEmit({ type: 'text', text: pending });
        }
        pending = '';
      }
      // Dedup by tool_use id and keep the RICHEST input. The stream-json
      // protocol emits a tool call twice: content_block_start (empty input)
      // then content_block_stop (full accumulated args). Without merging, the
      // empty start block would be executed with `{}` → empty shell command →
      // L2 critical → headless fail-closed. When a later chunk for the same id
      // carries more structured keys, update the existing block in place.
      const resolvedInput = _resolveToolBlockInput(chunk);
      const blockId = chunk.id || chunk.toolUseId || null;
      let toolBlock;
      const existingBlock = (_streamToolRawInputEnabled() && blockId)
        ? collectedToolUseBlocks.find((b) => b && b.id === blockId)
        : null;
      if (existingBlock) {
        const newKeys = Object.keys((resolvedInput && typeof resolvedInput === 'object') ? resolvedInput : {}).length;
        const oldKeys = Object.keys((existingBlock.input && typeof existingBlock.input === 'object') ? existingBlock.input : {}).length;
        if (newKeys > oldKeys) {
          existingBlock.input = resolvedInput;
          existingBlock.name = toolName;
        }
        toolBlock = existingBlock;
      } else {
        toolBlock = {
          name: toolName,
          input: resolvedInput,
          id: blockId,
        };
        collectedToolUseBlocks.push(toolBlock);
      }
      toolCallDetected = true;
      normalizedChunk = {
        ...chunk,
        type: 'tool_use',
        tool: toolBlock.name,
        input: summarizeToolChunkInput(chunk.input),
        rawInput: chunk.rawInput !== undefined ? chunk.rawInput : chunk.input,
        id: toolBlock.id || '',
      };

      // Phase 7: Pre-execute concurrency-safe tools during streaming
      if (streamingExecutor) {
        try {
          streamingExecutor.addTool({
            name: toolBlock.name,
            params: toolBlock.input,
            id: toolBlock.id,
          });
        } catch { /* pre-execution failure is non-critical */ }
      }
    }

    if (chunk.type === 'tool_result') {
      let normalizedSuccess;
      if (typeof chunk.success === 'boolean') {
        normalizedSuccess = chunk.success;
      } else if (typeof chunk.isError === 'boolean') {
        normalizedSuccess = !chunk.isError;
      } else if (typeof chunk.is_error === 'boolean') {
        normalizedSuccess = !chunk.is_error;
      }
      if (typeof normalizedSuccess === 'boolean') {
        normalizedChunk = {
          ...normalizedChunk,
          success: normalizedSuccess,
        };
      }
    }

    // Always pass non-text events through for status/thinking/tool UI.
    if (normalizedChunk.type !== 'text') {
      safeEmit(normalizedChunk);
      return;
    }

    pushText(normalizedChunk.text || '');
  };

  const finalize = () => {
    if (pending) {
      if (toolCallDetected && suppressPrefixOnToolCall) {
        pending = '';
        return;
      }
      // When a tool call was detected, the PASS_TAIL buffer may still hold
      // real response text.  Only suppress it when it looks like a partial
      // artifact marker (e.g. "【调", "<tool_").  Otherwise flush it so the
      // user sees the complete reply.
      const isArtifact = toolCallDetected &&
        (/^[【<]/.test(pending) || /^<\/?tool/.test(pending));
      if (!isArtifact) {
        safeEmit({ type: 'text', text: pending });
      }
    }
    pending = '';
  };

  const reset = () => {
    pending = '';
    toolCallDetected = false;
    collectedToolUseBlocks.length = 0;
  };

  return {
    onChunk: onInterceptChunk,
    finalize,
    reset,
    hasToolCall: () => toolCallDetected,
    getToolUseBlocks: () => collectedToolUseBlocks,
    getStreamingExecutor: () => streamingExecutor,
  };
}

function _classifyGatewayThrownError(err) {
  const msg = String(err && err.message ? err.message : err || '').toLowerCase();
  if (/aborted|cancelled|canceled/.test(msg)) return 'cancelled';
  if (/timeout|timed out|stream stalled|unresponsive/.test(msg)) return 'timeout';
  if (/network|econn|enotfound|socket|fetch failed|getaddrinfo|proxy/.test(msg)) return 'network';
  if (/unauthorized|forbidden|invalid api key|auth|login/.test(msg)) return 'auth';
  if (/reconnecting|channel closed|process|exited with code|adapter .* timeout/.test(msg)) return 'process';
  return 'unknown';
}

function _isFirstTokenSignalChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  const kind = String(chunk.type || '').trim().toLowerCase();
  if (!kind) return false;
  if (kind === 'status' || kind === 'cost') return false;
  if (kind === 'text' || kind === 'thinking' || kind === 'tool_use' || kind === 'tool_result' || kind === 'tool_call' || kind === 'control_request') {
    return true;
  }
  const text = String(chunk.text || chunk.content || '').trim();
  return !!text;
}

function _isTransientGatewayErrorType(type = '') {
  const t = String(type || '').toLowerCase();
  return t === 'timeout' || t === 'cancelled' || t === 'network' || t === 'process' || t === 'unknown';
}

/** @type {(msg: string, opts?: object) => 'small'|'normal'|'large'} */
function _resolveTaskScale(userMessage = '', opts = {}) {
  const { resolveTaskScale } = require('../services/taskScale');
  return resolveTaskScale(userMessage, opts);
}

/**
 * Longest token _extractFileReferences will run its regex against. Real file
 * paths are far shorter; anything longer is the ReDoS DoS vector, not a path.
 */
const FILEREF_MAX_TOKEN = 256;

/** ReDoS guard gate for _extractFileReferences. Default on; disable tokens fall back byte-identically. */
function _fileRefRedosGuardEnabled(env = process.env) {
  const raw = String((env && env.KHY_FILEREF_REDOS_GUARD) || '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  return true;
}

/** Extract file references from user message for execution brief. */
function _extractFileReferences(text) {
  const pattern = /(?:[\w./\\-]+\.(?:js|ts|jsx|tsx|py|go|java|rs|vue|css|html|json|yaml|yml|md|rb|php|c|cpp|h|sh|sql))\b/gi;
  const raw = String(text == null ? '' : text);

  // ReDoS guard (KHY_FILEREF_REDOS_GUARD, default on). The char class
  // `[\w./\\-]+` overlaps the required `\.(ext)` suffix, so on a long token that
  // never ends in a known extension the engine backtracks O(n²) — a real user
  // pasting ~80KB of dotted/path-like text hangs this call for 10+ seconds
  // (it runs on every medium/large task, ai.js:_extractFileReferences caller).
  // Whitespace can never appear inside a match (the char class excludes it), so
  // splitting on whitespace and skipping over-long tokens (real paths are short)
  // is byte-identical for every realistic input while bounding worst-case cost.
  if (_fileRefRedosGuardEnabled(process.env)) {
    const files = [];
    for (const token of raw.split(/\s+/)) {
      if (!token || token.length > FILEREF_MAX_TOKEN) continue;
      const re = new RegExp(pattern.source, pattern.flags);
      let mm;
      while ((mm = re.exec(token)) !== null) {
        if (!files.includes(mm[0])) files.push(mm[0]);
        if (files.length >= 64) break;
      }
      if (files.length >= 64) break;
    }
    return files.slice(0, 10);
  }

  // Legacy path (guard disabled): byte-identical to the original single-pass scan.
  const files = [];
  let m;
  while ((m = pattern.exec(raw)) !== null) {
    if (!files.includes(m[0])) files.push(m[0]);
  }
  return files.slice(0, 10);
}

function _isLightweightConversationInput(userMessage = '', options = {}) {
  // Strip system-injected context (memory hints, boulder resume, context route)
  // so that enriched messages are classified by user intent, not injected bulk.
  const text = String(userMessage || '')
    .replace(/\n\n\[System [^\]]*\][\s\S]*$/i, '')
    .replace(/^\[SYSTEM:[\s\S]*?\]\n\n/i, '')
    .trim();
  if (!text) return false;
  if (text.length > 140) return false;
  if (/\n/.test(text)) return false;

  const scale = String(options.scale || '').trim().toLowerCase();
  if (scale && scale !== 'small') return false;

  // Avoid misclassifying executable/coding tasks as casual chat.
  if (/`|\/|\\|\.([cm]?[jt]sx?|py|go|java|rs|cpp|vue|json|yaml|yml|md)\b/i.test(text)) return false;
  if (/(修复|修改|实现|重构|创建|删除|运行|执行|命令|shell|bash|grep|glob|read|write|edit|test|build|debug)/i.test(text)) return false;

  if (runtime.isGreeting(text)) return true;
  // Jokes, stories, self-intro, simple factual Q&A — no structured analysis needed
  if (/^(讲|说|来).{0,6}(笑话|段子|故事|joke|story)/i.test(text)) return true;
  if (/^(tell|give)\s+me\s+a\s+(joke|riddle|story)/i.test(text)) return true;
  return /^(你是谁|你能做什么|介绍一下你自己|who are you|what can you do)\s*[\?？!！。]*$/i.test(text);
}

function _buildGreetingQuickReply(userMessage = '') {
  const raw = String(userMessage || '').trim();
  const hasChinese = /[\u3400-\u9fff]/.test(raw);
  const hasLatin = /[A-Za-z]/.test(raw);
  if (hasLatin && !hasChinese) {
    return 'Hi, I am khy OS. I am online and ready to help with coding, commands, or analysis. What would you like to do first?';
  }
  return '你好，我是 khy OS。已在线并准备好协助你处理代码、命令或分析任务。你现在想先做哪件事？';
}

function _extractRequestedLanguage(userMessage = '') {
  const text = String(userMessage || '').trim();
  if (!text) return '';
  if (/(请|麻烦|能否|可以|改为|切换到|use|switch to).{0,12}(英文|英语|english|en-us|en)\b/i.test(text)) return 'en';
  if (/(请|麻烦|能否|可以|改为|切换到|use|switch to).{0,12}(中文|汉语|chinese|zh-cn|zh)\b/i.test(text)) return 'zh';
  if (/(跟随用户语言|和用户同语言|follow.*user.*language|same language as user)/i.test(text)) return 'auto';
  return '';
}

function _detectUserInputLanguage(userMessage = '') {
  const text = String(userMessage || '').trim();
  if (!text) return 'zh';
  const zhCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const enCount = (text.match(/[A-Za-z]/g) || []).length;
  if (zhCount === 0 && enCount > 0) return 'en';
  if (zhCount > 0) return 'zh';
  return 'zh';
}

function _hasLanguageRuleInPrompt(prompt = '') {
  const text = String(prompt || '');
  if (!text) return false;
  return /#\s*Language\b|LANGUAGE LOCK|Always respond in|默认使用中文|跟随用户语言|Respond in the same language/i.test(text);
}

function _buildLanguageFallbackDirective(userMessage = '', systemPrompt = '') {
  const forcedLang = String(process.env.KHY_LANGUAGE || '').trim();
  if (forcedLang) return '';
  if (_hasLanguageRuleInPrompt(systemPrompt)) return '';

  const requested = _extractRequestedLanguage(userMessage);
  if (requested === 'en') {
    return '# Language\nUser explicitly requested English for this turn. Reply in English for this turn.';
  }
  if (requested === 'zh') {
    return '# Language\n默认使用中文回复。';
  }
  if (requested === 'auto') {
    return '# Language\n默认使用中文回复；如果用户明确要求其它语言，或用户持续使用其它语言交流，则跟随用户语言。';
  }

  const detected = _detectUserInputLanguage(userMessage);
  if (detected === 'en') {
    return '# Language\nDefault to Chinese when language is unspecified. For this turn, user input is English, so reply in English.';
  }
  return '# Language\n默认使用中文回复；如果用户明确要求其它语言，或用户持续使用其它语言交流，则跟随用户语言。';
}


module.exports = {
  _TOOL_CALL_MARKERS,
  _partialToolMarkerTailLen,
  _STREAM_TOOL_RAWINPUT_OFF,
  _streamToolRawInputEnabled,
  _resolveToolBlockInput,
  _createStreamToolInterceptor,
  _classifyGatewayThrownError,
  _isFirstTokenSignalChunk,
  _isTransientGatewayErrorType,
  _resolveTaskScale,
  FILEREF_MAX_TOKEN,
  _fileRefRedosGuardEnabled,
  _extractFileReferences,
  _isLightweightConversationInput,
  _buildGreetingQuickReply,
  _extractRequestedLanguage,
  _detectUserInputLanguage,
  _hasLanguageRuleInPrompt,
  _buildLanguageFallbackDirective,
};
