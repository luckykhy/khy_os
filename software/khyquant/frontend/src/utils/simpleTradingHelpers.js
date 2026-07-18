export function getStrategyTypeColor(type) {
  const colorMap = {
    'macd': 'primary',
    'rsi': 'warning',
    'ma': 'success',
    'bollinger': 'info',
    'momentum': 'danger'
  }
  return colorMap[type] || 'info'
}

export function getStrategyTypeLabel(type) {
  const labelMap = {
    'macd': 'MACD',
    'rsi': 'RSI',
    'ma': '均线',
    'bollinger': '布林带',
    'momentum': '动量',
    'trend': '趋势',
    'mean_reversion': '均值回归',
    'arbitrage': '套利',
    'market_making': '做市',
    'other': '其他'
  }
  return labelMap[type] || type
}

export function getLanguageColor(language) {
  const colorMap = {
    'javascript': 'warning',
    'python': 'success'
  }
  return colorMap[language] || 'info'
}

export function getLanguageName(language) {
  const nameMap = {
    'javascript': 'JavaScript',
    'python': 'Python'
  }
  return nameMap[language] || language
}

export function disabledStartDate(time) {
  return time.getTime() > Date.now()
}

export function disabledEndDate(time, startDate) {
  const startAt = startDate?.getTime?.()
  return time.getTime() > Date.now() || (typeof startAt === 'number' && !Number.isNaN(startAt) && time.getTime() < startAt)
}

export function parseTradingError(error) {
  console.log('🔍 解析错误对象:', error)

  if (typeof error === 'string') {
    return error
  }

  if (error instanceof Error) {
    return error.message || '未知错误'
  }

  if (error && typeof error === 'object') {
    if (error.message) return error.message
    if (error.msg) return error.msg
    if (error.error) return error.error
    if (error.data && error.data.message) return error.data.message
    if (error.response && error.response.data && error.response.data.message) {
      return error.response.data.message
    }
    if (error.code) {
      return `网络错误: ${error.code}`
    }
    try {
      const errorStr = JSON.stringify(error)
      if (errorStr !== '{}') {
        return `对象错误: ${errorStr.substring(0, 100)}...`
      }
    } catch {
      // ignore stringify errors
    }
    return '未知对象错误'
  }

  return '系统错误'
}

export function formatTime(timestamp) {
  const date = new Date(timestamp)
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${hour}:${minute}:${second}`
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '-'
  try {
    const date = new Date(dateStr)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${year}年${month}月${day}日 ${hour}:${minute}`
  } catch {
    return dateStr
  }
}
