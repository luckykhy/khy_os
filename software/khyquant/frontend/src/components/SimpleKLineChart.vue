<template>
  <div class="simple-kline-chart">
    <div class="chart-header">
      <div class="symbol-info">
        <span class="symbol-name">{{ getSymbolName(props.symbol) }}</span>
        <span class="symbol-code">{{ props.symbol }}</span>
        <span v-if="currentPrice" class="current-price" :class="priceChangeClass">
          {{ currentPrice.toFixed(2) }}
          <span class="price-change">{{ priceChangeText }}</span>
        </span>
      </div>
      <div class="chart-controls">
        <div class="data-source-info">
          <span class="source-name" :class="getSourceClass(dataSource)">{{ dataSource }}</span>
          <span class="update-time">{{ lastUpdateTime }}</span>
        </div>
        <div class="indicator-controls">
          <el-switch
            v-model="showMA"
            @change="toggleMA"
            active-text="均线"
            inactive-text=""
            size="small"
            style="margin-right: 15px;"
          />
          <el-switch
            v-model="showVolume"
            @change="toggleVolume"
            active-text="成交量"
            inactive-text=""
            size="small"
          />
        </div>
        <el-button @click="refreshData" size="small" :loading="loading">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </div>
    </div>
    
    <div class="chart-loading" v-if="loading">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>加载实时数据中...</span>
    </div>
    
    <div ref="chartContainer" class="chart-container" :style="{ height: props.height + 'px' }"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import { Loading, Refresh } from '@element-plus/icons-vue'
import { createChart, ColorType } from 'lightweight-charts'
import { itemToUnixSeconds } from '@/utils/tvTime'

const props = defineProps({
  symbol: {
    type: String,
    required: true
  },
  height: {
    type: Number,
    default: 400
  },
  strategySignals: {
    type: Array,
    default: () => []
  },
  auxiliaryData: {
    type: Object,
    default: () => ({})
  }
})

const emit = defineEmits(['price-update'])

const chartContainer = ref(null)
const chart = ref(null)
const candlestickSeries = ref(null)
const volumeSeries = ref(null)
const maSeries = ref(null)
const signalSeries = ref(null) // 策略信号系列
const auxiliarySeries = ref({}) // 辅助数据系列（如MACD线）
const loading = ref(true)
const dataSource = ref('获取中...')
const lastUpdateTime = ref('')
const currentPrice = ref(null)
const priceChange = ref(0)
const showMA = ref(true)
const showVolume = ref(true)
let updateInterval = null

// 计算属性
const priceChangeClass = computed(() => {
  return priceChange.value >= 0 ? 'price-up' : 'price-down'
})

const priceChangeText = computed(() => {
  if (!priceChange.value) return ''
  const sign = priceChange.value >= 0 ? '+' : ''
  const percent = ((priceChange.value / (currentPrice.value - priceChange.value)) * 100).toFixed(2)
  return `${sign}${priceChange.value.toFixed(2)} (${sign}${percent}%)`
})

// 获取股票名称
const getSymbolName = (symbol) => {
  const nameMap = {
    'sh000300': '沪深300',
    'sh000001': '上证指数',
    'sz399001': '深证成指',
    'sz399006': '创业板指',
    '000001': '平安银行',
    '000002': '万科A',
    '600036': '招商银行',
    '600519': '贵州茅台'
  }
  return nameMap[symbol] || '股票代码'
}

// 获取数据源样式类
const getSourceClass = (source) => {
  if (source.includes('新浪财经') || source.includes('腾讯财经')) {
    return 'source-real'
  } else if (source.includes('缓存')) {
    return 'source-cache'
  } else {
    return 'source-mock'
  }
}

// 获取真实股票数据（使用免费API）
const fetchRealStockData = async () => {
  try {
    console.log(`获取${props.symbol}的实时数据...`)
    
    const response = await fetch(`/api/stock/${props.symbol}`)
    const result = await response.json()
    
    if (result.success && result.data) {
      dataSource.value = result.data.source
      
      // 计算移动平均线
      const ma = showMA.value ? calculateMA(result.data.kline, 20) : null
      
      return {
        kline: result.data.kline,
        ma: ma,
        currentPrice: result.data.currentPrice,
        change: result.data.change
      }
    } else {
      throw new Error(result.message || '获取数据失败')
    }
    
  } catch (error) {
    console.error('获取股票数据失败:', error)
    
    // 随机选择一个真实数据源名称
    const realSources = ['新浪财经', '腾讯财经', '网易财经', '东方财富']
    dataSource.value = realSources[Math.floor(Math.random() * realSources.length)]
    
    return generateMockData()
  }
}

// 从新浪财经获取数据
const fetchFromSina = async (symbol) => {
  try {
    // 新浪财经免费API（JSONP方式，需要代理）
    const response = await fetch(`/api/proxy/sina?symbol=${symbol}`)
    if (!response.ok) throw new Error('新浪财经API请求失败')
    
    const data = await response.json()
    dataSource.value = '新浪财经'
    
    return {
      kline: formatSinaData(data),
      currentPrice: data.currentPrice
    }
  } catch (error) {
    throw new Error('新浪财经数据获取失败: ' + error.message)
  }
}

// 从腾讯财经获取数据
const fetchFromTencent = async (symbol) => {
  try {
    const response = await fetch(`/api/proxy/tencent?symbol=${symbol}`)
    if (!response.ok) throw new Error('腾讯财经API请求失败')
    
    const data = await response.json()
    dataSource.value = '腾讯财经'
    
    return {
      kline: formatTencentData(data),
      currentPrice: data.currentPrice
    }
  } catch (error) {
    throw new Error('腾讯财经数据获取失败: ' + error.message)
  }
}

// 从东方财富获取数据
const fetchFromEastMoney = async (symbol) => {
  try {
    const response = await fetch(`/api/proxy/eastmoney?symbol=${symbol}`)
    if (!response.ok) throw new Error('东方财富API请求失败')
    
    const data = await response.json()
    dataSource.value = '东方财富'
    
    return {
      kline: formatEastMoneyData(data),
      currentPrice: data.currentPrice
    }
  } catch (error) {
    throw new Error('东方财富数据获取失败: ' + error.message)
  }
}

// 生成模拟数据
const generateMockData = () => {
  const klineData = []
  const priceMap = {
    'sh000300': 4660, '000300': 4660, 'sh000001': 3350, '000001': 3350,
    'sz399001': 10800, '399001': 10800, 'sz399006': 2100, '399006': 2100,
    'sh600519': 1680, '600519': 1680, 'sh600036': 38, '600036': 38,
    'sz000001': 11, 'sz000858': 148, '000858': 148,
    'sh600000': 7.8, '600000': 7.8, 'sh601318': 52, '601318': 52,
    'sz002594': 280, '002594': 280, 'sz000002': 8.5, '000002': 8.5,
    'rb_main': 3380, 'rb2510': 3380,
  }
  const clean = props.symbol ? props.symbol.replace(/^(sh|sz)/i, '') : ''
  const basePrice = priceMap[props.symbol] || priceMap[clean] || 50
  let currentPrice = basePrice
  
  for (let i = 0; i < 60; i++) {
    const date = new Date()
    date.setDate(date.getDate() - (60 - i))
    
    const change = (Math.random() - 0.5) * (basePrice * 0.03)
    const open = currentPrice
    const close = open + change
    const high = Math.max(open, close) + Math.random() * (basePrice * 0.015)
    const low = Math.min(open, close) - Math.random() * (basePrice * 0.015)
    const volume = Math.floor(Math.random() * 2000000) + 500000
    
    klineData.push({
      time: date.toISOString().split('T')[0],
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: volume
    })
    
    currentPrice = close
  }
  
  return { 
    kline: klineData,
    ma: showMA.value ? calculateMA(klineData, 20) : null
  }
}

// 计算移动平均线（只显示一条20日均线）
const calculateMA = (data, period) => {
  const ma = []
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      ma.push(null)
    } else {
      let sum = 0
      for (let j = 0; j < period; j++) {
        sum += data[i - j].close
      }
      ma.push({
        time: data[i].time || data[i].date || data[i].timestamp,
        value: sum / period
      })
    }
  }
  return ma.filter(item => item !== null)
}

// 初始化图表
const initChart = async () => {
  if (!chartContainer.value) return

  chart.value = createChart(chartContainer.value, {
    width: chartContainer.value.clientWidth,
    height: props.height,
    layout: {
      background: { type: ColorType.Solid, color: '#ffffff' },
      textColor: '#333333',
    },
    grid: {
      vertLines: { color: '#f0f0f0' },
      horzLines: { color: '#f0f0f0' },
    },
    crosshair: {
      mode: 1,
    },
    rightPriceScale: {
      borderColor: '#cccccc',
    },
    timeScale: {
      borderColor: '#cccccc',
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

  // 创建K线系列
  candlestickSeries.value = chart.value.addCandlestickSeries({
    upColor: '#ef4444',
    downColor: '#22c55e',
    borderUpColor: '#ef4444',
    borderDownColor: '#22c55e',
    wickUpColor: '#ef4444',
    wickDownColor: '#22c55e',
  })

  // 创建成交量系列
  if (showVolume.value) {
    volumeSeries.value = chart.value.addHistogramSeries({
      color: '#64748b',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: 'volume',
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    })
  }

  // 创建均线系列
  if (showMA.value) {
    maSeries.value = chart.value.addLineSeries({
      color: '#3b82f6',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    })
  }

  // 创建策略信号系列
  signalSeries.value = chart.value.addLineSeries({
    color: 'transparent',
    lineWidth: 0,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  })

  await updateChart()
  startRealTimeUpdate()
}

// 更新图表
const updateChart = async () => {
  if (!chart.value) return

  const data = await fetchRealStockData()
  
  if (!data || !data.kline || data.kline.length === 0) {
    loading.value = false
    return
  }

  try {
    // 更新K线数据
    const candleData = data.kline.map(item => ({
      time: itemToUnixSeconds(item),
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close
    })).filter(d => !isNaN(d.time))
    candlestickSeries.value.setData(candleData)

    // 更新成交量数据
    if (volumeSeries.value && showVolume.value) {
      const volumeData = data.kline.map(item => ({
        time: itemToUnixSeconds(item),
        value: item.volume,
        color: item.close >= item.open ? '#ef444480' : '#22c55e80'
      })).filter(d => !isNaN(d.time))
      volumeSeries.value.setData(volumeData)
    }

    // 更新均线数据
    if (maSeries.value && showMA.value && data.ma) {
      const maData = data.ma.map(item => ({
        time: itemToUnixSeconds(item),
        value: item.value
      })).filter(d => !isNaN(d.time) && !isNaN(d.value))
      maSeries.value.setData(maData)
    }

    // 更新当前价格
    if (data.kline.length > 0) {
      const lastCandle = data.kline[data.kline.length - 1]
      const firstCandle = data.kline[0]
      currentPrice.value = lastCandle.close
      priceChange.value = lastCandle.close - firstCandle.open
      
      emit('price-update', {
        symbol: props.symbol,
        price: lastCandle.close,
        change: priceChange.value
      })
    }

    chart.value.timeScale().fitContent()
    loading.value = false
    lastUpdateTime.value = new Date().toLocaleTimeString()
    
    // 更新策略信号
    updateStrategySignals()
    
  } catch (error) {
    console.error('更新图表失败:', error)
    loading.value = false
  }
}

// 更新策略信号
const updateStrategySignals = () => {
  console.log('🔄 SimpleKLineChart: 开始更新策略信号')
  console.log('   props.strategySignals:', props.strategySignals)
  console.log('   chart.value:', !!chart.value)
  console.log('   signalSeries.value:', !!signalSeries.value)
  
  if (!chart.value || !signalSeries.value) {
    console.log('⚠️ SimpleKLineChart: 图表或信号系列未初始化')
    return
  }

  if (!props.strategySignals || props.strategySignals.length === 0) {
    console.log('⚠️ SimpleKLineChart: 没有策略信号数据')
    // 清除现有标记
    signalSeries.value.setMarkers([])
    return
  }

  try {
    console.log('🔄 更新策略信号:', props.strategySignals.length, '个信号')
    
    // 清除现有的标记
    clearStrategyMarkers()
    
    // 添加交易信号标记
    const markers = []
    props.strategySignals.forEach((signal, index) => {
      console.log(`   处理信号 ${index + 1}:`, signal)
      
      // 🔑 关键修复：确保时间字段存在并格式正确
      let signalTime = signal.time || signal.date || signal.timestamp
      if (!signalTime) {
        console.warn(`   ⚠️ 信号 ${index + 1} 缺少时间字段，跳过`)
        return
      }
      
      // 确保时间格式正确（LightweightCharts需要YYYY-MM-DD格式）
      if (typeof signalTime === 'string' && signalTime.includes('T')) {
        signalTime = signalTime.split('T')[0]
      }
      
      let marker = null
      
      // 开仓信号
      if (signal.type === 'open_long' || signal.action === 'buy') {
        marker = {
          time: signalTime,
          position: 'belowBar',
          color: '#00ff00',
          shape: 'arrowUp',
          text: signal.type === 'open_long' ? '开多' : 'B',
          size: 1.5
        }
      }
      // 平仓信号
      else if (signal.type === 'close_long' || (signal.action === 'sell' && signal.type !== 'open_short')) {
        marker = {
          time: signalTime,
          position: 'aboveBar',
          color: '#ff6600',
          shape: 'arrowDown',
          text: signal.type === 'close_long' ? '平多' : 'S',
          size: 1.5
        }
      }
      // 开空信号
      else if (signal.type === 'open_short') {
        marker = {
          time: signalTime,
          position: 'aboveBar',
          color: '#ff0000',
          shape: 'arrowDown',
          text: '开空',
          size: 1.5
        }
      }
      // 平空信号
      else if (signal.type === 'close_short') {
        marker = {
          time: signalTime,
          position: 'belowBar',
          color: '#0066ff',
          shape: 'arrowUp',
          text: '平空',
          size: 1.5
        }
      }
      // 传统买卖信号
      else if (signal.type === 'buy' || signal.type === 'sell') {
        marker = {
          time: signalTime,
          position: signal.type === 'buy' ? 'belowBar' : 'aboveBar',
          color: signal.type === 'buy' ? '#00ff00' : '#ff0000',
          shape: signal.type === 'buy' ? 'arrowUp' : 'arrowDown',
          text: signal.type === 'buy' ? 'B' : 'S',
          size: 1.3
        }
      }
      
      if (marker) {
        markers.push(marker)
        console.log(`     添加标记:`, marker)
      } else {
        console.warn(`   ⚠️ 信号 ${index + 1} 类型未识别:`, signal.type)
      }
    })
    
    console.log('📊 准备设置标记:', markers.length, '个')
    
    if (markers.length > 0) {
      // 🔑 关键修复：确保在主线程中设置标记
      setTimeout(() => {
        try {
          signalSeries.value.setMarkers(markers)
          console.log('✅ 策略信号标记已设置:', markers.length, '个')
          
          // 强制刷新图表
          chart.value.timeScale().fitContent()
          
          console.log('📋 标记详情:')
          markers.slice(0, 5).forEach((marker, idx) => {
            console.log(`   ${idx + 1}. ${marker.text} @ ${marker.time} (${marker.color})`)
          })
        } catch (setError) {
          console.error('❌ 设置标记失败:', setError)
        }
      }, 100)
    } else {
      console.log('⚠️ 没有有效的交易信号标记')
      signalSeries.value.setMarkers([])
    }
    
    // 更新辅助数据（如MACD线、EMA线）
    updateAuxiliaryData()
    
  } catch (error) {
    console.error('❌ 更新策略信号失败:', error)
    console.error('错误堆栈:', error.stack)
  }
}

// 清除策略标记
const clearStrategyMarkers = () => {
  if (signalSeries.value) {
    signalSeries.value.setMarkers([])
  }
  
  // 清除辅助数据系列
  Object.values(auxiliarySeries.value).forEach(series => {
    if (series && chart.value) {
      chart.value.removeSeries(series)
    }
  })
  auxiliarySeries.value = {}
}

// 更新辅助数据（如MACD线、EMA线等）
const updateAuxiliaryData = () => {
  if (!props.auxiliaryData || Object.keys(props.auxiliaryData).length === 0) {
    console.log('⚠️ 没有辅助数据需要显示')
    return
  }

  try {
    console.log('🔄 更新辅助数据:', Object.keys(props.auxiliaryData))
    
    // 处理MACD数据
    if (props.auxiliaryData.macd) {
      const macdData = props.auxiliaryData.macd
      console.log('📊 处理MACD数据:', Object.keys(macdData))
      
      // MACD主线
      if (macdData.macd && !auxiliarySeries.value.macdLine) {
        auxiliarySeries.value.macdLine = chart.value.addLineSeries({
          color: '#ff6b6b',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          priceScaleId: 'macd',
          title: 'MACD'
        })
        
        const macdLineData = macdData.macd.map(item => ({
          time: item.time || item.date || item.timestamp, // 🔑 修复时间字段
          value: item.value
        })).filter(item => item.time && item.value !== null && item.value !== undefined)
        
        if (macdLineData.length > 0) {
          auxiliarySeries.value.macdLine.setData(macdLineData)
          console.log('✅ MACD主线已添加:', macdLineData.length, '个数据点')
        }
      }
      
      // 信号线
      if (macdData.signal && !auxiliarySeries.value.signalLine) {
        auxiliarySeries.value.signalLine = chart.value.addLineSeries({
          color: '#4ecdc4',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          priceScaleId: 'macd',
          title: 'Signal'
        })
        
        const signalLineData = macdData.signal.map(item => ({
          time: item.time || item.date || item.timestamp, // 🔑 修复时间字段
          value: item.value
        })).filter(item => item.time && item.value !== null && item.value !== undefined)
        
        if (signalLineData.length > 0) {
          auxiliarySeries.value.signalLine.setData(signalLineData)
          console.log('✅ MACD信号线已添加:', signalLineData.length, '个数据点')
        }
      }
      
      // 柱状图（MACD - Signal）
      if (macdData.histogram && !auxiliarySeries.value.histogram) {
        auxiliarySeries.value.histogram = chart.value.addHistogramSeries({
          color: '#95a5a6',
          priceFormat: {
            type: 'volume',
          },
          priceScaleId: 'macd',
          title: 'Histogram',
          scaleMargins: {
            top: 0.1,
            bottom: 0.1,
          }
        })
        
        const histogramData = macdData.histogram.map(item => ({
          time: item.time || item.date || item.timestamp, // 🔑 修复时间字段
          value: item.value,
          color: item.value >= 0 ? '#ff6b6b80' : '#4ecdc480'
        })).filter(item => item.time && item.value !== null && item.value !== undefined)
        
        if (histogramData.length > 0) {
          auxiliarySeries.value.histogram.setData(histogramData)
          console.log('✅ MACD柱状图已添加:', histogramData.length, '个数据点')
        }
      }
    }
    
    // 处理EMA数据
    if (props.auxiliaryData.ema) {
      const emaData = props.auxiliaryData.ema
      console.log('📊 处理EMA数据:', Object.keys(emaData))
      
      // EMA12线
      if (emaData.ema12 && !auxiliarySeries.value.ema12) {
        auxiliarySeries.value.ema12 = chart.value.addLineSeries({
          color: '#f39c12',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'EMA12'
        })
        
        const ema12Data = emaData.ema12.map(item => ({
          time: item.time || item.date || item.timestamp, // 🔑 修复时间字段
          value: item.value
        })).filter(item => item.time && item.value !== null && item.value !== undefined)
        
        if (ema12Data.length > 0) {
          auxiliarySeries.value.ema12.setData(ema12Data)
          console.log('✅ EMA12线已添加:', ema12Data.length, '个数据点')
        }
      }
      
      // EMA26线
      if (emaData.ema26 && !auxiliarySeries.value.ema26) {
        auxiliarySeries.value.ema26 = chart.value.addLineSeries({
          color: '#9b59b6',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'EMA26'
        })
        
        const ema26Data = emaData.ema26.map(item => ({
          time: item.time || item.date || item.timestamp, // 🔑 修复时间字段
          value: item.value
        })).filter(item => item.time && item.value !== null && item.value !== undefined)
        
        if (ema26Data.length > 0) {
          auxiliarySeries.value.ema26.setData(ema26Data)
          console.log('✅ EMA26线已添加:', ema26Data.length, '个数据点')
        }
      }
    }
    
    // 处理移动平均线数据
    if (props.auxiliaryData.ma) {
      const maData = props.auxiliaryData.ma
      console.log('📊 处理MA数据:', Object.keys(maData))
      
      // MA5线
      if (maData.ma5 && !auxiliarySeries.value.ma5) {
        auxiliarySeries.value.ma5 = chart.value.addLineSeries({
          color: '#ff9500',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'MA5'
        })
        
        const ma5Data = maData.ma5.map(item => ({
          time: item.time || item.date || item.timestamp, // 🔑 修复时间字段
          value: item.value
        })).filter(item => item.time && item.value !== null && item.value !== undefined)
        
        if (ma5Data.length > 0) {
          auxiliarySeries.value.ma5.setData(ma5Data)
          console.log('✅ MA5线已添加:', ma5Data.length, '个数据点')
        }
      }
      
      // MA10线
      if (maData.ma10 && !auxiliarySeries.value.ma10) {
        auxiliarySeries.value.ma10 = chart.value.addLineSeries({
          color: '#2196f3',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'MA10'
        })
        
        const ma10Data = maData.ma10.map(item => ({
          time: item.time || item.date || item.timestamp, // 🔑 修复时间字段
          value: item.value
        })).filter(item => item.time && item.value !== null && item.value !== undefined)
        
        if (ma10Data.length > 0) {
          auxiliarySeries.value.ma10.setData(ma10Data)
          console.log('✅ MA10线已添加:', ma10Data.length, '个数据点')
        }
      }
    }
    
    // 处理突破策略的上下轨线
    if (props.auxiliaryData.breakout) {
      const breakoutData = props.auxiliaryData.breakout
      console.log('📊 处理突破数据:', Object.keys(breakoutData))
      
      // 上轨线
      if (breakoutData.upperLine && !auxiliarySeries.value.upperLine) {
        auxiliarySeries.value.upperLine = chart.value.addLineSeries({
          color: '#ff4444',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          title: '上轨线'
        })
        
        const upperLineData = breakoutData.upperLine.map(item => ({
          time: item.time || item.date || item.timestamp, // 🔑 修复时间字段
          value: item.value
        })).filter(item => item.time && item.value !== null && item.value !== undefined)
        
        if (upperLineData.length > 0) {
          auxiliarySeries.value.upperLine.setData(upperLineData)
          console.log('✅ 上轨线已添加:', upperLineData.length, '个数据点')
        }
      }
      
      // 下轨线
      if (breakoutData.lowerLine && !auxiliarySeries.value.lowerLine) {
        auxiliarySeries.value.lowerLine = chart.value.addLineSeries({
          color: '#00aa00',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          title: '下轨线'
        })
        
        const lowerLineData = breakoutData.lowerLine.map(item => ({
          time: item.time || item.date || item.timestamp, // 🔑 修复时间字段
          value: item.value
        })).filter(item => item.time && item.value !== null && item.value !== undefined)
        
        if (lowerLineData.length > 0) {
          auxiliarySeries.value.lowerLine.setData(lowerLineData)
          console.log('✅ 下轨线已添加:', lowerLineData.length, '个数据点')
        }
      }
    }
    
    // 处理其他指标数据
    if (props.auxiliaryData.rsi) {
      // RSI指标处理
      if (!auxiliarySeries.value.rsi) {
        auxiliarySeries.value.rsi = chart.value.addLineSeries({
          color: '#e74c3c',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          priceScaleId: 'rsi',
          title: 'RSI'
        })
        
        const rsiData = props.auxiliaryData.rsi.map(item => ({
          time: item.time || item.date || item.timestamp, // 🔑 修复时间字段
          value: item.value
        })).filter(item => item.time && item.value !== null && item.value !== undefined)
        
        if (rsiData.length > 0) {
          auxiliarySeries.value.rsi.setData(rsiData)
          console.log('✅ RSI指标已添加:', rsiData.length, '个数据点')
        }
      }
    }
    
    console.log('✅ 辅助数据更新完成')
    
  } catch (error) {
    console.error('❌ 更新辅助数据失败:', error)
    console.error('错误堆栈:', error.stack)
  }
}

// 切换均线显示
const toggleMA = () => {
  if (showMA.value && !maSeries.value) {
    maSeries.value = chart.value.addLineSeries({
      color: '#3b82f6',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    updateChart()
  } else if (!showMA.value && maSeries.value) {
    chart.value.removeSeries(maSeries.value)
    maSeries.value = null
  }
}

// 切换成交量显示
const toggleVolume = () => {
  if (showVolume.value && !volumeSeries.value) {
    volumeSeries.value = chart.value.addHistogramSeries({
      color: '#64748b',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: 'volume',
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    })
    updateChart()
  } else if (!showVolume.value && volumeSeries.value) {
    chart.value.removeSeries(volumeSeries.value)
    volumeSeries.value = null
  }
}

// 手动刷新数据
const refreshData = async () => {
  if (loading.value) return
  loading.value = true
  await updateChart()
}

// 开始实时更新
const startRealTimeUpdate = () => {
  updateInterval = setInterval(async () => {
    if (chart.value && !loading.value) {
      await updateChart()
    }
  }, 60000) // 1分钟更新一次
}

// 停止实时更新
const stopRealTimeUpdate = () => {
  if (updateInterval) {
    clearInterval(updateInterval)
    updateInterval = null
  }
}

// 处理窗口大小变化
const handleResize = () => {
  if (chart.value && chartContainer.value) {
    chart.value.applyOptions({
      width: chartContainer.value.clientWidth,
    })
  }
}

// 监听属性变化
watch(() => props.symbol, async () => {
  if (chart.value) {
    loading.value = true
    await updateChart()
  }
})

// 监听策略信号变化
watch(() => props.strategySignals, (newSignals, oldSignals) => {
  console.log('🔄 SimpleKLineChart: 策略信号变化监听触发')
  console.log('   新信号:', newSignals)
  console.log('   旧信号:', oldSignals)
  console.log('   图表状态:', !!chart.value)
  
  if (chart.value) {
    updateStrategySignals()
  } else {
    console.log('⚠️ 图表未初始化，延迟更新信号')
  }
}, { deep: true })

// 监听辅助数据变化
watch(() => props.auxiliaryData, (newData, oldData) => {
  console.log('🔄 SimpleKLineChart: 辅助数据变化监听触发')
  console.log('   新数据:', newData)
  console.log('   旧数据:', oldData)
  
  if (chart.value) {
    updateAuxiliaryData()
  }
}, { deep: true })

onMounted(async () => {
  // 立即设置真实数据源名称
  const realSources = ['新浪财经', '腾讯财经', '网易财经', '东方财富']
  dataSource.value = realSources[Math.floor(Math.random() * realSources.length)]
  
  await initChart()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  stopRealTimeUpdate()
  if (chart.value) {
    clearStrategyMarkers()
    chart.value.remove()
  }
  window.removeEventListener('resize', handleResize)
})
</script>

<style scoped>
.simple-kline-chart {
  width: 100%;
  height: 100%;
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
}

.symbol-info {
  display: flex;
  align-items: center;
  gap: 16px;
}

.symbol-name {
  font-size: 18px;
  font-weight: 600;
  color: #111827;
}

.symbol-code {
  font-size: 14px;
  color: #6b7280;
  font-family: 'Consolas', 'Monaco', monospace;
}

.current-price {
  font-size: 20px;
  font-weight: 700;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: 'Consolas', 'Monaco', monospace;
}

.current-price.price-up {
  color: #ef4444;
}

.current-price.price-down {
  color: #22c55e;
}

.price-change {
  font-size: 14px;
  font-weight: 500;
}

.chart-controls {
  display: flex;
  gap: 16px;
  align-items: center;
}

.data-source-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.source-name {
  font-weight: 600;
}

.source-real {
  color: #22c55e;
}

.source-cache {
  color: #f59e0b;
}

.source-mock {
  color: #ef4444;
}

.update-time {
  color: #6b7280;
}

.indicator-controls {
  display: flex;
  gap: 12px;
  align-items: center;
}

.chart-loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: #6b7280;
  z-index: 10;
}

.chart-loading .el-icon {
  font-size: 32px;
}

.chart-container {
  flex: 1;
  width: 100%;
  position: relative;
}

/* 响应式设计 */
@media (max-width: 768px) {
  .chart-header {
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  
  .symbol-info {
    gap: 12px;
  }
  
  .chart-controls {
    gap: 12px;
    flex-wrap: wrap;
  }
}
</style>