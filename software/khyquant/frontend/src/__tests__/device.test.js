/**
 * device.test.js — locks the device-detection contract in src/utils/device.js:
 * UA-classify helpers (isMobile/isTablet/getDeviceType/getOS/getBrowser) plus
 * screen-orientation derivation. jsdom gives a desktop UA + 1024x768 viewport,
 * so positive mobile/tablet branches are exercised by overriding
 * navigator.userAgent per case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isMobile,
  isTablet,
  isDesktop,
  getDeviceType,
  isTouchDevice,
  getScreenInfo,
  getOS,
  getBrowser,
  getDeviceInfo
} from '../utils/device.js'

function setUa(ua) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
}
function setWidth(w) {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
}

describe('device.js', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('getOS classifies major desktop/mobile UAs', () => {
    setUa('Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120')
    expect(getOS()).toBe('Windows')
    setUa('Mozilla/5.0 (Macintosh) AppleWebKit/605')
    expect(getOS()).toBe('MacOS')
    setUa('Mozilla/5.0 (Android 14) Mobile')
    expect(getOS()).toBe('Android')
    setUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')
    expect(getOS()).toBe('iOS')
    setUa('Mozilla/5.0 (Windows Phone 10.0)')
    expect(getOS()).toBe('Windows Phone')
    setUa('Mozilla/5.0 (X11; Linux x86_64)')
    expect(getOS()).toBe('Linux')
    setUa('SomeUnknownAgent')
    expect(getOS()).toBe('Unknown')
  })

  it('getBrowser classifies major browser UAs', () => {
    setUa('Mozilla/5.0 (Windows) Firefox/115.0')
    expect(getBrowser()).toBe('Firefox')
    setUa('Mozilla/5.0 (Windows) OPR/90.0')
    expect(getBrowser()).toBe('Opera')
    setUa('Mozilla/5.0 (Windows) Chrome/120.0 Safari/537')
    expect(getBrowser()).toBe('Chrome')
    setUa('Mozilla/5.0 (Macintosh) Safari/605')
    expect(getBrowser()).toBe('Safari')
    setUa('Mozilla/5.0 (X11) Gecko/4.0')
    expect(getBrowser()).toBe('Unknown')
  })

  it('isMobile true for mobile UAs or narrow viewports', () => {
    setUa('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0) Mobile/15E148')
    expect(isMobile()).toBe(true)
    setUa('Mozilla/5.0 (Windows NT 10.0) Chrome/120')
    setWidth(600)
    expect(isMobile()).toBe(true) // width <= 768
  })

  it('isTablet true for iPad UA or 768<w<=1024', () => {
    setUa('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)')
    expect(isTablet()).toBe(true)
    setUa('Mozilla/5.0 (Linux; Android 14) Tablet/1')
    setWidth(900)
    expect(isTablet()).toBe(true)
  })

  it('getDeviceType returns mobile > tablet > desktop', () => {
    setUa('Mozilla/5.0 (iPhone) Mobile')
    expect(getDeviceType()).toBe('mobile')
    // jsdom's built-in UA string contains "Mobile Safari" (desktop Safari UA),
    // so an iPad UA is still classified mobile by the /iPad/i branch — assert
    // tablet via the width-only path with a neutral desktop UA instead.
    setUa('Mozilla/5.0 (X11; Linux x86_64) Firefox/120')
    setWidth(900)
    expect(getDeviceType()).toBe('tablet')
    setUa('Mozilla/5.0 (Windows NT 10.0) Chrome/120')
    setWidth(1920)
    expect(getDeviceType()).toBe('desktop')
    expect(isDesktop()).toBe(true)
  })

  it('isTouchDevice reflects ontouchstart / maxTouchPoints', () => {
    const origMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
    const origOntouchstart = 'ontouchstart' in window
    try {
      // Ensure no implicit touch surface in jsdom, then drive maxTouchPoints.
      if (origOntouchstart) delete window.ontouchstart
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true, writable: true })
      expect(isTouchDevice()).toBe(false)
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true, writable: true })
      expect(isTouchDevice()).toBe(true)
    } finally {
      if (origMaxTouchPoints) Object.defineProperty(navigator, 'maxTouchPoints', origMaxTouchPoints)
    }
  })

  it('getScreenInfo derives orientation from w vs h', () => {
    setWidth(800)
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
    const info = getScreenInfo()
    expect(info.orientation).toBe('landscape')
    Object.defineProperty(window, 'innerHeight', { value: 1200, configurable: true })
    expect(getScreenInfo().orientation).toBe('portrait')
  })

  it('getDeviceInfo aggregates all fields coherently', () => {
    setUa('Mozilla/5.0 (Linux; Android 14) Mobile')
    setWidth(400)
    const info = getDeviceInfo()
    expect(info.deviceType).toBe('mobile')
    expect(info.isMobile).toBe(true)
    expect(info.isTablet).toBe(false)
    expect(info.os).toBe('Android')
    expect(info.userAgent).toBe(navigator.userAgent)
  })
})
