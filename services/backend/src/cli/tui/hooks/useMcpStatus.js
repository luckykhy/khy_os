'use strict';

/**
 * useMcpStatus.js —— MCP 状态桥接 Hook
 *
 * 将 MCP 运行时状态桥接到 React 组件。
 * 轮询间隔由 ccTimers 控制。
 *
 * 参考：[DESIGN-ARCH-081] MCP 状态显示规范
 */

const React = require('react');
const { TIMING } = require('../utils/ccTimers');

/**
 * MCP 状态桥接 Hook
 * @param {object} options
 * @param {boolean} options.enabled - 是否启用轮询
 * @param {Function} options.getMcpServers - 获取 MCP 服务器列表的函数
 * @returns {{ servers: Array, loading: boolean, error: string|null }}
 */
function useMcpStatus({ enabled = true, getMcpServers } = {}) {
  const [servers, setServers] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);

  const fetchStatus = React.useCallback(async () => {
    if (!getMcpServers) return;
    setLoading(true);
    try {
      const result = await getMcpServers();
      setServers(result || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to fetch MCP status');
    } finally {
      setLoading(false);
    }
  }, [getMcpServers]);

  // 初始加载 + 轮询
  React.useEffect(() => {
    if (!enabled) return;

    fetchStatus();
    const timer = setInterval(fetchStatus, TIMING.mcp.interval);

    return () => clearInterval(timer);
  }, [enabled, fetchStatus]);

  return { servers, loading, error, refetch: fetchStatus };
}

module.exports = { useMcpStatus };
