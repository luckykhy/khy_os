// request.test.js — 锁全局 Axios 客户端拦截器行为（src/utils/request.js）
// 不发起真实网络：直接驱动 axios 实例上注册的拦截器 handlers
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  useUserStore: vi.fn(),
  isLocalToken: vi.fn(() => false),
  normalizeToken: vi.fn((t) => t),
  ElMessage: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  ElLoadingService: vi.fn(),
  getFriendlyErrorMessage: vi.fn((err, fallback) => fallback)
}))

vi.mock('@/stores/user', () => ({ useUserStore: mocks.useUserStore }))
vi.mock('@/services/localAuthService', () => ({ isLocalToken: mocks.isLocalToken }))
vi.mock('@khy/ui-shared/auth/token', () => ({ normalizeToken: mocks.normalizeToken }))
vi.mock('element-plus', () => ({
  ElMessage: mocks.ElMessage,
  ElLoading: { service: mocks.ElLoadingService }
}))
vi.mock('@/utils/errorMessage', () => ({ getFriendlyErrorMessage: mocks.getFriendlyErrorMessage }))

import request from '@/utils/request'

const reqHandler = () => request.interceptors.request.handlers[0]
const resHandler = () => request.interceptors.response.handlers[0]

function setStore(token, logout) {
  mocks.useUserStore.mockReturnValue({ token, logout: logout || vi.fn(() => Promise.resolve()) })
}

let savedLocation
beforeEach(() => {
  vi.clearAllMocks()
  mocks.isLocalToken.mockReturnValue(false)
  mocks.getFriendlyErrorMessage.mockImplementation((e, fallback) => fallback)
  localStorage.removeItem('khy_connection_mode')
  savedLocation = window.location
  Object.defineProperty(window, 'location', {
    value: { pathname: '/', href: '', protocol: 'http:', host: 'localhost' },
    configurable: true
  })
})
afterEach(() => {
  Object.defineProperty(window, 'location', { value: savedLocation, configurable: true })
})

describe('请求拦截器', () => {
  it('远程 token 自动注入 Authorization 头并动态更新 baseURL/超时', async () => {
    setStore('jwt-token')
    const config = await reqHandler().fulfilled({ url: '/x', headers: {} })
    expect(config.headers.Authorization).toBe('Bearer jwt-token')
    expect(config.baseURL).toBe('/api')
    expect(config.timeout).toBe(120000)
  })

  it('本地 token 不注入，且清除已有 Authorization', async () => {
    mocks.isLocalToken.mockReturnValue(true)
    setStore('local-tok')
    const config = await reqHandler().fulfilled({ url: '/x', headers: { Authorization: 'Bearer old' } })
    expect(config.headers.Authorization).toBeUndefined()
  })

  it('无 token 时不改动 Authorization', async () => {
    setStore('')
    const config = await reqHandler().fulfilled({ url: '/x', headers: {} })
    expect(config.headers.Authorization).toBeUndefined()
    expect(mocks.normalizeToken).toHaveBeenCalled()
  })

  it('请求拦截器异常直接 reject', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(reqHandler().rejected(new Error('int')))
      .rejects.toThrow('int')
    expect(mocks.ElMessage).not.toHaveBeenCalled()
  })
})

describe('响应拦截器', () => {
  it('成功只返回 response.data', () => {
    const response = { data: { success: true }, config: {} }
    expect(resHandler().fulfilled(response)).toEqual({ success: true })
  })

  it('404/403/500 映射到用户可读错误文案', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mk = (status, data) => ({ config: {}, response: { status, data } })
    await expect(resHandler().rejected(mk(404, {}))).rejects.toEqual(mk(404, {}))
    expect(mocks.ElMessage.error).toHaveBeenLastCalledWith('请求的资源不存在')
    await expect(resHandler().rejected(mk(403, {}))).rejects.toBeDefined()
    expect(mocks.ElMessage.error).toHaveBeenLastCalledWith('权限不足')
    await expect(resHandler().rejected(mk(500, { message: '数据库连接失败' }))).rejects.toBeDefined()
    expect(mocks.ElMessage.error).toHaveBeenLastCalledWith('数据库连接失败')
  })

  it('未识别状态码使用友好错误文案', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.getFriendlyErrorMessage.mockImplementation(() => '网关错误 (502)，请稍后重试')
    await expect(resHandler().rejected({ config: {}, response: { status: 502, data: {} } })).rejects.toBeDefined()
    expect(mocks.ElMessage.error).toHaveBeenCalledWith('网关错误 (502)，请稍后重试')
  })

  it('401 远程 token：登出 + 提示 + 跳转登录页', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const logout = vi.fn(() => Promise.resolve())
    setStore('jwt-token', logout)
    await expect(resHandler().rejected({ config: {}, response: { status: 401, data: {} } })).rejects.toBeDefined()
    expect(logout).toHaveBeenCalledWith({ skipRemote: true })
    expect(mocks.ElMessage.error).toHaveBeenCalledWith('登录已过期，请重新登录')
    expect(window.location.href).toBe('/login')
  })

  it('401 本地 token 不触发登出', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.isLocalToken.mockReturnValue(true)
    const logout = vi.fn(() => Promise.resolve())
    setStore('local-tok', logout)
    await expect(resHandler().rejected({ config: {}, response: { status: 401, data: {} } })).rejects.toBeDefined()
    expect(logout).not.toHaveBeenCalled()
  })

  it('401 但标记跳过处理时不登出', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const logout = vi.fn(() => Promise.resolve())
    setStore('jwt-token', logout)
    await expect(
      resHandler().rejected({ config: { __skipAuthErrorHandling: true }, response: { status: 401, data: {} } })
    ).rejects.toBeDefined()
    expect(logout).not.toHaveBeenCalled()
  })

  it('logout 请求路径上的 401 不重复处理', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const logout = vi.fn(() => Promise.resolve())
    setStore('jwt-token', logout)
    await expect(
      resHandler().rejected({ config: { url: '/auth/logout' }, response: { status: 401, data: {} } })
    ).rejects.toBeDefined()
    expect(logout).not.toHaveBeenCalled()
  })

  it('网络错误在单机模式下提示本地模式不可用', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // jsdom 默认连接模式为 local
    await expect(resHandler().rejected({ config: {}, request: {} })).rejects.toBeDefined()
    expect(mocks.ElMessage.warning).toHaveBeenCalledWith('当前处于单机模式，云端接口不可用')
  })

  it('网络错误在云端模式下降级为通用错误', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    localStorage.setItem('khy_connection_mode', 'cloud')
    await expect(resHandler().rejected({ config: {}, request: {} })).rejects.toBeDefined()
    expect(mocks.getFriendlyErrorMessage).toHaveBeenCalledWith(expect.anything(), '网络连接失败，请检查网络')
  })
})

describe('全局 loading 防抖', () => {
  it('300ms 内完成的请求不触发 loading；超时才显示并可关闭', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    mocks.ElLoadingService.mockImplementation(() => ({ close }))
    try {
      setStore('')
      // 发起（不 await）
      reqHandler().fulfilled({ url: '/slow', headers: {}, silentLoading: false })
      expect(mocks.ElLoadingService).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(mocks.ElLoadingService).toHaveBeenCalledTimes(1)
      expect(mocks.ElLoadingService).toHaveBeenCalledWith(
        expect.objectContaining({ lock: true, text: '加载中...' })
      )
      // 响应完成 → 引用计数归零 → 关闭
      resHandler().fulfilled({ data: 1, config: { url: '/slow' } })
      expect(close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      mocks.ElLoadingService.mockReset()
    }
  })

  it('silentLoading 请求不参与 loading 计数', async () => {
    vi.useFakeTimers()
    try {
      setStore('')
      reqHandler().fulfilled({ url: '/s', headers: {}, silentLoading: true })
      vi.advanceTimersByTime(300)
      expect(mocks.ElLoadingService).not.toHaveBeenCalled()
      resHandler().fulfilled({ data: 1, config: { url: '/s', silentLoading: true } })
      expect(mocks.ElLoadingService).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      mocks.ElLoadingService.mockReset()
    }
  })
})
