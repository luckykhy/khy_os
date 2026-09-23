// simpleTradingHelpers.test.js — 锁交易界面辅助纯函数
// 覆盖：颜色/标签/语言映射、日期禁用规则、错误解析、时间格式化
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getStrategyTypeColor,
  getStrategyTypeLabel,
  getLanguageColor,
  getLanguageName,
  disabledStartDate,
  disabledEndDate,
  parseTradingError,
  formatTime,
  formatDateTime
} from '@/utils/simpleTradingHelpers'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('getStrategyTypeColor', () => {
  it('已知类型映射到主题色，未知回退 info', () => {
    expect(getStrategyTypeColor('macd')).toBe('primary')
    expect(getStrategyTypeColor('rsi')).toBe('warning')
    expect(getStrategyTypeColor('ma')).toBe('success')
    expect(getStrategyTypeColor('bollinger')).toBe('info')
    expect(getStrategyTypeColor('momentum')).toBe('danger')
    expect(getStrategyTypeColor('unknown')).toBe('info')
  })
})

describe('getStrategyTypeLabel', () => {
  it('中英文标签映射，未知类型原样返回', () => {
    expect(getStrategyTypeLabel('trend')).toBe('趋势')
    expect(getStrategyTypeLabel('mean_reversion')).toBe('均值回归')
    expect(getStrategyTypeLabel('arbitrage')).toBe('套利')
    expect(getStrategyTypeLabel('my_type')).toBe('my_type')
  })
})

describe('语言映射', () => {
  it('getLanguageColor 已知/未知', () => {
    expect(getLanguageColor('javascript')).toBe('warning')
    expect(getLanguageColor('python')).toBe('success')
    expect(getLanguageColor('rust')).toBe('info')
  })

  it('getLanguageName 已知/未知', () => {
    expect(getLanguageName('javascript')).toBe('JavaScript')
    expect(getLanguageName('python')).toBe('Python')
    expect(getLanguageName('unknown')).toBe('unknown')
  })
})

describe('日期禁用规则', () => {
  it('非 Date 或空值一律禁用', () => {
    expect(disabledStartDate(null)).toBe(true)
    expect(disabledStartDate(undefined)).toBe(true)
    expect(disabledStartDate('2024-01-01')).toBe(true)
  })

  it('未来日期禁用，过去日期可用', () => {
    expect(disabledStartDate(new Date(Date.now() + 86400000))).toBe(true)
    expect(disabledStartDate(new Date(Date.now() - 86400000))).toBe(false)
  })

  it('disabledEndDate 早于开始日期时禁用', () => {
    const start = new Date(Date.now() - 86400000)
    expect(disabledEndDate(new Date(start.getTime() - 1000), start)).toBe(true)
    expect(disabledEndDate(new Date(start.getTime() + 1000), start)).toBe(false)
  })

  it('disabledEndDate 无开始日期时只看是否未来', () => {
    expect(disabledEndDate(new Date(Date.now() - 1000), undefined)).toBe(false)
    expect(disabledEndDate(new Date(Date.now() + 86400000), null)).toBe(true)
  })
})

describe('parseTradingError', () => {
  it('字符串原样返回', () => {
    expect(parseTradingError('网络超时')).toBe('网络超时')
  })

  it('Error 实例取 message', () => {
    expect(parseTradingError(new Error('boom'))).toBe('boom')
  })

  it('对象错误按 message → msg → error → data.message → response.data.message 顺序解析', () => {
    expect(parseTradingError({ message: 'm1' })).toBe('m1')
    expect(parseTradingError({ msg: 'm2' })).toBe('m2')
    expect(parseTradingError({ error: 'm3' })).toBe('m3')
    expect(parseTradingError({ data: { message: 'm4' } })).toBe('m4')
    expect(parseTradingError({ response: { data: { message: 'm5' } } })).toBe('m5')
  })

  it('网络错误 code 拼接可读前缀', () => {
    expect(parseTradingError({ code: 'ECONNABORTED' })).toBe('网络错误: ECONNABORTED')
  })

  it('无 message 的普通对象降级为对象错误描述', () => {
    const out = parseTradingError({ a: 1 })
    expect(out).toContain('对象错误')
  })

  it('空对象与空值回退系统错误', () => {
    expect(parseTradingError({})).toBe('未知对象错误')
    expect(parseTradingError(123)).toBe('系统错误')
  })
})

describe('时间格式化', () => {
  it('formatTime 输出 HH:mm:ss', () => {
    const t = new Date(2024, 5, 1, 9, 5, 3)
    expect(formatTime(t.getTime())).toBe('09:05:03')
  })

  it('formatDateTime 空值输出占位符', () => {
    expect(formatDateTime('')).toBe('-')
    expect(formatDateTime(null)).toBe('-')
  })

  it('formatDateTime 输出中文年月日时分', () => {
    const out = formatDateTime(new Date(2024, 11, 31, 8, 9).toISOString())
    expect(out).toContain('2024')
    expect(out).toContain('12')
    expect(out).toContain('31')
    expect(out).toMatch(/年.*月.*日/)
  })
})
