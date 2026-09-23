import { ref } from 'vue';
import request from '@/api/request';
import { unwrap } from '@/api/unwrap';

/**
 * Turn a rejected fetch into a structured failure record for the caller.
 *
 * Carries data only (source / status / message) — user-facing wording is the
 * view layer's job, so the composable stays free of presentation semantics.
 * `message` mirrors the caller's existing extraction so nothing is lost.
 *
 * @param {string} source which source failed ('overview' | 'customers')
 * @param {*} err the rejection reason
 * @returns {{ source: string, status: number|undefined, message: string }}
 */
function toFailureRecord(source, err) {
  return {
    source,
    status: err?.response?.status,
    message: err?.response?.data?.error || err?.message || '未知错误',
  };
}

export function useAssetCustomer() {
  const overview = ref(null);
  const customers = ref([]);
  const loadingOverview = ref(false);
  const loadingCustomers = ref(false);

  async function fetchOverview() {
    try {
      loadingOverview.value = true;
      const res = await request.get('/api/ai-gateway/assets/overview');
      overview.value = unwrap(res);
      return overview.value;
    } finally {
      loadingOverview.value = false;
    }
  }

  async function fetchCustomers({ includeSecrets = false, model = '' } = {}) {
    try {
      loadingCustomers.value = true;
      const params = {};
      if (includeSecrets) params.includeSecrets = 'true';
      if (model) params.model = model;
      const res = await request.get('/api/ai-gateway/customers', { params });
      customers.value = unwrap(res);
      return customers.value;
    } finally {
      loadingCustomers.value = false;
    }
  }

  async function createCustomer(data) {
    const res = await request.post('/api/ai-gateway/customers', data);
    await fetchCustomers();
    return unwrap(res);
  }

  async function updateCustomer(id, data) {
    const res = await request.put(`/api/ai-gateway/customers/${id}`, data);
    await fetchCustomers();
    return unwrap(res);
  }

  async function enableCustomer(id) {
    await request.post(`/api/ai-gateway/customers/${id}/enable`);
    await fetchCustomers();
  }

  async function disableCustomer(id) {
    await request.post(`/api/ai-gateway/customers/${id}/disable`);
    await fetchCustomers();
  }

  async function issueToken(customerId, data = {}, options = {}) {
    const res = await request.post(`/api/ai-gateway/customers/${customerId}/tokens`, data);
    if (options.refresh !== false) {
      await fetchCustomers({ includeSecrets: true });
    }
    return unwrap(res);
  }

  async function rotateToken(customerId, tokenId, token = '') {
    const res = await request.post(
      `/api/ai-gateway/customers/${customerId}/tokens/${tokenId}/rotate`,
      { token }
    );
    await fetchCustomers({ includeSecrets: true });
    return unwrap(res);
  }

  async function enableToken(customerId, tokenId) {
    await request.post(`/api/ai-gateway/customers/${customerId}/tokens/${tokenId}/enable`);
    await fetchCustomers({ includeSecrets: true });
  }

  async function disableToken(customerId, tokenId) {
    await request.post(`/api/ai-gateway/customers/${customerId}/tokens/${tokenId}/disable`);
    await fetchCustomers({ includeSecrets: true });
  }

  async function deleteToken(customerId, tokenId) {
    await request.delete(`/api/ai-gateway/customers/${customerId}/tokens/${tokenId}`);
    await fetchCustomers({ includeSecrets: true });
  }

  /**
   * Refresh both panel sources in parallel.
   *
   * Customers is the PRIMARY source (the panel's main data, and the caller reads
   * `customers` right after awaiting this to auto-select the first row).
   * Overview is SECONDARY. A secondary failure must therefore degrade — it
   * records the failure instead of rejecting — otherwise one unreachable
   * endpoint would discard the primary's result AND the caller's post-refresh
   * side effect. A primary failure still rejects: swallowing it would leave an
   * empty customer panel with no error at all, which is worse than today.
   *
   * @param {{ includeSecrets?: boolean, model?: string }} [opts]
   * @returns {Promise<{ customers: *, overview: *, failed: Array<{source: string, status: number|undefined, message: string}> }>}
   */
  async function refreshAll({ includeSecrets = false, model = '' } = {}) {
    const [customersRes, overviewRes] = await Promise.allSettled([
      fetchCustomers({ includeSecrets, model }),
      fetchOverview(),
    ]);

    const failed = [];
    if (overviewRes.status === 'rejected') {
      failed.push(toFailureRecord('overview', overviewRes.reason));
    }
    if (customersRes.status === 'rejected') {
      failed.push(toFailureRecord('customers', customersRes.reason));
      throw customersRes.reason;
    }

    return {
      customers: customersRes.value,
      overview: overviewRes.value ?? null,
      failed,
    };
  }

  return {
    overview,
    customers,
    loadingOverview,
    loadingCustomers,
    fetchOverview,
    fetchCustomers,
    createCustomer,
    updateCustomer,
    enableCustomer,
    disableCustomer,
    issueToken,
    rotateToken,
    enableToken,
    disableToken,
    deleteToken,
    refreshAll,
  };
}
