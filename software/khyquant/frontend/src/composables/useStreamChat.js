/**
 * SSE streaming chat composable.
 *
 * Connects to POST /ai/chat/stream and emits incremental chunks
 * that the component can render in real time.
 */
import { ref } from 'vue'
import { getApiBaseUrl } from '@/config/api'

export function useStreamChat() {
  const isStreaming = ref(false)
  const streamContent = ref('')
  const thinkingContent = ref('')
  const currentModel = ref('')
  const adapterInfo = ref(null)    // { adapter, deduplicated }
  const statusText = ref('')       // Latest status message from gateway

  let abortController = null

  /**
   * Start a streaming request.
   *
   * @param {object}   body     Request body (question, stockCode, etc.)
   * @param {Function} onDone   Called with the final SSE "done" payload
   * @param {string}   [token]  JWT auth token
   */
  async function sendStream(body, onDone, token) {
    abortController = new AbortController()
    isStreaming.value = true
    streamContent.value = ''
    thinkingContent.value = ''
    currentModel.value = ''
    adapterInfo.value = null
    statusText.value = ''

    const baseUrl = getApiBaseUrl()
    const url = `${baseUrl}/ai/chat/stream`

    const headers = { 'Content-Type': 'application/json' }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        onDone?.({ error: `HTTP ${response.status}: ${text}` })
        isStreaming.value = false
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let data
          try {
            data = JSON.parse(line.slice(6))
          } catch {
            continue
          }

          switch (data.type) {
            case 'start':
              currentModel.value = data.model || ''
              if (data.adapter) adapterInfo.value = { adapter: data.adapter }
              break
            case 'chunk':
              streamContent.value += data.content
              break
            case 'thinking':
              thinkingContent.value += data.content
              break
            case 'status':
              statusText.value = data.text || ''
              break
            case 'heartbeat':
              // Keep-alive signal from backend during AI processing — no UI action needed
              break
            case 'done':
              if (data.content) streamContent.value = data.content
              currentModel.value = data.model || currentModel.value
              if (data.adapter) adapterInfo.value = { adapter: data.adapter, deduplicated: !!data.deduplicated }
              onDone?.(data)
              break
            case 'error':
              onDone?.({ error: data.message })
              break
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        onDone?.({ error: err.message })
      }
    }

    isStreaming.value = false
  }

  /** Cancel an in-progress stream. */
  function cancelStream() {
    abortController?.abort()
    isStreaming.value = false
  }

  return {
    isStreaming,
    streamContent,
    thinkingContent,
    currentModel,
    adapterInfo,
    statusText,
    sendStream,
    cancelStream,
  }
}
