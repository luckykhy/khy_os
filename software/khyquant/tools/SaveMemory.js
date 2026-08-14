'use strict';

/**
 * SaveMemory — let the model PERSIST a durable memory on demand.
 *
 * WHY THIS EXISTS (the real defect it fixes):
 *   Before this tool, saveMemory() had exactly two callers — the TUI manual
 *   save (App.js) and the /remember command. The model itself had NO way to
 *   write memory: when it said "我记住了" it never actually persisted anything,
 *   so the fact was gone by the next session. This tool gives the model a
 *   first-class write path, mirroring Claude Code's memory-write capability.
 *
 *   Writes go through the existing memdir SSOT (saveMemory + updateMemoryIndex),
 *   so after 刀1 (unified home) they land in the durable ~/.khy/memory that the
 *   recall side also reads — closing the "told it, forgot it" loop.
 *
 * Gate: KHY_SAVE_MEMORY_TOOL (default ON). Also honors KHY_DISABLE_MEMORY.
 */

const { defineTool } = require('./_baseTool');

const OFF_VALUES = ['0', 'false', 'off', 'no'];
const VALID_TYPES = ['user', 'feedback', 'project', 'reference'];

function _saveMemoryEnabled(env) {
  const e = env || process.env;
  const disabled = String(e.KHY_DISABLE_MEMORY || '').trim().toLowerCase();
  if (disabled === '1' || disabled === 'true') return false;
  const raw = String(e.KHY_SAVE_MEMORY_TOOL == null ? '' : e.KHY_SAVE_MEMORY_TOOL).trim().toLowerCase();
  return !OFF_VALUES.includes(raw);
}

// 写侧「主动写入的时机」引导(goal 2026-07-03「…没把握主动写入与主动调用的时机,感觉
// 特别健忘」)。原描述只教模型「用户说记住才存」——纯触发式,正是用户抱怨的窄时机。这里
// 追加**主动捕获**引导:durable 跨会话事实自然浮现时(身份/稳定偏好/工作方式反馈/长期
// 项目约束)不等命令就存,同时明确**不存**易逝/仓库已录/一次性琐事——给引导也给防噪护栏。
// 门控 KHY_SAVE_MEMORY_PROACTIVE 默认开;关 → 描述逐字回退到原始基线串。
// 注意:这只丰富**模型自选** SaveMemory 的引导,**不动**确定性自动保存分类器
// (memoryTrigger.classify 刻意保守以防假阳)——判断式与确定式两条路各自其分。
const _BASE_DESC =
  'Persist a durable memory the user wants you to remember across sessions '
  + '(their identity/preferences, your agreed working style, ongoing project facts, or reference pointers). '
  + 'Use this whenever the user tells you something to remember — do not just claim you remembered it. '
  + 'type: user|feedback|project|reference. Writes to the local memory store and updates the index.';

const _PROACTIVE_HINT =
  ' PROACTIVE TIMING — also save WITHOUT being told when a durable, cross-session fact emerges: '
  + 'the user states who they are or a stable preference/workflow, gives feedback on how you should work, '
  + 'or a lasting project constraint/decision surfaces. Do NOT save ephemeral or conversational details, '
  + 'anything already recorded in the repo or git history, or one-off task minutiae; check for an existing '
  + 'memory on the same fact and update it instead of duplicating. When unsure a fact is durable, prefer saving a concise version.';

function _saveMemoryProactive(env) {
  const raw = String((env || process.env).KHY_SAVE_MEMORY_PROACTIVE == null ? '' : (env || process.env).KHY_SAVE_MEMORY_PROACTIVE).trim().toLowerCase();
  return !OFF_VALUES.includes(raw);
}

function buildSaveMemoryDescription(env) {
  return _saveMemoryProactive(env) ? (_BASE_DESC + _PROACTIVE_HINT) : _BASE_DESC;
}

module.exports = defineTool({
  name: 'SaveMemory',
  description: buildSaveMemoryDescription(process.env),
  category: 'system',
  risk: 'medium',
  aliases: ['saveMemory', 'remember', 'rememberFact'],
  isReadOnly: () => false,
  isConcurrencySafe: false,
  isEnabled: () => _saveMemoryEnabled(process.env),
  inputSchema: {
    type: {
      type: 'string',
      required: true,
      enum: VALID_TYPES,
      description: 'user = who they are/preferences; feedback = how you should work; project = ongoing work facts; reference = external pointers.',
    },
    name: {
      type: 'string',
      required: true,
      description: 'Short kebab-case slug naming the fact (e.g. "user-home-address").',
    },
    content: {
      type: 'string',
      required: true,
      description: 'The fact to remember, in prose. Convert relative dates to absolute.',
    },
    description: {
      type: 'string',
      required: false,
      description: 'One-line summary used for relevance during recall (defaults to name).',
    },
  },
  async execute(params, _context) {
    if (!_saveMemoryEnabled(process.env)) {
      return { success: false, error: 'SaveMemory is disabled (KHY_SAVE_MEMORY_TOOL=off or memory disabled).' };
    }
    const type = String((params && params.type) || '').trim().toLowerCase();
    const name = String((params && params.name) || '').trim();
    const content = String((params && params.content) || '').trim();
    const description = params && params.description ? String(params.description).trim() : '';

    if (!VALID_TYPES.includes(type)) {
      return { success: false, error: `Invalid type: "${type}". Valid: ${VALID_TYPES.join(', ')}.` };
    }
    if (!name) return { success: false, error: 'name is required (short kebab-case slug).' };
    if (!content) return { success: false, error: 'content is required (the fact to remember).' };

    let memdir;
    try {
      memdir = require('../memdir');
    } catch (e) {
      return { success: false, error: 'memory store unavailable: ' + ((e && e.message) || e) };
    }

    try {
      const { filename } = memdir.saveMemory(type, name, content, { description: description || undefined });
      try {
        memdir.updateMemoryIndex([{ title: name, filename, description: description || name }]);
      } catch { /* index update best-effort — the memory file is already written */ }
      return { success: true, data: { filename, type, name } };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  },
});
