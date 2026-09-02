import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { consumeSse } from './sse';

// Standalone mode: talk to any OpenAI-compatible /v1/chat/completions endpoint
// directly from the phone. API keys are stored in the Keystore-backed
// SecureStoragePlugin; they are never written to plain Preferences.

const KEY_PREFIX = 'khy_standalone_key_';

const browserKeyStore = new Map();

async function secureGet(key) {
  if (!Capacitor.isNativePlatform()) return browserKeyStore.get(key) || null;
  try {
    const result = await SecureStoragePlugin.get({ key });
    return result.value || null;
  } catch {
    return null;
  }
}

async function secureSet(key, value) {
  if (!Capacitor.isNativePlatform()) {
    browserKeyStore.set(key, value);
    return;
  }
  await SecureStoragePlugin.set({ key, value });
}

async function secureRemove(key) {
  if (!Capacitor.isNativePlatform()) {
    browserKeyStore.delete(key);
    return;
  }
  try { await SecureStoragePlugin.remove({ key }); } catch { /* already absent */ }
}

function providerKey(provider) {
  return `${KEY_PREFIX}${String(provider).toLowerCase()}`;
}

// Each standalone provider is a simple OpenAI-compatible endpoint.
// logo 字段给 UI 用，区分厂商；不参与网络协议。
const DEFAULTS = {
  openai: {
    label: 'OpenAI',
    logo: '✦',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  },
  deepseek: {
    label: 'DeepSeek',
    logo: '◈',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  moonshot: {
    label: 'Moonshot Kimi',
    logo: '☾',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  qwen: {
    label: '通义千问',
    logo: '⌘',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
  },
  zhipu: {
    label: '智谱 GLM',
    logo: '◆',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
  },
  agnes: {
    label: 'Agnes',
    logo: '✺',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    models: ['agnes-2.0-flash'],
  },
  custom: {
    label: '自定义',
    logo: '✎',
    baseUrl: '',
    models: ['gpt-4o'],
  },
};

export function standaloneProviders() {
  return Object.entries(DEFAULTS).map(([id, cfg]) => ({ id, ...cfg }));
}

export async function getStandaloneApiKey(provider) {
  return secureGet(providerKey(provider));
}

export async function saveStandaloneApiKey(provider, value) {
  const trimmed = String(value || '').trim();
  if (trimmed) await secureSet(providerKey(provider), trimmed);
  else await secureRemove(providerKey(provider));
}

export async function removeStandaloneApiKey(provider) {
  await secureRemove(providerKey(provider));
}

function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  return value.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');
}

export async function fetchModels(provider, baseUrl, apiKey) {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/models`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）`);
  const payload = await response.json().catch(() => ({}));
  const models = Array.isArray(payload?.data)
    ? payload.data.map((item) => item.id).filter(Boolean)
    : [];
  return models.length ? models : DEFAULTS[provider]?.models || [];
}

export function toOpenAiMessages(messages) {
  // Keep a bounded window (last 12) so long conversations stay cheap.
  const window = messages.slice(-12);
  return window.map((item) => {
    if (item.role === 'tool') {
      return { role: 'tool', tool_call_id: item.toolCallId, content: item.content };
    }
    if (item.role === 'assistant' && item.toolCalls?.length) {
      return {
        role: 'assistant',
        content: item.content || null,
        tool_calls: item.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
        })),
      };
    }
    return { role: item.role === 'system' ? 'system' : 'user', content: item.content || '' };
  });
}

export async function streamChatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  onChunk,
  onDone,
  onToolCall,
  signal,
  tools,
}) {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
  const body = {
    model,
    messages: toOpenAiMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
    temperature: typeof temperature === 'number' ? temperature : 0.7,
  };
  // OpenAI 工具调用：tools 是顶层字段。模型不识别 tools 时会被服务端忽略
  // ——非关键路径。Agnes / DeepSeek / 通义 / GLM 都已支持 function calling。
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  await consumeSse(url, {
    auth: false,
    retryAuth: false,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
    onEvent({ data }) {
      const event = data && typeof data === 'object' ? data : {};
      if (event.error) {
        throw new Error(event.error.message || '模型返回错误');
      }
      const choice = event.choices?.[0];
      if (choice?.delta?.content) {
        onChunk?.(choice.delta.content);
      }
      if (choice?.delta?.tool_calls?.length) {
        onToolCall?.(choice.delta.tool_calls, choice.finish_reason);
      }
      if (choice?.finish_reason === 'tool_calls') {
        onDone?.({ finishReason: 'tool_calls', usage: event.usage || null });
      }
      if (event.usage && (event.choices?.length || 0) === 0) {
        onDone?.({ finishReason: 'stop', usage: event.usage });
      }
    },
  });
}

export async function chatCompletionOnce({
  baseUrl,
  apiKey,
  model,
  messages,
  signal,
}) {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages: toOpenAiMessages(messages), stream: false }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `对话请求失败（HTTP ${response.status}）`);
  }
  return {
    content: payload?.choices?.[0]?.message?.content || '',
    usage: payload?.usage || null,
    toolCalls: payload?.choices?.[0]?.message?.tool_calls || null,
  };
}

export { normalizeBaseUrl as normalizeStandaloneBaseUrl };
