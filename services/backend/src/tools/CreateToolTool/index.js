'use strict';

/**
 * CreateToolTool — agent 可调用的「元工具」（设计见
 * docs/03_DESIGN_设计/[DESIGN-ARCH-017] 元工具系统设计.md）。
 *
 * 触发模型（设计 §2 主路径）：把铸造能力作为一个普通工具暴露给模型。**仅当**现有
 * 工具都不匹配、且需求是一段**可纯计算**完成的逻辑时，模型才调用本工具；引擎随后
 * 经 LLM 生成定义 → 静态扫描 → 沙箱冒烟 → 注册，使新工具在同会话即可被后续步骤调用。
 *
 * 安全与边界：
 *   - 默认关闭，仅 KHY_ENABLE_META_TOOL=1 时 isEnabled() 为真（设计 §0）。
 *   - 全部安全逻辑在 metaToolEngine 内，本工具只做「装配 LLM + 透出自然语言结果」。
 *   - 用户层只见自然语言（设计 §6 / DESIGN-ARCH-016 R5），不回显源码/JSON/内部字段。
 *
 * 注册：本文件导出一个 defineTool() 结果，由 tools/index.js 自动发现（Case 1）。
 */

const { defineTool } = require('../_baseTool');

/**
 * 默认 LLM 适配器：把 cli/ai.chat 收敛成 `async (message) => string`。
 * 失败一律抛出，由引擎捕获并降级（绝不崩 Agent）。
 */
async function _defaultLlm(message) {
  const ai = require('../../cli/ai');
  const res = await ai.chat(message, {
    // 纯生成调用：不触发自然语言工具循环，避免递归调用工具系统。
    disableNaturalToolLoop: true,
    source: 'meta-tool-forge',
  });
  return (res && (res.reply || res.text || res.content)) || '';
}

module.exports = defineTool({
  name: 'createTool',
  description:
    '当现有工具都无法满足需求、且该需求可由一段纯计算逻辑（数学/字符串/数组/JSON 变换）完成时，'
    + '动态创建并注册一个新工具供后续步骤调用。新工具经静态安全扫描与沙箱测试后才会生效，'
    + '严禁用于文件/网络/进程等带副作用的操作（这些请改用既有受控工具）。',
  category: 'system',
  risk: 'medium',
  // 默认不进初始 prompt，按关键词延迟揭示，避免无谓鼓励铸造（设计 §2/§7）。
  shouldDefer: true,
  searchHint: 'create tool forge meta generate new capability 元工具 新建工具',
  aliases: ['CreateTool', 'forge_tool', 'make_tool'],
  isReadOnly: false,
  isConcurrencySafe: false,
  // 默认关闭门禁：未显式启用时本工具对模型不可见（设计 §0）。
  isEnabled: () => {
    try { return require('../../services/metaToolEngine').isEnabled(); } catch { return false; }
  },
  inputSchema: {
    purpose: {
      type: 'string',
      required: true,
      minLength: 4,
      maxLength: 500,
      description: '要新建工具解决的需求（自然语言描述，越具体越好）。',
    },
    name: {
      type: 'string',
      required: false,
      maxLength: 40,
      description: '建议的工具名（camelCase，可选；引擎可能调整）。',
    },
    inputHint: {
      type: 'string',
      required: false,
      maxLength: 200,
      description: '对工具输入参数的提示（可选）。',
    },
  },
  async execute(params = {}, context = {}) {
    let engine;
    try {
      engine = require('../../services/metaToolEngine');
    } catch (e) {
      return { success: false, content: '元工具系统不可用。', error: e.message };
    }
    if (!engine.isEnabled()) {
      return {
        success: false,
        content: '元工具系统未启用（需设置 KHY_ENABLE_META_TOOL=1）。已改用现有能力继续。',
      };
    }

    // 允许测试/宿主注入 llm；否则用默认 cli/ai 适配器。
    const llm = (context && typeof context.llm === 'function') ? context.llm : _defaultLlm;

    let result;
    try {
      result = await engine.forgeTool(
        { purpose: params.purpose, name: params.name, inputHint: params.inputHint },
        { llm, session: context && context.session },
      );
    } catch (e) {
      // 引擎内部已尽量不抛；此处为终极防呆。
      return { success: false, content: '新建工具时发生意外，已改用现有能力继续。', error: e.message };
    }

    const created = result.status === 'created' || result.status === 'reused';
    return {
      success: created,
      // 用户层：自然语言，无内部字段（DESIGN-ARCH-016 R5）。
      content: result.message,
      // 结构化字段供调度层/上游消费（不展示给用户）。
      data: { status: result.status, toolName: result.toolName || null },
    };
  },
});
