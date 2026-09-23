// clientMode.test.js — 锁客户端模式解析（auto/mobile/desktop）
// 覆盖：偏好存取、URL 查询参数、自动探测（UA/宽度/触摸）、解析优先级、变更事件
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getClientModePreference,
  setClientModePreference,
  getModeFromQuery,
  detectAutoClientMode,
  resolveClientMode,
  notifyClientModeChanged
} from '@/utils/clientMode'

const KEY = 'khy_client_mode'

beforeEach(() => {
  window.localStorage.removeItem(KEY)
  window.history.replaceState(null, '', '/')
})
afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('偏好存取', () => {
  it('无偏好时默认 auto', () => {
    expect(getClientModePreference()).toBe('auto')
  })

  it('合法偏好可读写（大小写/空白归一）', () => {
    setClientModePreference('MOBILE ')
    expect(getClientModePreference()).toBe('mobile')
    setClientModePreference('desktop')
    expect(window.localStorage.getItem(KEY)).toBe('desktop')
  })

  it('非法偏好被忽略', () => {
    setClientModePreference('tablet')
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(getClientModePreference()).toBe('auto')
  })
})

describe('URL 查询参数', () => {
  it('view/mobile 参数可读取', () => {
    window.history.replaceState(null, '', '/?view=mobile')
    expect(getModeFromQuery()).toBe('mobile')
    window.history.replaceState(null, '', '/?mode=desktop')
    expect(getModeFromQuery()).toBe('desktop')
    window.history.replaceState(null, '', '/?mode=auto')
    expect(getModeFromQuery()).toBe('auto')
  })

  it('非法参数值返回 null', () => {
    window.history.replaceState(null, '', '/?view=tablet')
    expect(getModeFromQuery()).toBe(null)
    window.history.replaceState(null, '', '/')
    expect(getModeFromQuery()).toBe(null)
  })
})

describe('自动探测', () => {
  function setUa(ua) {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
  }
  function setWidth(w) {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(w)
  }

  afterEach(() => vi.restoreAllMocks())

  it('手机 UA 优先判定为 mobile（即使宽度大）', () => {
    setUa('Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile')
    setWidth(1920)
    expect(detectAutoClientMode()).toBe('mobile')
  })

  it('小视口（≤768）判定为 mobile', () => {
    setUa('Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120')
    setWidth(768)
    expect(detectAutoClientMode()).toBe('mobile')
  })

  it('平板 UA + 触摸 + 宽度≤900 判定为 mobile', () => {
    setUa('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)')
    setWidth(820)
    Object.defineProperty(window, 'ontouchstart', { value: undefined, configurable: true })
    expect(detectAutoClientMode()).toBe('mobile')
  })

  it('桌面 UA + 宽视口判定为 desktop', () => {
    setUa('Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120')
    setWidth(1440)
    delete window.ontouchstart
    expect(detectAutoClientMode()).toBe('desktop')
  })

  it('宽度为 0 时跳过视口判定', () => {
    setUa('Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120')
    setWidth(0)
    expect(detectAutoClientMode()).toBe('desktop')
  })
})

describe('resolveClientMode 优先级', () => {
  it('URL 参数优先于 localStorage 偏好', () => {
    setClientModePreference('mobile')
    window.history.replaceState(null, '', '/?view=desktop')
    expect(resolveClientMode()).toEqual({ preference: 'desktop', resolved: 'desktop' })
  })

  it('显式偏好直接生效，不走探测', () => {
    setClientModePreference('desktop')
    expect(resolveClientMode()).toEqual({ preference: 'desktop', resolved: 'desktop' })
  })

  it('auto 偏好走自动探测', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0; Win64')
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440)
    delete window.ontouchstart
    const { preference, resolved } = resolveClientMode()
    expect(preference).toBe('auto')
    expect(resolved).toBe('desktop')
  })
})

describe('notifyClientModeChanged', () => {
  it('派发 khy-client-mode-changed 事件', () => {
    const spy = vi.fn()
    window.addEventListener('khy-client-mode-changed', spy)
    notifyClientModeChanged()
    expect(spy).toHaveBeenCalledTimes(1)
    window.removeEventListener('khy-client-mode-changed', spy)
  })
})
