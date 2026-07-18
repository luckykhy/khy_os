<template>
  <div class="strategy-kline-container">
    <div class="chart-header">
      <div class="symbol-info">
        <span class="symbol-name">{{ symbolName }}</span>
        <span class="symbol-code">{{ symbol }}</span>
        <span v-if="strategyName" class="strategy-name">
          <el-icon><TrendCharts /></el-icon>
          {{ strategyName }}
        </span>
      </div>
      <div class="chart-controls">
        <el-checkbox-group v-model="indicators" size="small" @change="updateChart">
          <el-checkbox label="MA5" value="MA5">MA5</el-checkbox>
          <el-checkbox label="MA10" value="MA10">MA10</el-checkbox>
          <el-checkbox label="MA20" value="MA20">MA20</el-checkbox>
          <el-checkbox label="MA30" value="MA30">MA30</el-checkbox>
        </el-checkbox-group>
        <el-checkbox v-model="showSignals" @change="updateChart">显示交易信号</el-checkbox>
      </div>
    </div>
    <div ref="chartRef" class="chart-main" :style="{ height: chartHeight }"></div>
    <div ref="volumeRef" class="chart-volume" style="height: 150px"></div>
    
    <!-- 信号统计 -->
    <div v-if="signals && signals.length > 0" class="signal-stats">
      <el-row :gutter="20">
        <el-col :span="6">
          <div class="stat-item">
            <span class="label">买入信号:</span>
            <span class="value buy">{{ buySignals.length }}</span>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-item">
            <span class="label">卖出信号:</span>
            <span class="value sell">{{ sellSignals.length }}</span>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-item">
            <span class="label">最后信号:</span>
            <span class="value">{{ lastSignalText }}</span>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-item">
            <span class="label">信号时间:</span>
            <span class="value">{{ lastSignalTime }}</span>
          </div>
        </el-col>
      </el-row>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { createChart, ColorType } from 'lightweight-charts'
import { itemToUnixSeconds } from '@/utils/tvTime'
import { TrendCharts } from '@element-plus/icons-vue'

const props = defineProps({
  symbol: {
    type: String,
    required: true
  },
  symbolName: {
    type: String,
    default: ''
  },
  strategyName: {
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
  chartHeight: {
    type: String,
    default: '500px'
  }
})

const emit = defineEmits(['price-update', 'data-loaded'])

const chartRef = ref(null)
const volumeRef = ref(null)
const mainChart = ref(null)
const volumeChart = ref(null)
const candlestickSeries = ref(null)
const volumeSeries = ref(null)
const maSeries = ref({})
const indicators = ref(['MA5', 'MA10', 'MA20'])
const showSignals = ref(true)

// 计算买卖信号
const buySignals = computed(() => {
  return props.signals.filter(s => s.type === 'buy')
})

const sellSignals = computed(() => {
  return props.signals.filter(s => s.type === 'sell')
})

const lastSignal = computed(() => {
  const allSignals = [...buySignals.value, ...sellSignals.value]
  if (allSignals.length === 0) return null
  return allSignals.sort((a, b) => b.index - a.index)[0]
})

const lastSignalText = computed(() => {
  if (!lastSignal.value) return '-'
  return lastSignal.value.type === 'buy' ? '买入' : '卖出'
})

const lastSignalTime = computed(() => {
  if (!lastSignal.value || !lastSignal.value.timestamp) return '-'
  const date = new Date(lastSignal.value.timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
})

onMounted(() => {
  initCharts()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  if (mainChart.value) {
    mainChart.value.remove()
  }
  if (volumeChart.value) {
    volumeChart.value.remove()
  }
  window.removeEventListener('resize', handleResize)
})

watch(() => [props.data, props.signals], () => {
  if (props.data && props.data.kline) {
    updateChart()
  }
}, { deep: true })

function initCharts() {
  if (!chartRef.value || !volumeRef.value) return

  // 主图表
  mainChart.value = createChart(chartRef.value, {
    width: chartRef.value.clientWidth,
    height: parseInt(props.chartHeight) || 500,
    layout: {
      background: { type: ColorType.Solid, color: '#1a1a1a' },
      textColor: '#ccc',
    },
    grid: {
      vertLines: { color: '#333' },
      horzLines: { color: '#333' },
    },
    crosshair: {
      mode: 1,
    },
    rightPriceScale: {
      borderColor: '#555',
    },
    timeScale: {
      borderColor: '#555',
      timeVisible: true,
      secondsVisible: false,
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
  })

  // 成交量图表
  volumeChart.value = createChart(volumeRef.value, {
    width: volumeRef.value.clientWidth,
    height: 150,
    layout: {
      background: { type: ColorType.Solid, color: '#1a1a1a' },
      textColor: '#ccc',
    },
    grid: {
      vertLines: { color: '#333' },
      horzLines: { color: '#333' },
    },
    rightPriceScale: {
      borderColor: '#555',
    },
    timeScale: {
      borderColor: '#555',
      visible: false,
    },
  })

  // 创建K线系列
  candlestickSeries.value = mainChart.value.addCandlestickSeries({
    upColor: '#ef5350',
    downColor: '#26a69a',
    borderUpColor: '#ef5350',
    borderDownColor: '#26a69a',
    wickUpColor: '#ef5350',
    wickDownColor: '#26a69a',
  })

  // 创建成交量系列
  volumeSeries.value = volumeChart.value.addHistogramSeries({
    color: '#64748b',
    priceFormat: {
      type: 'volume',
    },
  })

  if (props.data && props.data.kline) {
    updateChart()
  }
}

function updateChart() {
  if (!props.data || !props.data.kline || props.data.kline.length === 0) {
    return
  }

  try {
    const klineData = props.data.kline
    
    // 转换数据格式为 lightweight-charts 格式
    const candleData = klineData.map(item => {
      const time = itemToUnixSeconds(item)
      if (!time) return null
      return { time, open: item.open, high: item.high, low: item.low, close: item.close }
    }).filter(Boolean)

    const volumeData = klineData.map(item => {
      const time = itemToUnixSeconds(item)
      if (!time) return null
      return { time, value: item.volume, color: item.close >= item.open ? '#ef535080' : '#26a69a80' }
    }).filter(Boolean)

    // 更新K线数据
    candlestickSeries.value.setData(candleData)
    
    // 更新成交量数据
    volumeSeries.value.setData(volumeData)

    // 添加移动平均线
    updateMovingAverages()

    // 显示信号标记
    updateSignalMarkers()

    // 同步时间轴
    mainChart.value.timeScale().fitContent()
    volumeChart.value.timeScale().fitContent()

    // 发出数据加载完成事件
    emit('data-loaded', { symbol: props.symbol, dataCount: klineData.length })

    // 发出价格更新事件
    if (klineData.length > 0) {
      const lastCandle = klineData[klineData.length - 1]
      emit('price-update', {
        symbol: props.symbol,
        price: lastCandle.close,
        open: lastCandle.open,
        high: lastCandle.high,
        low: lastCandle.low,
        volume: lastCandle.volume,
        amount: lastCandle.amount
      })
    }

  } catch (error) {
    console.error('K线图更新失败:', error)
  }
}

function updateMovingAverages() {
  if (!props.data || !props.data.indicators) return

  // 清除现有均线
  Object.values(maSeries.value).forEach(series => {
    if (series) {
      mainChart.value.removeSeries(series)
    }
  })
  maSeries.value = {}

  const colors = {
    MA5: '#fff',
    MA10: '#ffeb3b',
    MA20: '#e91e63',
    MA30: '#00bcd4'
  }

  indicators.value.forEach(indicator => {
    const key = indicator.toLowerCase()
    const maData = props.data.indicators[key]
    
    if (maData && Array.isArray(maData)) {
      const series = mainChart.value.addLineSeries({
        color: colors[indicator],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })

      const lineData = maData.map((value, index) => {
        if (value === '-' || value === null || value === undefined || isNaN(value)) {
          return null
        }
        const time = itemToUnixSeconds(props.data.kline[index])
        if (!time) return null
        return {
          time,
          value: typeof value === 'number' ? value : parseFloat(value)
        }
      }).filter(item => item !== null)

      if (lineData.length > 0) {
        series.setData(lineData)
        maSeries.value[indicator] = series
      }
    }
  })
}

function updateSignalMarkers() {
  if (!showSignals.value || !props.signals || props.signals.length === 0) {
    return
  }

  console.log('🔄 StrategyKLineChart: 更新信号标记', props.signals.length, '个信号')

  // 清除现有的信号覆盖层
  const existingOverlay = chartRef.value.querySelector('#signal-overlay')
  if (existingOverlay) {
    existingOverlay.remove()
  }

  // 获取K线数据用于时间戳匹配
  const klineData = props.data?.kline || []
  if (klineData.length === 0) {
    console.warn('⚠️ 没有K线数据，无法定位信号')
    return
  }

  const signalOverlay = document.createElement('div')
  signalOverlay.id = 'signal-overlay'
  signalOverlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 1000;
  `

  chartRef.value.style.position = 'relative'
  chartRef.value.appendChild(signalOverlay)

  // 获取图表的时间范围和尺寸
  const chartWidth = chartRef.value.clientWidth
  const chartHeight = chartRef.value.clientHeight

  props.signals.forEach((signal, signalIndex) => {
    try {
      // 根据信号时间戳找到对应的K线位置
      let signalPosition = null
      
      // 方法1: 如果信号有index属性，直接使用
      if (signal.index !== undefined && signal.index >= 0 && signal.index < klineData.length) {
        signalPosition = {
          index: signal.index,
          kline: klineData[signal.index]
        }
      }
      // 方法2: 根据时间戳匹配
      else if (signal.timestamp || signal.time) {
        const signalTimestamp = signal.timestamp || new Date(signal.time).getTime()
        
        // 找到最接近的K线
        let closestIndex = 0
        let minTimeDiff = Math.abs(klineData[0].timestamp - signalTimestamp)
        
        for (let i = 1; i < klineData.length; i++) {
          const timeDiff = Math.abs(klineData[i].timestamp - signalTimestamp)
          if (timeDiff < minTimeDiff) {
            minTimeDiff = timeDiff
            closestIndex = i
          }
        }
        
        signalPosition = {
          index: closestIndex,
          kline: klineData[closestIndex]
        }
        
        console.log(`📍 信号 ${signalIndex + 1} 时间匹配:`, {
          signalTime: signal.time,
          signalTimestamp: signalTimestamp,
          matchedKlineTime: new Date(klineData[closestIndex].timestamp).toISOString(),
          matchedIndex: closestIndex,
          timeDiff: minTimeDiff
        })
      }
      // 方法3: 如果都没有，按顺序分布
      else {
        const distributedIndex = Math.floor((signalIndex / props.signals.length) * (klineData.length - 1))
        signalPosition = {
          index: distributedIndex,
          kline: klineData[distributedIndex]
        }
        
        console.warn(`⚠️ 信号 ${signalIndex + 1} 缺少时间信息，使用分布式定位:`, distributedIndex)
      }

      if (!signalPosition) {
        console.error(`❌ 无法定位信号 ${signalIndex + 1}`)
        return
      }

      // 计算信号在图表中的位置
      const leftPercent = (signalPosition.index / (klineData.length - 1)) * 100
      
      // 根据信号价格计算垂直位置
      const signalPrice = signal.price || signalPosition.kline.close
      const klinePrices = klineData.map(k => [k.high, k.low]).flat()
      const maxPrice = Math.max(...klinePrices)
      const minPrice = Math.min(...klinePrices)
      const priceRange = maxPrice - minPrice
      
      // 计算价格在图表中的相对位置 (0-100%)
      let topPercent = 100 - ((signalPrice - minPrice) / priceRange) * 100
      
      // 为买入和卖出信号添加偏移，避免重叠
      if (signal.type === 'buy') {
        topPercent = Math.min(95, topPercent + 5) // 买入信号稍微向下偏移
      } else {
        topPercent = Math.max(5, topPercent - 5)  // 卖出信号稍微向上偏移
      }

      // 创建信号标记
      const marker = document.createElement('div')
      marker.innerHTML = signal.type === 'buy' ? '▲' : '▼'
      marker.title = `${signal.type === 'buy' ? '买入' : '卖出'}信号\n价格: ${signalPrice}\n时间: ${signal.time || new Date(signalPosition.kline.timestamp).toLocaleString()}\n原因: ${signal.reason || '策略信号'}\nK线索引: ${signalPosition.index}`

      marker.style.cssText = `
        position: absolute;
        left: ${Math.max(2, Math.min(98, leftPercent))}%;
        top: ${Math.max(5, Math.min(95, topPercent))}%;
        width: 20px;
        height: 20px;
        color: ${signal.type === 'buy' ? '#ef5350' : '#26a69a'};
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        font-weight: bold;
        cursor: pointer;
        pointer-events: auto;
        transform: translate(-50%, -50%);
        transition: all 0.3s ease;
        z-index: 1001;
        text-shadow: 0 0 3px rgba(0,0,0,0.8);
        border: 2px solid white;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.3);
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      `

      // 添加悬停效果
      marker.addEventListener('mouseenter', () => {
        marker.style.transform = 'translate(-50%, -50%) scale(1.5)'
        marker.style.background = 'rgba(0, 0, 0, 0.6)'
        marker.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)'
      })

      marker.addEventListener('mouseleave', () => {
        marker.style.transform = 'translate(-50%, -50%) scale(1)'
        marker.style.background = 'rgba(0, 0, 0, 0.3)'
        marker.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)'
      })

      // 添加点击事件
      marker.addEventListener('click', () => {
        const detailInfo = `${signal.type === 'buy' ? '👍 买入信号' : '👎 卖出信号'}

📊 信号详情:
• 价格: ${signalPrice}
• 时间: ${signal.time || new Date(signalPosition.kline.timestamp).toLocaleString()}
• 原因: ${signal.reason || '策略信号'}
• K线索引: ${signalPosition.index}

📈 K线数据:
• 开盘: ${signalPosition.kline.open}
• 最高: ${signalPosition.kline.high}
• 最低: ${signalPosition.kline.low}
• 收盘: ${signalPosition.kline.close}
• 成交量: ${signalPosition.kline.volume}`

        alert(detailInfo)
      })

      signalOverlay.appendChild(marker)

      // 显示动画
      setTimeout(() => {
        marker.style.opacity = '1'
        marker.style.transform = 'translate(-50%, -50%) scale(1.3)'
        setTimeout(() => {
          marker.style.transform = 'translate(-50%, -50%) scale(1)'
        }, 300)
      }, signalIndex * 150)

      marker.style.opacity = '0'

      console.log(`✅ 信号 ${signalIndex + 1} 已定位:`, {
        type: signal.type,
        price: signalPrice,
        leftPercent: leftPercent.toFixed(1),
        topPercent: topPercent.toFixed(1),
        klineIndex: signalPosition.index
      })

    } catch (error) {
      console.error(`❌ 处理信号 ${signalIndex + 1} 时出错:`, error, signal)
    }
  })

  console.log('✅ StrategyKLineChart: 所有信号标记已根据实际位置设置')
}

function handleResize() {
  if (mainChart.value && chartRef.value) {
    mainChart.value.applyOptions({
      width: chartRef.value.clientWidth,
    })
  }
  if (volumeChart.value && volumeRef.value) {
    volumeChart.value.applyOptions({
      width: volumeRef.value.clientWidth,
    })
  }
}
</script>

<style scoped>
.strategy-kline-container {
  width: 100%;
  background: #1a1a1a;
  border-radius: 4px;
  overflow: hidden;
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px 20px;
  background: #252525;
  border-bottom: 1px solid #333;
}

.symbol-info {
  display: flex;
  align-items: center;
  gap: 15px;
}

.symbol-name {
  font-size: 18px;
  font-weight: bold;
  color: #fff;
}

.symbol-code {
  font-size: 14px;
  color: #999;
}

.strategy-name {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 14px;
  color: #409eff;
  padding: 4px 12px;
  background: rgba(64, 158, 255, 0.1);
  border-radius: var(--radius-md);
}

.chart-controls {
  display: flex;
  gap: 20px;
  align-items: center;
}

.chart-main,
.chart-volume {
  width: 100%;
}

.signal-stats {
  padding: 15px 20px;
  background: #252525;
  border-top: 1px solid #333;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #1a1a1a;
  border-radius: 4px;
}

.stat-item .label {
  color: #999;
  font-size: 14px;
}

.stat-item .value {
  font-size: 16px;
  font-weight: bold;
  color: #fff;
}

.stat-item .value.buy {
  color: #ef5350;
}

.stat-item .value.sell {
  color: #26a69a;
}

:deep(.el-checkbox) {
  color: #ccc;
}

:deep(.el-checkbox__input.is-checked .el-checkbox__inner) {
  background-color: #409eff;
  border-color: #409eff;
}
</style>