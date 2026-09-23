/**
 * errorMessage.test.js — locks the friendly-error-mapping contract:
 * response.data.message enrichment (field/hint/error suffix), known
 * network/timeout signatures, and the fallback chain. If a mapping drifts,
 * this test goes red first.
 */
import { describe, it, expect } from 'vitest'
import { getFriendlyErrorMessage } from '../utils/errorMessage.js'

describe('getFriendlyErrorMessage', () => {
  it('response.data.message with field+hint → "msg [field] hint"', () => {
    const err = { response: { data: { message: '密码错误', details: { field: 'password', hint: '请输入至少 8 位' } } } }
    expect(getFriendlyErrorMessage(err)).toBe('密码错误 [password] 请输入至少 8 位')
  })

  it('response.data.message with field only → "msg [field]"', () => {
    const err = { response: { data: { message: '余额不足', details: { field: 'amount' } } } }
    expect(getFriendlyErrorMessage(err)).toBe('余额不足 [amount]')
  })

  it('response.data.message + distinct error suffix → "msg: error"', () => {
    const err = { response: { data: { message: '订单拒绝', error: 'RISK_REJECT' } } }
    expect(getFriendlyErrorMessage(err)).toBe('订单拒绝: RISK_REJECT')
  })

  it('response.data.message with error same as message → bare message', () => {
    const err = { response: { data: { message: 'same', error: 'same' } } }
    expect(getFriendlyErrorMessage(err)).toBe('same')
  })

  it('error.message "Network Error" → network hint (中文)', () => {
    expect(getFriendlyErrorMessage({ message: 'Network Error' })).toBe('网络连接异常，请检查网络后重试')
  })

  it('error.message containing "timeout" → timeout hint (中文)', () => {
    expect(getFriendlyErrorMessage({ message: 'Request timeout' })).toBe('请求超时，请稍后重试')
  })

  it('plain error.message is passed through', () => {
    expect(getFriendlyErrorMessage({ message: 'something bad' })).toBe('something bad')
  })

  it('empty error → caller fallback', () => {
    expect(getFriendlyErrorMessage(null, '兜底文案')).toBe('兜底文案')
    expect(getFriendlyErrorMessage(undefined)).toBe('操作失败，请稍后重试')
  })

  it('whitespace-only message falls through to next branch', () => {
    expect(getFriendlyErrorMessage({ message: '   ' })).toBe('操作失败，请稍后重试')
  })
})
