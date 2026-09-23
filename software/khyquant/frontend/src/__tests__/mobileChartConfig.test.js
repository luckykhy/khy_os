/**
 * mobileChartConfig.test.js — locks the chart-config contract in
 * src/utils/mobileChartConfig.ts: mobile vs desktop option shapes, the
 * isMobile dispatch in getChartOptions, and the time formatters'
 * date-only vs date+time rules. If the config keys drift, this goes red first.
 */
import { describe, it, expect } from 'vitest'
import {
  getMobileChartOptions,
  getMobileCandlestickOptions,
  getMobilePriceScaleOptions,
  getMobileTimeScaleOptions,
  getDesktopChartOptions,
  getChartOptions
} from '../utils/mobileChartConfig.ts'

describe('mobileChartConfig', () => {
  it('getMobileChartOptions carries the mobile-sized layout and disabled default gestures', () => {
    const cfg = getMobileChartOptions(360, 240)
    expect(cfg.width).toBe(360)
    expect(cfg.height).toBe(240)
    expect(cfg.layout.fontSize).toBe(12)
    // mobile disables built-in scroll/scale so custom gestures own the canvas
    expect(cfg.handleScroll).toMatchObject({ mouseWheel: false, horzTouchDrag: false })
    expect(cfg.handleScale).toMatchObject({ pinch: false })
    expect(cfg.kineticScroll).toMatchObject({ touch: false, mouse: false })
  })

  it('getMobileCandlestickOptions sets fixed up/down colors and price precision', () => {
    const s = getMobileCandlestickOptions()
    expect(s.upColor).toBe('#26a69a')
    expect(s.priceFormat).toEqual({ type: 'price', precision: 2, minMove: 0.01 })
  })

  it('getMobilePriceScaleOptions locks the scale margins', () => {
    const p = getMobilePriceScaleOptions()
    expect(p.scaleMargins).toEqual({ top: 0.1, bottom: 0.2 })
    expect(p.autoScale).toBe(true)
  })

  it('getMobileTimeScaleOptions keeps rightOffset=5 and barSpacing=8', () => {
    const t = getMobileTimeScaleOptions()
    expect(t.rightOffset).toBe(5)
    expect(t.barSpacing).toBe(8)
    expect(t.lockVisibleTimeRangeOnResize).toBe(true)
  })

  it('getDesktopChartOptions enables default gestures (mobile inverse)', () => {
    const cfg = getDesktopChartOptions(1280, 720)
    expect(cfg.width).toBe(1280)
    expect(cfg.layout.fontSize).toBe(11)
    expect(cfg.handleScroll).toMatchObject({ mouseWheel: true, horzTouchDrag: true })
    expect(cfg.handleScale).toMatchObject({ pinch: true })
  })

  it('getChartOptions dispatches mobile vs desktop by flag', () => {
    // The config objects contain function values (tickMarkFormatter /
    // timeFormatter) that `toEqual` cannot compare, so assert the dispatch by
    // the discriminator fields: mobile keeps the built-in gestures off while
    // desktop enables them.
    const mobile = getChartOptions(true, 320, 480)
    const desktop = getChartOptions(false, 1024, 600)
    // mobile branch shape
    expect(mobile).toMatchObject({ width: 320, height: 480, handleScale: { pinch: false } })
    expect(mobile.kineticScroll).toMatchObject({ touch: false, mouse: false })
    // desktop branch shape
    expect(desktop).toMatchObject({ width: 1024, height: 600, handleScale: { pinch: true } })
    expect(desktop.handleScroll).toMatchObject({ mouseWheel: true, horzTouchDrag: true })
    // discriminator: same dims, different gesture policy
    expect(getChartOptions(true, 320, 480).handleScale.pinch).toBe(false)
    expect(getChartOptions(false, 320, 480).handleScale.pinch).toBe(true)
  })

  it('tickMarkFormatter renders M/D and timeFormatter renders date(+time)', () => {
    const m = getMobileChartOptions(100, 100)
    const ts = new Date(2026, 0, 5, 15, 30).getTime() / 1000 // local 2026-01-05 15:30
    expect(m.timeScale.tickMarkFormatter(ts)).toBe('1/5')

    // date+time case: hour/minute not both 00 → full datetime
    const withTime = m.localization.timeFormatter(ts)
    expect(withTime).toContain('15:30')
    expect(withTime).toContain('2026年01月05日')

    // date-only case: midnight → no time suffix
    const midnight = new Date(2026, 2, 9).getTime() / 1000
    const dateOnly = m.localization.timeFormatter(midnight)
    expect(dateOnly).toBe('2026年03月09日')
  })
})
