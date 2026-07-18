export function shortRequestId(requestId) {
  return String(requestId || '').trim().slice(0, 8)
}

export function describeControlTarget(request = {}) {
  const toolName = String(request.tool_name || request.toolName || request.tool || '').trim()
  if (toolName) return `工具 ${toolName}`

  const command = String(request.command || request.shell_command || '').trim()
  if (command) {
    const preview = command.length > 36 ? `${command.slice(0, 36)}...` : command
    return `命令 ${preview}`
  }

  const filePath = String(request.path || request.file_path || request.filePath || '').trim()
  if (filePath) return `文件 ${filePath}`
  return '受控操作'
}

export function normalizeControlRequestPayload(payload = {}) {
  const requestId = String(payload.requestId || payload.id || '').trim()
  const request = payload && typeof payload.request === 'object' && payload.request
    ? payload.request
    : {}
  return { requestId, request }
}

export function formatControlRequestText(payload = {}) {
  const { requestId, request } = normalizeControlRequestPayload(payload)
  const subtype = String(request.subtype || request.type || '').trim()
  const suffix = requestId ? `（${shortRequestId(requestId)}）` : ''
  if (subtype === 'can_use_tool') {
    return `权限确认：AI 请求使用${describeControlTarget(request)}${suffix}`
  }
  if (subtype === 'can_execute_command' || subtype === 'execute_command') {
    return `权限确认：AI 请求执行${describeControlTarget(request)}${suffix}`
  }
  if (subtype === 'can_write_file' || subtype === 'write_file') {
    return `权限确认：AI 请求写入${describeControlTarget(request)}${suffix}`
  }
  if (subtype) {
    return `控制请求：${subtype}${suffix}`
  }
  return `控制请求：${describeControlTarget(request)}${suffix}`
}

/**
 * Map a stream/ws chat event to a digital-human status-orb state (C2).
 *
 * Four states drive the 2D status orb:
 *   idle      — no active turn
 *   listening — turn accepted, awaiting first model output
 *   thinking  — model reasoning / tool calls in flight
 *   speaking  — model is streaming visible output
 *
 * Pure function: takes the same (channel, payload) shape as
 * resolveAiChatThinkingEvent and returns one of the four state strings, or
 * null when the event carries no state transition (caller keeps prior state).
 *
 * @param {string} channel  'stream' | 'ws'
 * @param {object} payload
 * @returns {('idle'|'listening'|'thinking'|'speaking')|null}
 */
export function mapEventToOrbState(channel, payload = {}) {
  const mode = String(channel || '').trim().toLowerCase()
  const type = String(payload?.type || '').trim()

  if (mode === 'stream') {
    if (type === 'start') return 'listening'
    if (type === 'status' || type === 'control_request' || type === 'heartbeat'
      || type === 'thinking' || type === 'tool_use' || type === 'tool_result'
      || type === 'reset') return 'thinking'
    if (type === 'chunk' || type === 'delta' || type === 'content') return 'speaking'
    if (type === 'done') return 'idle'
    if (type === 'error') return 'idle'
    return null
  }

  if (mode === 'ws') {
    if (type === 'chat_start') return 'listening'
    if (type === 'thinking' || type === 'tool_call' || type === 'tool_use' || type === 'tool_result'
      || type === 'fallback' || type === 'control_request' || type === 'reset') return 'thinking'
    if (type === 'text' || type === 'chunk' || type === 'delta' || type === 'content' || type === 'message') return 'speaking'
    if (type === 'chat_complete') return 'idle'
    return null
  }

  return null
}

/**
 * Internal pseudo-tools (names starting with "_") are not real tool calls —
 * the backend uses them to push system status through the tool_result channel
 * (retry / forced summarization / background-task completion / teammate inbox).
 * Provide a clean human label so they never surface the raw internal name.
 */
function internalPseudoToolLabel(tool) {
  switch (tool) {
    case '_system_retry': return '正在重试…'
    case '_system_summarize': return '正在生成总结…'
    case '_task_notification': return '后台任务已完成'
    case '_teammate_message': return '收到协作消息'
    default: return '系统状态更新'
  }
}

/**
 * Map a tool_use / tool_result event (from either transport) to a thinking-log
 * entry. Returns null for any other event type so callers can fall through.
 *
 * @param {object} payload
 * @returns {{type:string,text:string}|null}
 */
export function describeToolEvent(payload = {}) {
  const type = String(payload?.type || '').trim()
  const tool = String(payload?.tool || payload?.name || payload?.command || 'tool').trim() || 'tool'
  const detail = String(payload?.text || '').trim()

  // Internal pseudo-tools carry system status, not a real tool invocation.
  // Render their summary text directly as a status line (no "工具结果：xxx 完成"
  // wrapper, no misleading "完成/失败"), so e.g. the network-fluctuation retry
  // notice reads "回复为空…正在重试 (1/2)…" instead of leaking "_system_retry".
  if ((type === 'tool_use' || type === 'tool_result') && tool.startsWith('_')) {
    return { type: 'status', text: detail || internalPseudoToolLabel(tool) }
  }

  if (type === 'tool_use') {
    return { type: 'status', text: `工具调用：${tool}` }
  }
  if (type === 'tool_result') {
    const ok = payload?.success !== false
    const head = `工具结果：${tool} ${ok ? '完成' : '失败'}`
    return { type: ok ? 'status' : 'error', text: detail ? `${head} — ${detail}` : head }
  }
  return null
}

const _SECRET_KEY_RE = /(key|token|secret|password|passwd|authorization|api[_-]?key)/i

/**
 * Deep-mask secret-looking values before tool params are rendered in the UI.
 * Two layers: (1) any string value under a key that looks like a credential
 * (key/token/secret/password/authorization) collapses to ***last4; (2) any
 * `sk-…` literal anywhere in a string is masked to sk-***last4. Pure, recursive,
 * never mutates the input, never throws. Non-string/array/object values pass
 * through untouched.
 *
 * @param {*} value
 * @param {string} keyHint  the object key this value was read from (drives layer 1)
 * @returns {*}
 */
export function maskSecretsForDisplay(value, keyHint = '') {
  if (value == null) return value
  if (typeof value === 'string') {
    if (_SECRET_KEY_RE.test(String(keyHint))) {
      const v = value.trim()
      if (!v) return value
      return v.length <= 4 ? '***' : `***${v.slice(-4)}`
    }
    return value.replace(/sk-[A-Za-z0-9_-]{4,}/g, (m) => `sk-***${m.slice(-4)}`)
  }
  if (Array.isArray(value)) return value.map((v) => maskSecretsForDisplay(v, keyHint))
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = maskSecretsForDisplay(value[k], k)
    return out
  }
  return value
}

/**
 * Render a tool-call input into a full, pretty-printed parameter block for the
 * expandable tool-step card (#7 「工具调用不透明：看不到参数和中间状态」). Unlike
 * summarizeStepInput — a 120-char single-line chip — this keeps the WHOLE object,
 * pretty-printed and secret-masked, capped at maxChars only to bound DOM size.
 * Nullish / empty → ''. Pure, never throws.
 *
 * @param {*} input
 * @param {{maxChars?:number}} [opts]
 * @returns {string}
 */
export function formatToolParams(input, opts = {}) {
  if (input == null) return ''
  const maxChars = Number.isFinite(opts?.maxChars) && opts.maxChars > 0 ? opts.maxChars : 4000
  let masked
  try { masked = maskSecretsForDisplay(input) } catch { masked = input }
  let s = ''
  if (typeof masked === 'string') {
    s = masked
  } else {
    try { s = JSON.stringify(masked, null, 2) } catch { s = String(masked) }
  }
  s = String(s).replace(/\r\n/g, '\n').trim()
  if (!s) return ''
  if (s.length > maxChars) return `${s.slice(0, maxChars)}\n… (已截断，共 ${s.length} 字符)`
  return s
}

/**
 * Derive an at-a-glance progress summary from an assistant message's structured
 * `steps` array (#6 「无流式进度反馈，用户难以一眼看清进度」). Instead of forcing
 * the user to read every log row, this collapses the run into one counted line:
 * how many tool steps have settled vs. are still running vs. failed. Reads the
 * clean `status` field ('running' | 'ok' | 'error'), never fragile log text.
 * Returns null when there are no steps (nothing to summarize). Pure, never throws.
 *
 * @param {Array<{status?:string}>} steps
 * @returns {{total:number,done:number,running:number,failed:number,active:boolean,label:string}|null}
 */
export function summarizeToolProgress(steps) {
  const list = Array.isArray(steps) ? steps : []
  let total = 0
  let done = 0
  let running = 0
  let failed = 0
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    total += 1
    if (s.status === 'running') {
      running += 1
    } else if (s.status === 'error') {
      done += 1
      failed += 1
    } else {
      done += 1 // 'ok' or any settled state
    }
  }
  if (total === 0) return null
  const parts = [`工具 ${done}/${total}`]
  if (running > 0) parts.push(`${running} 进行中`)
  if (failed > 0) parts.push(`${failed} 失败`)
  return { total, done, running, failed, active: running > 0, label: parts.join(' · ') }
}

export function resolveAiChatThinkingEvent(channel, payload = {}) {
  const mode = String(channel || '').trim().toLowerCase()
  const type = String(payload?.type || '').trim()

  if (mode === 'stream') {
    if (type === 'start') {
      return {
        type: 'status',
        text: `步骤 2/3：已连接 AI 网关，模型=${payload.model || 'auto'}`
      }
    }
    if (type === 'status') {
      return { type: 'status', text: payload.text || '网关状态更新' }
    }
    if (type === 'heartbeat') {
      return { type: 'heartbeat', text: '连接保活正常，正在持续接收输出' }
    }
    if (type === 'control_request') {
      return { type: 'control', text: formatControlRequestText(payload) }
    }
    if (type === 'thinking') {
      return { type: 'status', text: payload.text || 'AI 正在思考' }
    }
    if (type === 'reset') {
      return { type: 'status', text: '检测到无具体原因的拒绝，已丢弃废稿并重试' }
    }
    if (type === 'tool_use' || type === 'tool_result') {
      return describeToolEvent(payload)
    }
    if (type === 'done') {
      return {
        type: 'done',
        text: `步骤 3/3：生成完成，来源=${payload.model || payload.adapter || 'AI'}`
      }
    }
    if (type === 'error') {
      return structuredErrorEvent(payload)
    }
    return null
  }

  if (mode === 'ws') {
    if (type === 'chat_start') {
      return { type: 'status', text: '步骤 2/3：AI 会话已启动，正在等待模型输出' }
    }
    if (type === 'thinking') {
      return { type: 'status', text: payload.text || 'AI 正在处理请求' }
    }
    if (type === 'reset') {
      return { type: 'status', text: '检测到无具体原因的拒绝，已丢弃废稿并重试' }
    }
    if (type === 'control_request') {
      return { type: 'control', text: formatControlRequestText(payload) }
    }
    if (type === 'tool_call') {
      return {
        type: 'status',
        text: `工具调用：${String(payload.command || 'unknown').trim() || 'unknown'}`
      }
    }
    if (type === 'tool_use' || type === 'tool_result') {
      return describeToolEvent(payload)
    }
    if (type === 'fallback') {
      return {
        type: 'status',
        text: `适配器回退：${payload.from || 'unknown'} -> ${payload.to || 'unknown'}`
      }
    }
    if (type === 'chat_complete' && payload.provider !== 'cancelled') {
      return {
        type: 'done',
        text: `步骤 3/3：生成完成，来源=${payload.provider || payload.adapter || 'AI'}`
      }
    }
    if (type === 'error') {
      return structuredErrorEvent(payload)
    }
    return null
  }

  return null
}

/**
 * Normalize a terminal `error` event (SSE or WS) into a thinking-log entry that
 * also carries the structured E0x attribution. When the backend stamped an
 * `error_code` (failsafe.classify), the extra fields let the caller render the
 * human-readable failure card + trace drill-down instead of a one-line log;
 * legacy connection/auth errors (no `error_code`) keep the plain text shape.
 *
 * @param {object} payload
 * @returns {{type:string,text:string,code?:string,category?:string,reason?:string,suggestion?:string,retryable?:boolean,sensitive?:boolean,requestId?:string}}
 */
export function structuredErrorEvent(payload = {}) {
  const code = String(payload?.error_code || '').trim()
  const reason = String(payload?.reason || '').trim()
  const text = code
    ? `${payload.category || '执行失败'}：${reason || payload.message || '未知原因'}`
    : `网关异常：${payload.message || '流式响应失败'}`
  if (!code) return { type: 'error', text }
  return {
    type: 'error',
    text,
    code,
    category: String(payload.category || '').trim(),
    reason,
    suggestion: String(payload.suggestion || '').trim(),
    retryable: payload.retryable === true,
    sensitive: payload.sensitive === true,
    requestId: String(payload.requestId || '').trim()
  }
}
