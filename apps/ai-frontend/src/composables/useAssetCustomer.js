import { ref } from 'vue'
import request from '@/api/request'
import { unwrap } from '@/api/unwrap'

export function useAssetCustomer() {
  const overview = ref(null)
  const customers = ref([])
  const loadingOverview = ref(false)
  const loadingCustomers = ref(false)

  async function fetchOverview() {
    try {
      loadingOverview.value = true
      const res = await request.get('/api/ai-gateway/assets/overview')
      overview.value = unwrap(res)
      return overview.value
    } finally {
      loadingOverview.value = false
    }
  }

  async function fetchCustomers({ includeSecrets = false, model = '' } = {}) {
    try {
      loadingCustomers.value = true
      const params = {}
      if (includeSecrets) params.includeSecrets = 'true'
      if (model) params.model = model
      const res = await request.get('/api/ai-gateway/customers', { params })
      customers.value = unwrap(res)
      return customers.value
    } finally {
      loadingCustomers.value = false
    }
  }

  async function createCustomer(data) {
    const res = await request.post('/api/ai-gateway/customers', data)
    await fetchCustomers()
    return unwrap(res)
  }

  async function updateCustomer(id, data) {
    const res = await request.put(`/api/ai-gateway/customers/${id}`, data)
    await fetchCustomers()
    return unwrap(res)
  }

  async function enableCustomer(id) {
    await request.post(`/api/ai-gateway/customers/${id}/enable`)
    await fetchCustomers()
  }

  async function disableCustomer(id) {
    await request.post(`/api/ai-gateway/customers/${id}/disable`)
    await fetchCustomers()
  }

  async function issueToken(customerId, data = {}, options = {}) {
    const res = await request.post(`/api/ai-gateway/customers/${customerId}/tokens`, data)
    if (options.refresh !== false) {
      await fetchCustomers({ includeSecrets: true })
    }
    return unwrap(res)
  }

  async function rotateToken(customerId, tokenId, token = '') {
    const res = await request.post(`/api/ai-gateway/customers/${customerId}/tokens/${tokenId}/rotate`, { token })
    await fetchCustomers({ includeSecrets: true })
    return unwrap(res)
  }

  async function enableToken(customerId, tokenId) {
    await request.post(`/api/ai-gateway/customers/${customerId}/tokens/${tokenId}/enable`)
    await fetchCustomers({ includeSecrets: true })
  }

  async function disableToken(customerId, tokenId) {
    await request.post(`/api/ai-gateway/customers/${customerId}/tokens/${tokenId}/disable`)
    await fetchCustomers({ includeSecrets: true })
  }

  async function deleteToken(customerId, tokenId) {
    await request.delete(`/api/ai-gateway/customers/${customerId}/tokens/${tokenId}`)
    await fetchCustomers({ includeSecrets: true })
  }

  async function refreshAll({ includeSecrets = false, model = '' } = {}) {
    await Promise.all([
      fetchOverview(),
      fetchCustomers({ includeSecrets, model }),
    ])
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
  }
}
