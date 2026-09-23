/**
 * requestInterceptor.test.js — 锁 src/utils/requestInterceptor.js 的错误分类契约：
 * get/网络/超时/服务端的错误类型判定、错误消息映射（自定义 message 优先）、
 * auth 静默规则、5 次连续失败触发 returnToSplash 的阈值行为。
 * 不发起真实网络：直接驱动全局 axios 实例上注册的拦截器 handlers。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  ElMessage: vi.fn(),
  returnToSplash: vi.fn(),
}))

vi.mock('element-plus', () => ({ ElMessage: mocks.ElMessage }))
vi.mock('@/utils/networkMonitor', () => ({
  default: { returnToSplash: mocks.returnToSplash },
}))

import axios from 'axios'
import { setupRequestInterceptor, resetErrorCount } from '@/utils/requestInterceptor'

// 该模块挂到全局 axios 实例上（main.js 已注释掉调用，测试自行装配一次）
setupRequestInterceptor()

// 全局 axios 的拦截器已注册（handlers[0]），测试直接驱动 handler 函数。
function reqHandler() { return axios.interceptors.request.handlers[0] }
function resHandler() { return axios.interceptors.response.handlers[0] }

function networkError(code, message) {
  return { code, message, config: {} }
}

function statusError(status, data) {
  return { config: {}, response: { status, data: data || {} } }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetErrorCount()
})

describe('请求配置器', () => {
  it('GET 请求注入时间戳参数防缓存', () => {
    const config = reqHandler().fulfilled({ method: 'get', url: '/x' })
    expect(config.params._t).toBeTypeOf('number')
  })

  it('非 GET 请求不注入时间戳参数', () => {
    const config = reqHandler().fulfilled({ method: 'post', url: '/x', params: { a: 1 } })
    expect(config.params._t).toBeUndefined()
    expect(config.params.a).toBe(1)
  })

  it('配置错误直接 reject 且无副作用', async () => {
    await expect(reqHandler().rejected(new Error('cfg')))
      .rejects.toThrow('cfg')
    expect(mocks.ElMessage).not.toHaveBeenCalled()
  })
})

describe('错误类型判定（经响应拦截器暴露）', () => {
  it('5xx 归类为 server 并使用「服务器错误,请稍后重试」', async () => {
    const spy = vi.spyOn(console, 'error')
    await expect(resHandler().rejected(statusError(500))).rejects.toBeDefined()
    // ElMessage 收到 warning 型「服务器错误」提示
    expect(mocks.ElMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: '服务器错误,请稍后重试',
      type: 'warning',
    }))
    expect(spy).toHaveBeenCalled()
  })

  it('404 归类为 notfound 且文案为「请求的资源不存在」', async () => {
    await expect(resHandler().rejected(statusError(404))).rejects.toBeDefined()
    expect(mocks.ElMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: '请求的资源不存在',
      type: 'warning',
    }))
  })

  it('401/403 归类为 auth 且静默（路由守卫处理）', async () => {
    await expect(resHandler().rejected(statusError(401))).rejects.toBeDefined()
    expect(mocks.ElMessage).not.toHaveBeenCalled()
    await expect(resHandler().rejected(statusError(403))).rejects.toBeDefined()
    expect(mocks.ElMessage).not.toHaveBeenCalled()
  })

  it('其他 4xx 归类为 client 且文案为「请求参数错误」', async () => {
    await expect(resHandler().rejected(statusError(400))).rejects.toBeDefined()
    expect(mocks.ElMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: '请求参数错误',
      type: 'warning',
    }))
  })

  it('ECONNABORTED 归类为 timeout 且文案为「请求超时,请检查网络连接」', async () => {
    await expect(resHandler().rejected(networkError('ECONNABORTED', 'timeout')))
      .rejects.toBeDefined()
    expect(mocks.ElMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: '请求超时,请检查网络连接',
      type: 'error',
    }))
  })

  it('Network Error / ERR_NETWORK 归类为 network 且文案为「网络连接失败,请检查后端服务是否运行」', async () => {
    await expect(resHandler().rejected(networkError('ERR_NETWORK', 'Network Error')))
      .rejects.toBeDefined()
    expect(mocks.ElMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: '网络连接失败,请检查后端服务是否运行',
      type: 'error',
    }))
  })

  it('无法识别的无响应错误归类为 unknown 且文案为「未知错误,请联系管理员」', async () => {
    await expect(resHandler().rejected(networkError('E_UNKNOWN', 'weird')))
      .rejects.toBeDefined()
    expect(mocks.ElMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: '未知错误,请联系管理员',
      type: 'warning',
    }))
  })
})

describe('自定义服务端消息优先', () => {
  it('response.data.message 存在时覆盖默认文案', async () => {
    await expect(resHandler().rejected(statusError(500, { message: '数据库连接失败' })))
      .rejects.toBeDefined()
    expect(mocks.ElMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: '数据库连接失败',
      type: 'warning',
    }))
  })
})

describe('连续失败阈值', () => {
  it('前 4 次连续失败不触发 returnToSplash', async () => {
    for (let i = 0; i < 4; i++) {
      await expect(resHandler().rejected(statusError(500))).rejects.toBeDefined()
    }
    expect(mocks.returnToSplash).not.toHaveBeenCalled()
  })

  it('第 5 次连续失败触发 returnToSplash 并给出修复指引', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(resHandler().rejected(statusError(500))).rejects.toBeDefined()
    }
    expect(mocks.returnToSplash).toHaveBeenCalledTimes(1)
    expect(mocks.returnToSplash).toHaveBeenCalledWith('前后端连接失败,请检查服务是否正常运行')
  })

  it('成功响应重置计数，之前 4 次失败不会累积到阈值', async () => {
    for (let i = 0; i < 4; i++) {
      await expect(resHandler().rejected(statusError(500))).rejects.toBeDefined()
    }
    resHandler().fulfilled({ data: 1, config: {} })
    await expect(resHandler().rejected(statusError(500))).rejects.toBeDefined()
    expect(mocks.returnToSplash).not.toHaveBeenCalled()
  })
})
