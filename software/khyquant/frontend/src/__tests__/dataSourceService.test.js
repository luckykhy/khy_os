// dataSourceService.test.js — 锁数据源状态管理服务
// 覆盖：默认状态、切换/刷新/更新、事件系统、组合式 API；request 以 vi.mock 打桩
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/utils/request', () => ({ default: { get: vi.fn() } }))

import request from '@/utils/request'
import dataSourceService, { dataSourceState, useDataSource } from '@/services/dataSourceService'

beforeEach(() => {
  vi.clearAllMocks()
  // 模块导入时启动了 30s 自动刷新，测试内先停掉避免挂起计时器
  dataSourceService.stopAutoRefresh()
})
afterEach(() => {
  dataSourceService.stopAutoRefresh()
})

describe('默认状态', () => {
  it('初始当前数据源为 AKShare 且连接状态 connected', () => {
    const cur = dataSourceService.getCurrentSource()
    expect(cur.key).toBe('akshare')
    expect(cur.name).toBe('AKShare')
    expect(dataSourceService.getConnectionStatus()).toBe('connected')
    expect(dataSourceService.getDataQuality()).toBe('high')
  })

  it('可用数据源列表包含 5 个内置源', () => {
    const keys = dataSourceService.getAvailableSources().map((s) => s.key)
    expect(keys).toContain('akshare')
    expect(keys).toContain('mock')
    expect(keys.length).toBe(5)
  })
})

describe('switchDataSource', () => {
  it('切换到已启用源成功，并触发 source-changed 事件', async () => {
    const onChanged = vi.fn()
    dataSourceService.on('source-changed', onChanged)
    try {
      const prev = dataSourceState.currentSource.key
      const result = await dataSourceService.switchDataSource('mock')
      expect(result.key).toBe('mock')
      expect(dataSourceState.currentSource.key).toBe('mock')
      expect(onChanged).toHaveBeenCalledTimes(1)
      const payload = onChanged.mock.calls[0][0]
      expect(payload.source).toBe('mock')
      expect(payload.previousSource).toBe(prev)
    } finally {
      dataSourceService.off('source-changed', onChanged)
      await dataSourceService.switchDataSource('akshare')
    }
  })

  it('未知数据源抛出带名称的错误', async () => {
    await expect(dataSourceService.switchDataSource('not-exist')).rejects.toThrow('数据源 not-exist 不存在')
  })

  it('不可用数据源（禁用/断开）切换被拒绝', async () => {
    const source = dataSourceService.getAvailableSources().find((s) => s.key === 'tushare')
    source.enabled = false
    try {
      await expect(dataSourceService.switchDataSource('tushare')).rejects.toThrow('当前不可用')
    } finally {
      source.enabled = true
    }
  })

  it('切换完成的最终态：loading 复位、error 清空、返回值即当前源', async () => {
    const result = await dataSourceService.switchDataSource('adata')
    expect(result).toBe(dataSourceState.currentSource)
    expect(result.key).toBe('adata')
    expect(dataSourceState.loading).toBe(false)
    expect(dataSourceState.error).toBeNull()
    await dataSourceService.switchDataSource('akshare')
  })
})

describe('updateSourceInfo', () => {
  it('名称前缀匹配把变体映射到已知数据源', () => {
    dataSourceService.updateSourceInfo({ source: 'AKShare每日数据', dataQuality: 'cached' })
    expect(dataSourceState.currentSource.key).toBe('akshare')
    expect(dataSourceState.currentSource.name).toBe('AKShare每日数据')
    expect(dataSourceState.dataQuality).toBe('cached')
  })

  it('数据质量映射：high/medium/low → high，模拟类 → simulated', () => {
    dataSourceService.updateSourceInfo({ source: 'akshare', dataQuality: 'low' })
    expect(dataSourceState.dataQuality).toBe('high')
    dataSourceService.updateSourceInfo({ source: 'mock', dataQuality: 'enhanced_simulation' })
    expect(dataSourceState.dataQuality).toBe('simulated')
    dataSourceService.updateSourceInfo({ source: 'mock', dataQuality: 'unknown_quality' })
    expect(dataSourceState.dataQuality).toBe('simulated')
  })

  it('futures-tick 键映射为友好名称', () => {
    dataSourceService.updateSourceInfo({ source: 'futures-tick', dataQuality: 'high' })
    expect(dataSourceState.currentSource.name).toBe('期货Tick数据')
  })

  it('触发 data-updated 事件且连接状态恒为 connected', () => {
    const spy = vi.fn()
    dataSourceService.on('data-updated', spy)
    dataSourceService.updateSourceInfo({ source: 'adata', dataQuality: 'high' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(dataSourceState.connectionStatus).toBe('connected')
    dataSourceService.off('data-updated', spy)
  })
})

describe('refreshSourceStatus', () => {
  it('成功响应更新各源状态并触发 status-refreshed', async () => {
    const spy = vi.fn()
    dataSourceService.on('status-refreshed', spy)
    request.get.mockResolvedValueOnce({
      success: true,
      data: { sources: { adata: { successRate: 88, enabled: true }, mock: { successRate: 100, enabled: false } } }
    })
    await dataSourceService.refreshSourceStatus()
    const adata = dataSourceService.getAvailableSources().find((s) => s.key === 'adata')
    const mock = dataSourceService.getAvailableSources().find((s) => s.key === 'mock')
    expect(adata.successRate).toBe(88)
    expect(adata.status).toBe('connected')
    expect(mock.status).toBe('disconnected')
    expect(mock.statusClass).toBe('source-disconnected')
    expect(spy).toHaveBeenCalledTimes(1)
    dataSourceService.off('status-refreshed', spy)
  })

  it('请求失败时写入 error 状态', async () => {
    request.get.mockRejectedValueOnce(new Error('network down'))
    await dataSourceService.refreshSourceStatus()
    expect(dataSourceState.error).toBe('network down')
    expect(dataSourceState.loading).toBe(false)
    dataSourceState.error = null
  })
})

describe('事件系统', () => {
  it('监听器抛错被捕获，不影响其他监听器', () => {
    const good = vi.fn()
    dataSourceService.on('evt', () => {
      throw new Error('bad listener')
    })
    dataSourceService.on('evt', good)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    dataSourceService.emit('evt', 42)
    expect(good).toHaveBeenCalledWith(42)
    errSpy.mockRestore()
    dataSourceService.off('evt', good)
  })
})

describe('useDataSource 组合式 API', () => {
  it('暴露计算属性与绑定方法', () => {
    const api = useDataSource()
    expect(api.currentSource.value.key).toBe(dataSourceState.currentSource.key)
    expect(typeof api.switchDataSource).toBe('function')
    expect(typeof api.refreshSourceStatus).toBe('function')
    expect(typeof api.updateSourceInfo).toBe('function')
    expect(typeof api.on).toBe('function')
    expect(typeof api.off).toBe('function')
  })
})

describe('destroy', () => {
  it('销毁后停止自动刷新并清空监听器', async () => {
    const spy = vi.fn()
    dataSourceService.on('source-changed', spy)
    const svc = dataSourceService
    svc.destroy()
    expect(svc.refreshInterval).toBeNull()
    // 监听器已清空：emit 不再触达 spy
    svc.emit('source-changed', { source: 'x' })
    expect(spy).not.toHaveBeenCalled()
    // 恢复：重新注册一个监听器不影响后续用例
  })
})
