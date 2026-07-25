'use strict';

/**
 * toolParamNaming —— 纯叶子(pure leaf):工具参数命名统一(snake_case)的单一真源。
 *
 * 契约:零 IO(不碰 fs/网络/子进程)、确定性、单一真源(命名归一只在本文件)、
 * env 门控默认开(`KHY_TOOL_PARAM_NAMING`,仅 0/false/off/no 关闭即字节回退)、
 * fail-soft 绝不抛。
 *
 * 背景(经源码核实):暴露给模型的工具参数大小写风格混杂——既有 snake_case
 * (file_path / old_string),也有 camelCase(filePath / outputPath / maxCount)。
 * 这让模型难以记忆「同一概念到底叫什么」(P1#3 诉求)。本叶子做两件**互逆**的事,
 * 合起来对调用零风险:
 *
 *   1) canonicalizeDefs(defs)      —— 在「定义侧」把暴露出去的参数键统一成 snake_case,
 *                                     让模型只看到一种风格。仅做**大小写折叠**(camelCase
 *                                     → snake_case),绝不合并语义不同的词(prompt/text/
 *                                     content 各自单词,原样不动 → 零假阳性)。
 *   2) expandParamAliases(params)  —— 在「执行侧」把入参补全为 snake + camel 两种拼写,
 *                                     这样无论某个工具的 execute 读的是 file_path 还是
 *                                     filePath 都能取到值。即:定义侧改了展示拼写,执行侧
 *                                     原样还原工具期望的拼写 → 往返无损、能力零损失。
 *
 * 安全性:门控关 → 两个函数都原样返回(同引用,字节回退);无任何键需要改写时同样
 * 返回原对象(避免无谓克隆)。命名碰撞(同一对象里同时存在 filePath 与 file_path 两个
 * 不同键)时**保留原键不改写**,绝不互相覆盖丢数据。下划线开头的内部标记键
 * (如 `_autoRepairedFrom`)一律跳过。
 *
 * 注:path↔file_path 这类**跨词**别名仍由 claudeCompat.normalizeToolParams 的逐工具
 * 映射负责;本叶子只补「同词不同大小写」这一层,与之正交、叠加生效。
 */

function _enabled() {
  const v = String(process.env.KHY_TOOL_PARAM_NAMING || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** camelCase / PascalCase → snake_case(纯大小写折叠,已是 snake 的原样返回)。 */
function toSnakeCase(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // fooBar → foo_Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // HTTPServer → HTTP_Server
    .toLowerCase();
}

/** snake_case → camelCase(已是 camel/单词的原样返回)。 */
function toCamelCase(key) {
  return String(key).replace(/_+([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * 定义侧:把每个工具定义里暴露的参数键统一成 snake_case。
 * 只改 `parameters.properties` 的键与 `parameters.required` 数组;名字/别名/类型不动。
 *
 * @param {Array<object>} defs  形如 [{name, description, parameters:{type,properties,required}}]
 * @returns {Array<object>}     门控关 / 无改动 → 原数组(同引用)
 */
function canonicalizeDefs(defs) {
  if (!_enabled()) return defs;
  try {
    if (!Array.isArray(defs)) return defs;
    let anyChange = false;
    const out = defs.map((def) => {
      if (!def || typeof def !== 'object' || !def.parameters || typeof def.parameters !== 'object') {
        return def;
      }
      const props = def.parameters.properties;
      if (!props || typeof props !== 'object') return def;

      const origKeys = new Set(Object.keys(props));
      const newProps = {};
      const renameMap = {};
      let changed = false;
      for (const key of Object.keys(props)) {
        const snake = toSnakeCase(key);
        // 碰撞:目标 snake 已作为另一个原始键存在 → 保留原键,绝不覆盖丢数据。
        if (snake !== key && origKeys.has(snake)) {
          newProps[key] = props[key];
          renameMap[key] = key;
          continue;
        }
        renameMap[key] = snake;
        if (snake !== key) changed = true;
        newProps[snake] = props[key];
      }
      if (!changed) return def;
      anyChange = true;

      const required = Array.isArray(def.parameters.required)
        ? def.parameters.required.map((k) => (Object.prototype.hasOwnProperty.call(renameMap, k) ? renameMap[k] : toSnakeCase(k)))
        : def.parameters.required;

      return {
        ...def,
        parameters: { ...def.parameters, properties: newProps, required },
      };
    });
    return anyChange ? out : defs;
  } catch {
    return defs; // fail-soft
  }
}

/**
 * 执行侧:把入参补全为 snake + camel 两种拼写(只填缺失,不覆盖既有)。
 * 这样定义侧统一成 snake 后,读取 camelCase 的旧工具仍能取到值。
 *
 * @param {object} params
 * @returns {object}  门控关 / 无新增 → 原对象(同引用)
 */
function expandParamAliases(params) {
  if (!_enabled()) return params;
  try {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
    let out = null; // 惰性克隆:有新增才克隆
    for (const key of Object.keys(params)) {
      if (key.startsWith('_')) continue; // 内部标记键(_autoRepairedFrom 等)
      const variants = [toSnakeCase(key), toCamelCase(key)];
      for (const variant of variants) {
        if (variant === key) continue;
        if (variant in params) continue; // 既有(含原对象里另一个真实键)→ 不动
        if (out && variant in out) continue;
        if (!out) out = { ...params };
        out[variant] = params[key];
      }
    }
    return out || params;
  } catch {
    return params; // fail-soft
  }
}

module.exports = {
  toSnakeCase,
  toCamelCase,
  canonicalizeDefs,
  expandParamAliases,
  _enabled,
};
