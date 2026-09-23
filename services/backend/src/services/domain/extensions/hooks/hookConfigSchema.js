'use strict';

/**
 * hookConfigSchema.js — 单一真源：`.khy/hooks.json`（与 `<appHome>/hooks.json`）
 * 的字段契约校验器。
 *
 * 背景：`hookRegistry.load()` 此前直接 `JSON.parse` 后逐项 `_register`，坏 schema
 * 只靠 `console.warn` 跳过，没有一处能机判「这份配置合不合标准」。本模块把契约
 * 抽成纯函数 `validateHooksConfig(raw)`，`hookRegistry` 与未来的 `.khy/hooks.json`
 * 工具（校验/迁移/导出）都消费它。
 *
 * 纯函数约定：零 IO、零副作用、只读入参、返回 `{ valid, errors[] }`。同
 * `@khy/plugin-sdk` 的 `validateManifest` 一个形状——契约真源可被第三方工具
 * 依赖，也便于测试钉死。
 *
 * @see [DESIGN-ARCH-116] khyos-插件系统契约（本文件的姊妹篇是 Hooks 侧）
 */

// 事件清单是 hookRegistry.js 的内部常量，此处镜像一份避免循环 require。
// 真源是 hookRegistry.js 的 HOOK_EVENTS（它已重新导出，供守卫测试对齐）。
// 若两侧漂移，hookConfigSchema.test.js 的「HOOK_EVENTS 钉 11 事件」断言会红。
const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PrePrompt',
  'PostResponse',
  'PreCompact',
  'PostCompact',
  'Stop',
  'SubAgentStart',
  'SubAgentEnd',
  'ToolPermission',
  'PromptSection',
];

// .khy/ 下 JSON 文件惯例：必须带 version 字段（见 FILE-FORMAT-PROTOCOL）。
// 缺 version 不阻断旧配置加载（向后兼容），但报 warning 级 error，
// 让工具链有机会提示迁移。
const REQUIRED_HOOK_FIELDS = ['event'];
// command 型 hook：event + command 二选一必有一项；function 型由代码注册，不走 JSON。
// 但 .khy/hooks.json 里 handler 是函数引用无法 JSON 序列化，所以 JSON 配置只收 command 型。
const JSON_HOOK_KINDS = ['command'];

/**
 * 校验一份 hooks.json 配置（已 parse 成 JS 对象）。
 *
 * 接受的两种顶层形状（与 `hookRegistry.load()` 现有解析一致）：
 *   - 裸数组：`[ { event, command, ... } ]`
 *   - 对象包：`{ version, hooks: [ ... ], disabled: [ ... ] }`
 *
 * @param {*} raw - `JSON.parse` 后的配置对象
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateHooksConfig(raw) {
  const errors = [];
  const warnings = [];

  if (raw === null || typeof raw !== 'object') {
    return { valid: false, errors: ['config must be an object or array'], warnings };
  }

  // 顶层形状归一：裸数组 → 包一层；对象 → 取 .hooks。
  const hooksArray = Array.isArray(raw) ? raw : raw.hooks || [];
  const disabledArray = Array.isArray(raw) ? [] : raw.disabled || [];

  // version 检查（对象包才允许带；裸数组缺省视为 legacy，不阻断）。
  if (!Array.isArray(raw) && raw.version === undefined) {
    warnings.push('missing version field (recommended for new configs; see FILE-FORMAT-PROTOCOL)');
  }
  if (raw.version !== undefined && typeof raw.version !== 'number') {
    errors.push(`version must be a number, got ${typeof raw.version}`);
  }

  // hooks 元素校验。
  if (!Array.isArray(hooksArray)) {
    errors.push('hooks must be an array');
  } else {
    hooksArray.forEach((h, i) => {
      const label = h && h.source ? h.source : `hooks[${i}]`;
      if (!h || typeof h !== 'object') {
        errors.push(`${label}: must be an object`);
        return;
      }
      // event 必填且合法。
      if (REQUIRED_HOOK_FIELDS.includes('event') && !h.event) {
        errors.push(`${label}: missing required field "event"`);
      } else if (!HOOK_EVENTS.includes(h.event)) {
        errors.push(
          `${label}: event "${h.event}" not in HOOK_EVENTS (${HOOK_EVENTS.join(', ')})`
        );
      }
      // command / handler 二选一（JSON 配置只认 command，handler 是运行时函数）。
      if (typeof h.command !== 'string' || !h.command.trim()) {
        if (typeof h.handler !== 'function') {
          // JSON 配置里 handler 几乎总是缺的（函数不可序列化）——但如果是对象
          // 包且声明了 handler 字段，至少得是个非空引用。缺 command 且缺 handler
          // 对 JSON 配置是 error（command 型 hook 必须给 command）。
          if (JSON_HOOK_KINDS.includes('command') && !h.command) {
            errors.push(
              `${label}: command-type hook requires a non-empty "command" string`
            );
          }
        }
      }
      // pattern 若给，必须可编译为 RegExp。
      if (h.pattern !== undefined) {
        try {
          new RegExp(h.pattern);
        } catch (err) {
          errors.push(`${label}: pattern is not a valid RegExp: ${err.message}`);
        }
      }
      // timeout 若给，必须正数。
      if (h.timeout !== undefined && (typeof h.timeout !== 'number' || h.timeout <= 0)) {
        errors.push(`${label}: timeout must be a positive number`);
      }
      // priority 若给，必须非负整数。
      if (
        h.priority !== undefined &&
        (!Number.isInteger(h.priority) || h.priority < 0)
      ) {
        errors.push(`${label}: priority must be a non-negative integer`);
      }
      // enabled 若给，必须布尔。
      if (h.enabled !== undefined && typeof h.enabled !== 'boolean') {
        errors.push(`${label}: enabled must be a boolean`);
      }
    });
  }

  // disabled 数组元素必须字符串。
  if (!Array.isArray(disabledArray)) {
    errors.push('disabled must be an array');
  } else {
    disabledArray.forEach((d, i) => {
      if (typeof d !== 'string') {
        errors.push(`disabled[${i}]: must be a string`);
      }
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * 校验并归一化一个 hook 元素，返回「合 schema 的形状」或 null。
 * 与 `hookRegistry._register` 的消费形状对齐：event/type/command/handler/
 * pattern/timeout/priority/source。
 *
 * @param {*} hookDef - 一个 hook 元素
 * @returns {object|null} 归一后的 hook（合 schema），或 null（不合）
 */
function normalizeHook(hookDef) {
  const check = validateHooksConfig({ hooks: [hookDef] });
  if (!check.valid) {
    return null;
  }
  return {
    event: hookDef.event,
    type: 'command',
    command: typeof hookDef.command === 'string' ? hookDef.command : null,
    handler: null,
    pattern: hookDef.pattern,
    timeout: typeof hookDef.timeout === 'number' ? hookDef.timeout : 10000,
    priority: Number.isInteger(hookDef.priority) ? hookDef.priority : 100,
    source: hookDef.source || 'config',
    enabled: hookDef.enabled !== false,
  };
}

module.exports = { validateHooksConfig, normalizeHook };
