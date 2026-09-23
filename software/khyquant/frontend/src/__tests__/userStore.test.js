/**
 * userStore.test.js — 锁 src/stores/user.js（Pinia setup store）的公共契约：
 * token 归一化 + localStorage 同步、连接模式切换时的凭证清洗
 * （local 模式清云端 token、cloud/auto 模式清 local 伪 token）、
 * updateBackendUrl 的 trim + 持久化、logout 的互斥与 finally 清理。
 * 不触真实网络：mock @/api/auth 与 @/services/localAuthService；
 * 公共成员只走 return 暴露面，不碰内部 ref。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia } from 'pinia'
import { createPinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  hasAuthToken: vi.fn((t) => Boolean(t)),
  normalizeToken: vi.fn((t) => (typeof t === 'string' ? t.trim() : '')),
  login: vi.fn(),
  register: vi.fn(),
  getCurrentUser: vi.fn(),
  logoutAPI: vi.fn(() => Promise.resolve()),
  loginLocalUser: vi.fn(),
  registerLocalUser: vi.fn(),
  getCurrentLocalUser: vi.fn(),
  logoutLocalUser: vi.fn(),
  isLocalToken: vi.fn((t) => typeof t === 'string' && t.startsWith('local-token.')),
  shouldFallbackLocalAuth: vi.fn(() => false),
  getConnectionMode: vi.fn(() => 'cloud'),
  setConnectionMode: vi.fn(),
  getBackendUrl: vi.fn(() => ''),
  setBackendUrl: vi.fn(),
}))

vi.mock('@khy/ui-shared/auth/state', () => ({ hasAuthToken: mocks.hasAuthToken }))
vi.mock('@khy/ui-shared/auth/token', () => ({ normalizeToken: mocks.normalizeToken }))
vi.mock('@/api/auth', () => ({
  login: mocks.login,
  register: mocks.register,
  getCurrentUser: mocks.getCurrentUser,
  logout: mocks.logoutAPI,
}))
vi.mock('@/services/localAuthService', () => ({
  loginLocalUser: mocks.loginLocalUser,
  registerLocalUser: mocks.registerLocalUser,
  getCurrentLocalUser: mocks.getCurrentLocalUser,
  logoutLocalUser: mocks.logoutLocalUser,
  isLocalToken: mocks.isLocalToken,
  shouldFallbackLocalAuth: mocks.shouldFallbackLocalAuth,
}))
vi.mock('@/utils/connectionMode', () => ({
  getConnectionMode: mocks.getConnectionMode,
  setConnectionMode: mocks.setConnectionMode,
  getBackendUrl: mocks.getBackendUrl,
  setBackendUrl: mocks.setBackendUrl,
}))

import { useUserStore } from '@/stores/user'

function freshStore() {
  setActivePinia(createPinia())
  localStorage.clear()
  const store = useUserStore()
  store.$patch({ connectionMode: 'cloud', backendUrl: '' })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hasAuthToken.mockImplementation((t) => Boolean(t))
  mocks.normalizeToken.mockImplementation((t) => (typeof t === 'string' ? t.trim() : ''))
  mocks.isLocalToken.mockImplementation((t) => typeof t === 'string' && t.startsWith('local-token.'))
  mocks.shouldFallbackLocalAuth.mockReturnValue(false)
  mocks.getConnectionMode.mockReturnValue('cloud')
  mocks.getBackendUrl.mockReturnValue('')
  mocks.logoutAPI.mockResolvedValue({ success: true })
})

describe('token 归一化与持久化', () => {
  it('setToken 归一化后写入 localStorage', () => {
    const store = freshStore()
    store.setToken('  jwt-abc ')
    expect(store.token).toBe('jwt-abc')
    expect(localStorage.getItem('token')).toBe('jwt-abc')
  })

  it('setToken 空串清 localStorage', () => {
    const store = freshStore()
    store.setToken('jwt-abc')
    store.setToken('')
    expect(store.token).toBe('')
    expect(localStorage.getItem('token')).toBeNull()
  })

  it('isAuthenticated 委托 hasAuthToken(token)', () => {
    const store = freshStore()
    store.setToken('jwt-x')
    expect(store.isAuthenticated()).toBe(true)
    store.setToken('')
    expect(store.isAuthenticated()).toBe(false)
  })
})

describe('连接模式切换的凭证清洗', () => {
  it('cloud → local：清掉云端 JWT（user + token 归零）', () => {
    const store = freshStore()
    store.setToken('cloud-jwt')
    store.setUser({ id: 1, username: 'u' })
    store.updateConnectionMode('local')
    expect(store.connectionMode).toBe('local')
    expect(mocks.setConnectionMode).toHaveBeenCalledWith('local')
    expect(store.token).toBe('')
    expect(store.user).toBeNull()
  })

  it('cloud → local：local 伪 token 保留', () => {
    const store = freshStore()
    store.setToken('local-token.abc')
    store.updateConnectionMode('local')
    expect(store.token).toBe('local-token.abc')
    expect(mocks.setConnectionMode).toHaveBeenCalledWith('local')
  })

  it('local → cloud：清掉 local 伪 token', () => {
    const store = freshStore()
    store.$patch({ connectionMode: 'local' })
    store.setToken('local-token.abc')
    store.updateConnectionMode('cloud')
    expect(store.token).toBe('')
    expect(store.user).toBeNull()
  })

  it('cloud → auto：同样清掉 local 伪 token', () => {
    const store = freshStore()
    store.$patch({ connectionMode: 'local' })
    store.setToken('local-token.abc')
    store.updateConnectionMode('auto')
    expect(store.token).toBe('')
    expect(store.connectionMode).toBe('auto')
  })
})

describe('updateBackendUrl', () => {
  it('trim 后同步到 connectionMode 持久化', () => {
    const store = freshStore()
    store.updateBackendUrl('  https://x.example  ')
    expect(store.backendUrl).toBe('https://x.example')
    expect(mocks.setBackendUrl).toHaveBeenCalledWith('https://x.example')
  })

  it('空输入归一为空串', () => {
    const store = freshStore()
    store.updateBackendUrl(null)
    expect(store.backendUrl).toBe('')
    expect(mocks.setBackendUrl).toHaveBeenCalledWith('')
  })
})

describe('logout 互斥与 finally 清理', () => {
  it('带 token 的 cloud 模式：调用远端 logoutAPI（带 skip 标记）并清状态', async () => {
    const store = freshStore()
    store.setToken('cloud-jwt')
    await store.logout()
    expect(mocks.logoutAPI).toHaveBeenCalledWith({ silentLoading: true, __skipAuthErrorHandling: true })
    expect(store.token).toBe('')
    expect(store.user).toBeNull()
  })

  it('local-token 走 logoutLocalUser 而非远端 API', async () => {
    const store = freshStore()
    store.setToken('local-token.abc')
    await store.logout()
    expect(mocks.logoutLocalUser).toHaveBeenCalled()
    expect(mocks.logoutAPI).not.toHaveBeenCalled()
  })

  it('skipRemote：跳过远端 API', async () => {
    const store = freshStore()
    store.setToken('cloud-jwt')
    await store.logout({ skipRemote: true })
    expect(mocks.logoutAPI).not.toHaveBeenCalled()
  })

  it('logoutAPI 抛错仍清本地状态（fail-soft）', async () => {
    const store = freshStore()
    store.setToken('cloud-jwt')
    mocks.logoutAPI.mockRejectedValue(new Error('boom'))
    await expect(store.logout()).resolves.toBeUndefined()
    expect(store.token).toBe('')
  })
})

describe('loginUser 本地回退', () => {
  it('local 模式下远端无响应类错误（无 response）回退本地登录', async () => {
    const store = freshStore()
    store.$patch({ connectionMode: 'local' })
    mocks.login.mockRejectedValue(new Error('no backend'))
    mocks.loginLocalUser.mockReturnValue({ success: true, data: { token: 'local-token.x', user: { id: 9, username: 'l' } } })
    const res = await store.loginUser({ username: 'l', password: 'p' })
    expect(res.success).toBe(true)
    expect(store.token).toBe('local-token.x')
    expect(store.user).toEqual({ id: 9, username: 'l' })
  })

  it('cloud 模式：远端失败且 shouldFallback=true 时回退本地注册/登录', async () => {
    const store = freshStore()
    mocks.login.mockRejectedValue(new Error('net down'))
    mocks.shouldFallbackLocalAuth.mockReturnValue(true)
    mocks.loginLocalUser.mockReturnValue({ success: true, data: { token: 'local-token.y', user: { id: 10 } } })
    await store.loginUser({ username: 'a', password: 'b' })
    expect(mocks.loginLocalUser).toHaveBeenCalled()
    expect(store.token).toBe('local-token.y')
  })

  it('远端成功直接返回，不走本地回退', async () => {
    const store = freshStore()
    mocks.login.mockResolvedValue({ success: true, data: { token: 'jwt-1', user: { id: 1 } } })
    const res = await store.loginUser({ username: 'a', password: 'b' })
    expect(res.success).toBe(true)
    expect(store.token).toBe('jwt-1')
    expect(mocks.loginLocalUser).not.toHaveBeenCalled()
  })
})
