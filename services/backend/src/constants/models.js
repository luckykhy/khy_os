'use strict';

/**
 * models.js — 纯叶子 (pure leaf): Khy 选用的所有模型名称的单一真源 (single source of truth)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无 env 读取 (env 覆盖留给调用方)。
 *
 * 设计意图 (为什么存在):
 *   模型名以前散落硬编码在十几个文件里 (默认兜底 / tier 映射 / 直连调用 / 适配器默认),
 *   换一次模型要全篇替换、极易漏改出错。这里按「类型/角色」把模型名收敛成具名数组,
 *   代码里只引用数组名 (或其 primary),换模型时只改这一个文件一处即可。
 *
 * 约定:
 *   - 每个数组按优先级排序,第一项 = 当前生效的首选模型 (primary)。
 *   - 需要单个字符串默认值的调用点用 `primaryOf(SOME_MODELS)` 或便捷的 `PRIMARY.<role>`。
 *   - 数组保留备选模型 (回退/兼容旧 ID),换模型把新名放到数组首位即可。
 *   - env 覆盖 (如 ANTHROPIC_MODEL / OLLAMA_MODEL) 仍由各调用点保留,本模块不读 env。
 */

// ── Anthropic 三档:Khy 自身身份模型 (系统提示词里声明的就是这三个) ──
const CLAUDE_OPUS_MODELS = ['claude-opus-4-8'];
const CLAUDE_SONNET_MODELS = ['claude-sonnet-4-6'];
const CLAUDE_HAIKU_MODELS = ['claude-haiku-4-5-latest'];

// ── 角色默认:按用途分组的 Khy 默认选择 ──
const EMBEDDING_MODELS = ['nomic-embed-text']; // 向量嵌入 (learningRetrieval)
const LOCAL_BRAIN_MODELS = ['qwen3.5:4b']; // 本地大脑模型 id (localLLMService / localLLMAdapter)
const LOCAL_BRAIN_GGUF_FILES = [ // 本地大脑权重候选文件名 (localLLMService)
  'qwen3.5-4b.gguf',
  'qwen3.5-4b-ollama.gguf',
  'qwen3.5-4b-export.gguf',
];
const OLLAMA_DEFAULT_MODELS = ['qwen2.5:7b']; // ollama 兜底默认 (aiManagementServer)
const IDE_DEFAULT_MODELS = ['gpt-4o']; // cursor / vscode / windsurf 适配器默认
const RELAY_DEFAULT_MODELS = ['claude-sonnet-4-20250514']; // relay-api 默认 (gateway.js)
const CODEX_PROBE_MODELS = ['o4-mini']; // codex 能力探测模型 (aiGateway)
const CODEX_AGENT_MODELS = ['gpt-5-codex']; // codex 子 agent 路由关键字 (cliAgentRunner)
const LIGHTWEIGHT_AGENT_MODELS = ['claude-haiku-3.5', 'gemini-2.0-flash']; // 轻量云端子 agent (AgentTool)

// ── 免费 LLM 渠道默认 (multiFreeService) ──
const FREE_GOOGLE_MODELS = ['gemini-2.5-flash'];
const FREE_GROQ_MODELS = ['llama-3.3-70b-versatile'];

// ── 直连 provider REST API 调用模型 (routes/ai.js 的裸 HTTP 调用) ──
const OPENAI_DIRECT_MODELS = ['gpt-3.5-turbo'];
const ANTHROPIC_DIRECT_MODELS = ['claude-3-sonnet-20240229'];
const QWEN_DIRECT_MODELS = ['qwen-turbo'];
const ZHIPU_DIRECT_MODELS = ['glm-4'];

/**
 * Return the primary (first / preferred) model name of a typed array.
 * Fail-soft: non-array or empty → '' (never throws).
 * @param {string[]} arr
 * @returns {string}
 */
function primaryOf(arr) {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : '';
}

// ── 便捷单值映射:各数组的 primary,供需要单个字符串的调用点直接取用 ──
const PRIMARY = {
  opus: primaryOf(CLAUDE_OPUS_MODELS),
  sonnet: primaryOf(CLAUDE_SONNET_MODELS),
  haiku: primaryOf(CLAUDE_HAIKU_MODELS),
  embedding: primaryOf(EMBEDDING_MODELS),
  localBrain: primaryOf(LOCAL_BRAIN_MODELS),
  ollama: primaryOf(OLLAMA_DEFAULT_MODELS),
  ide: primaryOf(IDE_DEFAULT_MODELS),
  relay: primaryOf(RELAY_DEFAULT_MODELS),
  codexProbe: primaryOf(CODEX_PROBE_MODELS),
  freeGoogle: primaryOf(FREE_GOOGLE_MODELS),
  freeGroq: primaryOf(FREE_GROQ_MODELS),
  openaiDirect: primaryOf(OPENAI_DIRECT_MODELS),
  anthropicDirect: primaryOf(ANTHROPIC_DIRECT_MODELS),
  qwenDirect: primaryOf(QWEN_DIRECT_MODELS),
  zhipuDirect: primaryOf(ZHIPU_DIRECT_MODELS),
};

module.exports = {
  // typed arrays (by tier/role)
  CLAUDE_OPUS_MODELS,
  CLAUDE_SONNET_MODELS,
  CLAUDE_HAIKU_MODELS,
  EMBEDDING_MODELS,
  LOCAL_BRAIN_MODELS,
  LOCAL_BRAIN_GGUF_FILES,
  OLLAMA_DEFAULT_MODELS,
  IDE_DEFAULT_MODELS,
  RELAY_DEFAULT_MODELS,
  CODEX_PROBE_MODELS,
  CODEX_AGENT_MODELS,
  LIGHTWEIGHT_AGENT_MODELS,
  FREE_GOOGLE_MODELS,
  FREE_GROQ_MODELS,
  OPENAI_DIRECT_MODELS,
  ANTHROPIC_DIRECT_MODELS,
  QWEN_DIRECT_MODELS,
  ZHIPU_DIRECT_MODELS,
  // helpers / convenience
  primaryOf,
  PRIMARY,
};
