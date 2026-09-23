/**
 * useFuturesTickData.test.js — locks the futures-tick data composable contract:
 * three-shape response unwrapping (data.data / data.dates / raw array), the
 * loading flag lifecycle, the empty-date short-circuit, and formatDate's
 * YYYYMMDD→YYYY-MM-DD normalization.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the axios-ish request module so the composable runs against fake payloads.
vi.mock('../api/request.js', () => ({
  default: {
    get: vi.fn(),
  },
}))

import { useFuturesTickData } from '../composables/useFuturesTickData.js'
import request from '../api/request.js'

function getComposable() {
  return useFuturesTickData()
}

describe('useFuturesTickData', () => {
  beforeEach(() => {
    request.get.mockReset()
  })

  it('loadDates unwraps res.data.data and resets the loading flag', async () => {
    request.get.mockResolvedValueOnce({ data: { data: ['20260101', '20260102'] } })
    const s = getComposable()
    expect(s.loading.value).toBe(false)
    await s.loadDates()
    expect(s.availableDates.value).toEqual(['20260101', '20260102'])
    expect(s.loading.value).toBe(false)
    expect(request.get).toHaveBeenCalledWith('/futures-tick/dates')
  })

  it('loadDates accepts the data.dates and raw-array shapes, else []', async () => {
    request.get.mockResolvedValueOnce({ data: { dates: ['20260101'] } })
    const a = getComposable()
    await a.loadDates()
    expect(a.availableDates.value).toEqual(['20260101'])

    request.get.mockResolvedValueOnce({ data: ['x', 'y'] })
    const b = getComposable()
    await b.loadDates()
    expect(b.availableDates.value).toEqual(['x', 'y'])

    request.get.mockResolvedValueOnce({ data: { unexpected: 1 } })
    const c = getComposable()
    await c.loadDates()
    expect(c.availableDates.value).toEqual([])
  })

  it('loadDates failure resets to [] without throwing', async () => {
    request.get.mockRejectedValueOnce(new Error('network down'))
    const s = getComposable()
    s.availableDates.value = ['stale']
    await s.loadDates()
    expect(s.availableDates.value).toEqual([])
    expect(s.loading.value).toBe(false)
  })

  it('loadSymbols no-ops when date is empty', async () => {
    const s = getComposable()
    await s.loadSymbols('')
    expect(request.get).not.toHaveBeenCalled()
  })

  it('loadSymbols unwraps the symbols shape for the given date', async () => {
    request.get.mockResolvedValueOnce({ data: { symbols: ['IF', 'IC'] } })
    const s = getComposable()
    await s.loadSymbols('20260101')
    expect(s.availableSymbols.value).toEqual(['IF', 'IC'])
    expect(request.get).toHaveBeenCalledWith('/futures-tick/symbols', { params: { date: '20260101' } })
  })

  it('refreshIndex is an alias of loadDates', async () => {
    request.get.mockResolvedValueOnce({ data: { data: ['d1'] } })
    const s = getComposable()
    await s.refreshIndex()
    expect(s.availableDates.value).toEqual(['d1'])
  })

  it('formatDate normalizes YYYYMMDD to YYYY-MM-DD and passes through others', () => {
    const s = getComposable()
    expect(s.formatDate('20260105')).toBe('2026-01-05')
    expect(s.formatDate('2026-01-05')).toBe('2026-01-05')
    expect(s.formatDate('')).toBe('')
    expect(s.formatDate(null)).toBe('')
    // a non-8-char value returns the original string
    expect(s.formatDate('2026')).toBe('2026')
  })
})
