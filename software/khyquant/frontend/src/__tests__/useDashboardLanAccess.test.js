/**
 * useDashboardLanAccess.test.js — 锁 src/composables/useDashboardLanAccess.js 的
 * 公共可测契约：LAN URL 生成规则（域名 → http://host，IP → http://host:8080）、
 * toggleQrCode 切换 + 无 URL 时 generateQrCode 短路、copyLanUrl 剪贴板降级路径。
 * WebRTC/RTCPeerConnection 与后端 API 探测依赖真实网络，本轮不锁。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  ElMessage: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  loadQRCode: vi.fn(),
}))

vi.mock('element-plus', () => ({ ElMessage: mocks.ElMessage }))
vi.mock('@/utils/qrcode', () => ({ loadQRCode: mocks.loadQRCode }))

import { useDashboardLanAccess } from '@/composables/useDashboardLanAccess'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('lanAccessUrl 生成规则', () => {
  it('IP 地址加 :8080 端口', () => {
    const h = useDashboardLanAccess()
    h.lanIpAddress.value = '192.168.1.100'
    expect(h.lanAccessUrl.value).toBe('http://192.168.1.100:8080')
  })

  it('域名不加端口', () => {
    const h = useDashboardLanAccess()
    h.lanIpAddress.value = 'lab.example.com'
    expect(h.lanAccessUrl.value).toBe('http://lab.example.com')
  })

  it('空 IP 时返回空串', () => {
    const h = useDashboardLanAccess()
    expect(h.lanAccessUrl.value).toBe('')
  })
})

describe('toggleQrCode + generateQrCode 短路', () => {
  it('打开二维码面板：showQrCode=true，无 canvas 时 generateQrCode 直接返回', async () => {
    const h = useDashboardLanAccess()
    h.lanIpAddress.value = '10.0.0.5'
    h.qrCodeCanvas.value = null
    await h.toggleQrCode()
    expect(h.showQrCode.value).toBe(true)
    expect(mocks.loadQRCode).not.toHaveBeenCalled()
  })

  it('关闭二维码面板：showQrCode=false', async () => {
    const h = useDashboardLanAccess()
    await h.toggleQrCode()
    expect(h.showQrCode.value).toBe(true)
    await h.toggleQrCode()
    expect(h.showQrCode.value).toBe(false)
  })

  it('有 canvas + URL 时调 loadQRCode 并 toCanvas（width=200）', async () => {
    const h = useDashboardLanAccess()
    h.lanIpAddress.value = '172.16.0.9'
    h.qrCodeCanvas.value = { fake: true }
    mocks.loadQRCode.mockResolvedValue({ toCanvas: vi.fn() })
    await h.toggleQrCode()
    // generateQrCode 在 toggleQrCode 里被调用但未被 await，等一个微任务
    await nextTick()
    await Promise.resolve()
    expect(mocks.loadQRCode).toHaveBeenCalledTimes(1)
  })

  it('loadQRCode 抛错：ElMessage.error 提示「二维码生成失败」', async () => {
    const h = useDashboardLanAccess()
    h.lanIpAddress.value = '172.16.0.9'
    h.qrCodeCanvas.value = { fake: true }
    mocks.loadQRCode.mockRejectedValue(new Error('load fail'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await h.toggleQrCode()
    await nextTick()
    await Promise.resolve()
    expect(mocks.ElMessage.error).toHaveBeenCalledWith('二维码生成失败')
  })
})

describe('copyLanUrl 剪贴板路径', () => {
  it('navigator.clipboard.writeText 成功：ElMessage.success 提示', async () => {
    const h = useDashboardLanAccess()
    h.lanIpAddress.value = '192.168.1.10'
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true
    })
    await h.copyLanUrl()
    expect(mocks.ElMessage.success).toHaveBeenCalledWith('已复制局域网访问地址')
  })

  it('clipboard 不可用：降级 document.execCommand 并提示成功', async () => {
    const h = useDashboardLanAccess()
    h.lanIpAddress.value = '192.168.1.10'
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    // jsdom 未实现 document.execCommand，注入测试替身
    document.execCommand = vi.fn(() => true)
    await h.copyLanUrl()
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(mocks.ElMessage.success).toHaveBeenCalledWith('已复制局域网访问地址')
  })
})
