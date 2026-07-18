'use strict';

/**
 * langPreference.js — 输出语言偏好「归一·描述·解析」的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;env 经入参注入(env 覆盖留给调用方)。
 *
 * 背后的逻辑(对齐 Claude Code /lang 的 preferredLanguage):/lang 命令面只是薄壳,
 * 真正决定「模型用哪种语言回复」的是这里的归一与解析 —— 它与 config.js 的
 * `_normalizeLanguagePreference`(历史实现)收敛为同一真源,且与 prompts.js
 * `getLanguageSection(KHY_LANGUAGE)` 的注入点对齐:
 *   - normalizeLanguage(raw) → 'auto' | 'Chinese' | 'English' | ''(无法识别)
 *       'auto' 语义 = 不写 KHY_LANGUAGE 覆盖、跟随用户输入(中文优先默认)。
 *   - describeLanguage(pref) → 给用户看的中文标签(纯展示,绝不参与解析判定)。
 *   - resolveActive(env)     → { preference, source } 从注入的 env.KHY_LANGUAGE
 *       解析当前生效语言;未设 → auto(default)。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵
 * 依赖边(textHeuristics.js 同坑)。本叶子零依赖。
 */

// 归一别名表:小写、去空白/下划线/连字符后比对。与 config.js 历史行为逐字一致。
const _AUTO = new Set(['auto', 'default', 'follow', 'same']);
const _ZH = new Set(['zh', 'zhcn', 'cn', 'chinese', '中文', '中']);
const _EN = new Set(['en', 'enus', 'engb', 'english', '英文', '英语']);

/**
 * 归一语言偏好输入。
 * @param {string} raw
 * @returns {'auto'|'Chinese'|'English'|''} 无法识别返回空串(由调用方友好报错)。
 */
function normalizeLanguage(raw = '') {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return '';
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (_AUTO.has(normalized)) return 'auto';
  if (_ZH.has(normalized)) return 'Chinese';
  if (_EN.has(normalized)) return 'English';
  return '';
}

/**
 * 给用户看的语言标签(纯展示)。
 * @param {string} pref normalizeLanguage 的输出('auto'|'Chinese'|'English')
 * @returns {string}
 */
function describeLanguage(pref) {
  switch (pref) {
    case 'Chinese': return '中文';
    case 'English': return 'English';
    case 'auto': return '自动(跟随用户输入·中文优先)';
    default: return String(pref || '未设置');
  }
}

/**
 * 从注入的 env 解析当前生效的输出语言。零 IO。
 * @param {Record<string,string>} [env] 注入的环境(默认空对象,绝不直接读 process.env)。
 * @returns {{ preference: 'auto'|'Chinese'|'English', source: 'env'|'default' }}
 */
function resolveActive(env = {}) {
  const raw = env && env.KHY_LANGUAGE ? String(env.KHY_LANGUAGE).trim() : '';
  if (!raw) return { preference: 'auto', source: 'default' };
  const pref = normalizeLanguage(raw);
  // KHY_LANGUAGE 已是 prompts.js 写入的规范值('Chinese'/'English');无法归一时回退 auto。
  return { preference: pref || 'auto', source: 'env' };
}

module.exports = { normalizeLanguage, describeLanguage, resolveActive };
