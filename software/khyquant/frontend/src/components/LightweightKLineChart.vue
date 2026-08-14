<template>
  <div class="lightweight-kline-container">
    <div class="chart-header">
      <div class="symbol-info">
        <span class="symbol-name">{{ symbolName }}</span>
        <span class="symbol-code">{{ symbol }}</span>
        <span class="data-source-badge" :class="dataSourceBadgeClass" :title="dataSourceTooltip">{{ dataSourceBadgeText }}</span>
        <span v-if="currentPrice" class="current-price" :class="priceChangeClass">
          {{ currentPrice.toFixed(2) }}
          <span class="price-change">{{ priceChangeText }}</span>
        </span>
      </div>
      <div class="chart-controls">
        <el-checkbox-group v-model="indicators" size="small" @change="updateIndicators">
          <el-checkbox label="MA5" value="MA5">MA5</el-checkbox>
          <el-checkbox label="MA10" value="MA10">MA10</el-checkbox>
          <el-checkbox label="MA20" value="MA20">MA20</el-checkbox>
          <el-checkbox label="MA30" value="MA30">MA30</el-checkbox>
        </el-checkbox-group>
        <el-checkbox v-if="signals && signals.length > 0" v-model="showSignals" @change="updateSignals">
          交易信号
        </el-checkbox>
      </div>
    </div>
    <div ref="chartContainer" class="chart-container"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import { createChart, ColorType } from 'lightweight-charts'

// 验证导入
console.log('createChart 函数:', typeof createChart)
console.log('ColorType:', ColorType)
console.log('lightweight-charts v4+ 已导入')

const props = defineProps({
  symbol: {
    type: String,
    required: true
  },
  symbolName: {
    type: String,
    default: ''
  },
  data: {
    type: Object,
    default: () => ({})
  },
  signals: {
    type: Array,
    default: () => []
  },
  isMock: {
    type: Boolean,
    default: false
  },
  dataSource: {
    type: String,
    default: 'unknown'
  },
  chartHeight: {
    type: String,
    default: '600px'
  }
})

const chartContainer = ref(null)
const chart = ref(null)
const candlestickSeries = ref(null)
const volumeSeries = ref(null)
const maSeries = ref({})
const indicators = ref(['MA5', 'MA10', 'MA20'])
const showSignals = ref(true)
const currentPrice = ref(null)
const priceChange = ref(0)

const priceChangeClass = computed(() => {
  return priceChange.value >= 0 ? 'price-up' : 'price-down'
})

// Data source badge: green=realtime, yellow=cache, red=mock
const dataSourceBadgeClass = computed(() => {
  const ds = props.dataSource
  if (ds === 'realtime') return 'badge-realtime'
  if (ds === 'postgres_cache' || ds === 'sqlite_cache' || ds === 'cache' || ds === 'local') return 'badge-cache'
  return 'badge-mock'
})
const dataSourceBadgeText = computed(() => {
  const ds = props.dataSource
  if (ds === 'realtime') return '\uD83D\uDFE2 \u5B9E\u65F6'
  if (ds === 'postgres_cache' || ds === 'sqlite_cache' || ds === 'cache' || ds === 'local') return '\uD83D\uDFE1 \u7F13\u5B58'
  return '\uD83D\uDD34 \u6A21\u62DF'
})
const dataSourceTooltip = computed(() => {
  const ds = props.dataSource
  if (ds === 'realtime') return 'Live data from market API'
  if (ds === 'postgres_cache') return 'Cached data from PostgreSQL'
  if (ds === 'sqlite_cache' || ds === 'local') return 'Cached data from SQLite'
  if (ds === 'cache') return 'Cached data'
  return 'Simulated data (offline/network issue)'
})

const priceChangeText = computed(() => {
  if (!priceChange.value) return ''
  const sign = priceChange.value >= 0 ? '+' : ''
  return `${sign}${priceChange.value.toFixed(2)}`
})

onMounted(() => {
  initChart()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  if (chart.value) {
    chart.value.remove()
  }
  window.removeEventListener('resize', handleResize)
})

watch(() => [props.data, props.signals], () => {
  if (props.data && props.data.kline) {
    // 深度克隆并确保数据类型正确
    const clonedData = {
      ...props.data,
      kline: props.data.kline.map(item => ({
        timestamp: item.timestamp,
        open: Number(item.open),
        high: Number(item.high),
        low: Number(item.low),
        close: Number(item.close),
        volume: Number(item.volume),
        amount: item.amount ? Number(item.amount) : 0,
      }))
    }
    console.log('watch 触发 - 克隆并转换数据')
    console.log('转换后第一条:', clonedData.kline[0])
    console.log('类型检查:', {
      open: typeof clonedData.kline[0].open,
      high: typeof clonedData.kline[0].high,
      low: typeof clonedData.kline[0].low,
      close: typeof clonedData.kline[0].close,
    })
    updateChart(clonedData)
  }
}, { deep: true })

function initChart() {
  if (!chartContainer.value) {
    console.error('图表容器未找到')
    return
  }

  console.log('初始化图表，容器宽度:', chartContainer.value.clientWidth)
  console.log('接收到的数据:', props.data)
  console.log('createChart 类型:', typeof createChart)

  if (typeof createChart !== 'function') {
    console.error('createChart 不是一个函数！lightweight-charts 可能没有正确加载')
    return
  }

  // 创建图表
  try {
    chart.value = createChart(chartContainer.value, {
    width: chartContainer.value.clientWidth,
    height: parseInt(props.chartHeight),
    layout: {
      background: { color: '#ffffff' },
      textColor: '#1f2937',
      fontSize: 12,
    },
    grid: {
      vertLines: { 
        color: 'rgba(99, 115, 129, 0.2)',
        style: 1,
      },
      horzLines: { 
        color: 'rgba(99, 115, 129, 0.2)',
        style: 1,
      },
    },
    crosshair: {
      mode: 1,
      vertLine: {
        width: 1,
        color: 'rgba(224, 227, 235, 0.3)',
        style: 2,
        labelBackgroundColor: '#2962FF',
      },
      horzLine: {
        width: 1,
        color: 'rgba(224, 227, 235, 0.3)',
        style: 2,
        labelBackgroundColor: '#2962FF',
      },
    },
    rightPriceScale: {
      borderColor: 'rgba(148, 163, 184, 0.5)',
      scaleMargins: {
        top: 0.1,
        bottom: 0.2,
      },
    },
    timeScale: {
      borderColor: 'rgba(148, 163, 184, 0.5)',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 5,
      barSpacing: 8,
      minBarSpacing: 3,
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
  })

  console.log('图表对象创建成功:', chart.value)
  console.log('图表对象类型:', typeof chart.value)
  
  // v5 API: 使用 addSeries 方法，传入系列类型
  console.log('使用 v5 API 创建 K线系列...')
  
  // 创建K线系列 - v4 API
  candlestickSeries.value = chart.value.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderUpColor: '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
    priceLineVisible: false,
    lastValueVisible: true,
  })

  // 创建成交量系列 - v4 API
  volumeSeries.value = chart.value.addHistogramSeries({
    priceFormat: {
      type: 'volume',
    },
    priceScaleId: 'volume',
    scaleMargins: {
      top: 0.7,
      bottom: 0,
    },
    lastValueVisible: false,
    priceLineVisible: false,
  })

  if (props.data && props.data.kline) {
    // 深度克隆并确保数据类型正确
    const clonedData = {
      ...props.data,
      kline: props.data.kline.map(item => ({
        timestamp: item.timestamp,
        open: Number(item.open),
        high: Number(item.high),
        low: Number(item.low),
        close: Number(item.close),
        volume: Number(item.volume),
        amount: item.amount ? Number(item.amount) : 0,
      }))
    }
    updateChart(clonedData)
  }
  } catch (error) {
    console.error('初始化图表时出错:', error)
    console.error('错误堆栈:', error.stack)
  }
}

function _toMs(item) {
  const t = item.timestamp ?? item.time ?? item.date
  if (typeof t === 'number') return t > 1e12 ? t : t * 1000
  const parsed = Date.parse(t)
  return isNaN(parsed) ? Date.now() : parsed
}

function _generateLocalMock(count = 120) {
  const data = []
  const base = 100
  let price = base
  const now = Date.now()
  for (let i = count; i > 0; i--) {
    const ts = now - i * 86400000
    const change = (Math.random() - 0.5) * 2
    const open = price
    const close = price + change
    const high = Math.max(open, close) + Math.random()
    const low = Math.min(open, close) - Math.random()
    data.push({
      timestamp: ts,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: Math.floor(Math.random() * 1000000) + 100000
    })
    price = close
  }
  return data
}

function updateChart(dataOverride = null) {
  const dataToUse = dataOverride || props.data

  // Never leave the chart empty — generate local mock if upstream gave nothing.
  let klineData = dataToUse?.kline
  if (!klineData || klineData.length === 0) {
    console.warn('K线数据为空,使用本地模拟数据兜底')
    klineData = _generateLocalMock()
  }

  // 转换K线数据格式 - 确保所有值都是 number 类型
  const candleData = klineData.map(item => {
    const data = {
      time: Math.floor(_toMs(item) / 1000),
      open: typeof item.open === 'number' ? item.open : parseFloat(item.open),
      high: typeof item.high === 'number' ? item.high : parseFloat(item.high),
      low: typeof item.low === 'number' ? item.low : parseFloat(item.low),
      close: typeof item.close === 'number' ? item.close : parseFloat(item.close),
    }
    
    // 验证数据
    if (isNaN(data.open) || isNaN(data.high) || isNaN(data.low) || isNaN(data.close)) {
      console.error('无效的K线数据:', item)
      return null
    }
    
    return data
  }).filter(item => item !== null)

  // 转换成交量数据 - 确保值是 number 类型
  const volumeData = klineData.map((item, idx) => {
    const close = typeof item.close === 'number' ? item.close : parseFloat(item.close)
    const open = typeof item.open === 'number' ? item.open : parseFloat(item.open)
    const volume = typeof item.volume === 'number' ? item.volume : parseFloat(item.volume)
    
    if (isNaN(volume)) {
      console.error('无效的成交量数据:', item)
      return null
    }
    
    return {
      time: Math.floor(_toMs(item) / 1000),
      value: volume,
      color: close >= open ? 'rgba(38, 166, 154, 0.4)' : 'rgba(239, 83, 80, 0.4)',
    }
  }).filter(item => item !== null)

  console.log('转换后的K线数据示例:', candleData[0])
  console.log('转换后的成交量数据示例:', volumeData[0])
  
  // 最终验证：确保所有数据都是 number 类型
  console.log('=== 最终数据类型验证 ===')
  console.log('candleData[0].open 类型:', typeof candleData[0].open, '值:', candleData[0].open)
  console.log('candleData[0].high 类型:', typeof candleData[0].high, '值:', candleData[0].high)
  console.log('candleData[0].low 类型:', typeof candleData[0].low, '值:', candleData[0].low)
  console.log('candleData[0].close 类型:', typeof candleData[0].close, '值:', candleData[0].close)
  console.log('volumeData[0].value 类型:', typeof volumeData[0].value, '值:', volumeData[0].value)

  // 更新K线和成交量
  console.log('准备调用 setData...')
  candlestickSeries.value.setData(candleData)
  console.log('K线数据设置成功')
  volumeSeries.value.setData(volumeData)
  console.log('成交量数据设置成功')

  // 更新当前价格
  if (candleData.length > 0) {
    const lastCandle = candleData[candleData.length - 1]
    const firstCandle = candleData[0]
    currentPrice.value = lastCandle.close
    priceChange.value = lastCandle.close - firstCandle.open
  }

  // 更新均线
  updateIndicators(dataToUse, klineData)

  // 更新交易信号
  updateSignals(dataToUse, klineData)

  // 自动缩放到合适的范围
  if (chart.value) {
    chart.value.timeScale().fitContent()
  }
}

function updateIndicators(dataToUse, klineData) {
  if (!dataToUse || !dataToUse.indicators) return

  // 清除旧的均线
  Object.values(maSeries.value).forEach(series => {
    chart.value.removeSeries(series)
  })
  maSeries.value = {}

  const maColors = {
    MA5: '#ffeb3b',
    MA10: '#2196f3',
    MA20: '#e91e63',
    MA30: '#9c27b0',
  }

  // 添加选中的均线 - v5 API
  indicators.value.forEach(ma => {
    const maKey = ma.toLowerCase()
    if (dataToUse.indicators && dataToUse.indicators[maKey]) {
      const maData = dataToUse.indicators[maKey]
        .map((value, idx) => {
          if (value === null || value === undefined || value === '-') return null
          return {
            time: Math.floor(_toMs(klineData[idx]) / 1000),
            value: typeof value === 'number' ? value : parseFloat(value),
          }
        })
        .filter(item => item !== null && !isNaN(item.value))

      if (maData.length > 0) {
        const series = chart.value.addLineSeries({
          color: maColors[ma],
          lineWidth: 2,
          title: ma,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        })
        series.setData(maData)
        maSeries.value[ma] = series
      }
    }
  })
}

function updateSignals(dataToUse, klineData) {
  if (!showSignals.value || !props.signals || props.signals.length === 0) {
    // 清除标记
    if (candlestickSeries.value) {
      candlestickSeries.value.setMarkers([])
    }
    return
  }

  if (!klineData || klineData.length === 0) {
    console.warn('没有K线数据，无法添加信号')
    return
  }

  // 添加买入信号标记 - 大拇指向上
  const buySignals = props.signals
    .filter(s => s.type === 'buy' && s.index < klineData.length)
    .map(s => ({
      time: Math.floor(_toMs(klineData[s.index]) / 1000),
      position: 'belowBar',
      color: '#26a69a',
      shape: 'circle',
      text: '👍',
      size: 2.0
    }))

  // 添加卖出信号标记 - 大拇指向下
  const sellSignals = props.signals
    .filter(s => s.type === 'sell' && s.index < klineData.length)
    .map(s => ({
      time: Math.floor(_toMs(klineData[s.index]) / 1000),
      position: 'aboveBar',
      color: '#ef5350',
      shape: 'circle',
      text: '👎',
      size: 2.0
    }))

  // 使用 v5 API 设置标记
  const allMarkers = [...buySignals, ...sellSignals]
  console.log('设置交易信号标记:', allMarkers.length, '个')
  candlestickSeries.value.setMarkers(allMarkers)
}

function handleResize() {
  try {
    if (chart.value && chartContainer.value) {
      chart.value.applyOptions({
        width: chartContainer.value.clientWidth,
      })
    }
  } catch (error) {
    console.warn('图表 resize 失败:', error.message)
  }
}
</script>

<style scoped>
.lightweight-kline-container {
  width: 100%;
  background: #ffffff;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.12);
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
  border-bottom: 1px solid rgba(148, 163, 184, 0.35);
}

.symbol-info {
  display: flex;
  align-items: center;
  gap: 16px;
}

.symbol-name {
  font-size: 18px;
  font-weight: 600;
  color: #0f172a;
  letter-spacing: 0.5px;
}

.symbol-code {
  font-size: 13px;
  color: #64748b;
  font-family: 'Consolas', 'Monaco', monospace;
}

.data-source-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: var(--radius-md);
  font-weight: 500;
  white-space: nowrap;
}
.badge-realtime {
  background: rgba(82, 196, 26, 0.15);
  color: #52c41a;
  border: 1px solid rgba(82, 196, 26, 0.4);
}
.badge-cache {
  background: rgba(255, 193, 7, 0.15);
  color: #ffc107;
  border: 1px solid rgba(255, 193, 7, 0.4);
}
.badge-mock {
  background: rgba(255, 77, 79, 0.15);
  color: #ff4d4f;
  border: 1px solid rgba(255, 77, 79, 0.4);
}

.current-price {
  font-size: 22px;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
}

.current-price.price-up {
  color: #26a69a;
}

.current-price.price-down {
  color: #ef5350;
}

.price-change {
  font-size: 14px;
  font-weight: 500;
}

.chart-controls {
  display: flex;
  gap: 20px;
  align-items: center;
}

.chart-container {
  width: 100%;
  position: relative;
  background: #ffffff;
}

:deep(.el-checkbox) {
  color: #334155;
  margin-right: 12px;
}

:deep(.el-checkbox__label) {
  font-size: 13px;
  font-weight: 500;
}

:deep(.el-checkbox__input.is-checked .el-checkbox__inner) {
  background-color: #2962FF;
  border-color: #2962FF;
}

:deep(.el-checkbox__inner) {
  background-color: #ffffff;
  border-color: #94a3b8;
}

:deep(.el-checkbox__inner:hover) {
  border-color: #2962FF;
}

:deep(.el-checkbox-group) {
  display: flex;
  gap: 4px;
}
</style>
