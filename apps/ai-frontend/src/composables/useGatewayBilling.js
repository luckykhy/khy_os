import { ref } from 'vue';
import request from '@/api/request';
import { unwrap } from '@/api/unwrap';
import { useLoadError, describeLoadError } from '@/api/loadError';

const BASE = '/api/ai-gateway';

// Singleton state shared across views.
const logs = ref({ total: 0, limit: 50, offset: 0, items: [] });
const summary = ref({ groupBy: 'model', totals: {}, groups: [] });
const pricing = ref({ groups: {}, modelPricing: {}, updatedAt: null });
const rateLimits = ref({ buckets: [] });
const loading = ref(false);

// Every failure below used to resolve to an empty default, which is why
// /usage and /pricing rendered as blank tables. The view renders this ref as an
// error state instead of guessing whether the data is empty or the endpoint is
// missing.
const loadError = useLoadError();

function recordFailure(subject, err, fix) {
  loadError.value = describeLoadError(err, subject, fix);
}

/**
 * Composable for AI gateway usage / billing / pricing admin state.
 */
export function useGatewayBilling() {
  async function fetchLogs(params = {}) {
    loadError.value = '';
    try {
      loading.value = true;
      const res = await request.get(`${BASE}/usage/logs`, { params });
      logs.value = unwrap(res) || { total: 0, items: [] };
      return logs.value;
    } catch (err) {
      recordFailure('用量日志', err);
      return logs.value;
    } finally {
      loading.value = false;
    }
  }

  async function fetchSummary(params = {}) {
    loadError.value = '';
    try {
      const res = await request.get(`${BASE}/usage/summary`, { params });
      summary.value = unwrap(res) || { totals: {}, groups: [] };
      return summary.value;
    } catch (err) {
      recordFailure('用量汇总', err);
      return summary.value;
    }
  }

  async function fetchCustomerUsage(customerId, params = {}) {
    loadError.value = '';
    try {
      const res = await request.get(`${BASE}/usage/customers/${customerId}`, { params });
      return unwrap(res);
    } catch (err) {
      recordFailure('客户用量', err);
      return null;
    }
  }

  async function fetchPricing() {
    loadError.value = '';
    try {
      const res = await request.get(`${BASE}/pricing`);
      pricing.value = unwrap(res) || { groups: {}, modelPricing: {} };
      return pricing.value;
    } catch (err) {
      recordFailure('模型定价', err);
      return pricing.value;
    }
  }

  async function updatePricing(patch) {
    const res = await request.put(`${BASE}/pricing`, patch);
    pricing.value = unwrap(res) || pricing.value;
    return pricing.value;
  }

  async function fetchGroups() {
    loadError.value = '';
    try {
      const res = await request.get(`${BASE}/groups`);
      const data = unwrap(res);
      return data?.groups || {};
    } catch (err) {
      recordFailure('分组配置', err);
      return {};
    }
  }

  async function updateGroups(groups) {
    const res = await request.put(`${BASE}/groups`, { groups });
    const data = unwrap(res);
    if (data?.groups) pricing.value = { ...pricing.value, groups: data.groups };
    return data?.groups || {};
  }

  async function fetchRateLimits() {
    loadError.value = '';
    try {
      const res = await request.get(`${BASE}/rate-limits`);
      rateLimits.value = unwrap(res) || { buckets: [] };
      return rateLimits.value;
    } catch (err) {
      recordFailure('限流配置', err);
      return rateLimits.value;
    }
  }

  return {
    logs,
    summary,
    pricing,
    rateLimits,
    loading,
    loadError,
    fetchLogs,
    fetchSummary,
    fetchCustomerUsage,
    fetchPricing,
    updatePricing,
    fetchGroups,
    updateGroups,
    fetchRateLimits,
  };
}
