// connectionMode.test.js — 锁连接模式（auto/cloud/local）与后端 URL 解析
// 单一真源：默认后端 URL 来自 constants/serviceDefaults（SSOT），本测试从其导入断言
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getConnectionMode,
  setConnectionMode,
  getBackendUrl,
  setBackendUrl,
  getApiBaseUrl,
  getRequestTimeoutMs,
  isNetworkLikeError,
  shouldUseLocalAuthFallback,
  getConnectionProfile,
  connectionModeKeys,
  isCapacitorNative
} from '@/utils/connectionMode'
import { DEFAULT_BACKEND_URL } from '@/constants/serviceDefaults'

beforeEach(() => {
  localStorage.removeItem(connectionModeKeys.CONNECTION_MODE_KEY)
  localStorage.removeItem(connectionModeKeys.BACKEND_URL_KEY)
})

describe('模式存取', () => {
  it('默认模式来自部署环境判定（jsdom 非生产域名 → local）', () => {
    expect(getConnectionMode()).toBe('local')
  })

  it('localStorage 中合法模式优先生效', () => {
    setConnectionMode('cloud')
    expect(getConnectionMode()).toBe('cloud')
    setConnectionMode('local')
    expect(getConnectionMode()).toBe('local')
    setConnectionMode('auto')
    expect(getConnectionMode()).toBe('auto')
  })

  it('非法模式回退默认值', () => {
    setConnectionMode('lan')
    expect(getConnectionMode()).toBe(connectionModeKeys.DEFAULT_CONNECTION_MODE)
  })

  it('导出键名常量与默认 URL 一致', () => {
    expect(connectionModeKeys.CONNECTION_MODE_KEY).toBeTruthy()
    expect(connectionModeKeys.DEFAULT_BACKEND_URL).toBe(DEFAULT_BACKEND_URL)
  })
})

describe('后端 URL 存取', () => {
  it('无覆盖时返回 SSOT 默认后端地址', () => {
    expect(getBackendUrl()).toBe(DEFAULT_BACKEND_URL)
  })

  it('设置 URL 时去除尾部斜杠', () => {
    setBackendUrl('http://192.168.1.10:8080/')
    expect(getBackendUrl()).toBe('http://192.168.1.10:8080')
  })

  it('空值回退默认地址', () => {
    setBackendUrl('   ')
    expect(getBackendUrl()).toBe(DEFAULT_BACKEND_URL)
    setBackendUrl('')
    expect(getBackendUrl()).toBe(DEFAULT_BACKEND_URL)
  })
})

describe('API 基址与超时', () => {
  it('非原生移动端环境走反向代理路径 /api', () => {
    expect(getApiBaseUrl()).toBe('/api')
  })

  it('超时策略：Web 120s，Capacitor 原生 15s', () => {
    expect(getRequestTimeoutMs()).toBe(120000)
    window.Capacitor = { isNativePlatform: () => true }
    try {
      expect(getRequestTimeoutMs()).toBe(15000)
    } finally {
      delete window.Capacitor
    }
  })

  it('Capacitor 原生环境直连配置的后端 URL + /api', () => {
    setBackendUrl('http://10.0.0.5:3000')
    window.Capacitor = { isNativePlatform: () => true }
    try {
      expect(getApiBaseUrl()).toBe('http://10.0.0.5:3000/api')
    } finally {
      delete window.Capacitor
    }
  })
})

describe('网络错误判定', () => {
  it('无 error 或非网络错误返回 false', () => {
    expect(isNetworkLikeError(null)).toBe(false)
    expect(isNetworkLikeError(new Error('boom'))).toBe(true) // 无 response 视为网络类
    expect(isNetworkLikeError({ response: {}, code: 'ECONNABORTED' })).toBe(true)
    expect(isNetworkLikeError({ response: {}, code: 'EINVAL' })).toBe(false)
    expect(isNetworkLikeError({ response: {} })).toBe(false)
  })

  it('本地/云端模式下回退策略不同', () => {
    setConnectionMode('local')
    expect(shouldUseLocalAuthFallback(new Error('x'))).toBe(true)
    setConnectionMode('cloud')
    expect(shouldUseLocalAuthFallback(new Error('x'))).toBe(false)
    setConnectionMode('auto')
    expect(shouldUseLocalAuthFallback({ response: {}, code: 'ENOTFOUND' })).toBe(true)
    expect(shouldUseLocalAuthFallback({ response: {}, code: 'OTHER' })).toBe(false)
  })
})

describe('getConnectionProfile', () => {
  it('聚合模式/URL/基址/原生标志', () => {
    const p = getConnectionProfile()
    expect(p.mode).toBe('local')
    expect(p.backendUrl).toBe(DEFAULT_BACKEND_URL)
    expect(p.apiBaseUrl).toBe('/api')
    expect(p.native).toBe(isCapacitorNative())
  })
})
