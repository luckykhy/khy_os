/**
 * Unified WebSocket service — single connection for the entire frontend.
 *
 * Replaces three separate WS connections (websocketService, websocket, SyncNotification)
 * with one singleton that handles: auth, heartbeat, data subscriptions, notifications.
 *
 * Key design choices:
 *   - Dynamic port from window.location (no hardcoded :3000)
 *   - Protocol-level pong listener + application-level ping every 25s
 *   - Exponential backoff with jitter on reconnect (max 12 attempts)
 *   - visibilitychange listener for wake-from-sleep reconnect
 *   - Event-based message dispatch via on()/off()
 *   - Works in production by default (no VITE_WS_ENABLED gate)
 */
import { ElNotification } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { getWsUrl } from '@/config/api'

class WebSocketService {
  constructor() {
    this.ws = null
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = Infinity // Never give up reconnecting
    this.baseReconnectInterval = 1000
    this.maxReconnectInterval = 60000   // Cap at 60s between attempts
    this.isConnected = false
    this.isAuthenticated = false
    this._connecting = false
    this._manualDisconnect = false

    // Event-based message dispatch: type -> Set<callback>
    this._listeners = new Map()

    // Data subscriptions (symbol -> Set<callback>)
    this._dataSubscribers = new Map()

    // Heartbeat
    this._heartbeatInterval = null
    this._heartbeatMs = 25000 // 25s — under typical NAT/proxy 30-60s timeout
    this._lastPong = 0

    // Reconnect timer
    this._reconnectTimer = null

    // Visibility change listener
    this._onVisibilityChange = this._handleVisibilityChange.bind(this)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibilityChange)
    }
  }

  // ─── Connection ────────────────────────────────────────────

  connect() {
    if (this._connecting || this.isConnected) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      this._connecting = true
      this._manualDisconnect = false
      this._clearReconnect()

      const wsUrl = getWsUrl()
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        this._connecting = false
        this.isConnected = true
        this.reconnectAttempts = 0
        this._lastPong = Date.now()
        this._startHeartbeat()

        // Auto-authenticate if token exists
        this._authenticate().then(resolve).catch((err) => {
          // Auth failure is non-fatal — connection is still up
          console.warn('WebSocket auth failed:', err.message)
          resolve()
        })
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          this._dispatch(data)
        } catch (err) {
          console.error('WebSocket message parse error:', err)
        }
      }

      this.ws.onclose = (event) => {
        const manualDisconnect = this._manualDisconnect
        this._manualDisconnect = false
        this.isConnected = false
        this.isAuthenticated = false
        this._connecting = false
        this._stopHeartbeat()
        this._emit('_disconnected', { code: event.code, reason: event.reason })
        if (!manualDisconnect) {
          this._scheduleReconnect()
        }
      }

      this.ws.onerror = () => {
        // onclose will fire after onerror, so reconnect is handled there
        if (this._connecting) {
          this._connecting = false
          reject(new Error('WebSocket connection failed'))
        }
      }
    })
  }

  disconnect() {
    this._manualDisconnect = true
    this._clearReconnect()
    this._stopHeartbeat()
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'client_disconnect')
      }
      this.ws = null
    }
    this.isConnected = false
    this.isAuthenticated = false
    this._connecting = false
    this._dataSubscribers.clear()
  }

  // ─── Authentication ────────────────────────────────────────

  _authenticate() {
    let userStore
    try {
      userStore = useUserStore()
    } catch {
      return Promise.resolve()
    }

    const token = typeof userStore.token === 'string'
      ? userStore.token.replace(/^Bearer\s+/i, '').trim()
      : ''

    if (!token) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Auth timeout'))
      }, 5000)

      const onSuccess = (data) => {
        clearTimeout(timeout)
        cleanup()
        this.isAuthenticated = true
        this._resubscribeAll()
        resolve(data)
      }

      const onError = (data) => {
        clearTimeout(timeout)
        cleanup()
        reject(new Error(data.message || 'Auth failed'))
      }

      const cleanup = () => {
        this.off('auth_success', onSuccess)
        this.off('auth_error', onError)
      }

      this.on('auth_success', onSuccess)
      this.on('auth_error', onError)

      this.send({ type: 'auth', token })
    })
  }

  // ─── Heartbeat ─────────────────────────────────────────────

  _startHeartbeat() {
    this._stopHeartbeat()
    this._heartbeatInterval = setInterval(() => {
      if (!this.isConnected) return

      // If we haven't received any pong in 2 intervals, connection is likely dead
      if (this._lastPong && Date.now() - this._lastPong > this._heartbeatMs * 2.5) {
        console.warn('WebSocket heartbeat timeout, forcing reconnect')
        if (this.ws) this.ws.close()
        return
      }

      this.send({ type: 'ping' })
    }, this._heartbeatMs)
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval)
      this._heartbeatInterval = null
    }
  }

  // ─── Reconnect ─────────────────────────────────────────────

  _scheduleReconnect() {
    this._clearReconnect()

    this.reconnectAttempts++
    // Exponential backoff capped at maxReconnectInterval, with jitter
    const exponentialDelay = Math.min(
      this.baseReconnectInterval * (2 ** Math.min(this.reconnectAttempts - 1, 6)),
      this.maxReconnectInterval
    )
    const jitter = Math.floor(Math.random() * 1000)
    const delay = exponentialDelay + jitter

    // Notify user every 5 failed attempts so they know the connection is down
    if (this.reconnectAttempts % 5 === 0) {
      console.warn(`WebSocket reconnect attempt #${this.reconnectAttempts}, next in ${Math.round(delay / 1000)}s`)
    }

    this._reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {})
    }, delay)
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  // ─── Visibility change (wake from sleep) ───────────────────

  _handleVisibilityChange() {
    if (document.visibilityState !== 'visible') return

    const readyState = this.ws ? this.ws.readyState : WebSocket.CLOSED
    if (!this.isConnected || readyState !== WebSocket.OPEN) {
      // Page became visible and WS is down — try immediate reconnect
      this.reconnectAttempts = 0
      this._clearReconnect()
      this.connect().catch(() => {})
      return
    }

    // Connection appears open; force a quick liveness check after wake.
    if (this._lastPong && Date.now() - this._lastPong > this._heartbeatMs * 2.5) {
      if (this.ws) this.ws.close()
      return
    }
    this.send({ type: 'ping' })
  }

  // ─── Message dispatch ──────────────────────────────────────

  _dispatch(data) {
    const { type } = data

    // Handle pong: update heartbeat tracker
    if (type === 'pong' || type === 'ai_heartbeat') {
      this._lastPong = Date.now()
      return
    }

    // Handle connected message from server
    if (type === 'connected') {
      return
    }

    // Handle realtime data push: dispatch to data subscribers
    if (type === 'realtime' && data.symbol) {
      const subs = this._dataSubscribers.get(data.symbol)
      if (subs) {
        subs.forEach(cb => {
          try { cb(data.data) } catch {}
        })
      }
    }

    // Handle announcements with default UI
    if (type === 'announcement' && data.data) {
      this._handleAnnouncement(data.data)
    }

    // Handle system notifications with default UI
    if (type === 'system' && data.data) {
      this._handleSystemNotification(data.data)
    }

    // Handle errors with default UI
    if (type === 'error') {
      console.error('WebSocket server error:', data.message)
    }

    // Fire all registered listeners for this message type
    this._emit(type, data)
  }

  _handleAnnouncement(announcement) {
    const typeMap = {
      system: 'error', maintenance: 'warning',
      feature: 'success', warning: 'warning', info: 'info'
    }

    ElNotification({
      title: 'New Announcement',
      message: announcement.title,
      type: typeMap[announcement.type] || 'info',
      duration: 5000,
    })

    window.dispatchEvent(new CustomEvent('newAnnouncement', { detail: announcement }))
  }

  _handleSystemNotification(notification) {
    ElNotification({
      title: notification.title || 'System',
      message: notification.message,
      type: notification.type || 'info',
      duration: 4000,
    })
  }

  // ─── Event API (on / off / once) ───────────────────────────

  on(type, callback) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set())
    }
    this._listeners.get(type).add(callback)
  }

  off(type, callback) {
    if (!this._listeners.has(type)) return
    if (callback) {
      this._listeners.get(type).delete(callback)
    } else {
      this._listeners.delete(type)
    }
  }

  _emit(type, data) {
    const listeners = this._listeners.get(type)
    if (!listeners) return
    listeners.forEach(cb => {
      try { cb(data) } catch {}
    })
  }

  // ─── Data subscriptions (symbol-based) ─────────────────────

  subscribe(symbol, callback) {
    if (!this._dataSubscribers.has(symbol)) {
      this._dataSubscribers.set(symbol, new Set())
    }
    this._dataSubscribers.get(symbol).add(callback)

    // If connected and authenticated, send subscribe command
    if (this.isAuthenticated) {
      this.send({ type: 'subscribe', symbol })
    }
  }

  unsubscribe(symbol, callback) {
    const subs = this._dataSubscribers.get(symbol)
    if (!subs) return
    subs.delete(callback)

    if (subs.size === 0) {
      this._dataSubscribers.delete(symbol)
      if (this.isAuthenticated) {
        this.send({ type: 'unsubscribe', symbol })
      }
    }
  }

  /**
   * Re-subscribe all data channels after reconnect.
   * Called internally after successful authentication.
   */
  _resubscribeAll() {
    for (const symbol of this._dataSubscribers.keys()) {
      this.send({ type: 'subscribe', symbol })
    }
  }

  // ─── Send ──────────────────────────────────────────────────

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
      return true
    }
    return false
  }

  // ─── Status ────────────────────────────────────────────────

  getStatus() {
    return {
      isConnected: this.isConnected,
      isAuthenticated: this.isAuthenticated,
      reconnectAttempts: this.reconnectAttempts,
      readyState: this.ws ? this.ws.readyState : WebSocket.CLOSED,
    }
  }
}

const websocketService = new WebSocketService()
export default websocketService
