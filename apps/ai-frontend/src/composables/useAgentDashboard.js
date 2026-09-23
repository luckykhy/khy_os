import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue';
import request from '@/api/request';

// Agent dashboard polling with backoff, shared by /admin/overview and /agents.
//
// Before this extraction the logic lived inline in AgentDashboard.vue, so the
// overview page could not reuse it without copying a 30-line state machine.
// The backoff is the part that must not drift: a fixed 5s poll against a dead
// backend used to spam the global error toast, which is why failures escalate
// 5s -> 10s -> 20s ... capped at 60s, and stop after MAX_FAILURES consecutive
// misses in favour of a visible degraded banner with a manual retry.
const BASE_INTERVAL = 5000;
const MAX_INTERVAL = 60000;
const MAX_FAILURES = 3;

export function useAgentDashboard({ auto = ref(true) } = {}) {
  const dashboard = ref({ agents: [], tree: [], stats: {} });
  const loading = ref(false);
  const degraded = ref(false);
  const failures = ref(0);

  let timer = null;

  const agents = computed(() => dashboard.value.agents || []);
  const tree = computed(() => dashboard.value.tree || []);
  const stats = computed(() => dashboard.value.stats || {});

  const statCards = computed(() => {
    const s = stats.value;
    return [
      { label: '总计', value: s.total || 0, color: 'var(--khy-primary)' },
      { label: '运行中', value: s.running || 0, color: 'var(--khy-warning)' },
      { label: '已完成', value: s.completed || 0, color: 'var(--khy-success)' },
      { label: '失败', value: s.failed || 0, color: 'var(--khy-danger)' },
    ];
  });

  function statusTagType(status) {
    const map = { running: 'warning', completed: 'success', failed: 'danger', idle: 'info' };
    return map[status] || 'info';
  }

  function formatMs(ms) {
    if (!ms || ms <= 0) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // Backed-off next tick: back to the base interval on success, 2^n growth
  // capped at 60s on failure.
  function scheduleNext() {
    if (!auto.value || degraded.value) return;
    const n = failures.value;
    const delay = n > 0 ? Math.min(BASE_INTERVAL * 2 ** n, MAX_INTERVAL) : BASE_INTERVAL;
    clearTimer();
    timer = setTimeout(fetchDashboard, delay);
  }

  async function fetchDashboard() {
    loading.value = true;
    try {
      // silent: polling has its own degraded banner, the global interceptor's
      // toast would fire every tick.
      const res = await request.get('/api/ai-gateway-admin/agents/dashboard', {
        silent: true,
      });
      const data = res?.data?.data || res?.data || res;
      if (data && typeof data === 'object') {
        dashboard.value = data;
      }
      failures.value = 0;
      degraded.value = false;
    } catch {
      failures.value += 1;
      if (failures.value >= MAX_FAILURES) {
        degraded.value = true;
        clearTimer();
      }
    } finally {
      loading.value = false;
      scheduleNext();
    }
  }

  // Manual refresh / retry: reset the backoff state and pull immediately.
  function manualRefresh() {
    failures.value = 0;
    degraded.value = false;
    clearTimer();
    fetchDashboard();
  }

  function toggleAuto(val) {
    if (val) {
      failures.value = 0;
      degraded.value = false;
      fetchDashboard();
    } else {
      clearTimer();
    }
  }

  function stop() {
    clearTimer();
  }

  onMounted(fetchDashboard);

  onActivated(() => {
    // keep-alive: resume polling when the tab becomes visible again.
    if (auto.value && !degraded.value && !timer) fetchDashboard();
  });
  onDeactivated(stop);
  onUnmounted(stop);

  return {
    dashboard,
    agents,
    tree,
    stats,
    statCards,
    loading,
    degraded,
    fetchDashboard,
    manualRefresh,
    toggleAuto,
    stop,
    statusTagType,
    formatMs,
  };
}
