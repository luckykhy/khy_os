'use strict';

/**
 * userFriendlyError.js — 用户友好错误包装器
 *
 * 将技术错误转换为用户可理解的错误消息
 * 特性：
 *   - 错误码体系
 *   - 用户友好消息
 *   - 修复建议
 *   - 中英文支持
 */

const ERROR_CODES = {
  // 网络错误
  EADDRINUSE: {
    code: 'NET_001',
    message: '端口已被占用',
    suggestion: '请关闭占用端口的程序，或更换端口',
  },
  ECONNREFUSED: {
    code: 'NET_002',
    message: '连接被拒绝',
    suggestion: '请检查服务是否已启动',
  },
  ETIMEDOUT: {
    code: 'NET_003',
    message: '连接超时',
    suggestion: '请检查网络连接，或稍后重试',
  },
  ENOTFOUND: {
    code: 'NET_004',
    message: '无法解析域名',
    suggestion: '请检查网络连接和 DNS 设置',
  },
  
  // 文件系统错误
  ENOENT: {
    code: 'FS_001',
    message: '文件或目录不存在',
    suggestion: '请检查路径是否正确',
  },
  EACCES: {
    code: 'FS_002',
    message: '权限不足',
    suggestion: '请检查文件权限，或以管理员身份运行',
  },
  EEXIST: {
    code: 'FS_003',
    message: '文件或目录已存在',
    suggestion: '请删除现有文件或更换路径',
  },
  ENOSPC: {
    code: 'FS_004',
    message: '磁盘空间不足',
    suggestion: '请释放磁盘空间后重试',
  },
  
  // 进程错误
  EPERM: {
    code: 'PROC_001',
    message: '操作不被允许',
    suggestion: '请检查进程权限',
  },
  EMFILE: {
    code: 'PROC_002',
    message: '打开的文件过多',
    suggestion: '请增加系统文件描述符限制',
  },
  
  // 配置错误
  CONFIG_MISSING: {
    code: 'CFG_001',
    message: '配置缺失',
    suggestion: '请运行 khy setup 初始化配置',
  },
  CONFIG_INVALID: {
    code: 'CFG_002',
    message: '配置无效',
    suggestion: '请检查配置文件格式',
  },
  
  // 认证错误
  AUTH_FAILED: {
    code: 'AUTH_001',
    message: '认证失败',
    suggestion: '请检查用户名和密码',
  },
  TOKEN_EXPIRED: {
    code: 'AUTH_002',
    message: '登录已过期',
    suggestion: '请重新登录',
  },
};

/**
 * 包装错误对象
 */
function wrapError(err, context = '') {
  if (!err) return null;
  
  const code = err.code;
  const known = ERROR_CODES[code];
  
  if (known) {
    return {
      code: known.code,
      message: known.message,
      suggestion: known.suggestion,
      original: err.message,
      context,
    };
  }
  
  return {
    code: 'UNKNOWN',
    message: err.message || '未知错误',
    suggestion: '请查看日志获取详细信息',
    original: err.message,
    context,
  };
}

/**
 * 格式化错误输出
 */
function formatError(wrapped) {
  if (!wrapped) return '';
  
  const lines = [
    `❌ ${wrapped.message}`,
    `   错误码: ${wrapped.code}`,
  ];
  
  if (wrapped.context) {
    `   位置: ${wrapped.context}`,
  }
  
  lines.push(`   💡 ${wrapped.suggestion}`);
  
  if (wrapped.original && wrapped.original !== wrapped.message) {
    lines.push(`   详情: ${wrapped.original}`);
  }
  
  return lines.join('\n');
}

module.exports = {
  ERROR_CODES,
  wrapError,
  formatError,
};
