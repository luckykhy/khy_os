const DEFAULT_ALIASES = {
  datetime: ['datetime', 'timestamp', 'datetimeutc', '交易时间', '时间', '日期时间', '更新时间'],
  date: ['date', 'tradingdate', 'actionday', '交易日', '日期'],
  time: ['time', 'updatetime', '更新时间'],
  open: ['open', 'openprice', '开盘价', '开盘'],
  high: ['high', 'highprice', '最高价', '最高'],
  low: ['low', 'lowprice', '最低价', '最低'],
  close: ['close', 'closeprice', 'last', 'lastprice', 'price', '成交价', '最新价', '最新', '收盘价', '收盘'],
  volume: ['volume', 'vol', 'qty', 'quantity', '成交量', '手数'],
  amount: ['amount', 'turnover', '成交额', '成交金额']
}

function detectDelimiter(headerLine = '') {
  const delimiters = [',', ';', '\t', '|']
  let best = ','
  let bestCount = -1
  for (const d of delimiters) {
    const count = headerLine.split(d).length
    if (count > bestCount) {
      best = d
      bestCount = count
    }
  }
  return best
}

function splitCsvLine(line, delimiter) {
  const out = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      const next = line[i + 1]
      if (quoted && next === '"') {
        current += '"'
        i += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (ch === delimiter && !quoted) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  out.push(current.trim())
  return out
}

function normalizeHeader(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-()[\]{}]/g, '')
}

function parseNumeric(value) {
  if (value === undefined || value === null || value === '') return null
  const normalized = String(value).replace(/,/g, '').trim()
  const num = Number(normalized)
  return Number.isFinite(num) ? num : null
}

function parseTimestamp(value, fallbackDate, fallbackTime) {
  let text = value
  if ((!text || text === '') && fallbackDate && fallbackTime) {
    text = `${fallbackDate} ${fallbackTime}`
  }
  if (!text || text === '') return null

  const trimmed = String(text).trim()

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed)
    if (trimmed.length >= 13) return Math.floor(numeric)
    if (trimmed.length >= 10) return Math.floor(numeric * 1000)
  }

  const compact = trimmed.replace(/[^\d]/g, '')
  if (/^\d{14,17}$/.test(compact)) {
    const year = Number(compact.slice(0, 4))
    const month = Number(compact.slice(4, 6)) - 1
    const day = Number(compact.slice(6, 8))
    const hour = Number(compact.slice(8, 10))
    const minute = Number(compact.slice(10, 12))
    const second = Number(compact.slice(12, 14))
    const milli = compact.length > 14 ? Number(compact.slice(14, 17).padEnd(3, '0')) : 0
    const ts = new Date(year, month, day, hour, minute, second, milli).getTime()
    return Number.isFinite(ts) ? ts : null
  }

  const normalized = trimmed
    .replace(/\//g, '-')
    .replace('T', ' ')
  const ts = Date.parse(normalized)
  return Number.isFinite(ts) ? ts : null
}

function resolveAggregationSeconds(aggregation = 'tick') {
  if (!aggregation || aggregation === 'tick') return 0
  const text = String(aggregation).trim().toLowerCase()
  const match = text.match(/^(\d+)\s*([smhd])$/)
  if (!match) return 0
  const amount = Number(match[1])
  const unit = match[2]
  const scale = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400
  }[unit] || 1
  return amount * scale
}

function mapColumns(headerRow) {
  const normalizedHeaders = headerRow.map((item) => normalizeHeader(item))
  const indexMap = {}
  normalizedHeaders.forEach((key, idx) => {
    if (!(key in indexMap)) indexMap[key] = idx
  })

  const find = (key) => {
    const aliases = DEFAULT_ALIASES[key] || []
    for (const alias of aliases) {
      const idx = indexMap[normalizeHeader(alias)]
      if (idx !== undefined) return idx
    }
    return -1
  }

  return {
    datetimeIdx: find('datetime'),
    dateIdx: find('date'),
    timeIdx: find('time'),
    openIdx: find('open'),
    highIdx: find('high'),
    lowIdx: find('low'),
    closeIdx: find('close'),
    volumeIdx: find('volume'),
    amountIdx: find('amount')
  }
}

function toKlineBar(point) {
  const timeSeconds = Math.floor(point.timestamp / 1000)
  return {
    timestamp: timeSeconds,
    time: timeSeconds,
    date: new Date(point.timestamp).toISOString().slice(0, 10),
    open: Number(point.open.toFixed(6)),
    high: Number(point.high.toFixed(6)),
    low: Number(point.low.toFixed(6)),
    close: Number(point.close.toFixed(6)),
    volume: Math.max(0, Math.round(point.volume || 0)),
    amount: Number((point.amount || 0).toFixed(6))
  }
}

function aggregatePoints(points, aggregationSeconds) {
  if (!aggregationSeconds || aggregationSeconds <= 0) {
    return points.map(toKlineBar)
  }

  const intervalMs = aggregationSeconds * 1000
  const buckets = new Map()

  for (const point of points) {
    const bucketTs = Math.floor(point.timestamp / intervalMs) * intervalMs
    const bucket = buckets.get(bucketTs)
    if (!bucket) {
      buckets.set(bucketTs, {
        timestamp: bucketTs,
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
        volume: point.volume || 0,
        amount: point.amount || 0
      })
      continue
    }
    bucket.high = Math.max(bucket.high, point.high)
    bucket.low = Math.min(bucket.low, point.low)
    bucket.close = point.close
    bucket.volume += point.volume || 0
    bucket.amount += point.amount || 0
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(toKlineBar)
}

export function parseTickCsvToKline(csvText, options = {}) {
  const {
    aggregation = 'tick',
    minRows = 20
  } = options

  if (!csvText || !String(csvText).trim()) {
    throw new Error('Tick CSV content is empty')
  }

  const content = String(csvText).replace(/^\uFEFF/, '').trim()
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) {
    throw new Error('Tick CSV must include header and data rows')
  }

  const delimiter = detectDelimiter(lines[0])
  const headerRow = splitCsvLine(lines[0], delimiter)
  const columns = mapColumns(headerRow)

  const parsed = []
  let invalidRows = 0
  for (let i = 1; i < lines.length; i += 1) {
    const row = splitCsvLine(lines[i], delimiter)
    const ts = parseTimestamp(
      columns.datetimeIdx >= 0 ? row[columns.datetimeIdx] : null,
      columns.dateIdx >= 0 ? row[columns.dateIdx] : null,
      columns.timeIdx >= 0 ? row[columns.timeIdx] : null
    )
    if (!ts) {
      invalidRows += 1
      continue
    }

    const close = parseNumeric(columns.closeIdx >= 0 ? row[columns.closeIdx] : null)
    const open = parseNumeric(columns.openIdx >= 0 ? row[columns.openIdx] : null)
    const high = parseNumeric(columns.highIdx >= 0 ? row[columns.highIdx] : null)
    const low = parseNumeric(columns.lowIdx >= 0 ? row[columns.lowIdx] : null)
    const basePrice = close ?? open ?? high ?? low

    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      invalidRows += 1
      continue
    }

    parsed.push({
      timestamp: ts,
      open: Number.isFinite(open) ? open : basePrice,
      high: Number.isFinite(high) ? high : basePrice,
      low: Number.isFinite(low) ? low : basePrice,
      close: Number.isFinite(close) ? close : basePrice,
      volume: parseNumeric(columns.volumeIdx >= 0 ? row[columns.volumeIdx] : null) || 0,
      amount: parseNumeric(columns.amountIdx >= 0 ? row[columns.amountIdx] : null) || 0
    })
  }

  parsed.sort((a, b) => a.timestamp - b.timestamp)

  const aggregationSeconds = resolveAggregationSeconds(aggregation)
  const kline = aggregatePoints(parsed, aggregationSeconds)
  if (kline.length < minRows) {
    throw new Error(`Tick CSV has insufficient valid rows (${kline.length}), need at least ${minRows}`)
  }

  return {
    data: kline,
    meta: {
      sourceRows: lines.length - 1,
      parsedRows: parsed.length,
      outputRows: kline.length,
      invalidRows,
      delimiter,
      aggregation: aggregationSeconds > 0 ? `${aggregationSeconds}s` : 'tick',
      startTime: new Date(kline[0].timestamp * 1000).toISOString(),
      endTime: new Date(kline[kline.length - 1].timestamp * 1000).toISOString()
    }
  }
}
