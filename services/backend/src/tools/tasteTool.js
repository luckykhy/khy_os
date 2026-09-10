/**
 * tasteTool — 模型在对话中直接读写用户偏好的工具。
 *
 * 与 Command Code 的 taste 工具对齐：模型可以通过工具调用
 * 记录、查询、更新用户的偏好设置。
 *
 * 操作：
 *   read    — 读取当前所有 taste 条目
 *   add     — 添加或更新一条 taste
 *   bump    — 提升一条 taste 的 confidence
 *   drop    — 降低一条 taste 的 confidence
 *   remove  — 删除一条 taste
 */
const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'taste',
  description: `Read or update user taste preferences. Use this tool to:
- Record a user preference you learned from the conversation
- Read current preferences to align your behavior
- Update confidence of existing preferences (bump/drop)

Each preference has a category, text description, and confidence score (0-1).
Preferences are injected into your system prompt so you remember them across turns.`,
  category: 'system',
  risk: 'safe',
  searchHint: 'taste preference user style learn remember 偏好 风格 学习 记忆',
  maxResultSizeChars: 8000,
  // taste 操作都是安全的偏好记录（写入 ~/.khyos/taste/ 和 .commandcode/taste/），
  // 不修改系统状态、不破坏数据。标记为 readOnly 让 syscall 网关自动放行，
  // 无需交互式确认（与 Command Code 的 taste 工具行为一致）。
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,

  inputSchema: {
    operation: {
      type: 'string',
      required: true,
      enum: ['read', 'add', 'bump', 'drop', 'remove'],
      description: 'Operation to perform: read (list all), add (new preference), bump (increase confidence), drop (decrease confidence), remove (delete)',
      example: 'add',
    },
    text: {
      type: 'string',
      required: false,
      description: 'The preference text (required for add/bump/drop/remove)',
      example: 'Prefers Chinese for all communication',
    },
    category: {
      type: 'string',
      required: false,
      description: 'Category for the preference (default: general)',
      example: 'style',
    },
    confidence: {
      type: 'number',
      required: false,
      description: 'Confidence score 0-1 for add (default: 0.7). For bump/drop: delta amount (default: 0.05).',
      example: 0.8,
    },
  },

  async validateInput(input) {
    const op = input?.operation || 'read';
    if (!['read', 'add', 'bump', 'drop', 'remove'].includes(op)) {
      return { valid: false, message: `Unknown operation: ${op}. Use read/add/bump/drop/remove.` };
    }
    if (['add', 'bump', 'drop', 'remove'].includes(op) && !input?.text) {
      return { valid: false, message: `"text" is required for ${op} operation.` };
    }
    return { valid: true };
  },

  getActivityDescription(input) {
    const op = input?.operation || 'read';
    const text = input?.text || '';
    const short = text.length > 40 ? text.slice(0, 37) + '...' : text;
    switch (op) {
      case 'read': return '读取用户偏好';
      case 'add': return `记录偏好: ${short}`;
      case 'bump': return `提升偏好 confidence: ${short}`;
      case 'drop': return `降低偏好 confidence: ${short}`;
      case 'remove': return `删除偏好: ${short}`;
      default: return `taste ${op}`;
    }
  },

  getToolUseSummary(input) {
    const op = input?.operation || 'read';
    return `taste.${op}${input?.text ? ': ' + input.text.slice(0, 40) : ''}`;
  },

  async execute(params) {
    const taste = require('../services/tasteService');
    const op = params.operation || 'read';

    switch (op) {
      case 'read': {
        const items = taste.readAll();
        if (items.length === 0) {
          return { success: true, output: 'No taste preferences recorded yet.' };
        }
        const lines = items.map(
          (it) => `- [${it.category}] ${it.text}. (confidence ${it.confidence.toFixed(2)})`
        );
        return {
          success: true,
          output: `Found ${items.length} preferences:\n${lines.join('\n')}`,
        };
      }

      case 'add': {
        const result = taste.addPreference({
          category: params.category || 'general',
          text: params.text,
          confidence: params.confidence,
        });
        if (!result.ok) {
          return { success: false, error: `Failed to add preference: ${result.error}` };
        }
        return {
          success: true,
          output: `Recorded: "${result.text}" (confidence ${result.confidence.toFixed(2)}, category: ${result.category})`,
        };
      }

      case 'bump': {
        const result = taste.adjustConfidence({
          text: params.text,
          delta: Math.abs(params.confidence || 0.05),
          category: params.category,
        });
        if (!result.ok) {
          return { success: false, error: `Failed to bump: ${result.error}` };
        }
        return {
          success: true,
          output: `Bumped "${params.text}" to confidence ${result.confidence.toFixed(2)} (category: ${result.category})`,
        };
      }

      case 'drop': {
        const result = taste.adjustConfidence({
          text: params.text,
          delta: -Math.abs(params.confidence || 0.05),
          category: params.category,
        });
        if (!result.ok) {
          return { success: false, error: `Failed to drop: ${result.error}` };
        }
        return {
          success: true,
          output: `Dropped "${params.text}" to confidence ${result.confidence.toFixed(2)} (category: ${result.category})`,
        };
      }

      case 'remove': {
        const result = taste.removePreference({
          text: params.text,
          category: params.category,
        });
        if (!result.ok) {
          return { success: false, error: `Failed to remove: ${result.error}` };
        }
        return { success: true, output: `Removed: "${params.text}"` };
      }

      default:
        return { success: false, error: `Unknown operation: ${op}` };
    }
  },
});
