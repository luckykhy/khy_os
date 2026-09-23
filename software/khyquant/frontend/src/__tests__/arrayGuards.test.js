/**
 * arrayGuards.test.js — locks the array-guard contract: ensureArray
 * fallback semantics, createSafeArrayRef get/set coercion, nested
 * validateApiArrayField path resolution, and the watch guard reset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ensureArray, createSafeArrayRef, validateApiArrayField, addArrayWatchGuard } from '../utils/arrayGuards.js'

describe('ensureArray', () => {
  it('returns arrays unchanged', () => {
    const arr = [1, 2, 3]
    expect(ensureArray(arr)).toBe(arr)
  })

  it('non-array → fallback (and logs an error)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(ensureArray(null, [], 'x')).toEqual([])
    expect(ensureArray('str', ['d'], 'y')).toEqual(['d'])
    expect(ensureArray(42)).toEqual([])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('createSafeArrayRef', () => {
  it('get coerces non-array value to [] and set coerces non-array writes to []', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const state = { value: null }
    const ref = createSafeArrayRef(state, 'items')
    expect(ref.value).toEqual([])
    ref.value = { not: 'array' }
    expect(state.value).toEqual([])
    ref.value = ['ok']
    expect(state.value).toEqual(['ok'])
    errSpy.mockRestore()
  })
})

describe('validateApiArrayField', () => {
  it('resolves nested "data.items" path', () => {
    const resp = { data: { items: [1, 2] } }
    expect(validateApiArrayField(resp, 'data.items')).toEqual([1, 2])
  })

  it('missing path → fallback', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateApiArrayField({ data: {} }, 'data.missing', ['f'])).toEqual(['f'])
    warnSpy.mockRestore()
  })

  it('field not an array → fallback', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(validateApiArrayField({ data: { items: 'nope' } }, 'data.items', ['f'])).toEqual(['f'])
    errSpy.mockRestore()
  })

  it('null response → fallback without throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateApiArrayField(null, 'data.items', ['f'])).toEqual(['f'])
    warnSpy.mockRestore()
  })
})

describe('addArrayWatchGuard', () => {
  it('resets the ref to [] when a non-array is written (immediate + on-change)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let cb = null
    const watch = vi.fn((refValue, handler, opts) => {
      cb = handler
      if (opts && opts.immediate) handler(refValue.value)
    })
    // Model a real ref indirection: the guard mutates the wrapped ref's .value,
    // and Vue's watch observes that same wrapped object, not our outer shell.
    const innerRef = { value: 'bad' }
    addArrayWatchGuard(innerRef, 'list', watch)
    expect(watch).toHaveBeenCalledWith(innerRef, expect.any(Function), { immediate: true })
    // immediate: seed 'bad' is non-array → guard forces it to []
    expect(innerRef.value).toEqual([])
    // a later non-array write is likewise forced back to []
    cb('not-array')
    expect(innerRef.value).toEqual([])
    // an array value passes through untouched by the guard
    cb(['fine'])
    expect(Array.isArray(innerRef.value)).toBe(true)
    errSpy.mockRestore()
  })
})

afterEach(() => vi.restoreAllMocks())
