'use strict';

/**
 * safeJsonParse.js — 安全 JSON 解析工具
 *
 * 对抗式综合方案 C：工具函数 + CI 检测
 * 统一处理 JSON 解析异常，避免进程崩溃
 */

/**
 * 安全解析 JSON 字符串。
 * @param {string} text 要解析的 JSON 字符串
 * @param {*} [fallback=null] 解析失败时的回退值
 * @returns {*} 解析结果或 fallback
 */
function safeJsonParse(text, fallback = null) {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 安全解析 JSON 字符串（严格模式）。
 * 解析失败时抛出详细错误。
 * @param {string} text 要解析的 JSON 字符串
 * @returns {*} 解析结果
 * @throws {Error} 解析失败时抛出
 */
function strictJsonParse(text) {
  if (typeof text !== 'string') {
    throw new Error('Input must be a string');
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON parse error: ${err.message}`);
  }
}

/**
 * 安全解析 JSON 文件。
 * @param {string} filePath 文件路径
 * @param {*} [fallback=null] 解析失败时的回退值
 * @returns {*} 解析结果或 fallback
 */
function safeJsonParseFile(filePath, fallback = null) {
  const fs = require('fs');
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 安全序列化为 JSON 字符串。
 * @param {*} value 要序列化的值
 * @param {string} [fallback='{}'] 序列化失败时的回退值
 * @param {boolean} [pretty=false] 是否美化输出
 * @returns {string} JSON 字符串
 */
function safeJsonStringify(value, fallback = '{}', pretty = false) {
  try {
    return JSON.stringify(value, null, pretty ? 2 : undefined);
  } catch {
    return fallback;
  }
}

module.exports = {
  safeJsonParse,
  strictJsonParse,
  safeJsonParseFile,
  safeJsonStringify,
};
