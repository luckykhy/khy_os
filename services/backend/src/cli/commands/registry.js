'use strict';

/**
 * Command Registry — 命令注册表
 *
 * 对抗式综合方案 C：分层注册表 + 懒加载
 *
 * 设计原则：
 *   - 注册表存储命令元数据（名称、描述、权限、handler 路径）
 *   - router.js 中的 switch 仍然存在，但通过注册表元数据获取 handler
 *   - 新增命令只需添加注册表条目，无需修改 router.js 的 switch
 *   - 懒加载：只在首次命中时 require handler
 *
 * 渐进迁移策略：
 *   - 阶段 1：创建注册表，现有命令通过注册表元数据获取 handler
 *   - 阶段 2：高频命令迁移到独立 handler 文件
 *   - 阶段 3：低频命令按需迁移
 */

const fs = require('fs');
const path = require('path');

// ── 命令元数据 ──────────────────────────────────────────────────────────
// handler 路径相对于 commands/ 目录，requirePath 用于懒加载
const COMMAND_REGISTRY = {
  // ── Meta / System ──
  version: {
    description: '显示版本号',
    category: 'meta',
    handler: 'system/version',
    lazy: true,
  },
  help: {
    description: '显示帮助信息',
    category: 'meta',
    handler: 'system/help',
    lazy: true,
  },
  clear: {
    description: '清屏',
    category: 'meta',
    handler: 'system/clear',
    lazy: true,
  },
  exit: {
    description: '退出',
    category: 'meta',
    handler: 'system/exit',
    lazy: true,
  },
  menu: {
    description: '交互式菜单',
    category: 'meta',
    handler: 'system/menu',
    lazy: true,
  },

  // ── AI / Chat ──
  ai: {
    description: 'AI 聊天 REPL',
    category: 'ai',
    handler: 'ai/aiChat',
    lazy: true,
  },

  // ── Gateway ──
  gateway: {
    description: 'AI 网关管理',
    category: 'gateway',
    handler: 'gateway/gateway',
    lazy: true,
  },

  // ── Service ──
  service: {
    description: '服务管理',
    category: 'service',
    handler: 'service/service',
    lazy: true,
  },

  // ── Config ──
  config: {
    description: '配置管理',
    category: 'config',
    handler: 'config/config',
    lazy: true,
  },

  // ── Doctor / Health ──
  doctor: {
    description: '系统健康检查',
    category: 'ops',
    handler: 'ops/doctor',
    lazy: true,
  },

  // ── Storage ──
  storage: {
    description: '存储管理',
    category: 'ops',
    handler: 'ops/storage',
    lazy: true,
  },

  // ── Restore ──
  restore: {
    description: '自动修复',
    category: 'ops',
    handler: 'ops/restore',
    lazy: true,
  },

  // ── Test ──
  test: {
    description: '测试命令',
    category: 'dev',
    handler: 'dev/test',
    lazy: true,
  },

  // ── Lint ──
  lint: {
    description: '代码风格检查',
    category: 'dev',
    handler: 'dev/lint',
    lazy: true,
  },

  // ── Docs ──
  docs: {
    description: '文档',
    category: 'dev',
    handler: 'dev/docs',
    lazy: true,
  },

  // ── Package ──
  package: {
    description: '打包',
    category: 'release',
    handler: 'release/package',
    lazy: true,
  },

  // ── Release ──
  release: {
    description: '发布',
    category: 'release',
    handler: 'release/release',
    lazy: true,
  },

  // ── Migrate ──
  migrate: {
    description: '数据迁移',
    category: 'ops',
    handler: 'ops/migrate',
    lazy: true,
  },

  // ── Test Coverage ──
  'test-coverage': {
    description: '测试覆盖率报告',
    category: 'dev',
    handler: 'dev/testCoverage',
    lazy: true,
  },
};

// ── 分类信息 ──────────────────────────────────────────────────────────────
const CATEGORIES = {
  meta: { label: '系统', description: '基础系统命令' },
  ai: { label: 'AI', description: 'AI 聊天与智能体' },
  gateway: { label: '网关', description: 'AI 网关管理' },
  service: { label: '服务', description: '后台服务管理' },
  config: { label: '配置', description: '系统配置' },
  ops: { label: '运维', description: '运维与诊断' },
  dev: { label: '开发', description: '开发工具' },
  release: { label: '发布', description: '打包与发布' },
};

// ── 缓存 ──────────────────────────────────────────────────────────────────
const _handlerCache = new Map();

// ── 注册表 API ──────────────────────────────────────────────────────────────

/**
 * 获取所有已注册的命令名称。
 * @returns {string[]}
 */
function getCommandNames() {
  return Object.keys(COMMAND_REGISTRY);
}

/**
 * 获取命令的元数据。
 * @param {string} cmdName
 * @returns {object|undefined}
 */
function getCommandMeta(cmdName) {
  return COMMAND_REGISTRY[cmdName];
}

/**
 * 获取 handler（懒加载）。
 * @param {string} cmdName
 * @returns {Function|undefined}
 */
function getHandler(cmdName) {
  const meta = COMMAND_REGISTRY[cmdName];
  if (!meta) return undefined;

  // 缓存命中
  if (_handlerCache.has(cmdName)) {
    return _handlerCache.get(cmdName);
  }

  // 懒加载
  if (meta.lazy) {
    try {
      const handlerPath = path.join(__dirname, meta.handler);
      const handler = require(handlerPath);
      _handlerCache.set(cmdName, handler);
      return handler;
    } catch {
      // handler 文件不存在，返回 undefined
      return undefined;
    }
  }

  return undefined;
}

/**
 * 检查命令是否有独立的 handler 文件。
 * @param {string} cmdName
 * @returns {boolean}
 */
function hasHandler(cmdName) {
  return getHandler(cmdName) !== undefined;
}

/**
 * 获取所有命令的元数据列表。
 * @returns {Array<{name: string, description: string, category: string, hasHandler: boolean}>}
 */
function getAllCommands() {
  return Object.entries(COMMAND_REGISTRY).map(([name, meta]) => ({
    name,
    description: meta.description,
    category: meta.category,
    hasHandler: hasHandler(name),
  }));
}

/**
 * 按分类获取命令。
 * @returns {Object<string, Array<{name: string, description: string}>>}
 */
function getCommandsByCategory() {
  const result = {};
  for (const [name, meta] of Object.entries(COMMAND_REGISTRY)) {
    if (!result[meta.category]) {
      result[meta.category] = [];
    }
    result[meta.category].push({
      name,
      description: meta.description,
    });
  }
  return result;
}

/**
 * 注册新命令（运行时扩展）。
 * @param {string} name 命令名称
 * @param {object} meta 元数据
 */
function registerCommand(name, meta) {
  COMMAND_REGISTRY[name] = meta;
}

/**
 * 获取分类信息。
 * @returns {Object}
 */
function getCategories() {
  return CATEGORIES;
}

// ── 导出 ──────────────────────────────────────────────────────────────────

module.exports = {
  getCommandNames,
  getCommandMeta,
  getHandler,
  hasHandler,
  getAllCommands,
  getCommandsByCategory,
  registerCommand,
  getCategories,
};
