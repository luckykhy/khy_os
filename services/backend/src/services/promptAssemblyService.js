'use strict';

/**
 * promptAssemblyService — stable + dynamic prompt architecture (Y-code inspired).
 *
 * Separates the system prompt into two tiers for optimal provider-side caching:
 *
 * 1. **Stable prefix** — cross-turn static content that rarely changes:
 *    - Base identity + core rules (from system prompt file)
 *    - General coding standards
 *    - Long-term memory section + memory index
 *    - Skills catalog
 *    - Sub-agent catalog
 *
 *    This content is the SAME every turn → provider caches it once and reuses
 *    it across all subsequent turns (Anthropic prompt caching, DeepSeek cache).
 *
 * 2. **Dynamic context** — per-turn content that changes each request:
 *    - Current time
 *    - Working directory
 *    - Model name
 *    - Plan snapshot
 *    - Active task summary
 *    - Recent daily log entries
 *
 *    This content forces a cache miss by design → small, unavoidable cost.
 *
 * The stable prefix is assembled once at startup and cached. It is only
 * rebuilt when: skills change, memory files change, or a config reload occurs.
 *
 * @module promptAssemblyService
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Cache ──

let _stablePrefixCache = null;
let _stablePrefixHash = null;
let _lastRebuildReason = 'init';

// Components that contribute to the stable prefix hash
const _STABLE_COMPONENTS = [
  'system_prompt',
  'coding_standards',
  'memory_section',
  'skills_catalog',
  'subagents_catalog',
  'daily_log',
];

/**
 * Compute a hash of all inputs that affect the stable prefix.
 * Used to detect when the stable prefix needs rebuilding.
 */
function computeStablePrefixHash(systemPromptText) {
  const hasher = crypto.createHash('sha256');
  const inputs = [systemPromptText];

  // Coding standards (static constant)
  inputs.push(CODING_STANDARDS);

  // Memory section
  try {
    const { buildMemorySystemSection } = require('./memoryKairos');
    inputs.push(buildMemorySystemSection());
  } catch {
    /* optional */
  }

  // Skills catalog
  try {
    const { getActiveSkillsCatalog } = require('../services/skills');
    inputs.push(getActiveSkillsCatalog());
  } catch {
    /* optional */
  }

  // Sub-agent catalog
  try {
    const { getCustomSubagentsCatalog } = require('../services/subagentRegistry');
    inputs.push(getCustomSubagentsCatalog());
  } catch {
    /* optional */
  }

  // Today's daily log (small excerpt for context)
  try {
    const memoryDir = getMemoryDataDir('logs');
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(
      memoryDir,
      String(new Date().getFullYear()),
      String(new Date().getMonth() + 1).padStart(2, '0'),
      `${today}.md`
    );
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8').slice(-2000);
      inputs.push(content);
    }
  } catch {
    /* optional */
  }

  for (const input of inputs) {
    hasher.update(String(input || ''));
  }
  return hasher.digest('hex');
}

// ── Coding Standards (static, Y-code pattern) ──

const CODING_STANDARDS = `【通用编码规范】
1. 修改代码前先理解现有结构与调用链，坚持最小改动原则，不做无关重构。
2. 改动后必须运行相关测试或编译/语法检查验证，验证通过才能声明任务完成。
3. 错误排查先定位根因（读报错、复现、查最近变更），再给出 1-3 个可选方案，不盲目重试。
4. 工具调用失败要如实保留错误信息，不隐瞒、不谎报成功；同因错误最多重试 2 次。
5. 结论优先，再展开细节；不过度寒暄，保持专业高效。
6. 删除文件/目录、危险 Git 操作、批量修改、安装全局依赖等破坏性操作先请求用户确认。
7. 新增功能优先复用现有工具、函数与模式，避免重复造轮子。
8. 命名遵循现有代码风格，注释补充必要上下文而非复述代码。
9. 处理文本数据注意编码一致性，避免 GBK/UTF-8 混淆导致乱码。
10. 长任务分阶段反馈进度，避免长时间静默。
11. 交付代码遵循对应语言的社区规范，添加必要注释，给出可直接运行的完整代码块。
12. 优先给出可执行的结论，不确定时明确说明假设，不臆测需求。`;

// ── Stable Prefix Builder ──

/**
 * Build the stable system message. This is the cacheable prefix that
 * stays byte-identical across turns (until skills/memory change).
 *
 * @param {string} systemPromptText - Base system prompt text
 * @param {boolean} [forceRebuild=false] - Force rebuild even if cache is valid
 * @returns {{ systemMessage: object, hash: string, reason: string }}
 */
function buildStableSystemMessage(systemPromptText, forceRebuild = false) {
  const currentHash = computeStablePrefixHash(systemPromptText);

  // Return cached version if hash matches
  if (!forceRebuild && _stablePrefixCache && _stablePrefixHash === currentHash) {
    return {
      systemMessage: _stablePrefixCache,
      hash: _stablePrefixHash,
      reason: 'cache_hit',
      lastRebuild: _lastRebuildReason,
    };
  }

  // Build fresh
  const parts = [systemPromptText || FALLBACK_SYSTEM_PROMPT];
  parts.push(CODING_STANDARDS);

  // Long-term memory section
  try {
    const { buildMemorySystemSection } = require('./memoryKairos');
    const memorySection = buildMemorySystemSection();
    if (memorySection.trim()) {
      parts.push(memorySection);
    }
  } catch {
    /* optional, fail-soft */
  }

  // Skills catalog (lightweight: names + descriptions only, not full prompts)
  try {
    const { getActiveSkillsCatalog } = require('../services/skills');
    const skillsCatalog = getActiveSkillsCatalog();
    if (skillsCatalog.trim()) {
      parts.push(skillsCatalog);
    }
  } catch {
    /* optional, fail-soft */
  }

  // Custom sub-agent catalog
  try {
    const { getCustomSubagentsCatalog } = require('../services/subagentRegistry');
    const subagentsCatalog = getCustomSubagentsCatalog();
    if (subagentsCatalog.trim()) {
      parts.push(subagentsCatalog);
    }
  } catch {
    /* optional, fail-soft */
  }

  const systemMessage = {
    role: 'system',
    content: parts.filter(Boolean).join('\n\n'),
  };

  // Cache it
  _stablePrefixCache = systemMessage;
  _stablePrefixHash = currentHash;
  _lastRebuildReason = forceRebuild ? 'force_rebuild' : 'hash_changed';

  return {
    systemMessage,
    hash: _stablePrefixHash,
    reason: _lastRebuildReason,
    lastRebuild: _lastRebuildReason,
  };
}

/**
 * Build dynamic runtime context — per-turn content that changes.
 * This goes after the stable prefix in the messages array.
 *
 * @param {object} opts
 * @param {string} opts.modelName - Current model name
 * @param {string} opts.permissionMode - confirm/plan/full
 * @param {string} opts.workingDir - Current working directory
 * @param {string} [opts.planSnapshot] - Active plan items text
 * @param {string} [opts.backgroundTaskSummary] - Background task results
 * @returns {{ role: string, content: string }}
 */
function buildDynamicContext(opts = {}) {
  const parts = [];

  // Build a compact runtime info block
  parts.push(`# Runtime Context`);
  parts.push(`- Model: ${opts.modelName || 'unknown'}`);
  parts.push(`- Permission: ${opts.permissionMode || 'confirm'}`);
  parts.push(`- Working directory: ${opts.workingDir || process.cwd()}`);

  // Current time (changes every turn)
  const now = new Date();
  parts.push(`- Current time: ${now.toLocaleString('zh-CN')}`);

  // Plan snapshot (only if a plan is active)
  if (opts.planSnapshot) {
    parts.push(`\n# Active Plan\n${opts.planSnapshot}`);
  }

  // Background task summary (consumed once)
  if (opts.backgroundTaskSummary) {
    parts.push(`\n# Background Task Results\n${opts.backgroundTaskSummary}`);
  }

  return {
    role: 'system',
    content: parts.join('\n'),
  };
}

/**
 * Assemble the complete messages array for an LLM request.
 * Separates stable prefix from dynamic context for cache optimization.
 *
 * @param {string} systemPromptText - Base system prompt
 * @param {Array} history - Conversation history messages
 * @param {object} [runtimeCtx] - Dynamic context options
 * @returns {{ messages: Array, stableHash: string, rebuildReason: string }}
 */
function assembleRequestMessages(systemPromptText, history = [], runtimeCtx = {}) {
  // Build stable prefix (cached across turns)
  const stable = buildStableSystemMessage(systemPromptText);

  // Build dynamic context (fresh each turn)
  const dynamic = buildDynamicContext(runtimeCtx);

  // Assemble: [stable, ...history, dynamic, currentUserMessage]
  const messages = [stable.systemMessage];

  // Add history, interleaving context blocks before user messages
  // (matches Y-code's _reposition_context_blocks pattern)
  const adjustedHistory = _repositionContextBlocks(history);
  for (const msg of adjustedHistory) {
    messages.push(msg);
  }

  // Dynamic context goes at the end (always changes)
  messages.push(dynamic);

  return {
    messages,
    stableHash: stable.hash,
    rebuildReason: stable.reason,
  };
}

/**
 * Reposition persisted context blocks: move them before the user message
 * they belong to, matching the inject-before-user convention.
 *
 * @param {Array} history
 * @returns {Array}
 */
function _repositionContextBlocks(history) {
  const out = [];
  for (const msg of history) {
    if (msg.role !== 'system' || !out.length) {
      out.push(msg);
      continue;
    }
    // Find the last user message and insert before it
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === 'user') {
        out.splice(i, 0, msg);
        break;
      }
    }
  }
  return out;
}

// ── Public API ──

/**
 * Invalidate the stable prefix cache. Call when skills, memory, or config change.
 */
function invalidateStablePrefix() {
  _stablePrefixCache = null;
  _stablePrefixHash = null;
  _lastRebuildReason = 'explicit_invalidation';
}

/**
 * Get cache status for debugging/monitoring.
 */
function getCacheStatus() {
  return {
    hasCache: !!_stablePrefixCache,
    hash: _stablePrefixHash,
    lastRebuild: _lastRebuildReason,
    prefixSize: _stablePrefixCache ? _stablePrefixCache.content.length : 0,
  };
}

// ── Fallback ──

const FALLBACK_SYSTEM_PROMPT = 'You are KHY OS, a helpful AI assistant.';

// ── Path helpers ──

function getMemoryDataDir(...segments) {
  try {
    const { getMemoryDataDir: _get } = require('../utils/dataHome');
    return _get(...segments);
  } catch {
    return path.join(os.homedir(), '.khy', 'memory', ...segments);
  }
}

module.exports = {
  buildStableSystemMessage,
  buildDynamicContext,
  assembleRequestMessages,
  invalidateStablePrefix,
  getCacheStatus,
  computeStablePrefixHash,
  CODING_STANDARDS,
  FALLBACK_SYSTEM_PROMPT,
};
