import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getApiBaseUrl } from '@/config/api'
import { getHandoverSnapshot } from '@/api/largeTasks'

const HANDOVER_SSE_REFRESH_DEBOUNCE_MS = 800
const HANDOVER_SSE_RECONNECT_BASE_MS = 1000
const HANDOVER_SSE_RECONNECT_MAX_MS = 15000
const HANDOVER_SSE_BASELINE_REFRESH_MS = 60_000
const HANDOVER_SSE_CHANNELS = Object.freeze([
  {
    key: 'task',
    path: '/large-tasks/events/stream',
    params: {
      watch: 1,
      limit: 20
    },
    updateEvents: new Set(['task_event'])
  },
  {
    key: 'approval',
    path: '/large-tasks/retry-policy/approvals/stream',
    params: {
      watch: 1,
      limit: 20
    },
    updateEvents: new Set(['retry_policy_approval_event'])
  },
  {
    key: 'retention',
    path: '/large-tasks/retry-policy/approvals/retention/stream',
    params: {
      watch: 1,
      limit: 20
    },
    updateEvents: new Set(['retry_policy_approval_retention_event'])
  }
])

const EMPTY_HANDOVER_SUMMARY = Object.freeze({
  recent_operation_count: 0,
  retention_policy_change_count: 0,
  active_large_task_count: 0,
  pending_todo_count: 0,
  pending_remote_approval_count: 0,
  active_remote_session_count: 0,
  queue_depth: 0
})

export function useDashboardHandover() {
  const handoverLoading = ref(false)
  const handoverError = ref('')
  const handoverSnapshot = ref(null)
  const handoverRealtimeChannelState = ref({
    task: 'idle',
    approval: 'idle',
    retention: 'idle'
  })
  const handoverRealtimeLastEventAt = ref('')
  const handoverRealtimeLastError = ref('')
  const handoverRealtimeRunning = ref(false)

  let handoverSseRefreshTimer = null
  let handoverSsePendingRefresh = false
  let handoverSseStopped = false
  let handoverSseBaselineTimer = null
  const handoverSseControllers = new Map()
  const handoverSseReconnectTimers = new Map()
  const handoverSseReconnectAttempts = new Map()

  const handoverSummary = computed(() => {
    const summary = handoverSnapshot.value?.summary
    if (!summary || typeof summary !== 'object') {
      return EMPTY_HANDOVER_SUMMARY
    }

    return {
      ...EMPTY_HANDOVER_SUMMARY,
      ...summary
    }
  })

  const recentRetentionChanges = computed(() => {
    const changes = handoverSnapshot.value?.recent_retry_policy_approval_retention_changes
    if (!Array.isArray(changes)) return []
    return changes.slice(0, 5)
  })

  const handoverRealtimeTotalChannels = HANDOVER_SSE_CHANNELS.length

  const handoverRealtimeConnectedChannels = computed(() => (
    Object.values(handoverRealtimeChannelState.value).filter((item) => item === 'connected').length
  ))

  const handoverRealtimeTagType = computed(() => {
    if (!handoverRealtimeRunning.value) return 'info'
    if (handoverRealtimeConnectedChannels.value === handoverRealtimeTotalChannels) return 'success'
    if (handoverRealtimeConnectedChannels.value > 0) return 'warning'
    return 'danger'
  })

  const handoverRealtimeTagText = computed(() => {
    if (!handoverRealtimeRunning.value) return 'SSE 未启动'
    return `SSE ${handoverRealtimeConnectedChannels.value}/${handoverRealtimeTotalChannels}`
  })

  const loadHandoverSnapshot = async (showSuccessMessage = false, options = {}) => {
    const trigger = options?.trigger || 'manual'
    if (handoverLoading.value) {
      if (options?.allowQueue !== false) {
        handoverSsePendingRefresh = true
      }
      return
    }

    try {
      handoverLoading.value = true
      handoverError.value = ''
      const response = await getHandoverSnapshot({
        window_minutes: 60,
        operation_limit: 5,
        retention_limit: 5,
        running_limit: 20,
        todo_limit: 10,
        approval_limit: 10,
        session_limit: 10
      })

      if (!response?.success || !response?.data?.snapshot) {
        throw new Error(response?.message || '读取跨设备交接快照失败')
      }

      handoverSnapshot.value = response.data.snapshot
      if (trigger === 'sse') {
        console.log('🔄 已根据 SSE 事件刷新交接快照')
      }
      if (showSuccessMessage) {
        ElMessage.success('跨设备交接快照已刷新：任务、审批与保留策略状态已更新')
      }
    } catch (error) {
      console.error('加载跨设备交接快照失败:', error)
      handoverError.value = error?.response?.data?.message || error?.message || '读取跨设备交接快照失败'
      if (showSuccessMessage) {
        ElMessage.error(`刷新交接快照失败：${handoverError.value}`)
      }
    } finally {
      handoverLoading.value = false
      if (handoverSsePendingRefresh) {
        handoverSsePendingRefresh = false
        loadHandoverSnapshot(false, {
          trigger: 'queued_refresh',
          allowQueue: false
        })
      }
    }
  }

  const setHandoverRealtimeChannelState = (channelKey, state) => {
    handoverRealtimeChannelState.value = {
      ...handoverRealtimeChannelState.value,
      [channelKey]: state
    }
  }

  const clearHandoverSseRefreshTimer = () => {
    if (handoverSseRefreshTimer) {
      clearTimeout(handoverSseRefreshTimer)
      handoverSseRefreshTimer = null
    }
  }

  const clearHandoverSseBaselineTimer = () => {
    if (handoverSseBaselineTimer) {
      clearInterval(handoverSseBaselineTimer)
      handoverSseBaselineTimer = null
    }
  }

  const scheduleHandoverSnapshotRefresh = (source = 'sse') => {
    clearHandoverSseRefreshTimer()
    handoverSseRefreshTimer = setTimeout(() => {
      handoverSseRefreshTimer = null
      loadHandoverSnapshot(false, {
        trigger: source,
        allowQueue: true
      })
    }, HANDOVER_SSE_REFRESH_DEBOUNCE_MS)
  }

  const parseSseFrame = (rawFrame) => {
    const lines = String(rawFrame || '')
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))

    let eventName = 'message'
    let eventId = ''
    const dataLines = []

    for (const line of lines) {
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || 'message'
        continue
      }
      if (line.startsWith('id:')) {
        eventId = line.slice(3).trim()
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    let payload = null
    if (dataLines.length > 0) {
      const rawData = dataLines.join('\n')
      try {
        payload = JSON.parse(rawData)
      } catch {
        payload = rawData
      }
    }

    return {
      eventName,
      eventId,
      payload
    }
  }

  const handleHandoverSseFrame = (channel, frame) => {
    const parsed = parseSseFrame(frame)
    if (!parsed) return

    if (parsed.eventName === 'ready') {
      setHandoverRealtimeChannelState(channel.key, 'connected')
      return
    }

    if (parsed.eventName === 'error' || parsed.eventName === 'done') {
      return
    }

    if (!channel.updateEvents.has(parsed.eventName)) {
      return
    }

    handoverRealtimeLastEventAt.value = new Date().toISOString()
    scheduleHandoverSnapshotRefresh(`${channel.key}:${parsed.eventName}`)
  }

  const getHandoverSseAuthToken = () => {
    const token = localStorage.getItem('token')
    if (!token) return ''
    return String(token).replace(/^Bearer\s+/i, '').trim()
  }

  const buildHandoverSseUrl = (channel) => {
    const query = new URLSearchParams()
    Object.entries(channel.params || {}).forEach(([key, value]) => {
      query.set(key, String(value))
    })
    const suffix = query.toString()
    return `${getApiBaseUrl()}${channel.path}${suffix ? `?${suffix}` : ''}`
  }

  const clearHandoverSseReconnectTimer = (channelKey) => {
    const timer = handoverSseReconnectTimers.get(channelKey)
    if (timer) {
      clearTimeout(timer)
      handoverSseReconnectTimers.delete(channelKey)
    }
  }

  const closeHandoverSseChannel = (channelKey) => {
    const controller = handoverSseControllers.get(channelKey)
    if (controller) {
      controller.abort()
      handoverSseControllers.delete(channelKey)
    }
  }

  const scheduleHandoverSseReconnect = (channel) => {
    if (handoverSseStopped) return
    clearHandoverSseReconnectTimer(channel.key)

    const previousAttempts = handoverSseReconnectAttempts.get(channel.key) || 0
    const nextAttempts = previousAttempts + 1
    handoverSseReconnectAttempts.set(channel.key, nextAttempts)

    const delay = Math.min(
      HANDOVER_SSE_RECONNECT_BASE_MS * (2 ** Math.max(0, nextAttempts - 1)),
      HANDOVER_SSE_RECONNECT_MAX_MS
    )

    const timer = setTimeout(() => {
      handoverSseReconnectTimers.delete(channel.key)
      startHandoverSseChannel(channel)
    }, delay)

    handoverSseReconnectTimers.set(channel.key, timer)
  }

  const startHandoverSseChannel = async (channel) => {
    if (handoverSseStopped) return

    closeHandoverSseChannel(channel.key)
    setHandoverRealtimeChannelState(channel.key, 'connecting')

    const authToken = getHandoverSseAuthToken()
    if (!authToken) {
      setHandoverRealtimeChannelState(channel.key, 'idle')
      handoverRealtimeLastError.value = '未检测到登录令牌，SSE 实时同步未启动'
      return
    }

    const controller = new AbortController()
    handoverSseControllers.set(channel.key, controller)

    const headers = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${authToken}`
    }

    try {
      const response = await fetch(buildHandoverSseUrl(channel), {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store'
      })

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          const authError = new Error(`SSE 通道 ${channel.key} 认证失败 (HTTP ${response.status})`)
          authError.code = 'sse_auth_failed'
          throw authError
        }
        throw new Error(`SSE 通道 ${channel.key} 返回 HTTP ${response.status}`)
      }

      if (!response.body) {
        throw new Error(`SSE 通道 ${channel.key} 未返回可读流`)
      }

      setHandoverRealtimeChannelState(channel.key, 'connected')
      handoverRealtimeLastError.value = ''
      handoverSseReconnectAttempts.set(channel.key, 0)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!handoverSseStopped) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const frames = buffer.split('\n\n')
        buffer = frames.pop() || ''

        for (const frame of frames) {
          handleHandoverSseFrame(channel, frame)
        }
      }

      if (buffer.trim()) {
        handleHandoverSseFrame(channel, buffer)
      }

      if (!handoverSseStopped && !controller.signal.aborted) {
        setHandoverRealtimeChannelState(channel.key, 'disconnected')
        scheduleHandoverSseReconnect(channel)
      }
    } catch (error) {
      if (controller.signal.aborted || handoverSseStopped) {
        return
      }

      console.error(`交接快照 SSE 通道 ${channel.key} 连接失败:`, error)
      handoverRealtimeLastError.value = error?.message || `SSE 通道 ${channel.key} 连接失败`
      setHandoverRealtimeChannelState(channel.key, 'error')
      if (error?.code === 'sse_auth_failed') {
        return
      }
      scheduleHandoverSseReconnect(channel)
    }
  }

  const startHandoverSseSync = () => {
    handoverSseStopped = false
    handoverRealtimeRunning.value = true
    clearHandoverSseBaselineTimer()
    handoverSseBaselineTimer = setInterval(() => {
      loadHandoverSnapshot(false, {
        trigger: 'baseline_timer',
        allowQueue: true
      })
    }, HANDOVER_SSE_BASELINE_REFRESH_MS)
    HANDOVER_SSE_CHANNELS.forEach((channel) => {
      startHandoverSseChannel(channel)
    })
  }

  const stopHandoverSseSync = () => {
    handoverSseStopped = true
    handoverRealtimeRunning.value = false
    handoverSsePendingRefresh = false
    clearHandoverSseRefreshTimer()
    clearHandoverSseBaselineTimer()
    HANDOVER_SSE_CHANNELS.forEach((channel) => {
      clearHandoverSseReconnectTimer(channel.key)
      closeHandoverSseChannel(channel.key)
      setHandoverRealtimeChannelState(channel.key, 'idle')
    })
  }

  return {
    handoverLoading,
    handoverError,
    handoverSnapshot,
    handoverSummary,
    recentRetentionChanges,
    handoverRealtimeLastEventAt,
    handoverRealtimeLastError,
    handoverRealtimeTagType,
    handoverRealtimeTagText,
    loadHandoverSnapshot,
    startHandoverSseSync,
    stopHandoverSseSync
  }
}
