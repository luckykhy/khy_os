const DEFAULT_INSTRUMENT_INFO = {
  listingDate: '1990-01-01',
  basePrice: 10,
  name: '未知标的'
}

const INSTRUMENT_MAP = {
  // 主要指数
  '000001.SH': { listingDate: '1991-07-15', basePrice: 3000, name: '上证指数' },
  '399001.SZ': { listingDate: '1991-04-03', basePrice: 10000, name: '深证成指' },
  '399006.SZ': { listingDate: '2010-06-01', basePrice: 2000, name: '创业板指' },
  '000300.SH': { listingDate: '2005-04-08', basePrice: 807.78, name: '沪深300' },
  '000116.SZ': { listingDate: '2014-01-01', basePrice: 3000, name: '信用100' },

  // 知名股票
  '600519.SH': { listingDate: '2001-08-27', basePrice: 1500, name: '贵州茅台' },
  '000002.SZ': { listingDate: '1991-01-29', basePrice: 10, name: '万科A' },
  '600036.SH': { listingDate: '2002-04-09', basePrice: 35, name: '招商银行' },
  '000001.SZ': { listingDate: '1991-04-03', basePrice: 12, name: '平安银行' },
  '600000.SH': { listingDate: '1999-11-10', basePrice: 10, name: '浦发银行' },

  // 期货（使用合约上市时间）
  'CU2312.SHFE': { listingDate: '2023-01-01', basePrice: 60000, name: '铜2312' },
  'AU2312.SHFE': { listingDate: '2023-01-01', basePrice: 400, name: '黄金2312' }
}

const PERIOD_MAP = {
  '1m': {
    intervalSeconds: 60,
    maxDataPoints: 2880,
    volatility: 0.005,
    trendFactor: 0.0001
  },
  '5m': {
    intervalSeconds: 300,
    maxDataPoints: 2016,
    volatility: 0.008,
    trendFactor: 0.0002
  },
  '15m': {
    intervalSeconds: 900,
    maxDataPoints: 2688,
    volatility: 0.012,
    trendFactor: 0.0005
  },
  '1h': {
    intervalSeconds: 3600,
    maxDataPoints: 2160,
    volatility: 0.015,
    trendFactor: 0.001
  },
  '1d': {
    intervalSeconds: 86400,
    maxDataPoints: 3650,
    volatility: 0.025,
    trendFactor: 0.002
  },
  '1w': {
    intervalSeconds: 604800,
    maxDataPoints: 1040,
    volatility: 0.035,
    trendFactor: 0.005
  },
  '1M': {
    intervalSeconds: 2592000,
    maxDataPoints: 360,
    volatility: 0.05,
    trendFactor: 0.01
  },
  '1Y': {
    intervalSeconds: 31536000,
    maxDataPoints: 50,
    volatility: 0.08,
    trendFactor: 0.02
  }
}

const BASE_VOLUME_MAP = {
  '1m': 50000,
  '5m': 200000,
  '15m': 500000,
  '1h': 1000000,
  '1d': 10000000,
  '1w': 50000000,
  '1M': 200000000,
  '1Y': 1000000000
}

const defaultNormalizeSymbolCode = (symbol) => {
  if (!symbol) return 'sh000001'
  const trimmed = symbol.trim()

  if (/^(sh|sz)\d{6}$/i.test(trimmed)) {
    return trimmed.toLowerCase()
  }

  if (/^\d{6}\.(SH|SZ)$/i.test(trimmed)) {
    const [code, market] = trimmed.split('.')
    return `${market.toLowerCase()}${code}`
  }

  if (/^\d{6}$/.test(trimmed)) {
    return trimmed.startsWith('6') ? `sh${trimmed}` : `sz${trimmed}`
  }

  return trimmed
}

export const getInstrumentInfo = (symbol, normalizeSymbolCodeFn = defaultNormalizeSymbolCode) => {
  const normalizedSymbol = normalizeSymbolCodeFn(symbol)

  let lookupSymbol = normalizedSymbol
  if (normalizedSymbol.match(/^(sh|sz)\d{6}$/i)) {
    const market = normalizedSymbol.substring(0, 2).toUpperCase()
    const code = normalizedSymbol.substring(2)
    lookupSymbol = `${code}.${market === 'SH' ? 'SH' : 'SZ'}`
  }

  const info = INSTRUMENT_MAP[lookupSymbol]
  if (info) {
    console.log(`✅ 找到标的信息: ${symbol} -> ${normalizedSymbol} -> ${lookupSymbol}, 上市日期: ${info.listingDate}`)
    return info
  }

  console.warn(`⚠️ 未找到标的信息: ${symbol} (标准化: ${normalizedSymbol}, 查找: ${lookupSymbol}), 使用默认值`)
  return DEFAULT_INSTRUMENT_INFO
}

export const getPeriodInfo = (period) => PERIOD_MAP[period] || PERIOD_MAP['1d']

export const getBaseVolume = (period) => BASE_VOLUME_MAP[period] || 10000000

export const getSymbolSeed = (symbol) => {
  let hash = 0
  for (let i = 0; i < symbol.length; i++) {
    const char = symbol.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash) % 100000 + 12345
}

export const generateMockKlineData = ({
  symbol,
  selectedPeriod,
  selectedSymbol,
  contract,
  getInstrumentInfoFn = getInstrumentInfo,
  getSymbolSeedFn = getSymbolSeed
}) => {
  const data = []
  const finalSymbol = symbol || contract || '000001.SH'

  console.log('='.repeat(80))
  console.log('🔥🔥🔥 generateMockKlineData 被调用！')
  console.log('🔥 当前时间:', new Date().toLocaleString())
  console.log('🔥 selectedSymbol.value:', selectedSymbol)
  console.log('🔥 props.contract:', contract)
  console.log('🔥 最终使用的symbol:', finalSymbol)
  console.log('� selectedPeriod.value:', selectedPeriod)
  console.log('='.repeat(80))

  const instrumentInfo = getInstrumentInfoFn(finalSymbol)
  const listingDate = new Date(instrumentInfo.listingDate)
  const basePrice = instrumentInfo.basePrice
  const now = new Date()

  console.log(`📊 生成K线数据: ${finalSymbol}`)
  console.log(`📅 上市时间: ${listingDate.toLocaleDateString()}, 基础价格: ${basePrice}`)

  let seed = getSymbolSeedFn(finalSymbol)
  const seededRandom = () => {
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }

  let currentPrice = basePrice
  const normalizedSymbol = String(finalSymbol).toLowerCase()
  const isHS300 = finalSymbol.includes('000300') || finalSymbol.includes('sh000300') || normalizedSymbol.includes('000300')

  console.log('🔍 检查是否为沪深300:')
  console.log(`   - symbol: "${finalSymbol}"`)
  console.log(`   - symbol.includes('000300'): ${finalSymbol.includes('000300')}`)
  console.log(`   - symbol.includes('sh000300'): ${finalSymbol.includes('sh000300')}`)
  console.log(`   - symbol.toLowerCase().includes('000300'): ${normalizedSymbol.includes('000300')}`)
  console.log(`   - isHS300: ${isHS300}`)
  console.log(`   - selectedPeriod: ${selectedPeriod}`)

  if (isHS300 && selectedPeriod === '1d') {
    console.log('🔥🔥🔥 使用新的沪深300数据生成算法！')
    console.log('🔥 起始价格: 807.78')
    currentPrice = 807.78
    const totalDays = Math.floor((now.getTime() - listingDate.getTime()) / (1000 * 60 * 60 * 24))
    console.log('🔥 总天数:', totalDays)

    const cycles = [
      { start: 0, end: 0.095, trend: 6.8, volatility: 0.025 },
      { start: 0.095, end: 0.16, trend: -5.5, volatility: 0.040 },
      { start: 0.16, end: 0.24, trend: 2.2, volatility: 0.025 },
      { start: 0.24, end: 0.33, trend: -1.0, volatility: 0.020 },
      { start: 0.33, end: 0.38, trend: 0.3, volatility: 0.015 },
      { start: 0.38, end: 0.43, trend: 1.8, volatility: 0.020 },
      { start: 0.43, end: 0.48, trend: 4.5, volatility: 0.035 },
      { start: 0.48, end: 0.52, trend: -4.0, volatility: 0.045 },
      { start: 0.52, end: 0.62, trend: 0.6, volatility: 0.018 },
      { start: 0.62, end: 0.71, trend: 1.2, volatility: 0.022 },
      { start: 0.71, end: 0.81, trend: -0.3, volatility: 0.020 },
      { start: 0.81, end: 0.90, trend: -0.8, volatility: 0.022 },
      { start: 0.90, end: 1.0, trend: 1.5, volatility: 0.018 }
    ]

    let dayCount = 0

    for (let d = new Date(listingDate); d <= now; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0 && d.getDay() !== 6) {
        const progress = dayCount / totalDays
        let currentCycle = cycles[cycles.length - 1]
        for (const cycle of cycles) {
          if (progress >= cycle.start && progress < cycle.end) {
            currentCycle = cycle
            break
          }
        }

        const trendFactor = currentCycle.trend * 0.0003
        const volatility = currentCycle.volatility

        const randomChange = (seededRandom() - 0.5) * volatility
        const trendChange = trendFactor
        const totalChange = randomChange + trendChange

        const open = currentPrice
        const close = open * (1 + totalChange)
        const high = Math.max(open, close) * (1 + seededRandom() * volatility * 0.3)
        const low = Math.min(open, close) * (1 - seededRandom() * volatility * 0.3)

        const baseVolume = 50000000
        const volumeVariation = (seededRandom() - 0.5) * 0.5 + 1
        const volume = Math.floor(baseVolume * volumeVariation * (1 + Math.abs(totalChange) * 10))

        data.push({
          time: Math.floor(d.getTime() / 1000),
          open: parseFloat(open.toFixed(2)),
          high: parseFloat(high.toFixed(2)),
          low: parseFloat(low.toFixed(2)),
          close: parseFloat(close.toFixed(2)),
          volume
        })

        currentPrice = close
        dayCount++
      }
    }
  } else {
    const volatility = 0.025
    const trendFactor = 0.002

    let dayCount = 0
    const totalDays = Math.floor((now.getTime() - listingDate.getTime()) / (1000 * 60 * 60 * 24))

    for (let d = new Date(listingDate); d <= now; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0 && d.getDay() !== 6) {
        const longTermTrend = Math.pow(1 + trendFactor, dayCount / totalDays)

        const change = (seededRandom() - 0.5) * volatility
        const open = currentPrice
        const close = open * (1 + change) * longTermTrend
        const high = Math.max(open, close) * (1 + seededRandom() * volatility * 0.5)
        const low = Math.min(open, close) * (1 - seededRandom() * volatility * 0.5)

        const baseVolume = 10000000
        const volumeVariation = (seededRandom() - 0.5) * 0.5 + 1
        const volume = Math.floor(baseVolume * volumeVariation * (1 + Math.abs(change) * 10))

        data.push({
          time: Math.floor(d.getTime() / 1000),
          open: parseFloat(open.toFixed(2)),
          high: parseFloat(high.toFixed(2)),
          low: parseFloat(low.toFixed(2)),
          close: parseFloat(close.toFixed(2)),
          volume
        })

        currentPrice = close
        dayCount++
      }
    }
  }

  if (data.length > 0) {
    console.log(`✅ K线数据生成完成: ${data.length} 条, 时间范围: ${new Date(data[0].time * 1000).toLocaleDateString()} - ${new Date(data[data.length - 1].time * 1000).toLocaleDateString()}`)
  } else {
    console.log('⚠️ K线数据生成完成，但没有可用数据')
  }

  return data
}
