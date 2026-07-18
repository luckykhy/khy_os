import { ref } from 'vue'
import request from '@/api/request'
import { unwrap } from '@/api/unwrap'

const BASE = '/api/ai-gateway'

// Singleton state shared across views.
const logs = ref({ total: 0, limit: 50, offset: 0, items: [] })
const summary = ref({ groupBy: 'model', totals: {}, groups: [] })
const pricing = ref({ groups: {}, modelPricing: {}, updatedAt: null })
const rateLimits = ref({ buckets: [] })
const loading = ref(false)

/**
 * Composable for AI gateway usage / billing / pricing admin state.
 */
export function useGatewayBilling() {
  async function fetchLogs(params = {}) {
    try {
      loading.value = true
      const res = await request.get(`${BASE}/usage/logs`, { params })
      logs.value = unwrap(res) || { total: 0, items: [] }
      return logs.value
    } catch {
      return logs.value
    } finally {
      loading.value = false
    }
  }

  async function fetchSummary(params = {}) {
    try {
      const res = await request.get(`${BASE}/usage/summary`, { params })
      summary.value = unwrap(res) || { totals: {}, groups: [] }
      return summary.value
    } catch {
      return summary.value
    }
  }

  async function fetchCustomerUsage(customerId, params = {}) {
    try {
      const res = await request.get(`${BASE}/usage/customers/${customerId}`, { params })
      return unwrap(res)
    } catch {
      return null
    }
  }

  async function fetchPricing() {
    try {
      const res = await request.get(`${BASE}/pricing`)
      pricing.value = unwrap(res) || { groups: {}, modelPricing: {} }
      return pricing.value
    } catch {
      return pricing.value
    }
  }

  async function updatePricing(patch) {
    const res = await request.put(`${BASE}/pricing`, patch)
    pricing.value = unwrap(res) || pricing.value
    return pricing.value
  }

  async function fetchGroups() {
    try {
      const res = await request.get(`${BASE}/groups`)
      const data = unwrap(res)
      return data?.groups || {}
    } catch {
      return {}
    }
  }

  async function updateGroups(groups) {
    const res = await request.put(`${BASE}/groups`, { groups })
    const data = unwrap(res)
    if (data?.groups) pricing.value = { ...pricing.value, groups: data.groups }
    return data?.groups || {}
  }

  async function fetchRateLimits() {
    try {
      const res = await request.get(`${BASE}/rate-limits`)
      rateLimits.value = unwrap(res) || { buckets: [] }
      return rateLimits.value
    } catch {
      return rateLimits.value
    }
  }

  return {
    logs,
    summary,
    pricing,
    rateLimits,
    loading,
    fetchLogs,
    fetchSummary,
    fetchCustomerUsage,
    fetchPricing,
    updatePricing,
    fetchGroups,
    updateGroups,
    fetchRateLimits,
  }
}
