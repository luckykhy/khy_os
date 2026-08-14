<template>
  <div class="enhanced-kline-container">
    <div class="chart-header">
      <div class="symbol-info">
        <span class="symbol-name">{{ symbolName }}</span>
        <span class="symbol-code">{{ symbol }}</span>
        <span v-if="currentPrice" class="current-price" :class="priceChangeClass">
          {{ currentPrice.toFixed(2) }}
          <span class="price-change">{{ priceChangeText }}</span>
        </span>
      </div>
      <div class="chart-controls">
        <!-- 移动平均线控制 -->
        <el-checkbox-group v-model="indicators" size="small" @change="updateIndicators">
          <el-checkbox label="MA5" value="MA5">MA5</el-checkbox>
          <el-checkbox label="MA10" value="MA10">MA10</el-checkbox>
          <el-checkbox label="MA20" value="MA20">MA20</el-checkbox>
          <el-checkbox label="MA60" value="MA60">MA60</el-checkbox>
        </el-checkbox-group>
        
        <!-- 辅助线控制 -->
        <el-checkbox-group v-model="auxiliaryLines" size="small" @change="updateAuxiliaryLines">
          <el-checkbox label="BB" value="BB">布林带</el-checkbox>
          <el-checkbox label="SR" value="SR">支撑阻力</el-checkbox>
          <el-checkbox label="TREND" value="TREND">趋势线</el-checkbox>
        </el-checkbox-group>
        
        <!-- 交易信号控制 -->
        <el-checkbox v-if="signals && signals.length > 0" v-model="showSignals" @change="updateSignals">
          交易信号
        </el-checkbox>
      </div>
    </div>
    <div ref="chartContainer" class="chart-container"></div>
    
    <!-- 指标面板 -->
    <div v-if="showIndicatorPanel" class="indicator-panel">
      <div class="indicator-item" v-if="indicators.includes('MA5')">
        <span class="indicator-label" style="color: #ff6b6b;">MA5:</span>
        <span class="indicator-value">{{ currentMA5 }}</span>
      </div>
      <div class="indicator-item" v-if="indicators.includes('MA10')">
        <span class="indicator-label" style="color: #4ecdc4;">MA10:</span>
        <span class="indicator-value">{{ currentMA10 }}</span>
      </div>
      <div class="indicator-item" v-if="indicators.includes('MA20')">
        <span class="indicator-label" style="color: #45b7d1;">MA20:</span>
        <span class="indicator-value">{{ currentMA20 }}</span>
      </div>
      <div class="indicator-item" v-if="indicators.includes('MA60')">
        <span class="indicator-label" style="color: #f9ca24;">MA60:</span>
        <span class="indicator-value">{{ currentMA60 }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import { createChart, ColorType } from 'lightweight-charts'
import { itemToUnixSeconds } from '@/utils/tvTime'

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
  auxiliaryData: {
    type: Object,
    default: () => ({})
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
const auxiliarySeries = ref({})

const indicators = ref(['MA5', 'MA10', 'MA20'])
const auxiliaryLines = ref(['BB'])
const showSignals = ref(true)
const showIndicatorPanel = ref(true)

const currentPrice = ref(null)
const priceChange = ref(0)
const currentMA5 = ref(null)
const currentMA10 = ref(null)
const currentMA20 = ref(null)
const currentMA60 = ref(null)

const priceChangeClass = computed(() => {
  return priceChange.value >= 0 ? 'price-up' : 'price-down'
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

watch(() => [props.data, props.signals, props.auxiliaryData], () => {
  if (props.data && props.data.kline) {
    updateChart()
  }
}, { deep: true })

function initChart() {
  if (!chartContainer.value) {
    console.error('图表容器未找到')
    return
  }

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
          color: 'rgba(42, 46, 57, 0.5)',
          style: 1,
        },
        horzLines: { 
          color: 'rgba(42, 46, 57, 0.5)',
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
        borderColor: 'rgba(197, 203, 206, 0.4)',
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
      },
      timeScale: {
        borderColor: 'rgba(197, 203, 206, 0.4)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 8,
        minBarSpacing: 3,
      },
    })

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
      updateChart()
    }
  } catch (error) {
    console.error('初始化图表时出错:', error)
  }
}

function updateChart() {
  if (!props.data || !props.data.kline || props.data.kline.length === 0) {
    return
  }

  const klineData = props.data.kline

  // Robustly convert time from any field/format to Unix seconds
  const candleData = klineData.map(item => {
    const time = itemToUnixSeconds(item)
    if (!time) return null
    return {
      time,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
    }
  }).filter(item => item && !isNaN(item.open))

  const volumeData = klineData.map(item => {
    const time = itemToUnixSeconds(item)
    if (!time) return null
    const close = Number(item.close)
    const open = Number(item.open)
    const volume = Number(item.volume)
    return {
      time,
      value: volume,
      color: close >= open ? 'rgba(38, 166, 154, 0.5)' : 'rgba(239, 83, 80, 0.5)'
    }
  }).filter(Boolean)

  // 设置数据
  candlestickSeries.value.setData(candleData)
  volumeSeries.value.setData(volumeData)

  // 更新当前价格
  if (candleData.length > 0) {
    const lastCandle = candleData[candleData.length - 1]
    const prevCandle = candleData[candleData.length - 2]
    currentPrice.value = lastCandle.close
    if (prevCandle) {
      priceChange.value = lastCandle.close - prevCandle.close
    }
  }

  // 更新指标
  updateIndicators()
  updateAuxiliaryLines()
  updateSignals()
}

function updateIndicators() {
  // 清除现有的MA线
  Object.values(maSeries.value).forEach(series => {
    chart.value.removeSeries(series)
  })
  maSeries.value = {}

  if (!props.data || !props.data.indicators) return

  const indicators_data = props.data.indicators
  const klineData = props.data.kline

  // 添加选中的MA线
  indicators.value.forEach(indicator => {
    if (indicators_data[indicator.toLowerCase()]) {
      const maData = indicators_data[indicator.toLowerCase()].map((value, index) => {
        if (value === '-' || value === null || isNaN(parseFloat(value))) {
          return null
        }
        return {
          time: itemToUnixSeconds(klineData[index]),
          value: parseFloat(value)
        }
      }).filter(item => item !== null)

      if (maData.length > 0) {
        const color = getMAColor(indicator)
        maSeries.value[indicator] = chart.value.addLineSeries({
          color: color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          title: indicator
        })
        maSeries.value[indicator].setData(maData)

        // 更新当前值显示
        const lastValue = maData[maData.length - 1]?.value
        if (lastValue) {
          switch(indicator) {
            case 'MA5':
              currentMA5.value = lastValue.toFixed(2)
              break
            case 'MA10':
              currentMA10.value = lastValue.toFixed(2)
              break
            case 'MA20':
              currentMA20.value = lastValue.toFixed(2)
              break
            case 'MA60':
              currentMA60.value = lastValue.toFixed(2)
              break
          }
        }
      }
    }
  })
}

function updateAuxiliaryLines() {
  // 清除现有的辅助线
  Object.values(auxiliarySeries.value).forEach(series => {
    chart.value.removeSeries(series)
  })
  auxiliarySeries.value = {}

  if (!props.auxiliaryData) return

  const klineData = props.data.kline

  // 🔥 优先处理自定义辅助线（策略返回的辅助线数据）
  const customLines = Object.keys(props.auxiliaryData).filter(key => 
    typeof props.auxiliaryData[key] === 'object' && 
    props.auxiliaryData[key].data && 
    Array.isArray(props.auxiliaryData[key].data)
  )

  if (customLines.length > 0) {
    console.log('🎨 检测到自定义辅助线:', customLines)
    customLines.forEach(lineName => {
      addCustomAuxiliaryLine(lineName, props.auxiliaryData[lineName])
    })
    return // 如果有自定义辅助线，就不再处理预定义类型
  }

  // 处理预定义的辅助线类型
  auxiliaryLines.value.forEach(lineType => {
    switch(lineType) {
      case 'BB':
        // 布林带
        if (props.auxiliaryData.bb_upper && props.auxiliaryData.bb_lower && props.auxiliaryData.bb_middle) {
          addBollingerBands(klineData)
        }
        break
      case 'SR':
        // 支撑阻力线
        if (props.auxiliaryData.support && props.auxiliaryData.resistance) {
          addSupportResistance(klineData)
        }
        break
      case 'TREND':
        // 趋势线
        if (props.auxiliaryData.trend_up || props.auxiliaryData.trend_down) {
          addTrendLines(klineData)
        }
        break
    }
  })
}

// 🔥 新增：添加自定义辅助线
function addCustomAuxiliaryLine(lineName, lineConfig) {
  try {
    if (!lineConfig.data || lineConfig.data.length === 0) {
      console.warn('辅助线数据为空:', lineName)
      return
    }

    // 转换数据格式
    const lineData = lineConfig.data.map(item => {
      const value = Number(item.value)
      if (isNaN(value)) return null
      
      // 处理时间戳
      const time = itemToUnixSeconds(item)
      if (!time) return null
      return { time, value }
    }).filter(Boolean)

    if (lineData.length === 0) {
      console.warn('辅助线数据转换后为空:', lineName)
      return
    }

    // 创建线条系列
    const lineStyle = lineConfig.lineStyle !== undefined ? lineConfig.lineStyle : 0
    const lineWidth = lineConfig.lineWidth || 2
    const color = lineConfig.color || '#ffa726'
    const title = lineConfig.name || lineName

    auxiliarySeries.value[lineName] = chart.value.addLineSeries({
      color: color,
      lineWidth: lineWidth,
      lineStyle: lineStyle, // 0=实线, 1=虚线, 2=点线, 3=点划线
      priceLineVisible: false,
      lastValueVisible: true,
      title: title
    })

    auxiliarySeries.value[lineName].setData(lineData)
    console.log(`✅ 辅助线 "${title}" 已添加，数据点数:`, lineData.length)
  } catch (error) {
    console.error(`❌ 添加辅助线 "${lineName}" 失败:`, error)
  }
}

function addBollingerBands(klineData) {
  // 上轨
  if (props.auxiliaryData.bb_upper) {
    const upperData = props.auxiliaryData.bb_upper.map((value, index) => {
      if (value === null || isNaN(value)) return null
      return {
        time: itemToUnixSeconds(klineData[index]),
        value: Number(value)
      }
    }).filter(item => item !== null)

    if (upperData.length > 0) {
      auxiliarySeries.value.bb_upper = chart.value.addLineSeries({
        color: 'rgba(255, 193, 7, 0.8)',
        lineWidth: 1,
        lineStyle: 2, // 虚线
        priceLineVisible: false,
        lastValueVisible: false,
        title: 'BB上轨'
      })
      auxiliarySeries.value.bb_upper.setData(upperData)
    }
  }

  // 中轨
  if (props.auxiliaryData.bb_middle) {
    const middleData = props.auxiliaryData.bb_middle.map((value, index) => {
      if (value === null || isNaN(value)) return null
      return {
        time: itemToUnixSeconds(klineData[index]),
        value: Number(value)
      }
    }).filter(item => item !== null)

    if (middleData.length > 0) {
      auxiliarySeries.value.bb_middle = chart.value.addLineSeries({
        color: 'rgba(255, 193, 7, 0.6)',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        title: 'BB中轨'
      })
      auxiliarySeries.value.bb_middle.setData(middleData)
    }
  }

  // 下轨
  if (props.auxiliaryData.bb_lower) {
    const lowerData = props.auxiliaryData.bb_lower.map((value, index) => {
      if (value === null || isNaN(value)) return null
      return {
        time: itemToUnixSeconds(klineData[index]),
        value: Number(value)
      }
    }).filter(item => item !== null)

    if (lowerData.length > 0) {
      auxiliarySeries.value.bb_lower = chart.value.addLineSeries({
        color: 'rgba(255, 193, 7, 0.8)',
        lineWidth: 1,
        lineStyle: 2, // 虚线
        priceLineVisible: false,
        lastValueVisible: false,
        title: 'BB下轨'
      })
      auxiliarySeries.value.bb_lower.setData(lowerData)
    }
  }
}

function addSupportResistance(klineData) {
  // 支撑线
  if (props.auxiliaryData.support) {
    const supportData = props.auxiliaryData.support.map((value, index) => {
      if (value === null || isNaN(value)) return null
      return {
        time: itemToUnixSeconds(klineData[index]),
        value: Number(value)
      }
    }).filter(item => item !== null)

    if (supportData.length > 0) {
      auxiliarySeries.value.support = chart.value.addLineSeries({
        color: 'rgba(76, 175, 80, 0.7)',
        lineWidth: 2,
        lineStyle: 1, // 实线
        priceLineVisible: false,
        lastValueVisible: true,
        title: '支撑线'
      })
      auxiliarySeries.value.support.setData(supportData)
    }
  }

  // 阻力线
  if (props.auxiliaryData.resistance) {
    const resistanceData = props.auxiliaryData.resistance.map((value, index) => {
      if (value === null || isNaN(value)) return null
      return {
        time: itemToUnixSeconds(klineData[index]),
        value: Number(value)
      }
    }).filter(item => item !== null)

    if (resistanceData.length > 0) {
      auxiliarySeries.value.resistance = chart.value.addLineSeries({
        color: 'rgba(244, 67, 54, 0.7)',
        lineWidth: 2,
        lineStyle: 1, // 实线
        priceLineVisible: false,
        lastValueVisible: true,
        title: '阻力线'
      })
      auxiliarySeries.value.resistance.setData(resistanceData)
    }
  }
}

function addTrendLines(klineData) {
  // 上升趋势线
  if (props.auxiliaryData.trend_up) {
    const trendUpData = props.auxiliaryData.trend_up.map((value, index) => {
      if (value === null || isNaN(value)) return null
      return {
        time: itemToUnixSeconds(klineData[index]),
        value: Number(value)
      }
    }).filter(item => item !== null)

    if (trendUpData.length > 0) {
      auxiliarySeries.value.trend_up = chart.value.addLineSeries({
        color: 'rgba(33, 150, 243, 0.8)',
        lineWidth: 2,
        lineStyle: 3, // 点线
        priceLineVisible: false,
        lastValueVisible: false,
        title: '上升趋势'
      })
      auxiliarySeries.value.trend_up.setData(trendUpData)
    }
  }

  // 下降趋势线
  if (props.auxiliaryData.trend_down) {
    const trendDownData = props.auxiliaryData.trend_down.map((value, index) => {
      if (value === null || isNaN(value)) return null
      return {
        time: itemToUnixSeconds(klineData[index]),
        value: Number(value)
      }
    }).filter(item => item !== null)

    if (trendDownData.length > 0) {
      auxiliarySeries.value.trend_down = chart.value.addLineSeries({
        color: 'rgba(255, 87, 34, 0.8)',
        lineWidth: 2,
        lineStyle: 3, // 点线
        priceLineVisible: false,
        lastValueVisible: false,
        title: '下降趋势'
      })
      auxiliarySeries.value.trend_down.setData(trendDownData)
    }
  }
}

function updateSignals() {
  if (!showSignals.value || !props.signals || props.signals.length === 0) {
    return
  }

  // 创建交易信号标记 - 使用大拇指图标
  const markers = props.signals
    .filter(signal => signal.type === 'buy' || signal.type === 'sell')
    .map(signal => {
      const klineItem = props.data.kline[signal.index]
      if (!klineItem) return null

      return {
        time: itemToUnixSeconds(klineItem),
        position: signal.type === 'buy' ? 'belowBar' : 'aboveBar',
        color: signal.type === 'buy' ? '#26a69a' : '#ef5350',
        shape: 'circle',
        text: signal.type === 'buy' ? '👍' : '👎',
        size: 2.0
      }
    })
    .filter(marker => marker !== null)

  if (markers.length > 0) {
    candlestickSeries.value.setMarkers(markers)
  }
}

function getMAColor(indicator) {
  const colors = {
    'MA5': '#ff6b6b',
    'MA10': '#4ecdc4', 
    'MA20': '#45b7d1',
    'MA30': '#96ceb4',
    'MA60': '#f9ca24'
  }
  return colors[indicator] || '#ffffff'
}

function handleResize() {
  if (chart.value && chartContainer.value) {
    chart.value.applyOptions({
      width: chartContainer.value.clientWidth
    })
  }
}
</script>

<style scoped>
.enhanced-kline-container {
  width: 100%;
  background: #ffffff;
  border-radius: 8px;
  overflow: hidden;
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: #1a1a1a;
  border-bottom: 1px solid #333;
}

.symbol-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.symbol-name {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
}

.symbol-code {
  font-size: 14px;
  color: #888;
}

.current-price {
  font-size: 18px;
  font-weight: 600;
}

.price-up {
  color: #26a69a;
}

.price-down {
  color: #ef5350;
}

.price-change {
  font-size: 14px;
  margin-left: 8px;
}

.chart-controls {
  display: flex;
  align-items: center;
  gap: 16px;
}

.chart-container {
  width: 100%;
}

.indicator-panel {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  background: #1a1a1a;
  border-top: 1px solid #333;
  font-size: 12px;
}

.indicator-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.indicator-label {
  font-weight: 600;
}

.indicator-value {
  color: #fff;
}

:deep(.el-checkbox-group) {
  display: flex;
  gap: 8px;
}

:deep(.el-checkbox) {
  color: #d1d4dc;
  margin-right: 0;
}

:deep(.el-checkbox__label) {
  color: #d1d4dc;
  font-size: 12px;
}

:deep(.el-checkbox__input.is-checked .el-checkbox__inner) {
  background-color: #2962FF;
  border-color: #2962FF;
}
</style>
