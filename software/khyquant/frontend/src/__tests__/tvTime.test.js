// tvTime.test.js — 锁 Lightweight Charts 时间归一化口径
// 覆盖：多格式时间 → Unix 秒、K线数组过滤/排序/去重、十字光标时间解析
import { describe, it, expect } from 'vitest'
import { toUnixSeconds, itemToUnixSeconds, normalizeKlineForTV, parseCrosshairTime } from '@/utils/tvTime'

const T = 1700000000 // 固定基准秒

describe('toUnixSeconds', () => {
  it('空值返回 null', () => {
    expect(toUnixSeconds(null)).toBe(null)
    expect(toUnixSeconds(undefined)).toBe(null)
    expect(toUnixSeconds('')).toBe(null)
  })

  it('10 位秒级数字直接取整', () => {
    expect(toUnixSeconds(T)).toBe(T)
    expect(toUnixSeconds(T + 0.7)).toBe(T)
  })

  it('13 位毫秒数字换算为秒', () => {
    expect(toUnixSeconds(T * 1000 + 999)).toBe(T)
  })

  it('Date 对象转秒，非法 Date 返回 null', () => {
    expect(toUnixSeconds(new Date(T * 1000))).toBe(T)
    expect(toUnixSeconds(new Date('invalid'))).toBe(null)
  })

  it('轻量图表 BusinessDay 对象按 UTC 解析', () => {
    const ts = toUnixSeconds({ year: 2023, month: 11, day: 15 })
    expect(ts).toBe(Math.floor(new Date(Date.UTC(2023, 10, 15)).getTime() / 1000))
  })

  it('"YYYY-MM-DD" 字符串按 UTC 解析避免时区偏移', () => {
    expect(toUnixSeconds('2023-11-15')).toBe(Math.floor(new Date('2023-11-15T00:00:00Z').getTime() / 1000))
  })

  it('ISO 字符串可解析，乱码返回 null', () => {
    expect(toUnixSeconds('2023-11-15T10:00:00Z')).toBe(Math.floor(new Date('2023-11-15T10:00:00Z').getTime() / 1000))
    expect(toUnixSeconds('not-a-date')).toBe(null)
  })

  it('负数与 0 返回 null', () => {
    expect(toUnixSeconds(0)).toBe(null)
    expect(toUnixSeconds(-5)).toBe(null)
  })
})

describe('itemToUnixSeconds', () => {
  it('空对象返回 null', () => {
    expect(itemToUnixSeconds(null)).toBe(null)
    expect(itemToUnixSeconds({})).toBe(null)
  })

  it('按 time → date → trade_date → timestamp 顺序取第一个可解析值', () => {
    expect(itemToUnixSeconds({ time: T })).toBe(T)
    expect(itemToUnixSeconds({ date: T })).toBe(T)
    expect(itemToUnixSeconds({ trade_date: T })).toBe(T)
    expect(itemToUnixSeconds({ timestamp: T })).toBe(T)
    expect(itemToUnixSeconds({ time: null, date: null, trade_date: T + 1 })).toBe(T + 1)
  })
})

describe('normalizeKlineForTV', () => {
  it('非数组/空数组返回空数组', () => {
    expect(normalizeKlineForTV(null)).toEqual([])
    expect(normalizeKlineForTV('x')).toEqual([])
    expect(normalizeKlineForTV([])).toEqual([])
  })

  it('过滤无时间或 OHLC 非法的点', () => {
    const data = [
      { time: '2023-01-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { time: 'garbage', open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: '2023-01-02', open: -1, high: 2, low: 0.5, close: 1.5 },
      { date: '2023-01-03', open_price: 2, high_price: 3, low_price: 1, close_price: 2.5, vol: 33 }
    ]
    const out = normalizeKlineForTV(data)
    expect(out).toHaveLength(2)
    expect(out[1].open).toBe(2)
    expect(out[1].volume).toBe(33)
  })

  it('乱序输入排序升序并去重相同时间', () => {
    const data = [
      { time: '2023-01-03', open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: '2023-01-01', open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: '2023-01-03', open: 2, high: 2, low: 2, close: 2, volume: 2 },
      { time: '2023-01-02', open: 1, high: 1, low: 1, close: 1, volume: 1 }
    ]
    const out = normalizeKlineForTV(data)
    expect(out).toHaveLength(3)
    expect(out[0].time).toBeLessThan(out[1].time)
    expect(out[1].time).toBeLessThan(out[2].time)
    // 去重保留第一次出现
    expect(out.find((b) => b.time === out[2].time).close).toBe(1)
  })
})

describe('parseCrosshairTime', () => {
  it('可解析时间返回补零的年月日时分', () => {
    const out = parseCrosshairTime(T)
    expect(out.year).toBe(String(new Date(T * 1000).getFullYear()))
    expect(out.month).toMatch(/^(0[1-9]|1[0-2])$/)
    expect(out.day).toMatch(/^(0[1-9]|[12]\d|3[01])$/)
    expect(out.hour).toMatch(/^([01]\d|2[0-3])$/)
  })

  it('无法解析时返回全空占位', () => {
    expect(parseCrosshairTime(null)).toEqual({ year: '', month: '', day: '', hour: '00', minute: '00' })
  })

  it('BusinessDay 对象可解析', () => {
    const out = parseCrosshairTime({ year: 2023, month: 11, day: 15 })
    expect(out.day).toBe('15')
    expect(out.month).toBe('11')
  })
})
