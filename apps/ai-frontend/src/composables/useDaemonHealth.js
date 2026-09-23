import { ref, onMounted, onUnmounted } from 'vue';
import request from '@/api/request';

/**
 * Daemon health monitor — keeps the khychat daemon alive as long as this
 * page is open, and auto-restarts it if it crashes.
 *
 * Mechanism:
 *   - Every KEEPALIVE_INTERVAL_MS, POST /api/daemon/keepalive to refresh the
 *     daemon's last-activity timestamp (prevents the 30-min WS idle timeout).
 *   - Every HEALTH_CHECK_INTERVAL_MS, GET /api/daemon/status to verify the
 *     daemon is still running.
 *   - On health-check failure, POST /api/daemon/ensure to restart the daemon.
 *   - Exposes reactive `connectionStatus` for UI indicators.
 *
 * States: 'checking' → 'connected' | 'reconnecting' | 'disconnected'
 */

const KEEPALIVE_INTERVAL_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const MAX_RESTART_ATTEMPTS = 3;

export function useDaemonHealth() {
  const connectionStatus = ref('checking');
  const daemonState = ref(null);
  const lastCheckedAt = ref(0);
  const reconnectAttempts = ref(0);

  let _keepaliveTimer = null;
  let _healthTimer = null;
  let _stopping = false;

  async function _doKeepalive() {
    if (_stopping) return;
    try {
      const res = await request.post('/api/daemon/keepalive');
      const data = res.data || {};
      daemonState.value = data.state || null;
      lastCheckedAt.value = Date.now();
      if (connectionStatus.value === 'disconnected') {
        connectionStatus.value = 'connected';
        reconnectAttempts.value = 0;
      }
    } catch {
      if (connectionStatus.value !== 'disconnected') {
        connectionStatus.value = 'disconnected';
      }
      await _tryRestart();
    }
  }

  async function _tryRestart() {
    if (_stopping) return;
    if (reconnectAttempts.value >= MAX_RESTART_ATTEMPTS) return;
    reconnectAttempts.value += 1;
    connectionStatus.value = 'reconnecting';
    try {
      const res = await request.post('/api/daemon/ensure');
      const data = res.data || {};
      if (data.state === 'running' || data.state === 'skipped') {
        daemonState.value = data.state;
        lastCheckedAt.value = Date.now();
        connectionStatus.value = 'connected';
        reconnectAttempts.value = 0;
      } else {
        connectionStatus.value = 'disconnected';
      }
    } catch {
      connectionStatus.value = 'disconnected';
    }
  }

  function _startTimers() {
    if (_stopping) return;
    _keepaliveTimer = setInterval(_doKeepalive, KEEPALIVE_INTERVAL_MS);
    _healthTimer = setInterval(_doKeepalive, HEALTH_CHECK_INTERVAL_MS);
  }

  function _stopTimers() {
    if (_keepaliveTimer) {
      clearInterval(_keepaliveTimer);
      _keepaliveTimer = null;
    }
    if (_healthTimer) {
      clearInterval(_healthTimer);
      _healthTimer = null;
    }
  }

  onMounted(() => {
    _stopping = false;
    _doKeepalive();
    _startTimers();
  });

  onUnmounted(() => {
    _stopping = true;
    _stopTimers();
  });

  return {
    connectionStatus,
    daemonState,
    lastCheckedAt,
    reconnectAttempts,
  };
}
