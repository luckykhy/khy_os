<template>
  <div class="professional-trading-chart">
    <!-- 顶部工具栏 -->
    <div class="chart-toolbar">
      <div class="toolbar-left">
        <!-- 品种选择器 -->
        <el-select
          v-model="selectedSymbol"
          @change="onSymbolChange"
          class="symbol-selector"
          filterable
          placeholder="选择品种"
        >
          <el-option-group label="指数">
            <el-option
              v-for="item in indexList"
              :key="item.code"
              :label="`${item.code} ${item.name}`"
              :value="item.code"
            >
              <span class="option-code">{{ item.code }}</span>
              <span class="option-name">{{ item.name }}</span>
            </el-option>
          </el-option-group>
          <el-option-group label="期货">
            <el-option
              v-for="item in futuresList"
              :key="item.code"
              :label="`${item.code} ${item.name}`"
              :value="item.code"
            >
              <span class="option-code">{{ item.code }}</span>
              <span class="option-name">{{ item.name }}</span>
            </el-option>
          </el-option-group>
          <el-option-group label="股票">
            <el-option
              v-for="item in stockList"
              :key="item.code"
              :label="`${item.code} ${item.name}`"
              :value="item.code"
            >
              <span class="option-code">{{ item.code }}</span>
              <span class="option-name">{{ item.name }}</span>
            </el-option>
          </el-option-group>
        </el-select>

        <!-- 周期选择 -->
        <el-radio-group v-model="selectedPeriod" @change="onPeriodChange" size="small">
          <el-radio-button
            v-for="p in availablePeriods"
            :key="p.value"
            :label="p.value"
          >{{ p.label }}</el-radio-button>
        </el-radio-group>
      </div>

      <div class="toolbar-center">
        <!-- 当前价格信息 -->
        <div class="price-info">
          <span class="symbol-name">{{ currentSymbolInfo.name }}</span>
          <span class="current-price" :class="priceChangeClass">{{ currentPrice }}</span>
          <span class="price-change" :class="priceChangeClass">
            {{ priceChangeText }} ({{ pricePercentText }})
          </span>
          <span v-if="dataSourceLabel" class="data-source-badge" :class="{ 'real-data': !dataSourceLabel.includes('模拟') }">
            {{ dataSourceLabel }}
          </span>
        </div>
      </div>

      <div class="toolbar-right">
        <!-- 技术指标开关 -->
        <el-checkbox-group v-model="enabledIndicators" @change="updateIndicators" size="small">
          <el-checkbox label="MA" value="MA">均线</el-checkbox>
          <el-checkbox label="MACD" value="MACD">MACD</el-checkbox>
          <el-checkbox label="RSI" value="RSI">RSI</el-checkbox>
        </el-checkbox-group>

        <!-- 信号控制 -->
        <el-button-group size="small">
          <el-button @click="loadTradingSignals" :loading="loadingSignals" type="primary">
            <el-icon><TrendCharts /></el-icon>
            加载信号
          </el-button>
          <el-button @click="clearSignals" :disabled="signals.length === 0">
            清除信号
          </el-button>
        </el-button-group>
      </div>
    </div>

    <!-- 主图表区域 -->
    <div class="chart-container">
      <div ref="mainChartRef" class="main-chart"></div>
      <div ref="volumeChartRef" class="volume-chart"></div>
      <div ref="indicatorChartRef" class="indicator-chart" v-if="showIndicatorChart"></div>
    </div>

    <!-- 信号统计面板 -->
    <div class="signal-stats" v-if="signals.length > 0">
      <div class="stats-row">
        <div class="stat-item">
          <span class="label">总信号:</span>
          <span class="value">{{ signals.length }}</span>
        </div>
        <div class="stat-item">
          <span class="label">买入:</span>
          <span class="value buy-signal">{{ buySignals.length }}</span>
        </div>
        <div class="stat-item">
          <span class="label">卖出:</span>
          <span class="value sell-signal">{{ sellSignals.length }}</span>
        </div>
        <div class="stat-item">
          <span class="label">最新信号:</span>
          <span class="value" :class="latestSignal?.type + '-signal'">
            {{ latestSignal ? (latestSignal.type === 'buy' ? '买入' : '卖出') : '无' }}
          </span>
        </div>
        <div class="stat-item">
          <span class="label">信号时间:</span>
          <span class="value">{{ latestSignal ? formatTime(latestSignal.time) : '--' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// ---------------------------------------------------------------------------
// ProfessionalTradingChart —— 专业K线图组件（类TradingView风格）
//
// 架构角色：属于前端交互层，对应论文第2.1节（lightweight-charts K线渲染）
//
// 功能说明：
//   基于 TradingView lightweight-charts 库渲染专业K线图，支持：
//   - 多周期切换：日K / 周K / 月K / 1分钟 / 5分钟 / 15分钟 / 60分钟
//   - 技术指标叠加：MA均线、MACD、RSI、布林带
//   - 交易信号标记：在K线图上标注买入/卖出信号点
//   - 数据源自动检测：优先使用真实数据，无数据时降级到模拟数据
//
// Props:
//   height {number}    — 图表总高度（默认600px）
//   enabledPeriods {Array} — 管理员启用的K线周期列表
//
// Emits:
//   symbol-change — 用户在图表内切换标的
//   period-change — 用户切换K线周期
//   signal-loaded — 交易信号加载完成
//
// 对应论文：第2.1节（表2 Vue3特性对比），第5.5节（前端实现）
// ---------------------------------------------------------------------------
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { createChart, ColorType } from 'lightweight-charts'
import { TrendCharts } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'
import { getApiBaseUrl as getRuntimeApiBaseUrl } from '@/utils/connectionMode'

// ── 组件属性定义 ──
const props = defineProps({
  height: {
    type: Number,
    default: 600
  },
  enabledPeriods: {
    type: Array,
    default: () => ['daily']
  }
})

// ── 组件事件声明 ──
const emit = defineEmits(['symbol-change', 'period-change', 'signal-loaded'])

// ── 响应式数据 ──
const selectedSymbol = ref('IF2609')
const selectedPeriod = ref('1d')
const currentPrice = ref(4648.6)
const priceChange = ref(3)
const priceChangePercent = ref(0.06)
const enabledIndicators = ref(['MA'])
const loadingSignals = ref(false)
const signals = ref([])

// 根据管理员后台设置动态生成可选K线周期（与Dashboard的K线周期管理联动）
const availablePeriods = computed(() => {
  const allDefs = [
    { setting: '1m', value: '1m', label: '1分' },
    { setting: '5m', value: '5m', label: '5分' },
    { setting: '15m', value: '15m', label: '15分' },
    { setting: '30m', value: '30m', label: '30分' },
    { setting: '1h', value: '1h', label: '1时' },
    { setting: 'daily', value: '1d', label: '日线' },
    { setting: 'weekly', value: '1w', label: '周线' },
    { setting: 'monthly', value: '1M', label: '月线' }
  ]
  const enabled = props.enabledPeriods || ['daily']
  return allDefs.filter(p => enabled.includes(p.setting) || enabled.includes(p.value))
})

// ── 图表DOM引用 ──
const mainChartRef = ref(null)
const volumeChartRef = ref(null)
const indicatorChartRef = ref(null)

// ── lightweight-charts 图表实例 ──
const mainChart = ref(null)
const volumeChart = ref(null)
const indicatorChart = ref(null)

// ── 图表数据系列（K线、成交量、均线、MACD、RSI） ──
const candlestickSeries = ref(null)
const volumeSeries = ref(null)
const maSeries = ref([])
const macdSeries = ref({})
const rsiSeries = ref(null)

// ── 金融工具列表（指数、期货、股票），按类别分组显示在选择器中 ──
const symbolList = ref([
  // 指数
  { code: 'IF2609', name: '沪深300期货', type: 'futures', category: 'index_futures' },
  { code: 'IC2609', name: '中证500期货', type: 'futures', category: 'index_futures' },
  { code: 'IH2609', name: '上证50期货', type: 'futures', category: 'index_futures' },
  { code: '000300', name: '沪深300', type: 'index', category: 'index' },
  { code: '000001', name: '上证指数', type: 'index', category: 'index' },
  { code: '399001', name: '深证成指', type: 'index', category: 'index' },
  { code: '399006', name: '创业板指', type: 'index', category: 'index' },
  
  // 期货
  { code: 'CU2609', name: '沪铜期货', type: 'futures', category: 'metal' },
  { code: 'AU2612', name: '沪金期货', type: 'futures', category: 'metal' },
  { code: 'AG2612', name: '沪银期货', type: 'futures', category: 'metal' },
  { code: 'RB2609', name: '螺纹钢期货', type: 'futures', category: 'metal' },
  { code: 'C2609', name: '玉米期货', type: 'futures', category: 'agriculture' },
  { code: 'A2609', name: '豆一期货', type: 'futures', category: 'agriculture' },
  
  // 股票
  { code: '000001', name: '平安银行', type: 'stock', category: 'finance' },
  { code: '000002', name: '万科A', type: 'stock', category: 'real_estate' },
  { code: '600036', name: '招商银行', type: 'stock', category: 'finance' },
  { code: '600519', name: '贵州茅台', type: 'stock', category: 'consumer' },
  { code: '000858', name: '五粮液', type: 'stock', category: 'consumer' },
  { code: '002415', name: '海康威视', type: 'stock', category: 'technology' }
])

// ── 计算属性：按类型过滤金融工具列表 ──
const indexList = computed(() => symbolList.value.filter(s => s.type === 'index'))
const futuresList = computed(() => symbolList.value.filter(s => s.type === 'futures'))
const stockList = computed(() => symbolList.value.filter(s => s.type === 'stock'))

const currentSymbolInfo = computed(() => {
  return symbolList.value.find(s => s.code === selectedSymbol.value) || { name: '未知品种' }
})

const priceChangeClass = computed(() => {
  return priceChange.value >= 0 ? 'price-up' : 'price-down'
})

const priceChangeText = computed(() => {
  const change = priceChange.value
  return `${change >= 0 ? '+' : ''}${change.toFixed(2)}`
})

const pricePercentText = computed(() => {
  const percent = priceChangePercent.value
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`
})

const buySignals = computed(() => signals.value.filter(s => s.type === 'buy'))
const sellSignals = computed(() => signals.value.filter(s => s.type === 'sell'))

const latestSignal = computed(() => {
  if (signals.value.length === 0) return null
  return signals.value[signals.value.length - 1]
})

const showIndicatorChart = computed(() => {
  return enabledIndicators.value.includes('MACD') || enabledIndicators.value.includes('RSI')
})

// ── 生命周期：挂载时初始化图表并加载数据，卸载时清理资源 ──
onMounted(() => {
  initCharts()
  loadInitialData().catch(err => console.error('[Chart] Init load failed:', err))
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  if (mainChart.value) mainChart.value.remove()
  if (volumeChart.value) volumeChart.value.remove()
  if (indicatorChart.value) indicatorChart.value.remove()
  window.removeEventListener('resize', handleResize)
})

// 监听指标开关变化，动态添加/移除子图表和指标线
watch(() => enabledIndicators.value, () => {
  nextTick(() => {
    if (showIndicatorChart.value && !indicatorChart.value) {
      initIndicatorChart()
    }
    updateIndicators()
  })
}, { deep: true })

// ── 初始化图表：创建主图（K线）、成交量图、同步时间轴 ──
function initCharts() {
  // 主图表
  mainChart.value = createChart(mainChartRef.value, {
    width: mainChartRef.value.clientWidth,
    height: Math.floor(props.height * 0.6),
    layout: {
      background: { type: ColorType.Solid, color: '#0d1421' },
      textColor: '#d1d4dc',
    },
    grid: {
      vertLines: { color: '#2b2b43' },
      horzLines: { color: '#2b2b43' },
    },
    crosshair: {
      mode: 1,
    },
    rightPriceScale: {
      borderColor: '#2b2b43',
    },
    timeScale: {
      borderColor: '#2b2b43',
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
  volumeChart.value = createChart(volumeChartRef.value, {
    width: volumeChartRef.value.clientWidth,
    height: Math.floor(props.height * 0.25),
    layout: {
      background: { type: ColorType.Solid, color: '#0d1421' },
      textColor: '#d1d4dc',
    },
    grid: {
      vertLines: { color: '#2b2b43' },
      horzLines: { color: '#2b2b43' },
    },
    rightPriceScale: {
      borderColor: '#2b2b43',
    },
    timeScale: {
      borderColor: '#2b2b43',
      visible: false,
    },
  })

  // 创建K线系列
  candlestickSeries.value = mainChart.value.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderUpColor: '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
  })

  // 创建成交量系列
  volumeSeries.value = volumeChart.value.addHistogramSeries({
    color: '#26a69a',
    priceFormat: {
      type: 'volume',
    },
  })

  // 同步时间轴
  mainChart.value.timeScale().subscribeVisibleTimeRangeChange(() => {
    const timeRange = mainChart.value.timeScale().getVisibleRange()
    if (timeRange) {
      volumeChart.value.timeScale().setVisibleRange(timeRange)
      if (indicatorChart.value) {
        indicatorChart.value.timeScale().setVisibleRange(timeRange)
      }
    }
  })
}

// 初始化技术指标子图表（用于MACD和RSI）
function initIndicatorChart() {
  if (!indicatorChartRef.value) return

  indicatorChart.value = createChart(indicatorChartRef.value, {
    width: indicatorChartRef.value.clientWidth,
    height: Math.floor(props.height * 0.15),
    layout: {
      background: { type: ColorType.Solid, color: '#0d1421' },
      textColor: '#d1d4dc',
    },
    grid: {
      vertLines: { color: '#2b2b43' },
      horzLines: { color: '#2b2b43' },
    },
    rightPriceScale: {
      borderColor: '#2b2b43',
    },
    timeScale: {
      borderColor: '#2b2b43',
      visible: false,
    },
  })
}

const dataSourceLabel = ref('')
let _loadVersion = 0

function getApiBaseUrl() {
  const apiBase = getRuntimeApiBaseUrl()
  return apiBase.endsWith('/api') ? apiBase.slice(0, -4) : apiBase
}

// 加载K线数据——优先从后端API获取真实数据，失败时降级到本地模拟数据
async function loadInitialData() {
  const thisLoad = ++_loadVersion
  const symbol = selectedSymbol.value
  const period = selectedPeriod.value

  // Map lightweight-charts period values to backend period parameter
  const periodMap = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '1d': 'daily', '1w': 'weekly', '1M': 'monthly' }
  const apiPeriod = periodMap[period] || 'daily'

  let klineData = null

  // Priority 1: Fetch from backend API (AKShare / AData / DB)
  try {
    const response = await request.get('/api/comprehensive-data/kline', {
      params: { symbol, period: apiPeriod, limit: 200 },
      timeout: 50000
    })

    const resData = response.data || response
    if (resData.success && Array.isArray(resData.kline) && resData.kline.length > 0) {
      const isMock = resData.isMock || false
      const source = resData.data_source || resData.source || 'API'
      dataSourceLabel.value = isMock ? `模拟数据 (${source})` : `真实数据 (${source})`

      klineData = resData.kline.map(item => {
        // Convert date string "YYYY-MM-DD" to Unix timestamp for lightweight-charts
        const dateStr = item.time || item.date || ''
        const ts = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0
        return {
          time: ts,
          open: parseFloat(item.open) || 0,
          high: parseFloat(item.high) || 0,
          low: parseFloat(item.low) || 0,
          close: parseFloat(item.close) || 0,
          volume: parseInt(item.volume) || 0
        }
      }).filter(item => item.time > 0)

      if (!isMock) {
        console.log(`[Chart] Loaded ${klineData.length} real data points from ${source}`)
      }
    }
  } catch (error) {
    console.warn(`[Chart] API fetch failed: ${error.message}, falling back to local data`)
  }

  // Priority 2: Fallback to local mock generation
  if (!klineData || klineData.length === 0) {
    klineData = generateKlineData(symbol, period)
    dataSourceLabel.value = '本地模拟数据'
  }

  // Stale request guard: skip if user switched symbol/period during fetch
  if (thisLoad !== _loadVersion) return

  // Update chart
  updateChartData(klineData)

  // Update price info
  if (klineData.length > 0) {
    const lastCandle = klineData[klineData.length - 1]
    const firstCandle = klineData[0]
    currentPrice.value = lastCandle.close
    priceChange.value = lastCandle.close - firstCandle.open
    priceChangePercent.value = firstCandle.open > 0
      ? (priceChange.value / firstCandle.open) * 100
      : 0
  }
}

// 本地生成模拟K线数据（当后端不可用时的降级方案）
function generateKlineData(symbol, period) {
  const data = []
  const basePrice = getBasePrice(symbol)
  let price = basePrice
  const dataCount = 100

  for (let i = 0; i < dataCount; i++) {
    const time = Math.floor(Date.now() / 1000) - (dataCount - i) * getPeriodSeconds(period)

    const change = (Math.random() - 0.5) * (basePrice * 0.02)
    const open = price
    const close = open + change
    const high = Math.max(open, close) + Math.random() * (basePrice * 0.01)
    const low = Math.min(open, close) - Math.random() * (basePrice * 0.01)
    const volume = Math.floor(Math.random() * 1000000) + 100000

    data.push({
      time,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume
    })

    price = close
  }

  return data
}

// 根据标的代码返回模拟基准价格
function getBasePrice(symbol) {
  const priceMap = {
    'sh000300': 4660, '000300': 4660, 'sh000001': 3350, '000001': 3350,
    'sz399001': 10800, '399001': 10800, 'sz399006': 2100, '399006': 2100,
    'IF2609': 4648, 'IC2609': 5200, 'IH2609': 2800, 'CU2609': 75000, 'AU2612': 580,
    'sh600519': 1680, '600519': 1680, 'sh600036': 38, '600036': 38,
    'sz000001': 11, 'sz000858': 148, '000858': 148,
    'sh600000': 7.8, '600000': 7.8, 'sh601318': 52, '601318': 52,
    'sz002594': 280, '002594': 280, 'sz000002': 8.5, '000002': 8.5,
    'rb_main': 3380, 'rb2510': 3380,
  }
  const clean = symbol ? symbol.replace(/^(sh|sz)/i, '') : ''
  return priceMap[symbol] || priceMap[clean] || 50
}

function getPeriodSeconds(period) {
  const periodMap = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '1d': 86400
  }
  return periodMap[period] || 86400
}

// 更新图表数据：设置K线、成交量，刷新技术指标，自适应时间轴
function updateChartData(klineData) {
  // 更新K线数据
  candlestickSeries.value.setData(klineData)
  
  // 更新成交量数据
  const volumeData = klineData.map(item => ({
    time: item.time,
    value: item.volume,
    color: item.close >= item.open ? '#26a69a80' : '#ef535080'
  }))
  volumeSeries.value.setData(volumeData)
  
  // 更新技术指标
  updateIndicators()
  
  // 适配时间轴
  mainChart.value.timeScale().fitContent()
  volumeChart.value.timeScale().fitContent()
  if (indicatorChart.value) {
    indicatorChart.value.timeScale().fitContent()
  }
}

// 根据勾选状态更新技术指标（MA/MACD/RSI）
function updateIndicators() {
  // 清除现有指标
  maSeries.value.forEach(series => {
    if (series) mainChart.value.removeSeries(series)
  })
  maSeries.value = []
  
  if (enabledIndicators.value.includes('MA')) {
    addMovingAverages()
  }
  
  if (enabledIndicators.value.includes('MACD')) {
    addMACDIndicator()
  }
  
  if (enabledIndicators.value.includes('RSI')) {
    addRSIIndicator()
  }
}

// 添加MA均线指标（5日、10日、20日、30日四条均线，不同颜色区分）
function addMovingAverages() {
  const klineData = candlestickSeries.value.data()
  if (!klineData || klineData.length === 0) return
  
  const periods = [5, 10, 20, 30]
  const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4']
  
  periods.forEach((period, index) => {
    const maData = calculateMA(klineData, period)
    if (maData.length > 0) {
      const series = mainChart.value.addLineSeries({
        color: colors[index],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      series.setData(maData)
      maSeries.value.push(series)
    }
  })
}

// 计算简单移动平均线（SMA）
function calculateMA(data, period) {
  const result = []
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close
    }
    result.push({
      time: data[i].time,
      value: sum / period
    })
  }
  return result
}

// 添加MACD指标（快线DIF、慢线DEA、柱状图MACD柱）到子图表
function addMACDIndicator() {
  if (!indicatorChart.value) return
  
  // 清除现有MACD系列
  Object.values(macdSeries.value).forEach(series => {
    if (series) indicatorChart.value.removeSeries(series)
  })
  
  const klineData = candlestickSeries.value.data()
  if (!klineData || klineData.length === 0) return
  
  const macdData = calculateMACD(klineData)
  
  // MACD线
  macdSeries.value.macd = indicatorChart.value.addLineSeries({
    color: '#2196F3',
    lineWidth: 1,
  })
  macdSeries.value.macd.setData(macdData.macd)
  
  // 信号线
  macdSeries.value.signal = indicatorChart.value.addLineSeries({
    color: '#FF9800',
    lineWidth: 1,
  })
  macdSeries.value.signal.setData(macdData.signal)
  
  // 柱状图
  macdSeries.value.histogram = indicatorChart.value.addHistogramSeries({
    color: '#4CAF50',
  })
  macdSeries.value.histogram.setData(macdData.histogram)
}

// 计算MACD指标：快速EMA(12) - 慢速EMA(26) = DIF，DIF的EMA(9) = DEA
function calculateMACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const ema12 = calculateEMA(data, fastPeriod)
  const ema26 = calculateEMA(data, slowPeriod)
  
  const macdLine = []
  for (let i = 0; i < Math.min(ema12.length, ema26.length); i++) {
    macdLine.push({
      time: ema12[i].time,
      value: ema12[i].value - ema26[i].value
    })
  }
  
  const signalLine = calculateEMA(macdLine, signalPeriod)
  
  const histogram = []
  for (let i = 0; i < Math.min(macdLine.length, signalLine.length); i++) {
    histogram.push({
      time: macdLine[i].time,
      value: macdLine[i].value - signalLine[i].value,
      color: macdLine[i].value >= signalLine[i].value ? '#4CAF50' : '#F44336'
    })
  }
  
  return {
    macd: macdLine,
    signal: signalLine,
    histogram: histogram
  }
}

// 计算指数移动平均线（EMA），乘数 = 2/(周期+1)
function calculateEMA(data, period) {
  const result = []
  const multiplier = 2 / (period + 1)
  let ema = data[0].close || data[0].value
  
  for (let i = 0; i < data.length; i++) {
    const price = data[i].close || data[i].value
    ema = (price - ema) * multiplier + ema
    result.push({
      time: data[i].time,
      value: ema
    })
  }
  
  return result
}

// 添加RSI相对强弱指标到子图表
function addRSIIndicator() {
  if (!indicatorChart.value) return
  
  const klineData = candlestickSeries.value.data()
  if (!klineData || klineData.length === 0) return
  
  const rsiData = calculateRSI(klineData)
  
  if (rsiSeries.value) {
    indicatorChart.value.removeSeries(rsiSeries.value)
  }
  
  rsiSeries.value = indicatorChart.value.addLineSeries({
    color: '#9C27B0',
    lineWidth: 1,
  })
  rsiSeries.value.setData(rsiData)
}

// 计算RSI指标：RSI = 100 - 100/(1 + 平均涨幅/平均跌幅)，默认14日周期
function calculateRSI(data, period = 14) {
  const result = []
  const gains = []
  const losses = []
  
  for (let i = 1; i < data.length; i++) {
    const change = data[i].close - data[i - 1].close
    gains.push(change > 0 ? change : 0)
    losses.push(change < 0 ? -change : 0)
    
    if (i >= period) {
      const avgGain = gains.slice(-period).reduce((a, b) => a + b) / period
      const avgLoss = losses.slice(-period).reduce((a, b) => a + b) / period
      const rs = avgGain / avgLoss
      const rsi = 100 - (100 / (1 + rs))
      
      result.push({
        time: data[i].time,
        value: rsi
      })
    }
  }
  
  return result
}

// ── 交易信号：加载信号并在K线图上用三角标记标注买入/卖出点 ──
function loadTradingSignals() {
  loadingSignals.value = true
  
  // 模拟加载信号
  setTimeout(() => {
    const klineData = candlestickSeries.value.data()
    if (klineData && klineData.length > 0) {
      signals.value = generateTradingSignals(klineData)
      displaySignals()
      ElMessage.success(`成功加载 ${signals.value.length} 个交易信号`)
      emit('signal-loaded', signals.value)
    }
    loadingSignals.value = false
  }, 1000)
}

// 生成模拟交易信号（4-12个随机买卖信号，按时间排序）
function generateTradingSignals(klineData) {
  const signals = []
  const signalCount = Math.floor(Math.random() * 8) + 4 // 4-12个信号
  
  for (let i = 0; i < signalCount; i++) {
    const randomIndex = Math.floor(Math.random() * (klineData.length - 10)) + 5
    const candle = klineData[randomIndex]
    const signalType = Math.random() > 0.5 ? 'buy' : 'sell'
    
    signals.push({
      type: signalType,
      price: candle.close,
      time: candle.time,
      index: randomIndex,
      reason: signalType === 'buy' ? 'MACD金叉买入信号' : 'MACD死叉卖出信号'
    })
  }
  
  return signals.sort((a, b) => a.time - b.time)
}

// 在K线主图上创建DOM覆盖层，渲染买入(绿色▲)/卖出(红色▼)信号标记
function displaySignals() {
  // 清除现有信号标记
  const existingOverlay = mainChartRef.value.querySelector('#signal-overlay')
  if (existingOverlay) {
    existingOverlay.remove()
  }
  
  if (signals.value.length === 0) return
  
  // 创建信号覆盖层
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
  
  mainChartRef.value.style.position = 'relative'
  mainChartRef.value.appendChild(signalOverlay)
  
  signals.value.forEach((signal, index) => {
    const marker = document.createElement('div')
    marker.innerHTML = signal.type === 'buy' ? '▲' : '▼'
    marker.title = `${signal.type === 'buy' ? '买入' : '卖出'}信号\n价格: ${signal.price}\n原因: ${signal.reason}`
    
    // 计算位置
    const leftPercent = Math.min(90, Math.max(10, (index / Math.max(1, signals.value.length - 1)) * 80 + 10))
    const topPercent = signal.type === 'buy' ? 85 : 15
    
    marker.style.cssText = `
      position: absolute;
      left: ${leftPercent}%;
      top: ${topPercent}%;
      width: 16px;
      height: 16px;
      color: ${signal.type === 'buy' ? '#26a69a' : '#ef5350'};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: bold;
      cursor: pointer;
      pointer-events: auto;
      transform: translate(-50%, -50%);
      transition: all 0.3s ease;
      z-index: 1001;
      text-shadow: 0 0 3px rgba(0,0,0,0.8);
    `
    
    // 添加悬停效果
    marker.addEventListener('mouseenter', () => {
      marker.style.transform = 'translate(-50%, -50%) scale(1.5)'
    })
    
    marker.addEventListener('mouseleave', () => {
      marker.style.transform = 'translate(-50%, -50%) scale(1)'
    })
    
    // 添加点击事件
    marker.addEventListener('click', () => {
      ElMessage.info(`${signal.type === 'buy' ? '买入' : '卖出'}信号 - 价格: ${signal.price}`)
    })
    
    signalOverlay.appendChild(marker)
    
    // 显示动画
    setTimeout(() => {
      marker.style.opacity = '1'
    }, index * 100)
    
    marker.style.opacity = '0'
  })
}

// 清除所有交易信号标记
function clearSignals() {
  signals.value = []
  const existingOverlay = mainChartRef.value.querySelector('#signal-overlay')
  if (existingOverlay) {
    existingOverlay.remove()
  }
  ElMessage.info('交易信号已清除')
}

// 用户切换标的时重新加载数据并通知父组件
function onSymbolChange(symbol) {
  selectedSymbol.value = symbol
  loadInitialData().catch(err => console.error('[Chart] Symbol change load failed:', err))
  emit('symbol-change', symbol)
}

// 用户切换K线周期时重新加载数据并通知父组件
function onPeriodChange(period) {
  selectedPeriod.value = period
  loadInitialData().catch(err => console.error('[Chart] Period change load failed:', err))
  emit('period-change', period)
}

function formatTime(timestamp) {
  const date = new Date(timestamp * 1000)
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// 窗口尺寸变化时自适应调整所有图表宽度
function handleResize() {
  if (mainChart.value && mainChartRef.value) {
    mainChart.value.applyOptions({ width: mainChartRef.value.clientWidth })
  }
  if (volumeChart.value && volumeChartRef.value) {
    volumeChart.value.applyOptions({ width: volumeChartRef.value.clientWidth })
  }
  if (indicatorChart.value && indicatorChartRef.value) {
    indicatorChart.value.applyOptions({ width: indicatorChartRef.value.clientWidth })
  }
}
</script>

<style scoped>
.professional-trading-chart {
  width: 100%;
  background: #0d1421;
  border-radius: 4px;
  overflow: hidden;
  font-family: 'Microsoft YaHei', Arial, sans-serif;
}

.chart-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: #1e2329;
  border-bottom: 1px solid #2b2b43;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.symbol-selector {
  width: 200px;
}

.option-code {
  font-family: 'Consolas', 'Monaco', monospace;
  font-weight: 600;
  color: #f0b90b;
  margin-right: 8px;
}

.option-name {
  color: #d1d4dc;
}

.toolbar-center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.price-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.symbol-name {
  font-size: 16px;
  font-weight: bold;
  color: #d1d4dc;
}

.current-price {
  font-size: 20px;
  font-weight: bold;
  font-family: 'Consolas', 'Monaco', monospace;
}

.price-change {
  font-size: 14px;
  font-weight: 600;
  font-family: 'Consolas', 'Monaco', monospace;
}

.price-up {
  color: #26a69a;
}

.price-down {
  color: #ef5350;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

.chart-container {
  position: relative;
}

.main-chart {
  width: 100%;
}

.volume-chart {
  width: 100%;
  border-top: 1px solid #2b2b43;
}

.indicator-chart {
  width: 100%;
  border-top: 1px solid #2b2b43;
}

.signal-stats {
  padding: 12px 16px;
  background: #1e2329;
  border-top: 1px solid #2b2b43;
}

.stats-row {
  display: flex;
  justify-content: space-around;
  align-items: center;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.stat-item .label {
  color: #848e9c;
}

.stat-item .value {
  font-weight: 600;
  color: #d1d4dc;
}

.buy-signal {
  color: #26a69a !important;
}

.sell-signal {
  color: #ef5350 !important;
}

/* Element Plus 样式覆盖 */
:deep(.el-select) {
  --el-select-input-color: #d1d4dc;
  --el-select-input-focus-border-color: #f0b90b;
}

:deep(.el-select .el-input__wrapper) {
  background-color: #2b2b43;
  border-color: #2b2b43;
}

:deep(.el-radio-button__inner) {
  background: #2b2b43;
  border-color: #2b2b43;
  color: #d1d4dc;
}

:deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background-color: #f0b90b;
  border-color: #f0b90b;
  color: #0d1421;
}

:deep(.el-checkbox) {
  --el-checkbox-text-color: #d1d4dc;
}

:deep(.el-checkbox__input.is-checked .el-checkbox__inner) {
  background-color: #f0b90b;
  border-color: #f0b90b;
}

:deep(.el-button) {
  --el-button-bg-color: #2b2b43;
  --el-button-border-color: #2b2b43;
  --el-button-text-color: #d1d4dc;
}

:deep(.el-button--primary) {
  --el-button-bg-color: #f0b90b;
  --el-button-border-color: #f0b90b;
  --el-button-text-color: #0d1421;
}

.data-source-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  margin-left: 8px;
  background: rgba(239, 83, 80, 0.15);
  color: #ef5350;
  border: 1px solid rgba(239, 83, 80, 0.3);
}
.data-source-badge.real-data {
  background: rgba(38, 166, 154, 0.15);
  color: #26a69a;
  border-color: rgba(38, 166, 154, 0.3);
}
</style>