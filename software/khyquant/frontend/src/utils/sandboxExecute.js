/**
 * Execute strategy code via the backend vm sandbox.
 * Replaces all frontend `new Function()` calls so user-authored code
 * never runs in the browser's main thread.
 *
 * @param {object} opts
 * @param {string} opts.code       - Strategy source code
 * @param {Array}  opts.klineData  - K-line bar array
 * @param {object} [opts.parameters] - Strategy parameters
 * @param {string} [opts.language]   - 'javascript' | 'python' | 'tdx'
 * @returns {Promise<{signals: Array, auxiliaryData: object}>}
 */
import request from '@/utils/request'

export async function executeSandbox({ code, klineData, parameters = {}, language = 'javascript' }) {
  const res = await request.post('/strategies/execute-sandbox', {
    code,
    klineData,
    parameters,
    language,
  })

  if (res.success && res.data) {
    return {
      signals: res.data.signals || [],
      auxiliaryData: res.data.auxiliaryData || {},
    }
  }

  throw new Error(res.message || 'Strategy sandbox execution failed')
}
