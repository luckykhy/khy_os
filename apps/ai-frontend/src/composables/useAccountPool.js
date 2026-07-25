import { ref } from 'vue'
import request from '@/api/request'
import { unwrap } from '@/api/unwrap'

/**
 * Composable for Antigravity-style Account Pool management.
 */
export function useAccountPool() {
  const accounts = ref([])
  const scheduling = ref({})
  const circuitBreaker = ref({})
  const loading = ref(false)
  const watcher = ref({ running: false, watcherCount: 0, watchers: [], stats: {}, recentEvents: [] })

  async function fetchAccounts() {
    try {
      loading.value = true
      const res = await request.get('/api/ai-gateway/accounts')
      accounts.value = unwrap(res)
    } catch { /* ignore */ } finally { loading.value = false }
  }

  async function addAccount(data) {
    const res = await request.post('/api/ai-gateway/accounts', data)
    await fetchAccounts()
    return unwrap(res)
  }

  async function updateAccount(id, data) {
    const res = await request.put(`/api/ai-gateway/accounts/${id}`, data)
    await fetchAccounts()
    return unwrap(res)
  }

  async function removeAccount(id) {
    await request.delete(`/api/ai-gateway/accounts/${id}`)
    await fetchAccounts()
  }

  async function batchRemoveAccounts(ids) {
    const res = await request.post('/api/ai-gateway/accounts/batch-delete', { ids })
    await fetchAccounts()
    return unwrap(res)
  }

  async function removeAllAccounts(provider = '') {
    const payload = provider ? { all: true, provider } : { all: true }
    const res = await request.post('/api/ai-gateway/accounts/batch-delete', payload)
    await fetchAccounts()
    return unwrap(res)
  }

  async function enableAccount(id) {
    await request.post(`/api/ai-gateway/accounts/${id}/enable`)
    await fetchAccounts()
  }

  async function disableAccount(id) {
    await request.post(`/api/ai-gateway/accounts/${id}/disable`)
    await fetchAccounts()
  }

  async function fetchScheduling() {
    try {
      const res = await request.get('/api/ai-gateway/accounts/scheduling')
      scheduling.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function updateScheduling(config) {
    const res = await request.put('/api/ai-gateway/accounts/scheduling', config)
    scheduling.value = unwrap(res)
    return scheduling.value
  }

  async function fetchCircuitBreaker() {
    try {
      const res = await request.get('/api/ai-gateway/accounts/circuit-breaker')
      circuitBreaker.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function updateCircuitBreaker(config) {
    const res = await request.put('/api/ai-gateway/accounts/circuit-breaker', config)
    circuitBreaker.value = unwrap(res)
    return circuitBreaker.value
  }

  // ── Credential Watcher ──
  async function fetchWatcherStatus() {
    try {
      const res = await request.get('/api/ai-gateway/credential-watcher/status')
      watcher.value = unwrap(res) || watcher.value
    } catch { /* ignore */ }
  }

  async function startWatcher() {
    const res = await request.post('/api/ai-gateway/credential-watcher/start')
    const data = unwrap(res)
    if (data?.status) watcher.value = data.status
    else await fetchWatcherStatus()
    return data
  }

  async function stopWatcher() {
    await request.post('/api/ai-gateway/credential-watcher/stop')
    await fetchWatcherStatus()
  }

  async function triggerWatcherScan() {
    const res = await request.post('/api/ai-gateway/credential-watcher/scan')
    await Promise.all([fetchWatcherStatus(), fetchAccounts()])
    return unwrap(res)
  }

  async function fetchAll() {
    await Promise.all([fetchAccounts(), fetchScheduling(), fetchCircuitBreaker(), fetchWatcherStatus()])
  }

  return {
    accounts, scheduling, circuitBreaker, loading, watcher,
    fetchAccounts, addAccount, updateAccount, removeAccount,
    batchRemoveAccounts, removeAllAccounts,
    enableAccount, disableAccount,
    fetchScheduling, updateScheduling,
    fetchCircuitBreaker, updateCircuitBreaker,
    fetchWatcherStatus, startWatcher, stopWatcher, triggerWatcherScan,
    fetchAll,
  }
}
