/**
 * Axios请求拦截器
 * 统一处理网络错误和后端连接失败
 */

import axios from 'axios';
import { ElMessage } from 'element-plus';
import networkMonitor from './networkMonitor';

// 错误计数器
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5; // 连续5个请求失败后返回启动界面

/**
 * 设置请求拦截器
 */
export function setupRequestInterceptor() {
  // 请求拦截器
  axios.interceptors.request.use(
    (config) => {
      // 添加时间戳防止缓存
      if (config.method === 'get') {
        config.params = {
          ...config.params,
          _t: Date.now()
        };
      }
      return config;
    },
    (error) => {
      console.error('❌ 请求配置错误:', error);
      return Promise.reject(error);
    }
  );

  // 响应拦截器
  axios.interceptors.response.use(
    (response) => {
      // 请求成功,重置错误计数
      consecutiveErrors = 0;
      return response;
    },
    (error) => {
      console.error('❌ 请求失败:', error);

      // 增加错误计数
      consecutiveErrors++;
      console.warn(`⚠️ 连续错误次数: ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}`);

      // 判断错误类型
      const errorType = getErrorType(error);
      const errorMessage = getErrorMessage(error, errorType);

      // 显示错误提示
      showErrorMessage(errorMessage, errorType);

      // 如果连续错误次数过多,返回启动界面
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error('❌ 连续请求失败次数过多,返回启动界面');
        networkMonitor.returnToSplash('前后端连接失败,请检查服务是否正常运行');
      }

      return Promise.reject(error);
    }
  );

  console.log('✅ Axios拦截器已设置');
}

/**
 * 获取错误类型
 */
function getErrorType(error) {
  if (!error.response) {
    // 网络错误或请求未发出
    if (error.code === 'ECONNABORTED') {
      return 'timeout';
    } else if (error.message === 'Network Error' || error.code === 'ERR_NETWORK') {
      return 'network';
    } else {
      return 'unknown';
    }
  } else {
    // 服务器返回错误状态码
    const status = error.response.status;
    if (status >= 500) {
      return 'server';
    } else if (status === 404) {
      return 'notfound';
    } else if (status === 401 || status === 403) {
      return 'auth';
    } else {
      return 'client';
    }
  }
}

/**
 * 获取错误消息
 */
function getErrorMessage(error, errorType) {
  const messages = {
    timeout: '请求超时,请检查网络连接',
    network: '网络连接失败,请检查后端服务是否运行',
    server: '服务器错误,请稍后重试',
    notfound: '请求的资源不存在',
    auth: '认证失败,请重新登录',
    client: '请求参数错误',
    unknown: '未知错误,请联系管理员'
  };

  // 如果有自定义错误消息,优先使用
  if (error.response && error.response.data && error.response.data.message) {
    return error.response.data.message;
  }

  return messages[errorType] || messages.unknown;
}

/**
 * 显示错误消息
 */
function showErrorMessage(message, errorType) {
  // 对于某些错误类型,不显示提示(避免过多弹窗)
  const silentErrors = ['auth']; // 认证错误由路由守卫处理
  
  if (silentErrors.includes(errorType)) {
    return;
  }

  // 根据错误类型选择提示样式
  const messageType = errorType === 'network' || errorType === 'timeout' ? 'error' : 'warning';

  ElMessage({
    message: message,
    type: messageType,
    duration: 3000,
    showClose: true
  });
}

/**
 * 重置错误计数
 */
export function resetErrorCount() {
  consecutiveErrors = 0;
  console.log('✅ 错误计数已重置');
}

export default {
  setupRequestInterceptor,
  resetErrorCount
};
