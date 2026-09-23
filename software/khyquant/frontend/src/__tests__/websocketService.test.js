// websocketService.test.js — 锁统一 WebSocket 单例服务
// 覆盖：连接/认证/心跳/重连/订阅/事件分发；WebSocket 与 store 全部打桩
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('element-plus', () => ({ ElNotification: vi.fn() }))
vi.mock('@/stores/user', () => ({ useUserStore: vi.fn() }))

import { ElNotification } from 'element-plus'
import { useUserStore } from '@/stores/user'
import websocketService from '@/services/websocketService'

// 假 WebSocket：可控开/收/断，常量与浏览器一致
class FakeWS {
  constructor(url) {
    this.url = url
    this.readyState = FakeWS.CONNECTING
    this.sent = []
    FakeWS.instances.push(this)
  }
  send(data) {
    this.sent.push(data)
  }
  close(code = 1000, reason = '') {
    this.readyState = FakeWS.CLOSED
    if (this.onclose) this.onclose({ code, reason })
  }
  // 测试辅助
  fireOpen() {
    this.readyState = FakeWS.OPEN
    if (this.onopen) this.onopen()
  }
  fireMessage(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) })
  }
  fireClose(code = 1006) {
    this.readyState = FakeWS.CLOSED
    if (this.onclose) this.onclose({ code, reason: 'test-close' })
  }
}
FakeWS.CONNECTING = 0
FakeWS.OPEN = 1
FakeWS.CLOSING = 2
FakeWS.CLOSED = 3
FakeWS.instances = []

vi.stubGlobal('WebSocket', FakeWS)

function lastWs() {
  return FakeWS.instances[FakeWS.instances.length - 1]
}

async function openConnection() {
  const p = websocketService.connect()
  lastWs().fireOpen()
  await p
  // 无 token 时认证直接 resolve
}

beforeEach(() => {
  useUserStore.mockReturnValue({ token: '' })
  vi.clearAllMocks()
})

afterEach(async () => {
  websocketService.disconnect()
  FakeWS.instances = []
})

describe('连接生命周期', () => {
  it('connect 使用动态 ws 地址并建立连接', async () => {
    await openConnection()
    const ws = lastWs()
    // 地址来自 window.location（非硬编码）
    expect(ws.url).toBe(`ws://${window.location.host}/ws`)
    expect(websocketService.isConnected).toBe(true)
    expect(websocketService.getStatus()).toMatchObject({ isConnected: true, readyState: FakeWS.OPEN })
  })

  it('连接中重复 connect 直接幂等返回', async () => {
    await openConnection()
    await expect(websocketService.connect()).resolves.toBeUndefined()
    expect(FakeWS.instances).toHaveLength(1)
  })

  it('手动 disconnect 停止连接且不触发重连', async () => {
    await openConnection()
    const ws = lastWs()
    websocketService.disconnect()
    expect(ws.readyState).toBe(FakeWS.CLOSED)
    expect(websocketService.getStatus().isConnected).toBe(false)
    // 手动断开不计入重连次数
    expect(websocketService.reconnectAttempts).toBe(0)
  })

  it('异常关闭触发退避重连计数', async () => {
    vi.useFakeTimers()
    try {
      const p = websocketService.connect()
      lastWs().fireOpen()
      await p
      lastWs().fireClose(1006)
      expect(websocketService.reconnectAttempts).toBe(1)
      // 首次重连延迟 ≤ 1s + 1s 抖动
      vi.advanceTimersByTime(2000)
      expect(FakeWS.instances).toHaveLength(2)
      websocketService.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('认证', () => {
  it('有 token 时发送 auth 消息（去除 Bearer 前缀）', async () => {
    useUserStore.mockReturnValue({ token: 'Bearer  abc123 ' })
    const p = websocketService.connect()
    const ws = lastWs()
    ws.fireOpen()
    ws.fireMessage({ type: 'auth_success' })
    await p
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'auth', token: 'abc123' })
  })

  it('auth_success 后标记已认证并重订阅既有频道', async () => {
    useUserStore.mockReturnValue({ token: 'tok' })
    const onData = vi.fn()
    websocketService.subscribe('SH600519', onData)
    const p = websocketService.connect()
    const ws = lastWs()
    ws.fireOpen()
    ws.fireMessage({ type: 'auth_success' })
    await p
    expect(websocketService.isAuthenticated).toBe(true)
    // 认证后自动补发订阅指令
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'subscribe', symbol: 'SH600519' })
  })

  it('无 token 跳过认证直接可用', async () => {
    await openConnection()
    expect(websocketService.isAuthenticated).toBe(false)
  })
})

describe('消息分发', () => {
  it('realtime 推送分发给对应 symbol 的订阅者', async () => {
    await openConnection()
    const onData = vi.fn()
    websocketService.subscribe('SH600519', onData)
    lastWs().fireMessage({ type: 'realtime', symbol: 'SH600519', data: { price: 100 } })
    expect(onData).toHaveBeenCalledWith({ price: 100 })
    lastWs().fireMessage({ type: 'realtime', symbol: 'OTHER', data: { x: 1 } })
    expect(onData).toHaveBeenCalledTimes(1)
  })

  it('announcement 触发默认通知 UI 与自定义事件', async () => {
    await openConnection()
    const listener = vi.fn()
    window.addEventListener('newAnnouncement', listener)
    lastWs().fireMessage({ type: 'announcement', data: { title: '维护通知', type: 'maintenance' } })
    expect(ElNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New Announcement', message: '维护通知', type: 'warning' })
    )
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('newAnnouncement', listener)
  })

  it('system 通知走默认 UI，error 类型打日志', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await openConnection()
    lastWs().fireMessage({ type: 'system', data: { title: 'T', message: 'M' } })
    expect(ElNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'T', message: 'M', duration: 4000 })
    )
    lastWs().fireMessage({ type: 'error', message: '服务端错误' })
    expect(console.error).toHaveBeenCalled()
  })

  it('pong / connected 消息静默处理并刷新心跳', async () => {
    await openConnection()
    const before = websocketService._lastPong
    expect(before).toBeGreaterThan(0)
    const cb = vi.fn()
    websocketService.on('pong', cb)
    lastWs().fireMessage({ type: 'connected' })
    lastWs().fireMessage({ type: 'pong' })
    expect(websocketService._lastPong).toBeGreaterThanOrEqual(before)
    // pong 属内部消息：不触发外部监听器
    expect(cb).not.toHaveBeenCalled()
    websocketService.off('pong', cb)
  })

  it('坏 JSON 消息被捕获不抛出', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await openConnection()
    expect(() => lastWs().onmessage({ data: 'not-json' })).not.toThrow()
  })
})

describe('订阅管理', () => {
  it('已认证时 subscribe/unsubscribe 发送对应指令', async () => {
    useUserStore.mockReturnValue({ token: 'tok' })
    const p = websocketService.connect()
    const ws = lastWs()
    ws.fireOpen()
    ws.fireMessage({ type: 'auth_success' })
    await p
    const onData = vi.fn()
    websocketService.subscribe('SZ000001', onData)
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'subscribe', symbol: 'SZ000001' })
    websocketService.unsubscribe('SZ000001', onData)
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'unsubscribe', symbol: 'SZ000001' })
  })

  it('send 仅在连接打开时发送', async () => {
    await openConnection()
    expect(websocketService.send({ type: 'ping' })).toBe(true)
    websocketService.disconnect()
    expect(websocketService.send({ type: 'ping' })).toBe(false)
  })
})

describe('事件 API', () => {
  it('on 返回退订函数；off 支持按类型清除', async () => {
    const cb = vi.fn()
    const off = websocketService.on('custom', cb)
    websocketService._emit('custom', { a: 1 })
    expect(cb).toHaveBeenCalledWith({ a: 1 })
    off()
    websocketService._emit('custom', { a: 2 })
    expect(cb).toHaveBeenCalledTimes(1)

    websocketService.on('custom', cb)
    websocketService.off('custom')
    websocketService._emit('custom', { a: 3 })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('_disconnected 内部事件可被监听', async () => {
    await openConnection()
    const cb = vi.fn()
    websocketService.on('_disconnected', cb)
    lastWs().fireClose(1011)
    expect(cb).toHaveBeenCalledWith({ code: 1011, reason: 'test-close' })
  })
})

describe('心跳', () => {
  it('25s 心跳周期发送 ping', async () => {
    vi.useFakeTimers()
    try {
      const p = websocketService.connect()
      lastWs().fireOpen()
      await p
      lastWs().sent.length = 0
      vi.advanceTimersByTime(25000)
      const last = JSON.parse(lastWs().sent[lastWs().sent.length - 1])
      expect(last).toEqual({ type: 'ping' })
      websocketService.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})
