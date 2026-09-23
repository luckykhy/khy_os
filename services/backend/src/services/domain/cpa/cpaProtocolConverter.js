'use strict';

/**
 * cpaProtocolConverter — CPA 接入层协议转换（纯函数、无 IO、确定性）。
 *
 * CPA (CLIProxyAPI) 把多种上游模型协议统一暴露成 OpenAI 兼容端点。本地网关需要
 * 在两侧做无损转换:
 *   - 请求侧: anthropic/gemini 的原生请求体 → OpenAI 请求体
 *   - 响应侧: OpenAI 响应体 → anthropic/gemini 的原生响应体
 *
 * 契约（单一真源见 tests/services/domain/cpa/cpaProtocolConverter.test.js）:
 *   - 纯函数、无 IO、无网络、无文件系统:可被任意进程独立 require,绝不抛。
 *   - 不可转换的输入(非对象/null/缺关键结构)一律返回 null(fail-soft,不造假)。
 *   - 映射选择「保守」原则:能无损映射的字段才搬;搬不动的结构
 *     (如 anthropic 的 thinking block) 丢弃,绝不静默变形。
 */

// ── 内部工具 ─────────────────────────────────────────────────────────

/** 把 anthropic 文本 block 数组拼成一个字符串(system/单文本消息用)。 */
function _textOf(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** 图片 block(anthropic) → OpenAI image_url part(base64 → data URL)。 */
function _anthropicImageToOpenaiPart(block) {
  const src = block && block.source;
  if (!src || src.type !== 'base64' || src.data == null) {
    return null;
  }
  const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/png';
  return {
    type: 'image_url',
    image_url: {
      url: `data:${mediaType};base64,${src.data}`,
    },
  };
}

// ── anthropic 请求 → OpenAI ─────────────────────────────────────────

/**
 * 把一条 anthropic 请求体转成 OpenAI 请求体。
 * @param {object} body  anthropic 原生请求({ model, max_tokens, system?, messages?, tools? })
 * @returns {object|null} OpenAI 请求体;不可转换 → null
 */
function anthropicToOpenaiRequest(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const out = {
    model: typeof body.model === 'string' ? body.model : undefined,
  };
  if (body.max_tokens != null) {
    out.max_tokens = body.max_tokens;
  }

  const messages = [];

  // system:字符串或 block 数组 → system 消息(置于最前)
  const system = body.system;
  if (system != null && system !== '') {
    const sysText = Array.isArray(system) ? _textOf(system) : String(system);
    if (sysText !== '') {
      messages.push({ role: 'system', content: sysText });
    }
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') {
      continue;
    }
    const role = m.role;
    const content = m.content;

    if (role === 'assistant') {
      // 可能是纯文本,或「文本 + tool_use」混合
      let text = '';
      const toolCalls = [];
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') {
            continue;
          }
          if (b.type === 'text' && typeof b.text === 'string') {
            text += b.text;
          } else if (b.type === 'tool_use') {
            toolCalls.push({
              id: b.id,
              type: 'function',
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input || {}),
              },
            });
          }
          // thinking / 其他未知 block → 丢弃(OpenAI 无对应物,不静默变形)
        }
      } else {
        text = _textOf(content);
      }
      const msg = { role: 'assistant', content: text };
      if (toolCalls.length) {
        msg.tool_calls = toolCalls;
      }
      messages.push(msg);
    } else if (role === 'user') {
      // 可能含 tool_result(对应 OpenAI 的 tool 消息,需先拆出)
      const toolParts = [];
      let media = null;
      let text = '';
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') {
            continue;
          }
          if (b.type === 'tool_result') {
            toolParts.push({
              tool_call_id: b.tool_use_id,
              content: typeof b.content === 'string' ? b.content : _textOf(b.content),
            });
          } else if (b.type === 'image') {
            media = _anthropicImageToOpenaiPart(b);
          } else if (b.type === 'text' && typeof b.text === 'string') {
            text += b.text;
          }
        }
      } else {
        text = _textOf(content);
      }
      // 先把 tool_result 落成 OpenAI 的 tool 消息(顺序保持在 assistant 之后)
      for (const t of toolParts) {
        messages.push({ role: 'tool', ...t });
      }
      // 若这条 user 消息带多模态 → content 用数组;否则用纯文本
      if (media) {
        const arr = [];
        if (text) {
          arr.push({ type: 'text', text });
        }
        arr.push(media);
        messages.push({ role: 'user', content: arr });
      } else {
        messages.push({ role: 'user', content: text });
      }
    } else {
      messages.push({ role, content: _textOf(content) });
    }
  }
  out.messages = messages;

  // tools 定义:anthropic input_schema → OpenAI function.parameters
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  return out;
}

// ── OpenAI 响应 → anthropic ─────────────────────────────────────────

/** finish_reason → anthropic stop_reason。 */
function _finishToStopReason(fr) {
  if (fr === 'length') {
    return 'max_tokens';
  }
  if (fr === 'tool_calls') {
    return 'tool_use';
  }
  return 'end_turn'; // stop 及未知 → 正常结束
}

/**
 * 把一条 OpenAI 响应体转成 anthropic 响应体。
 * @param {object} resp OpenAI 响应({ choices, usage })
 * @returns {object|null} anthropic 响应;不可转换(缺 choices)→ null
 */
function openaiToAnthropicResponse(resp) {
  if (!resp || typeof resp !== 'object' || !Array.isArray(resp.choices) || resp.choices.length === 0) {
    return null;
  }
  const choice = resp.choices[0] || {};
  const m = choice.message || {};
  const usage = resp.usage || {};

  const out = {
    type: 'message',
    role: 'assistant',
    content: [],
    stop_reason: _finishToStopReason(choice.finish_reason),
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };

  const text = typeof m.content === 'string' ? m.content : '';
  if (text) {
    out.content.push({ type: 'text', text });
  }
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function && tc.function.arguments) || {};
      } catch {
        input = {};
      }
      out.content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function && tc.function.name,
        input,
      });
    }
  }
  return out;
}

// ── gemini 请求 → OpenAI ───────────────────────────────────────────

/**
 * 把一条 gemini 原生请求体转成 OpenAI 请求体。
 * @param {object} body gemini 请求({ model, contents?, systemInstruction?, generationConfig? })
 * @returns {object|null} OpenAI 请求体;缺 contents → null
 */
function geminiToOpenaiRequest(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  if (!Array.isArray(body.contents) || body.contents.length === 0) {
    return null;
  }
  const out = {
    model: typeof body.model === 'string' ? body.model : undefined,
  };
  const gc = body.generationConfig || {};
  if (gc.temperature != null) {
    out.temperature = gc.temperature;
  }
  if (gc.maxOutputTokens != null) {
    out.max_tokens = gc.maxOutputTokens;
  }

  const messages = [];
  // systemInstruction → system 消息
  const sys = body.systemInstruction;
  if (sys && Array.isArray(sys.parts)) {
    const sysText = sys.parts
      .filter((p) => p && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
    if (sysText !== '') {
      messages.push({ role: 'system', content: sysText });
    }
  }

  for (const c of body.contents) {
    const role = c && c.role === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(c && c.parts) ? c.parts : [];
    let text = '';
    const toolCalls = [];
    let media = null;
    for (const p of parts) {
      if (!p || typeof p !== 'object') {
        continue;
      }
      if (typeof p.text === 'string') {
        text += p.text;
      } else if (p.inlineData) {
        const dt = p.inlineData;
        const mt = typeof dt.mimeType === 'string' ? dt.mimeType : 'image/png';
        media = {
          type: 'image_url',
          image_url: {
            url: `data:${mt};base64,${dt.data}`,
          },
        };
      } else if (p.functionCall) {
        toolCalls.push({
          id: p.functionCall.id,
          type: 'function',
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args || {}),
          },
        });
      }
    }
    const msg = { role, content: media ? [{ type: 'text', text }, media] : text };
    if (toolCalls.length) {
      msg.tool_calls = toolCalls;
    }
    messages.push(msg);
  }
  out.messages = messages;
  return out;
}

// ── OpenAI 响应 → gemini ───────────────────────────────────────────

/** finish_reason → gemini finishReason。 */
function _finishToGeminiReason(fr) {
  if (fr === 'length') {
    return 'MAX_TOKENS';
  }
  if (fr === 'tool_calls') {
    return 'STOP';
  }
  return 'STOP';
}

/**
 * 把一条 OpenAI 响应体转成 gemini 原生响应体。
 * @param {object} resp OpenAI 响应({ model?, choices, usage })
 * @returns {object|null} gemini 响应;缺 choices → null
 */
function openaiToGeminiResponse(resp) {
  if (!resp || typeof resp !== 'object' || !Array.isArray(resp.choices) || resp.choices.length === 0) {
    return null;
  }
  const choice = resp.choices[0] || {};
  const m = choice.message || {};
  const usage = resp.usage || {};
  const text = typeof m.content === 'string' ? m.content : '';

  const out = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text }],
        },
        finishReason: _finishToGeminiReason(choice.finish_reason),
      },
    ],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens || 0,
      candidatesTokenCount: usage.completion_tokens || 0,
      totalTokenCount: usage.total_tokens || 0,
    },
  };
  if (typeof resp.model === 'string') {
    out.modelVersion = resp.model;
  }
  return out;
}

module.exports = {
  anthropicToOpenaiRequest,
  openaiToAnthropicResponse,
  geminiToOpenaiRequest,
  openaiToGeminiResponse,
};
