/**
 * Channel Health composable.
 *
 * Subscribes to WebSocket 'channel_health' and 'channel_activity' events
 * and exposes reactive state for channel health indicator components.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'

export function useChannelHealth(wsService) {
  const channels = ref([])
  const activeAdapter = ref(null)
  const activity = ref([])

  const overallHealth = computed(() => {
    const list = channels.value
    if (!list || list.length === 0) return 'unknown'
    const statuses = list.map(c => c.status)
    if (statuses.every(s => s === 'healthy')) return 'healthy'
    if (statuses.every(s => s === 'cooldown')) return 'critical'
    return 'degraded'
  })

  const healthyCount = computed(() => channels.value.filter(c => c.status === 'healthy').length)
  const totalCount = computed(() => channels.value.length)

  // Ring buffer of last 20 activity events
  function pushActivity(entry) {
    activity.value = [...activity.value.slice(-19), entry]
  }

  function handleHealthEvent(data) {
    if (data && Array.isArray(data.adapters)) {
      channels.value = data.adapters
    }
  }

  function handleActivityEvent(data) {
    if (data && data.adapter) {
      pushActivity(data)
      if (data.event === 'attempt') {
        activeAdapter.value = data.adapter
      }
    }
  }

  let offHealth = null
  let offActivity = null

  onMounted(() => {
    if (wsService && typeof wsService.on === 'function') {
      offHealth = wsService.on('channel_health', handleHealthEvent)
      offActivity = wsService.on('channel_activity', handleActivityEvent)
    }
  })

  onUnmounted(() => {
    if (typeof offHealth === 'function') offHealth()
    if (typeof offActivity === 'function') offActivity()
  })

  return {
    channels,
    activeAdapter,
    activity,
    overallHealth,
    healthyCount,
    totalCount,
  }
}
