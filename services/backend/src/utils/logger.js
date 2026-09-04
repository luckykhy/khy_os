'use strict';

/**
 * logger.js — 轻量级统一日志工具
 *
 * 替代 console.log/info/warn/error 的直接调用
 * 特性：
 *   - 日志级别控制（silent/error/warn/info/debug）
 *   - 时间戳
 *   - 敏感信息自动脱敏
 *   - 生产环境可关闭
 *
 * 使用方式：
 *   const logger = require('./logger');
 *   logger.info('message');
 *   logger.error('error', { details });
 */

const LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const CURRENT_LEVEL = LEVELS[process.env.KHY_LOG_LEVEL] ?? LEVELS.info;

// 敏感字段列表
const SENSITIVE_FIELDS = [
  'password', 'secret', 'token', 'apikey', 'api_key', 'key',
  'authorization', 'auth', 'credential', 'private', 'sk-',
];

/**
 * 脱敏处理
 */
function sanitize(data) {
  if (!data || typeof data !== 'object') return data;
  const result = Array.isArray(data) ? [...data] : { ...data };
  for (const key of Object.keys(result)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_FIELDS.some(f => lower.includes(f))) {
      const val = String(result[key]);
      result[key] = val.length > 8 ? val.slice(0, 4) + '****' + val.slice(-4) : '****';
    } else if (typeof result[key] === 'object' && result[key] !== null) {
      result[key] = sanitize(result[key]);
    }
  }
  return result;
}

/**
 * 格式化日志行
 */
function format(level, message, details) {
  const timestamp = new Date().toISOString();
  const levelTag = level.toUpperCase().padEnd(5);
  const prefix = `[${timestamp}] ${levelTag}`;
  
  let line = `${prefix} ${message}`;
  
  if (details !== undefined) {
    try {
      const sanitized = sanitize(details);
      const detailStr = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
      if (detailStr && detailStr !== '{}') {
        line += ` ${detailStr}`;
      }
    } catch {
      // ignore serialization errors
    }
  }
  
  return line;
}

function error(message, details) {
  if (CURRENT_LEVEL >= LEVELS.error) {
    console.error(format('error', message, details));
  }
}

function warn(message, details) {
  if (CURRENT_LEVEL >= LEVELS.warn) {
    console.warn(format('warn', message, details));
  }
}

function info(message, details) {
  if (CURRENT_LEVEL >= LEVELS.info) {
    console.info(format('info', message, details));
  }
}

function debug(message, details) {
  if (CURRENT_LEVEL >= LEVELS.debug) {
    console.log(format('debug', message, details));
  }
}

module.exports = {
  error,
  warn,
  info,
  debug,
  LEVELS,
};
