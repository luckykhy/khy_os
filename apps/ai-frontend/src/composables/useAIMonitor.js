import { ref, onUnmounted } from 'vue'
import request from '@/api/request'
import { unwrap } from '@/api/unwrap'

/**
 * Composable for real-time AI Monitor SSE connection.
 */
export function useAIMonitor() {
  const traces = ref([])
  const stats = ref(null)
  const connected = ref(false)
  let eventSource = null
  let reconnectTimer = null
  let reconnectAttempts = 0
  const MAX_RECONNECT_ATTEMPTS = 10

  async function fetchStats() {
    try {
      const res = await request.get('/api/ai-gateway/monitor/stats')
      stats.value = unwrap(res)
    } catch { /* ignore */ }
  }

  async function fetchTraces(filter = {}) {
    try {
      const params = new URLSearchParams()
      if (filter.limit) params.set('limit', filter.limit)
      if (filter.offset) params.set('offset', filter.offset)
      if (filter.provider) params.set('provider', filter.provider)
      if (filter.success !== undefined && filter.success !== null && filter.success !== '') {
        params.set('success', String(filter.success))
      }
      if (filter.since) params.set('since', filter.since)
      const res = await request.get(`/api/ai-gateway/monitor/traces?${params}`)
      traces.value = unwrap(res).traces || []
    } catch { /* ignore */ }
  }

  function connectSSE() {
    if (eventSource) return
    clearTimeout(reconnectTimer)
    const baseUrl = request.defaults?.baseURL || ''
    eventSource = new EventSource(`${baseUrl}/api/ai-gateway/monitor/stream`)
    eventSource.onopen = () => {
      connected.value = true
      reconnectAttempts = 0
    }
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.id) {
          // Update or add trace
          const idx = traces.value.findIndex(t => t.id === data.id)
          if (idx >= 0) traces.value[idx] = data
          else traces.value.unshift(data)
          // Keep max 50
          if (traces.value.length > 50) traces.value.pop()
        }
      } catch { /* ignore */ }
    }
    eventSource.onerror = () => {
      connected.value = false
      // Close the broken connection and schedule a reconnect with exponential backoff
      if (eventSource) {
        eventSource.close()
        eventSource = null
      }
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts))
        reconnectAttempts++
        reconnectTimer = setTimeout(connectSSE, delay)
      }
    }
  }

  function disconnect() {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    reconnectAttempts = 0
    if (eventSource) {
      eventSource.close()
      eventSource = null
      connected.value = false
    }
  }

  onUnmounted(disconnect)

  return { traces, stats, connected, fetchStats, fetchTraces, connectSSE, disconnect }
}
