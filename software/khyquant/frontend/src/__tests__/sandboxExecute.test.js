/**
 * sandboxExecute.test.js — 锁 src/utils/sandboxExecute.js 的沙箱执行契约：
 * 成功路径（signals/auxiliaryData 缺省归一）、language 透传、
 * 失败路径（success=false 与 HTTP 异常都 throw 且文案可定制）。
 * 不发起真实网络：mock @/utils/request。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}))

vi.mock('@/utils/request', () => ({
  default: { post: mocks.post },
}))

import { executeSandbox } from '@/utils/sandboxExecute'

beforeEach(() => {
  mocks.post.mockReset()
})

describe('executeSandbox', () => {
  it('成功：返回 signals + auxiliaryData 归一结构', async () => {
    mocks.post.mockResolvedValue({
      success: true,
      data: { signals: [{ side: 1, price: 100 }], auxiliaryData: { vol: 1.5 } },
    })
    const res = await executeSandbox({ code: 'x', klineData: [1, 2, 3] })
    expect(res).toEqual({ signals: [{ side: 1, price: 100 }], auxiliaryData: { vol: 1.5 } })
  })

  it('成功：data 缺 signals / auxiliaryData 时归一为 [] / {}', async () => {
    mocks.post.mockResolvedValue({ success: true, data: {} })
    const res = await executeSandbox({ code: 'x', klineData: [] })
    expect(res).toEqual({ signals: [], auxiliaryData: {} })
  })

  it('默认 language=javascript，parameters 默认 {}；透传给后端 payload', async () => {
    mocks.post.mockResolvedValue({ success: true, data: {} })
    await executeSandbox({ code: 'c', klineData: [1], parameters: { fast: 5 } })
    expect(mocks.post).toHaveBeenCalledWith('/strategies/execute-sandbox', {
      code: 'c',
      klineData: [1],
      parameters: { fast: 5 },
      language: 'javascript',
    })
  })

  it('language 与 parameters 显式透传', async () => {
    mocks.post.mockResolvedValue({ success: true, data: {} })
    await executeSandbox({ code: 'c', klineData: [1], parameters: {}, language: 'python' })
    expect(mocks.post).toHaveBeenCalledWith('/strategies/execute-sandbox', {
      code: 'c',
      klineData: [1],
      parameters: {},
      language: 'python',
    })
  })

  it('success=false 时 throw 且使用 res.message 文案', async () => {
    mocks.post.mockResolvedValue({ success: false, message: '策略语法错误: L12' })
    await expect(executeSandbox({ code: 'bad', klineData: [1] }))
      .rejects.toThrow('策略语法错误: L12')
  })

  it('success=false 且无 message 时 throw 默认文案', async () => {
    mocks.post.mockResolvedValue({ success: false })
    await expect(executeSandbox({ code: 'bad', klineData: [1] }))
      .rejects.toThrow('Strategy sandbox execution failed')
  })

  it('data 为 null 时（success=true）视同失败并 throw 默认文案', async () => {
    mocks.post.mockResolvedValue({ success: true, data: null })
    await expect(executeSandbox({ code: 'x', klineData: [1] }))
      .rejects.toThrow('Strategy sandbox execution failed')
  })

  it('HTTP 异常原样透传（不吞掉 network 错误）', async () => {
    const boom = new Error('Network Error')
    mocks.post.mockRejectedValue(boom)
    await expect(executeSandbox({ code: 'x', klineData: [1] })).rejects.toBe(boom)
  })
})
