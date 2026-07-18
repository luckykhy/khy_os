<template>
  <div class="unified-trading-interface">
    <!-- 顶部工具栏 -->
    <div class="top-toolbar">
      <div class="toolbar-left">
        <!-- 合约选择器 -->
        <div class="contract-selector">
          <el-select
            v-model="selectedContract"
            @change="onContractChange"
            class="contract-select"
            filterable
            placeholder="选择合约"
          >
            <el-option-group label="指数">
              <el-option
                v-for="item in indexList"
                :key="item.code"
                :label="`${item.code} ${item.name}`"
                :value="item.code"
              >
                <span class="contract-code">{{ item.code }}</span>
                <span class="contract-name">{{ item.name }}</span>
              </el-option>
            </el-option-group>
            <el-option-group label="期货">
              <el-option
                v-for="item in futuresList"
                :key="item.code"
                :label="`${item.code} ${item.name}`"
                :value="item.code"
              >
                <span class="contract-code">{{ item.code }}</span>
                <span class="contract-name">{{ item.name }}</span>
              </el-option>
            </el-option-group>
            <el-option-group label="股票">
              <el-option
                v-for="item in stockList"
                :key="item.code"
                :label="`${item.code} ${item.name}`"
                :value="item.code"
              >
                <span class="contract-code">{{ item.code }}</span>
                <span class="contract-name">{{ item.name }}</span>
              </el-option>
            </el-option-group>
          </el-select>
        </div>

        <!-- 周期选择 -->
        <div class="period-selector">
          <el-radio-group v-model="selectedPeriod" @change="onPeriodChange" size="small">
            <!-- 非日线周期暂时隐藏 -->
            <!-- <el-radio-button label="1m">1分</el-radio-button> -->
            <!-- <el-radio-button label="5m">5分</el-radio-button> -->
            <!-- <el-radio-button label="15m">15分</el-radio-button> -->
            <!-- <el-radio-button label="30m">30分</el-radio-button> -->
            <!-- <el-radio-button label="1h">1小时</el-radio-button> -->
            <el-radio-button label="1d">日线</el-radio-button>
          </el-radio-group>
        </div>

        <!-- 技术指标开关 -->
        <div class="indicator-controls">
          <el-checkbox-group v-model="enabledIndicators" @change="updateIndicators" size="small">
            <el-checkbox label="MA5" value="MA5">MA5</el-checkbox>
            <el-checkbox label="MA10" value="MA10">MA10</el-checkbox>
            <el-checkbox label="MA20" value="MA20">MA20</el-checkbox>
            <el-checkbox label="MA30" value="MA30">MA30</el-checkbox>
          </el-checkbox-group>
        </div>
      </div>

      <div class="toolbar-center">
        <!-- 当前合约信息 -->
        <div class="contract-info">
          <span class="contract-display">{{ currentContract.name }}</span>
          <span class="current-price" :class="priceChangeClass">{{ currentPrice }}</span>
          <span class="price-change" :class="priceChangeClass">
            {{ priceChangeText }} ({{ pricePercentText }})
          </span>
          <span class="volume-info">量: {{ formatVolume(currentContract.volume) }}</span>
        </div>
      </div>

      <div class="toolbar-right">
        <!-- 策略和信号控制 -->
        <div class="strategy-controls">
          <el-button-group size="small">
            <el-button @click="loadTradingSignals" :loading="loadingSignals" type="primary">
              <el-icon><TrendCharts /></el-icon>
              {{ loadedStrategy ? '刷新信号' : '加载信号' }}
            </el-button>
            <el-button @click="toggleSignalDisplay" :disabled="signals.length === 0">
              {{ showSignals ? '隐藏信号' : '显示信号' }}
            </el-button>
            <el-button @click="clearSignals" :disabled="signals.length === 0">
              清除信号
            </el-button>
          </el-button-group>
        </div>
      </div>
    </div>

    <!-- 主要交易区域 -->
    <div class="main-trading-area">
      <!-- 左侧面板 -->
      <div class="left-panel">
        <!-- 策略管理 -->
        <div class="strategy-panel">
          <div class="panel-header">
            <span class="panel-title">策略管理</span>
            <el-button size="small" text @click="refreshStrategy">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
          <div class="strategy-content">
            <div v-if="loadedStrategy" class="loaded-strategy">
              <div class="strategy-info">
                <div class="strategy-name">{{ loadedStrategy.name }}</div>
                <el-tag :type="getStrategyStatusColor(loadedStrategy.status)" size="small">
                  {{ getStrategyStatusText(loadedStrategy.status) }}
                </el-tag>
              </div>
              <div class="strategy-stats">
                <div class="stat-item">
                  <span class="label">信号数:</span>
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
              </div>
              <div class="strategy-actions">
                <el-button size="small" type="danger" @click="unloadStrategy">
                  卸载策略
                </el-button>
              </div>
            </div>
            <div v-else class="no-strategy">
              <p>未加载策略</p>
              <el-button size="small" type="primary" @click="loadTestStrategy">
                加载测试策略
              </el-button>
            </div>
          </div>
        </div>

        <!-- 五档行情 -->
        <div class="depth-panel">
          <div class="panel-header">
            <span class="panel-title">五档行情</span>
            <el-button size="small" text @click="refreshDepth">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
          <div class="depth-content">
            <!-- 卖盘 -->
            <div class="sell-orders">
              <div 
                v-for="(order, index) in sellOrders" 
                :key="'sell-' + index"
                class="order-row sell-order"
              >
                <span class="order-label">卖{{ 5 - index }}</span>
                <span class="order-price">{{ order.price }}</span>
                <span class="order-volume">{{ order.volume }}</span>
              </div>
            </div>
            
            <!-- 当前价格 -->
            <div class="current-price-row">
              <span class="current-price-display" :class="priceChangeClass">
                {{ currentPrice }}
              </span>
            </div>
            
            <!-- 买盘 -->
            <div class="buy-orders">
              <div 
                v-for="(order, index) in buyOrders" 
                :key="'buy-' + index"
                class="order-row buy-order"
              >
                <span class="order-label">买{{ index + 1 }}</span>
                <span class="order-price">{{ order.price }}</span>
                <span class="order-volume">{{ order.volume }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 快速下单 -->
        <div class="quick-order-panel">
          <div class="panel-header">
            <span class="panel-title">快速下单</span>
          </div>
          <div class="order-content">
            <div class="order-controls">
              <div class="price-input">
                <el-input
                  v-model="orderPrice"
                  placeholder="价格"
                  size="small"
                  class="price-field"
                />
              </div>
              <div class="volume-input">
                <el-input
                  v-model="orderVolume"
                  placeholder="手数"
                  size="small"
                  class="volume-field"
                />
              </div>
              <div class="order-buttons">
                <el-button type="danger" size="small" @click="placeBuyOrder" class="buy-btn">
                  买入开仓
                </el-button>
                <el-button type="success" size="small" @click="placeSellOrder" class="sell-btn">
                  卖出开仓
                </el-button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 中间图表区域 -->
      <div class="center-panel">
        <!-- 主K线图 -->
        <div class="main-chart-container">
          <div ref="mainChartRef" class="main-chart"></div>
        </div>
        
        <!-- 成交量图 -->
        <div class="volume-chart-container">
          <div ref="volumeChartRef" class="volume-chart"></div>
        </div>

        <!-- 信号统计面板 -->
        <div class="signal-stats-panel" v-if="signals.length > 0">
          <div class="stats-header">
            <span class="stats-title">交易信号统计</span>
            <el-button size="small" text @click="toggleSignalStats">
              {{ showSignalStats ? '隐藏' : '显示' }}
            </el-button>
          </div>
          <div class="stats-content" v-show="showSignalStats">
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
                <span class="value">{{ latestSignal ? formatSignalTime(latestSignal.time) : '--' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧面板 -->
      <div class="right-panel">
        <!-- 策略信号列表 -->
        <div class="signals-panel">
          <div class="panel-header">
            <span class="panel-title">策略信号</span>
          </div>
          <div class="signals-content">
            <div v-if="signals.length > 0" class="signals-list">
              <div 
                v-for="(signal, index) in latestSignals" 
                :key="signal.id || index"
                class="signal-row"
                :class="signal.type"
              >
                <div class="signal-type">
                  <span class="signal-icon">{{ signal.type === 'buy' ? '↑' : '↓' }}</span>
                  <span class="signal-text">{{ signal.type === 'buy' ? '买入' : '卖出' }}</span>
                </div>
                <div class="signal-details">
                  <div class="signal-price">{{ signal.price }}</div>
                  <div class="signal-time">{{ formatSignalTime(signal.time) }}</div>
                </div>
              </div>
            </div>
            <div v-else class="no-signals">
              <p>暂无策略信号</p>
            </div>
          </div>
        </div>

        <!-- 成交明细 -->
        <div class="trades-panel">
          <div class="panel-header">
            <span class="panel-title">成交明细</span>
            <el-button size="small" text @click="refreshTrades">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
          <div class="trades-content">
            <div class="trades-header">
              <span>时间</span>
              <span>价格</span>
              <span>数量</span>
              <span>方向</span>
            </div>
            <div class="trades-list">
              <div 
                v-for="trade in recentTrades" 
                :key="trade.id"
                class="trade-row"
              >
                <span class="trade-time">{{ formatTime(trade.time) }}</span>
                <span class="trade-price" :class="trade.direction === 'up' ? 'price-up' : 'price-down'">
                  {{ trade.price }}
                </span>
                <span class="trade-volume">{{ trade.volume }}</span>
                <span class="trade-direction" :class="trade.direction === 'up' ? 'direction-up' : 'direction-down'">
                  {{ trade.direction === 'up' ? '↑' : '↓' }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 持仓和资金 -->
        <div class="account-panel">
          <div class="panel-header">
            <span class="panel-title">持仓资金</span>
          </div>
          <div class="account-content">
            <div class="position-section">
              <div class="section-title">持仓信息</div>
              <div class="position-item">
                <span class="label">多头:</span>
                <span class="value">{{ positions.long }}</span>
              </div>
              <div class="position-item">
                <span class="label">空头:</span>
                <span class="value">{{ positions.short }}</span>
              </div>
              <div class="position-item">
                <span class="label">净持仓:</span>
                <span class="value" :class="positions.net >= 0 ? 'positive' : 'negative'">
                  {{ positions.net }}
                </span>
              </div>
            </div>
            <div class="account-section">
              <div class="section-title">资金状况</div>
              <div class="account-item">
                <span class="label">可用:</span>
                <span class="value">{{ formatMoney(account.available) }}</span>
              </div>
              <div class="account-item">
                <span class="label">冻结:</span>
                <span class="value">{{ formatMoney(account.frozen) }}</span>
              </div>
              <div class="account-item">
                <span class="label">浮盈:</span>
                <span class="value" :class="account.floatPnl >= 0 ? 'positive' : 'negative'">
                  {{ formatMoney(account.floatPnl) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部状态栏 -->
    <div class="bottom-status">
      <div class="status-left">
        <span class="status-item">
          <span class="status-indicator" :class="connectionStatus"></span>
          连接状态: {{ connectionText }}
        </span>
        <span class="status-item">延迟: {{ latency }}ms</span>
        <span class="status-item">更新: {{ lastUpdateTime }}</span>
      </div>
      <div class="status-right">
        <span class="status-item">{{ currentContract.exchange || 'EXCHANGE' }}</span>
        <span class="status-item">{{ currentContract.code }}</span>
        <span class="status-item">{{ formatDateTime(new Date()) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { createChart, ColorType } from 'lightweight-charts'
import { TrendCharts, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useStrategyStore } from '@/stores/strategyStore'
import { itemToUnixSeconds } from '@/utils/tvTime'

const props = defineProps({
  height: {
    type: Number,
    default: 800
  },
  symbol: {
    type: String,
    default: 'sh000300'
  },
  data: {
    type: Object,
    default: () => ({})
  },
  signals: {
    type: Array,
    default: () => []
  },
  loadedStrategy: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['contract-change', 'period-change', 'signal-loaded', 'order-placed', 'price-update', 'data-loaded'])

// 策略状态管理
const strategyStore = useStrategyStore()

// 响应式数据
const selectedContract = ref(props.symbol)
const selectedPeriod = ref('1d')
const currentPrice = ref(4660.26)
const priceChange = ref(5.11)
const priceChangePercent = ref(0.11)
const enabledIndicators = ref(['MA5', 'MA10', 'MA20'])
const loadingSignals = ref(false)
const signals = ref([...props.signals])
const showSignals = ref(true)
const showSignalStats = ref(true)
const loadedStrategy = ref(props.loadedStrategy)

// 图表引用
const mainChartRef = ref(null)
const volumeChartRef = ref(null)

// 图表实例
const mainChart = ref(null)
const volumeChart = ref(null)

// 数据系列
const candlestickSeries = ref(null)
const volumeSeries = ref(null)
const maSeries = ref([])

// 合约数据
const contractList = ref([
  // 指数
  { code: 'sh000300', name: '沪深300', type: 'index', exchange: 'SSE' },
  { code: 'sh000001', name: '上证指数', type: 'index', exchange: 'SSE' },
  { code: 'sz399001', name: '深证成指', type: 'index', exchange: 'SZSE' },
  { code: 'sz399006', name: '创业板指', type: 'index', exchange: 'SZSE' },
  
  // 期货
  { code: 'IF2609', name: '沪深300期货', type: 'futures', exchange: 'CFFEX' },
  { code: 'IC2609', name: '中证500期货', type: 'futures', exchange: 'CFFEX' },
  { code: 'IH2609', name: '上证50期货', type: 'futures', exchange: 'CFFEX' },
  { code: 'CU2609', name: '沪铜期货', type: 'futures', exchange: 'SHFE' },
  
  // 股票
  { code: 'sh600000', name: '浦发银行', type: 'stock', exchange: 'SSE' },
  { code: 'sh600036', name: '招商银行', type: 'stock', exchange: 'SSE' },
  { code: 'sh600519', name: '贵州茅台', type: 'stock', exchange: 'SSE' },
  { code: 'sz000001', name: '平安银行', type: 'stock', exchange: 'SZSE' }
])

// 计算属性
const indexList = computed(() => contractList.value.filter(c => c.type === 'index'))
const futuresList = computed(() => contractList.value.filter(c => c.type === 'futures'))
const stockList = computed(() => contractList.value.filter(c => c.type === 'stock'))

const currentContract = computed(() => {
  return contractList.value.find(c => c.code === selectedContract.value) || contractList.value[0]
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

const latestSignals = computed(() => {
  return signals.value.slice(-10).reverse()
})

const latestSignal = computed(() => {
  if (signals.value.length === 0) return null
  return signals.value[signals.value.length - 1]
})

// 五档行情数据
const sellOrders = ref([
  { price: 4665.50, volume: 1200 },
  { price: 4664.30, volume: 800 },
  { price: 4663.10, volume: 1500 },
  { price: 4662.00, volume: 900 },
  { price: 4661.20, volume: 1100 }
])

const buyOrders = ref([
  { price: 4659.80, volume: 1300 },
  { price: 4658.60, volume: 950 },
  { price: 4657.40, volume: 1600 },
  { price: 4656.20, volume: 750 },
  { price: 4655.00, volume: 1200 }
])

// 成交明细
const recentTrades = ref([
  { id: 1, time: '14:35:23', price: 4660.26, volume: 100, direction: 'up' },
  { id: 2, time: '14:35:20', price: 4659.44, volume: 200, direction: 'down' },
  { id: 3, time: '14:35:18', price: 4660.45, volume: 150, direction: 'up' },
  { id: 4, time: '14:35:15', price: 4659.43, volume: 300, direction: 'down' },
  { id: 5, time: '14:35:12', price: 4660.44, volume: 180, direction: 'up' }
])

// 下单相关
const orderPrice = ref('')
const orderVolume = ref('1')

// 持仓信息
const positions = ref({
  long: 0,
  short: 0,
  net: 0
})

// 资金状况
const account = ref({
  available: 1000000,
  frozen: 50000,
  floatPnl: 12500,
  total: 1062500
})

// 连接状态
const connectionStatus = ref('connected')
const connectionText = ref('已连接')
const latency = ref(15)
const lastUpdateTime = ref('')

// 生命周期
onMounted(() => {
  initCharts()
  loadInitialData()
  startRealTimeUpdate()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  // 清理图表
  if (mainChart.value) mainChart.value.remove()
  if (volumeChart.value) volumeChart.value.remove()
  
  // 清理定时器
  if (realTimeUpdateTimer) {
    clearInterval(realTimeUpdateTimer)
    realTimeUpdateTimer = null
  }
  
  // 清理事件监听器
  window.removeEventListener('resize', handleResize)
})

// 监听器
watch(() => props.signals, (newSignals) => {
  signals.value = [...newSignals]
  if (newSignals.length > 0) {
    displaySignals()
  }
}, { deep: true })

watch(() => props.data, (newData) => {
  if (newData && newData.kline) {
    updateChartData(newData.kline)
  }
}, { deep: true })

watch(() => enabledIndicators.value, () => {
  updateIndicators()
}, { deep: true })

// 方法
function initCharts() {
  // 主图表
  mainChart.value = createChart(mainChartRef.value, {
    width: mainChartRef.value.clientWidth,
    height: Math.floor(props.height * 0.7),
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
    height: Math.floor(props.height * 0.2),
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
    }
  })
}

function loadInitialData() {
  // 如果有传入的数据，使用传入的数据
  if (props.data && props.data.kline && props.data.kline.length > 0) {
    updateChartData(props.data.kline)
    updateIndicators()
  } else {
    // 否则生成模拟数据
    const klineData = generateKlineData(selectedContract.value, selectedPeriod.value)
    updateChartData(klineData)
  }
  
  // 如果有传入的信号，显示信号
  if (props.signals && props.signals.length > 0) {
    signals.value = [...props.signals]
    displaySignals()
  }
}

function generateKlineData(contract, period) {
  const data = []
  const basePrice = getBasePrice(contract)
  let currentPrice = basePrice
  const dataCount = 100
  
  for (let i = 0; i < dataCount; i++) {
    const time = Math.floor(Date.now() / 1000) - (dataCount - i) * getPeriodSeconds(period)
    
    const change = (Math.random() - 0.5) * (basePrice * 0.02)
    const open = currentPrice
    const close = open + change
    const high = Math.max(open, close) + Math.random() * (basePrice * 0.01)
    const low = Math.min(open, close) - Math.random() * (basePrice * 0.01)
    const volume = Math.floor(Math.random() * 1000000) + 100000
    
    data.push({
      time,
      timestamp: time * 1000,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume,
      amount: volume * ((high + low) / 2)
    })
    
    currentPrice = close
  }
  
  return data
}

function getBasePrice(contract) {
  const priceMap = {
    'sh000300': 4660, '000300': 4660, 'sh000001': 3350, '000001': 3350,
    'sz399001': 10800, '399001': 10800, 'sz399006': 2100, '399006': 2100,
    'IF2609': 4648, 'IC2609': 5200, 'IH2609': 2800, 'CU2609': 75000,
    'sh600519': 1680, '600519': 1680, 'sh600036': 38, '600036': 38,
    'sz000001': 11, 'sz000858': 148, '000858': 148,
    'sh600000': 7.8, '600000': 7.8, 'sh601318': 52, '601318': 52,
    'sz002594': 280, '002594': 280, 'sz000002': 8.5, '000002': 8.5,
    'rb_main': 3380, 'rb2510': 3380,
  }
  const clean = contract ? contract.replace(/^(sh|sz)/i, '') : ''
  return priceMap[contract] || priceMap[clean] || 50
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

function updateChartData(klineData) {
  // 转换数据格式为 lightweight-charts 格式
  const candleData = klineData.map(item => ({
    time: itemToUnixSeconds(item),
    open: item.open,
    high: item.high,
    low: item.low,
    close: item.close
  })).filter(d => !isNaN(d.time))

  const volumeData = klineData.map(item => ({
    time: itemToUnixSeconds(item),
    value: item.volume,
    color: item.close >= item.open ? '#26a69a80' : '#ef535080'
  })).filter(d => !isNaN(d.time))

  // 更新K线数据
  candlestickSeries.value.setData(candleData)
  
  // 更新成交量数据
  volumeSeries.value.setData(volumeData)

  // 更新技术指标
  updateIndicators()

  // 适配时间轴
  mainChart.value.timeScale().fitContent()
  volumeChart.value.timeScale().fitContent()

  // 更新价格信息
  if (klineData.length > 0) {
    const lastCandle = klineData[klineData.length - 1]
    const firstCandle = klineData[0]
    currentPrice.value = lastCandle.close
    priceChange.value = lastCandle.close - firstCandle.open
    priceChangePercent.value = (priceChange.value / firstCandle.open) * 100

    // 发出价格更新事件
    emit('price-update', {
      symbol: selectedContract.value,
      price: lastCandle.close,
      open: lastCandle.open,
      high: lastCandle.high,
      low: lastCandle.low,
      volume: lastCandle.volume,
      amount: lastCandle.amount
    })
  }

  // 发出数据加载完成事件
  emit('data-loaded', { symbol: selectedContract.value, dataCount: klineData.length })
}

function updateIndicators() {
  // 清除现有指标
  maSeries.value.forEach(series => {
    if (series) mainChart.value.removeSeries(series)
  })
  maSeries.value = []
  
  const klineData = candlestickSeries.value.data()
  if (!klineData || klineData.length === 0) return
  
  const colors = {
    MA5: '#fff',
    MA10: '#ffeb3b',
    MA20: '#e91e63',
    MA30: '#00bcd4'
  }

  enabledIndicators.value.forEach(indicator => {
    const period = parseInt(indicator.replace('MA', ''))
    const maData = calculateMA(klineData, period)
    
    if (maData.length > 0) {
      const series = mainChart.value.addLineSeries({
        color: colors[indicator],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      series.setData(maData)
      maSeries.value.push(series)
    }
  })
}

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

// 精确信号定位显示 (来自StrategyKLineChart的优化版本) - 临时禁用
function displaySignals() {
  if (!showSignals.value || signals.value.length === 0) {
    return
  }

  console.log('🔄 UnifiedTradingInterface: 显示信号 (安全模式)')
  
  // 使用安全的信号显示方式，不创建DOM覆盖层
  if (candlestickSeries.value && signals.value.length > 0) {
    try {
      // 清除现有标记
      if (signalMarkers.value.length > 0) {
        candlestickSeries.value.setMarkers([])
        signalMarkers.value = []
      }
      
      // 创建新的信号标记
      const markers = signals.value.map(signal => ({
        time: signal.time,
        position: signal.type === 'buy' ? 'belowBar' : 'aboveBar',
        color: signal.type === 'buy' ? '#00ff88' : '#ff4444',
        shape: signal.type === 'buy' ? 'arrowUp' : 'arrowDown',
        text: signal.type === 'buy' ? '买入' : '卖出',
        size: 1
      }))
      
      // 应用标记到图表
      candlestickSeries.value.setMarkers(markers)
      signalMarkers.value = markers
      
      console.log(`✅ 成功显示 ${markers.length} 个信号标记`)
    } catch (error) {
      console.error('❌ 显示信号标记失败:', error)
    }
  }
}

// 事件处理
function onContractChange(contract) {
  selectedContract.value = contract
  loadInitialData()
  emit('contract-change', contract)
}

function onPeriodChange(period) {
  selectedPeriod.value = period
  loadInitialData()
  emit('period-change', period)
}

function loadTradingSignals() {
  loadingSignals.value = true
  
  // 如果有加载的策略，获取策略信号
  if (loadedStrategy.value) {
    // 这里应该调用策略执行API
    // 暂时使用模拟数据
    setTimeout(() => {
      const klineData = candlestickSeries.value.data()
      if (klineData && klineData.length > 0) {
        signals.value = generateTradingSignals(klineData)
        displaySignals()
        ElMessage.success(`成功加载 ${signals.value.length} 个策略信号`)
        emit('signal-loaded', signals.value)
      }
      loadingSignals.value = false
    }, 1000)
  } else {
    // 生成测试信号
    setTimeout(() => {
      const klineData = candlestickSeries.value.data()
      if (klineData && klineData.length > 0) {
        signals.value = generateTradingSignals(klineData)
        displaySignals()
        ElMessage.success(`成功加载 ${signals.value.length} 个测试信号`)
        emit('signal-loaded', signals.value)
      }
      loadingSignals.value = false
    }, 1000)
  }
}

function generateTradingSignals(klineData) {
  const signals = []
  const signalCount = Math.floor(Math.random() * 8) + 4 // 4-12个信号
  
  for (let i = 0; i < signalCount; i++) {
    const randomIndex = Math.floor(Math.random() * (klineData.length - 10)) + 5
    const candle = klineData[randomIndex]
    const signalType = Math.random() > 0.5 ? 'buy' : 'sell'
    
    signals.push({
      id: `signal-${i}`,
      type: signalType,
      price: candle.close,
      time: candle.time,
      timestamp: candle.time * 1000,
      index: randomIndex,
      reason: signalType === 'buy' ? 'MACD金叉买入信号' : 'MACD死叉卖出信号'
    })
  }
  
  return signals.sort((a, b) => a.time - b.time)
}

function toggleSignalDisplay() {
  showSignals.value = !showSignals.value
  if (showSignals.value) {
    displaySignals()
  } else {
    // 清除图表上的信号标记
    if (candlestickSeries.value) {
      candlestickSeries.value.setMarkers([])
      signalMarkers.value = []
    }
    console.log('🔄 信号显示已隐藏')
  }
  ElMessage.info(showSignals.value ? '已显示策略信号' : '已隐藏策略信号')
}

function clearSignals() {
  signals.value = []
  // 清除图表上的信号标记
  if (candlestickSeries.value) {
    candlestickSeries.value.setMarkers([])
    signalMarkers.value = []
  }
  console.log('🧹 信号已清除')
  ElMessage.info('交易信号已清除')
}

function loadTestStrategy() {
  loadedStrategy.value = {
    id: 'test-strategy',
    name: '测试MACD策略',
    status: 'active',
    type: 'MACD'
  }
  ElMessage.success('测试策略已加载')
}

function unloadStrategy() {
  const strategyName = loadedStrategy.value?.name
  loadedStrategy.value = null
  signals.value = []
  clearSignals()
  ElMessage.info(`策略 "${strategyName}" 已卸载`)
}

function refreshStrategy() {
  if (loadedStrategy.value) {
    loadTradingSignals()
  } else {
    ElMessage.warning('请先加载策略')
  }
}

function getStrategyStatusColor(status) {
  const colorMap = {
    active: 'success',
    paused: 'warning',
    stopped: 'info',
    error: 'danger'
  }
  return colorMap[status] || 'info'
}

function getStrategyStatusText(status) {
  const textMap = {
    active: '运行中',
    paused: '已暂停',
    stopped: '已停止',
    error: '错误'
  }
  return textMap[status] || status
}

function placeBuyOrder() {
  const order = {
    type: 'buy',
    price: orderPrice.value || currentPrice.value,
    volume: parseInt(orderVolume.value) || 1,
    contract: selectedContract.value
  }
  
  ElMessage.success(`买入开仓订单已提交: ${order.volume}手 @ ${order.price}`)
  emit('order-placed', order)
}

function placeSellOrder() {
  const order = {
    type: 'sell',
    price: orderPrice.value || currentPrice.value,
    volume: parseInt(orderVolume.value) || 1,
    contract: selectedContract.value
  }
  
  ElMessage.success(`卖出开仓订单已提交: ${order.volume}手 @ ${order.price}`)
  emit('order-placed', order)
}

function refreshDepth() {
  updateDepthData(currentPrice.value)
  ElMessage.success('五档行情已刷新')
}

function refreshTrades() {
  const newTrade = {
    id: Date.now(),
    time: new Date().toLocaleTimeString(),
    price: currentPrice.value + (Math.random() - 0.5) * 0.1,
    volume: Math.floor(Math.random() * 50) + 10,
    direction: Math.random() > 0.5 ? 'up' : 'down'
  }
  
  recentTrades.value.unshift(newTrade)
  if (recentTrades.value.length > 20) {
    recentTrades.value.pop()
  }
  
  ElMessage.success('成交明细已刷新')
}

function updateDepthData(price) {
  const basePrice = parseFloat(price)
  
  // 更新卖盘
  for (let i = 0; i < sellOrders.value.length; i++) {
    sellOrders.value[i].price = (basePrice + (i + 1) * 0.01).toFixed(2)
    sellOrders.value[i].volume = Math.floor(Math.random() * 1000) + 500
  }
  
  // 更新买盘
  for (let i = 0; i < buyOrders.value.length; i++) {
    buyOrders.value[i].price = (basePrice - (i + 1) * 0.01).toFixed(2)
    buyOrders.value[i].volume = Math.floor(Math.random() * 1000) + 500
  }
}

// 定时器引用
let realTimeUpdateTimer = null

function startRealTimeUpdate() {
  // 清除现有定时器
  if (realTimeUpdateTimer) {
    clearInterval(realTimeUpdateTimer)
  }
  
  realTimeUpdateTimer = setInterval(() => {
    lastUpdateTime.value = new Date().toLocaleTimeString()
    
    // 模拟价格波动
    const randomChange = (Math.random() - 0.5) * 0.1
    currentPrice.value = parseFloat((currentPrice.value + randomChange).toFixed(2))
    
    // 更新五档行情
    updateDepthData(currentPrice.value)
  }, 3000)
}

function toggleSignalStats() {
  showSignalStats.value = !showSignalStats.value
}

function handleResize() {
  if (mainChart.value && mainChartRef.value) {
    mainChart.value.applyOptions({ width: mainChartRef.value.clientWidth })
  }
  if (volumeChart.value && volumeChartRef.value) {
    volumeChart.value.applyOptions({ width: volumeChartRef.value.clientWidth })
  }
}

// 工具函数
function formatVolume(volume) {
  if (!volume && volume !== 0) return '-'
  if (volume >= 10000) {
    return (volume / 10000).toFixed(1) + '万'
  }
  return volume.toString()
}

function formatMoney(amount) {
  if (!amount && amount !== 0) return '0.00'
  return amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })
}

function formatTime(timestamp) {
  return timestamp
}

function formatSignalTime(time) {
  if (!time) return '--:--'
  try {
    const date = typeof time === 'number' ? new Date(time * 1000) : new Date(time)
    return date.toLocaleTimeString('zh-CN', { 
      hour: '2-digit', 
      minute: '2-digit' 
    })
  } catch (error) {
    return '--:--'
  }
}

function formatDateTime(date) {
  return date.toLocaleString('zh-CN')
}
</script>
<style scoped>
.unified-trading-interface {
  width: 100%;
  height: 100%;
  background: #0d1421;
  color: #d1d4dc;
  font-family: 'Microsoft YaHei', Arial, sans-serif;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  overflow: auto;
  position: relative;
  z-index: 1;
}

/* 顶部工具栏 */
.top-toolbar {
  height: 50px;
  background: linear-gradient(to bottom, #1e2329, #181a20);
  border-bottom: 1px solid #2b2b43;
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 20px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.contract-selector {
  min-width: 200px;
}

.contract-select {
  width: 100%;
}

.contract-code {
  font-family: 'Consolas', 'Monaco', monospace;
  font-weight: 600;
  color: #f0b90b;
  margin-right: 8px;
}

.contract-name {
  color: #d1d4dc;
}

.period-selector {
  margin-left: 10px;
}

.indicator-controls {
  margin-left: 10px;
}

.toolbar-center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.contract-info {
  display: flex;
  align-items: center;
  gap: 16px;
}

.contract-display {
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

.volume-info {
  font-size: 12px;
  color: #848e9c;
}

.toolbar-right {
  display: flex;
  align-items: center;
}

/* 主要交易区域 */
.main-trading-area {
  flex: 1;
  display: flex;
  overflow: auto;
}

/* 左侧面板 */
.left-panel {
  width: 280px;
  background: #181a20;
  border-right: 1px solid #2b2b43;
  display: flex;
  flex-direction: column;
}

.panel-header {
  height: 32px;
  background: linear-gradient(to bottom, #2b2b43, #1e2329);
  border-bottom: 1px solid #2b2b43;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 12px;
}

.panel-title {
  font-weight: bold;
  color: #d1d4dc;
  font-size: 12px;
}

/* 策略管理面板 */
.strategy-panel {
  height: 160px;
}

.strategy-content {
  padding: 12px;
  height: calc(100% - 32px);
  display: flex;
  flex-direction: column;
}

.loaded-strategy {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.strategy-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.strategy-name {
  font-weight: bold;
  color: #00aaff;
  font-size: 14px;
}

.strategy-stats {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.stat-item .label {
  color: #848e9c;
}

.stat-item .value {
  font-weight: bold;
  color: #d1d4dc;
}

.buy-signal {
  color: #ef5350 !important;
}

.sell-signal {
  color: #26a69a !important;
}

.strategy-actions {
  margin-top: auto;
}

.no-strategy {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 10px;
  color: #848e9c;
}

/* 五档行情 */
.depth-panel {
  height: 280px;
  border-top: 1px solid #2b2b43;
}

.depth-content {
  padding: 8px;
}

.order-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
  font-size: 11px;
  font-family: 'Consolas', 'Monaco', monospace;
}

.sell-order {
  color: #ef5350;
}

.buy-order {
  color: #26a69a;
}

.order-label {
  width: 30px;
  color: #848e9c;
}

.order-price {
  flex: 1;
  text-align: center;
  font-weight: bold;
}

.order-volume {
  width: 60px;
  text-align: right;
}

.current-price-row {
  text-align: center;
  padding: 8px 0;
  border-top: 1px solid #2b2b43;
  border-bottom: 1px solid #2b2b43;
  margin: 5px 0;
}

.current-price-display {
  font-size: 16px;
  font-weight: bold;
  font-family: 'Consolas', 'Monaco', monospace;
}

/* 快速下单 */
.quick-order-panel {
  height: 180px;
  border-top: 1px solid #2b2b43;
}

.order-content {
  padding: 12px;
}

.order-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.price-input, .volume-input {
  width: 100%;
}

.order-buttons {
  display: flex;
  gap: 8px;
}

.buy-btn, .sell-btn {
  flex: 1;
}

/* 中间图表区域 */
.center-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #0d1421;
}

.main-chart-container {
  flex: 1;
  position: relative;
}

.main-chart {
  width: 100%;
  height: 100%;
}

.volume-chart-container {
  height: 150px;
  border-top: 1px solid #2b2b43;
}

.volume-chart {
  width: 100%;
  height: 100%;
}

/* 信号统计面板 */
.signal-stats-panel {
  height: 60px;
  background: #181a20;
  border-top: 1px solid #2b2b43;
}

.stats-header {
  height: 28px;
  background: linear-gradient(to bottom, #2b2b43, #1e2329);
  border-bottom: 1px solid #2b2b43;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 12px;
}

.stats-title {
  font-weight: bold;
  color: #d1d4dc;
  font-size: 12px;
}

.stats-content {
  padding: 8px 12px;
}

.stats-row {
  display: flex;
  justify-content: space-around;
  align-items: center;
}

/* 右侧面板 */
.right-panel {
  width: 280px;
  background: #181a20;
  border-left: 1px solid #2b2b43;
  display: flex;
  flex-direction: column;
}

/* 策略信号列表 */
.signals-panel {
  height: 250px;
}

.signals-content {
  flex: 1;
  overflow-y: auto;
}

.signals-list {
  padding: 8px;
}

.signal-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  margin-bottom: 4px;
  background: rgba(43, 43, 67, 0.3);
  border-radius: 4px;
  border-left: 3px solid #848e9c;
}

.signal-row.buy {
  border-left-color: #ef5350;
}

.signal-row.sell {
  border-left-color: #26a69a;
}

.signal-type {
  display: flex;
  align-items: center;
  gap: 4px;
}

.signal-icon {
  font-size: 12px;
  font-weight: bold;
}

.signal-row.buy .signal-icon,
.signal-row.buy .signal-text {
  color: #ef5350;
}

.signal-row.sell .signal-icon,
.signal-row.sell .signal-text {
  color: #26a69a;
}

.signal-text {
  font-size: 10px;
  font-weight: 600;
}

.signal-details {
  text-align: right;
}

.signal-price {
  font-size: 11px;
  font-weight: 600;
  color: #d1d4dc;
  font-family: 'Consolas', 'Monaco', monospace;
}

.signal-time {
  font-size: 9px;
  color: #848e9c;
}

.no-signals {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #848e9c;
}

/* 成交明细 */
.trades-panel {
  height: 200px;
  border-top: 1px solid #2b2b43;
}

.trades-content {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.trades-header {
  height: 24px;
  display: flex;
  justify-content: space-between;
  padding: 4px 12px;
  background: #1e2329;
  border-bottom: 1px solid #2b2b43;
  font-size: 11px;
  color: #848e9c;
}

.trades-list {
  flex: 1;
  overflow-y: auto;
}

.trade-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 12px;
  font-size: 11px;
  border-bottom: 1px solid rgba(43, 43, 67, 0.3);
}

.trade-time {
  color: #848e9c;
  font-family: 'Consolas', 'Monaco', monospace;
}

.trade-price {
  font-weight: bold;
  font-family: 'Consolas', 'Monaco', monospace;
}

.trade-volume {
  color: #d1d4dc;
}

.trade-direction {
  font-weight: bold;
}

/* 持仓和资金 */
.account-panel {
  flex: 1;
  border-top: 1px solid #2b2b43;
}

.account-content {
  padding: 12px;
}

.position-section, .account-section {
  margin-bottom: 15px;
}

.section-title {
  font-size: 12px;
  font-weight: bold;
  color: #00aaff;
  margin-bottom: 8px;
  border-bottom: 1px solid #2b2b43;
  padding-bottom: 4px;
}

.position-item, .account-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  margin-bottom: 4px;
}

.position-item .label, .account-item .label {
  color: #848e9c;
}

.position-item .value, .account-item .value {
  font-weight: bold;
  font-family: 'Consolas', 'Monaco', monospace;
  color: #d1d4dc;
}

/* 底部状态栏 */
.bottom-status {
  height: 24px;
  background: linear-gradient(to bottom, #2b2b43, #1e2329);
  border-top: 1px solid #2b2b43;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 16px;
  font-size: 11px;
}

.status-left, .status-right {
  display: flex;
  gap: 16px;
}

.status-item {
  color: #848e9c;
  display: flex;
  align-items: center;
  gap: 4px;
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-indicator.connected {
  background: #26a69a;
  box-shadow: 0 0 6px #26a69a;
}

.status-indicator.disconnected {
  background: #ef5350;
  box-shadow: 0 0 6px #ef5350;
}

/* 价格颜色 */
.price-up {
  color: #ef5350 !important;
}

.price-down {
  color: #26a69a !important;
}

.direction-up {
  color: #ef5350;
}

.direction-down {
  color: #26a69a;
}

.positive {
  color: #ef5350;
}

.negative {
  color: #26a69a;
}

/* 滚动条样式 */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: #1e2329;
}

::-webkit-scrollbar-thumb {
  background: #2b2b43;
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: #404040;
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

:deep(.el-button--danger) {
  --el-button-bg-color: #ef5350;
  --el-button-border-color: #ef5350;
}

:deep(.el-button--success) {
  --el-button-bg-color: #26a69a;
  --el-button-border-color: #26a69a;
}

:deep(.el-input__wrapper) {
  background-color: #2b2b43;
  border-color: #2b2b43;
}

:deep(.el-input__inner) {
  color: #d1d4dc;
}

:deep(.el-tag) {
  --el-tag-bg-color: rgba(43, 43, 67, 0.3);
  --el-tag-border-color: #2b2b43;
  --el-tag-text-color: #d1d4dc;
}
</style>