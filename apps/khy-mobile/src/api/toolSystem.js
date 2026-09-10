// khy.toolSystem —— 增强工具系统
//
// 功能：
// 1. 动态 Schema 生成（支持从 JSON Schema 自动生成）
// 2. 细粒度权限控制（工具级别、操作级别）
// 3. Tool Hooks（执行前后钩子）
// 4. 输出截断和格式化

// ---------- 权限系统 ----------

/**
 * 权限级别
 */
export const PermissionLevel = {
  AUTO: 'auto',           // 自动允许（无需确认）
  ASK: 'ask',             // 需要用户确认
  DENY: 'deny',           // 禁止
};

/**
 * 工具权限配置
 */
const toolPermissions = new Map();

/**
 * 设置工具权限
 */
export function setToolPermission(toolName, level) {
  toolPermissions.set(toolName, level);
}

/**
 * 获取工具权限
 */
export function getToolPermission(toolName) {
  return toolPermissions.get(toolName) || PermissionLevel.AUTO;
}

/**
 * 检查工具是否可执行
 */
export function canExecuteTool(toolName) {
  const level = getToolPermission(toolName);
  return level !== PermissionLevel.DENY;
}

// ---------- Tool Hooks ----------

/**
 * Hook 类型
 */
export const HookType = {
  BEFORE_EXECUTE: 'beforeExecute',
  AFTER_EXECUTE: 'afterExecute',
  ON_ERROR: 'onError',
};

const hooks = {
  [HookType.BEFORE_EXECUTE]: new Map(),
  [HookType.AFTER_EXECUTE]: new Map(),
  [HookType.ON_ERROR]: new Map(),
};

/**
 * 注册 Hook
 * @param {string} type - Hook 类型
 * @param {string} toolName - 工具名（或 '*' 表示所有工具）
 * @param {Function} handler - 处理函数
 */
export function registerHook(type, toolName, handler) {
  if (!hooks[type]) hooks[type] = new Map();
  if (!hooks[type].has(toolName)) {
    hooks[type].set(toolName, []);
  }
  hooks[type].get(toolName).push(handler);
}

/**
 * 移除 Hook
 */
export function removeHook(type, toolName, handler) {
  if (!hooks[type] || !hooks[type].has(toolName)) return;
  const handlers = hooks[type].get(toolName);
  const index = handlers.indexOf(handler);
  if (index >= 0) handlers.splice(index, 1);
}

/**
 * 执行 Hooks
 */
async function executeHooks(type, toolName, context) {
  const results = [];

  // 执行全局 hooks (*)
  if (hooks[type]?.has('*')) {
    for (const handler of hooks[type].get('*')) {
      try {
        const result = await handler(toolName, context);
        results.push(result);
      } catch (error) {
        console.error(`Hook error (${type}):`, error);
      }
    }
  }

  // 执行工具特定 hooks
  if (hooks[type]?.has(toolName)) {
    for (const handler of hooks[type].get(toolName)) {
      try {
        const result = await handler(toolName, context);
        results.push(result);
      } catch (error) {
        console.error(`Hook error (${type}/${toolName}):`, error);
      }
    }
  }

  return results;
}

// ---------- 输出格式化 ----------

/**
 * 截断长文本输出
 */
export function truncateOutput(text, maxLength = 4000) {
  if (!text || text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  return `${truncated}\n\n... (已截断，原始长度: ${text.length} 字符)`;
}

/**
 * 格式化工具结果
 */
export function formatToolResult(result, options = {}) {
  const { maxLength = 4000, format = 'text' } = options;

  let content;
  if (typeof result === 'string') {
    content = result;
  } else if (result && typeof result === 'object') {
    content = JSON.stringify(result, null, 2);
  } else {
    content = String(result);
  }

  return truncateOutput(content, maxLength);
}

/**
 * 检测是否为图片输出（data URI）
 */
export function isImageOutput(text) {
  if (!text) return false;
  return /^data:image\/(png|jpeg|gif|webp);base64,/.test(text.trim());
}

/**
 * 解析 data URI
 */
export function parseDataUri(text) {
  const match = text.trim().match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

// ---------- Schema 生成 ----------

/**
 * 从 JSON Schema 生成 OpenAI 格式的工具定义
 */
export function jsonSchemaToTool(name, description, jsonSchema) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: jsonSchema,
    },
  };
}

/**
 * 从简单参数定义生成 JSON Schema
 */
export function simpleSchema(properties, required = []) {
  const schema = {
    type: 'object',
    properties: {},
    required,
  };

  for (const [key, def] of Object.entries(properties)) {
    if (typeof def === 'string') {
      schema.properties[key] = { type: 'string', description: def };
    } else {
      schema.properties[key] = def;
    }
  }

  return schema;
}

// ---------- 工具包装器 -----------

/**
 * 创建带权限和 Hook 的工具执行器
 */
export function createToolExecutor(toolName, toolExecute) {
  return async (args) => {
    // 权限检查
    if (!canExecuteTool(toolName)) {
      return { ok: false, content: `工具 "${toolName}" 已被禁用` };
    }

    // 执行前 Hook
    const beforeResults = await executeHooks(HookType.BEFORE_EXECUTE, toolName, { args });
    for (const result of beforeResults) {
      if (result === false) {
        return { ok: false, content: `工具 "${toolName}" 执行被 Hook 取消` };
      }
    }

    try {
      // 执行工具
      let result = await toolExecute(args);

      // 格式化输出
      if (typeof result === 'string') {
        result = formatToolResult(result);
      } else if (result && result.content) {
        result.content = formatToolResult(result.content);
      }

      // 执行后 Hook
      await executeHooks(HookType.AFTER_EXECUTE, toolName, { args, result });

      return typeof result === 'string' ? { ok: true, content: result } : result;
    } catch (error) {
      // 错误 Hook
      await executeHooks(HookType.ON_ERROR, toolName, { args, error });

      return { ok: false, content: `执行失败: ${error.message}` };
    }
  };
}

// ----------

/**
 * 初始化默认权限配置
 */
export function initDefaultPermissions() {
  // 文件操作默认需要确认
  setToolPermission('khy.local.fileWrite', PermissionLevel.ASK);
  setToolPermission('khy.local.fileDelete', PermissionLevel.ASK);

  // 危险操作默认禁止
  setToolPermission('khy.local.linuxExec', PermissionLevel.ASK);

  // 其他工具自动允许
  setToolPermission('khy.local.fileList', PermissionLevel.AUTO);
  setToolPermission('khy.local.fileRead', PermissionLevel.AUTO);
  setToolPermission('khy.local.fileSearch', PermissionLevel.AUTO);
  setToolPermission('khy.local.fileInfo', PermissionLevel.AUTO);
}

// 初始化
initDefaultPermissions();

export default {
  PermissionLevel,
  HookType,
  setToolPermission,
  getToolPermission,
  canExecuteTool,
  registerHook,
  removeHook,
  truncateOutput,
  formatToolResult,
  isImageOutput,
  parseDataUri,
  jsonSchemaToTool,
  simpleSchema,
  createToolExecutor,
  initDefaultPermissions,
};
