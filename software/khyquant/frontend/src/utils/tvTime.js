/**
 * TradingView Lightweight Charts time normalization utilities.
 *
 * Provides robust conversion from any time format to Unix seconds,
 * which Lightweight Charts accepts for all chart types.
 */

/**
 * Convert any raw time value into Unix seconds (integer).
 * Handles: "YYYY-MM-DD", ISO strings, unix seconds, unix ms,
 * Date objects, undefined/null, and Lightweight Charts BusinessDay objects.
 *
 * @param {*} raw - A time value (string, number, Date, object, or falsy)
 * @returns {number|null} Unix seconds or null if unparseable
 */
export function toUnixSeconds(raw) {
  if (raw == null) return null

  // Already unix seconds (10-digit-ish number, before year ~5138)
  if (typeof raw === 'number' && raw > 0 && raw < 1e11) return Math.floor(raw)

  // Unix milliseconds (13-digit number)
  if (typeof raw === 'number' && raw >= 1e11) return Math.floor(raw / 1000)

  // Date object
  if (raw instanceof Date) {
    const ms = raw.getTime()
    return isNaN(ms) ? null : Math.floor(ms / 1000)
  }

  // Lightweight Charts BusinessDay object { year, month, day }
  if (typeof raw === 'object' && raw.year && raw.month && raw.day) {
    const d = new Date(Date.UTC(raw.year, raw.month - 1, raw.day))
    return Math.floor(d.getTime() / 1000)
  }

  // String — parse via Date
  if (typeof raw === 'string' && raw.length > 0) {
    // "YYYY-MM-DD" — parse as UTC to avoid timezone shift
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const d = new Date(raw + 'T00:00:00Z')
      const ms = d.getTime()
      return isNaN(ms) ? null : Math.floor(ms / 1000)
    }
    // Any other string — try Date.parse
    const ms = Date.parse(raw)
    return isNaN(ms) ? null : Math.floor(ms / 1000)
  }

  return null
}

/**
 * Extract the best available time from a kline item and return Unix seconds.
 * Tries: time, date, trade_date, timestamp — in order.
 *
 * @param {object} item - A kline data point
 * @returns {number|null} Unix seconds or null
 */
export function itemToUnixSeconds(item) {
  if (!item) return null
  return (
    toUnixSeconds(item.time) ??
    toUnixSeconds(item.date) ??
    toUnixSeconds(item.trade_date) ??
    toUnixSeconds(item.timestamp) ??
    null
  )
}

/**
 * Normalize an entire kline array for Lightweight Charts (unix seconds).
 * Filters out items with unparseable time or invalid OHLC.
 * Returns a sorted, deduplicated array.
 *
 * @param {Array} data - Raw kline array from any backend source
 * @returns {Array} Normalized array ready for candlestickSeries.setData()
 */
export function normalizeKlineForTV(data) {
  if (!Array.isArray(data) || data.length === 0) return []

  const result = []
  for (const item of data) {
    const time = itemToUnixSeconds(item)
    if (!time) continue

    const open = parseFloat(item.open ?? item.open_price ?? 0)
    const high = parseFloat(item.high ?? item.high_price ?? 0)
    const low = parseFloat(item.low ?? item.low_price ?? 0)
    const close = parseFloat(item.close ?? item.close_price ?? 0)
    const volume = parseInt(item.volume ?? item.vol ?? 0, 10) || 0

    if (isNaN(open) || isNaN(close) || open <= 0 || close <= 0) continue

    result.push({ time, open, high, low, close, volume })
  }

  // Sort ascending by time
  result.sort((a, b) => a.time - b.time)

  // Deduplicate by time
  const unique = []
  let prev = null
  for (const item of result) {
    if (item.time !== prev) {
      unique.push(item)
      prev = item.time
    }
  }

  return unique
}

/**
 * Format a Lightweight Charts crosshair param.time for display.
 * Handles unix seconds, string, and BusinessDay object.
 *
 * @param {*} time - param.time from crosshair callback
 * @returns {{ year: string, month: string, day: string }} date parts
 */
export function parseCrosshairTime(time) {
  const ts = toUnixSeconds(time)
  if (ts == null) return { year: '', month: '', day: '', hour: '00', minute: '00' }
  const d = new Date(ts * 1000)
  return {
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1).padStart(2, '0'),
    day: String(d.getDate()).padStart(2, '0'),
    hour: String(d.getHours()).padStart(2, '0'),
    minute: String(d.getMinutes()).padStart(2, '0'),
  }
}
