'use strict';

/**
 * ccKeyRegistry.js —— 快捷键注册表
 *
 * 集中管理所有 CC 模式快捷键。
 * 支持上下文感知（不同模式下快捷键行为不同）。
 *
 * 参考：[DESIGN-ARCH-088] 快捷键系统
 */

/**
 * 快捷键定义
 */
const KEY_BINDINGS = Object.freeze({
  // 全局快捷键
  global: Object.freeze({
    'ctrl+c': { action: 'cancel_or_exit', description: '取消/双击退出' },
    'ctrl+d': { action: 'exit', description: '退出 REPL' },
    'ctrl+o': { action: 'transcript_mode', description: '切换 transcript 模式' },
    'ctrl+l': { action: 'clear', description: '清除对话' },
    'ctrl+r': { action: 'history_search', description: '历史搜索' },
    'ctrl+p': { action: 'command_palette', description: '命令面板' },
    'ctrl+b': { action: 'toggle_sidebar', description: '切换右侧看板' },
    '?': { action: 'help', description: '帮助菜单' },
    'escape': { action: 'cancel', description: '取消当前操作' },
  }),

  // 消息列表快捷键
  messageList: Object.freeze({
    'up': { action: 'history_up', description: '上一条历史' },
    'down': { action: 'history_down', description: '下一条历史' },
    'r': { action: 'regenerate', description: '重新生成' },
    'shift+r': { action: 'regenerate_edit', description: '编辑后重做' },
    'f': { action: 'fork', description: '分叉新分支' },
    'z': { action: 'undo', description: '撤销' },
    'shift+z': { action: 'redo', description: '重做' },
  }),

  // 选择列表快捷键
  selection: Object.freeze({
    'up': { action: 'select_up', description: '上一项' },
    'down': { action: 'select_down', description: '下一项' },
    'return': { action: 'confirm', description: '确认选择' },
    'escape': { action: 'cancel', description: '取消选择' },
    'tab': { action: 'next_field', description: '下一字段' },
  }),

  // 输入框快捷键
  input: Object.freeze({
    'return': { action: 'submit', description: '提交' },
    'shift+return': { action: 'newline', description: '换行' },
    'tab': { action: 'complete', description: '补全' },
    'ctrl+u': { action: 'clear_line', description: '清空行' },
    'ctrl+w': { action: 'delete_word', description: '删除单词' },
  }),
});

/**
 * 快捷键注册表类
 */
class KeyRegistry {
  constructor() {
    this._bindings = new Map();
    this._contextStack = ['global'];
    this._loadDefaults();
  }

  _loadDefaults() {
    for (const [context, bindings] of Object.entries(KEY_BINDINGS)) {
      for (const [key, def] of Object.entries(bindings)) {
        this.register(context, key, def);
      }
    }
  }

  /**
   * 注册快捷键
   */
  register(context, key, definition) {
    const normalizedKey = key.toLowerCase();
    if (!this._bindings.has(context)) {
      this._bindings.set(context, new Map());
    }
    this._bindings.get(context).set(normalizedKey, { ...definition, key: normalizedKey });
  }

  /**
   * 解析快捷键事件
   */
  resolveEvent(input, key, context = null) {
    const ctx = context || this._currentContext();
    const keyStr = this._keyToString(input, key);

    // 先查当前上下文
    const ctxBindings = this._bindings.get(ctx);
    if (ctxBindings && ctxBindings.has(keyStr)) {
      return { context: ctx, ...ctxBindings.get(keyStr) };
    }

    // 回退到全局
    if (ctx !== 'global') {
      const globalBindings = this._bindings.get('global');
      if (globalBindings && globalBindings.has(keyStr)) {
        return { context: 'global', ...globalBindings.get(keyStr) };
      }
    }

    return null;
  }

  /**
   * 获取当前上下文
   */
  _currentContext() {
    return this._contextStack[this._contextStack.length - 1] || 'global';
  }

  /**
   * 推入上下文
   */
  pushContext(context) {
    this._contextStack.push(context);
  }

  /**
   * 弹出上下文
   */
  popContext() {
    if (this._contextStack.length > 1) {
      return this._contextStack.pop();
    }
    return this._contextStack[0];
  }

  /**
   * 将 key 事件转为字符串
   */
  _keyToString(input, key) {
    const parts = [];
    if (key.ctrl) parts.push('ctrl');
    if (key.shift) parts.push('shift');
    if (key.meta) parts.push('meta');

    if (key.ctrl && input) {
      parts.push(input.toLowerCase());
    } else if (key.upArrow) parts.push('up');
    else if (key.downArrow) parts.push('down');
    else if (key.leftArrow) parts.push('left');
    else if (key.rightArrow) parts.push('right');
    else if (key.return) parts.push('return');
    else if (key.escape) parts.push('escape');
    else if (key.tab) parts.push('tab');
    else if (key.backspace) parts.push('backspace');
    else if (key.delete) parts.push('delete');
    else if (input) parts.push(input.toLowerCase());

    return parts.join('+');
  }
}

// 单例
let _instance = null;
function getKeyRegistry() {
  if (!_instance) {
    _instance = new KeyRegistry();
  }
  return _instance;
}

module.exports = {
  KEY_BINDINGS,
  KeyRegistry,
  getKeyRegistry,
};
