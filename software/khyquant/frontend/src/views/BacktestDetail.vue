<template>
  <div class="backtest-detail">
    <!-- Page header -->
    <div class="page-header">
      <div class="header-left">
        <el-button @click="goBack" size="small" type="primary" plain>
          <el-icon><ArrowLeft /></el-icon>
          返回列表
        </el-button>
        <div class="title-info">
          <h2>回测详情</h2>
          <span class="subtitle" v-if="backtestData">
            {{ backtestData.strategyName }} - {{ backtestData.symbol }}
          </span>
        </div>
      </div>
      <div class="header-right">
        <el-button @click="exportReport" size="small">
          <el-icon><Download /></el-icon>
          导出报告
        </el-button>
        <el-button @click="refreshDetail" size="small" type="primary">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="loading" class="loading-container">
      <el-skeleton :rows="8" animated />
    </div>

    <!-- Backtest result detail -->
    <div v-else-if="backtestData" class="detail-content">
      <!-- Info cards row -->
      <div class="info-cards">
        <div class="info-card">
          <div class="card-header"><h3>基本信息</h3></div>
          <div class="card-content">
            <div class="info-grid">
              <div class="info-item">
                <span class="label">策略名称:</span>
                <span class="value">{{ backtestData.strategyName }}</span>
              </div>
              <div class="info-item">
                <span class="label">策略类型:</span>
                <el-tag :type="getStrategyTypeColor(backtestData.strategyType)" size="small">
                  {{ getStrategyTypeLabel(backtestData.strategyType) }}
                </el-tag>
              </div>
              <div class="info-item">
                <span class="label">交易标的:</span>
                <span class="value symbol-code">{{ backtestData.symbol }}</span>
              </div>
              <div class="info-item">
                <span class="label">回测周期:</span>
                <span class="value">{{ backtestData.startDate }} 至 {{ backtestData.endDate }}</span>
              </div>
              <div class="info-item">
                <span class="label">数据源:</span>
                <el-tag size="small" :type="backtestData.dataSource === 'akshare' ? 'success' : 'info'">
                  {{ getDataSourceLabel(backtestData.dataSource) }}
                </el-tag>
              </div>
              <div class="info-item">
                <span class="label">回测时间:</span>
                <span class="value">{{ formatDateTime(backtestData.createdAt) }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="info-card">
          <div class="card-header"><h3>收益指标</h3></div>
          <div class="card-content">
            <div class="metrics-grid">
              <div class="metric-item">
                <div class="metric-label">初始资金</div>
                <div class="metric-value">{{ formatAmount(backtestData.initialCapital) }}</div>
              </div>
              <div class="metric-item">
                <div class="metric-label">期末资金</div>
                <div class="metric-value" :class="getProfitClass(backtestData.finalCapital - backtestData.initialCapital)">
                  {{ formatAmount(backtestData.finalCapital) }}
                </div>
              </div>
              <div class="metric-item">
                <div class="metric-label">总收益率</div>
                <div class="metric-value" :class="getProfitClass(backtestData.totalReturn)">
                  {{ formatPercent(backtestData.totalReturn) }}
                </div>
              </div>
              <div class="metric-item">
                <div class="metric-label">年化收益率</div>
                <div class="metric-value" :class="getProfitClass(backtestData.annualizedReturn)">
                  {{ formatPercent(backtestData.annualizedReturn) }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="info-card">
          <div class="card-header"><h3>风险指标</h3></div>
          <div class="card-content">
            <div class="metrics-grid">
              <div class="metric-item">
                <div class="metric-label">最大回撤</div>
                <div class="metric-value drawdown-text">{{ formatPercent(backtestData.maxDrawdown) }}</div>
              </div>
              <div class="metric-item">
                <div class="metric-label">夏普比率</div>
                <div class="metric-value" :class="getSharpeClass(backtestData.sharpeRatio)">
                  {{ backtestData.sharpeRatio?.toFixed(2) || '-' }}
                </div>
              </div>
              <div class="metric-item">
                <div class="metric-label">胜率</div>
                <div class="metric-value win-rate">{{ formatPercent(backtestData.winRate) }}</div>
              </div>
              <div class="metric-item">
                <div class="metric-label">交易次数</div>
                <div class="metric-value">{{ backtestData.totalTrades }}次</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- K-line chart with trade signals -->
      <div class="chart-section">
        <div class="card-header">
          <h3>K线走势与交易信号</h3>
          <span class="chart-hint" v-if="chartLoading">加载K线数据中...</span>
          <span class="chart-hint" v-else-if="klineData.length > 0">共 {{ klineData.length }} 根K线</span>
        </div>
        <div class="chart-body">
          <div ref="klineChartRef" class="kline-chart" v-loading="chartLoading"></div>
        </div>
        <!-- Equity curve -->
        <div class="card-header sub-header">
          <h3>资金曲线</h3>
        </div>
        <div class="chart-body equity-body">
          <div ref="equityChartRef" class="equity-chart"></div>
        </div>
      </div>

      <!-- Signal overview -->
      <div class="signal-overview">
        <div class="card-header"><h3>交易信号总览</h3></div>
        <div class="card-content">
          <div class="signal-stats">
            <div class="stat-item">
              <div class="stat-number">{{ signalStats.totalTrades }}</div>
              <div class="stat-label">总交易笔数</div>
            </div>
            <div class="stat-item buy">
              <div class="stat-number">{{ signalStats.buyCount }}</div>
              <div class="stat-label">买入次数</div>
            </div>
            <div class="stat-item sell">
              <div class="stat-number">{{ signalStats.sellCount }}</div>
              <div class="stat-label">卖出次数</div>
            </div>
            <div class="stat-item" :class="signalStats.winCount > signalStats.loseCount ? 'win' : 'lose'">
              <div class="stat-number">{{ signalStats.winCount }} / {{ signalStats.loseCount }}</div>
              <div class="stat-label">盈利 / 亏损笔数</div>
            </div>
            <div class="stat-item">
              <div class="stat-number">{{ signalStats.profitFactor }}</div>
              <div class="stat-label">盈亏比</div>
            </div>
            <div class="stat-item">
              <div class="stat-number">{{ signalStats.avgHoldDays }}天</div>
              <div class="stat-label">平均持仓天数</div>
            </div>
            <div class="stat-item profit-positive">
              <div class="stat-number">{{ formatAmount(signalStats.maxProfit) }}</div>
              <div class="stat-label">最大单笔盈利</div>
            </div>
            <div class="stat-item profit-negative">
              <div class="stat-number">{{ formatAmount(signalStats.maxLoss) }}</div>
              <div class="stat-label">最大单笔亏损</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Trade records table with pagination and filter -->
      <div class="table-card">
        <div class="card-header">
          <h3>逐笔交易记录</h3>
          <div class="table-controls">
            <el-radio-group v-model="tradeFilter" size="small">
              <el-radio-button value="all">全部</el-radio-button>
              <el-radio-button value="buy">买入</el-radio-button>
              <el-radio-button value="sell">卖出</el-radio-button>
            </el-radio-group>
            <span class="record-count">共 {{ filteredTrades.length }} 笔</span>
          </div>
        </div>
        <div class="card-content">
          <el-table
            :data="paginatedTrades"
            stripe
            size="small"
            :default-sort="{ prop: 'date', order: 'ascending' }"
            @sort-change="handleSortChange"
            show-summary
            :summary-method="getTableSummary"
          >
            <el-table-column prop="id" label="序号" width="60" align="center" />
            <el-table-column prop="date" label="日期" width="150" align="center" sortable="custom" />
            <el-table-column prop="type" label="方向" width="80" align="center">
              <template #default="{ row }">
                <el-tag :type="row.type === 'buy' ? 'success' : 'danger'" size="small">
                  {{ row.type === 'buy' ? '买入' : '卖出' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="price" label="价格" width="110" align="right" sortable="custom">
              <template #default="{ row }">
                {{ row.price?.toFixed(2) }}
              </template>
            </el-table-column>
            <el-table-column prop="quantity" label="数量" width="90" align="right" />
            <el-table-column prop="amount" label="金额" width="120" align="right">
              <template #default="{ row }">
                {{ formatAmount(row.amount || row.price * row.quantity) }}
              </template>
            </el-table-column>
            <el-table-column label="费用" width="100" align="right">
              <template #default="{ row }">
                {{ ((row.fee || 0) + (row.stampTax || 0)).toFixed(2) }}
              </template>
            </el-table-column>
            <el-table-column prop="profit" label="盈亏" width="120" align="right" sortable="custom">
              <template #default="{ row }">
                <span v-if="row.type === 'sell'" :class="getProfitClass(row.profit)">
                  {{ row.profit >= 0 ? '+' : '' }}{{ row.profit?.toFixed(2) }}
                </span>
                <span v-else class="profit-neutral">-</span>
              </template>
            </el-table-column>
            <el-table-column prop="return" label="收益率" width="100" align="right" sortable="custom">
              <template #default="{ row }">
                <span v-if="row.type === 'sell' && row.return != null" :class="getProfitClass(row.return)">
                  {{ formatPercent(row.return * 100) }}
                </span>
                <span v-else class="profit-neutral">-</span>
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="信号原因" min-width="120">
              <template #default="{ row }">
                <span class="reason-text">{{ row.reason || '-' }}</span>
              </template>
            </el-table-column>
          </el-table>

          <div class="pagination-wrapper" v-if="filteredTrades.length > pageSize">
            <el-pagination
              v-model:current-page="currentPage"
              :page-size="pageSize"
              :page-sizes="[10, 20, 50]"
              :total="filteredTrades.length"
              layout="total, sizes, prev, pager, next"
              @size-change="handlePageSizeChange"
              @current-change="handlePageChange"
              small
            />
          </div>
        </div>
      </div>

      <!-- Backtest parameters -->
      <div class="params-card" v-if="backtestData.backtestParams">
        <div class="card-header"><h3>回测参数</h3></div>
        <div class="card-content">
          <div class="params-grid">
            <div class="param-item">
              <span class="param-label">初始资金:</span>
              <span class="param-value">{{ formatAmount(backtestData.backtestParams.initialCapital) }}</span>
            </div>
            <div class="param-item" v-if="backtestData.backtestParams.fees">
              <span class="param-label">买入手续费:</span>
              <span class="param-value">{{ (backtestData.backtestParams.fees.buyFeeRate * 100).toFixed(4) }}%</span>
            </div>
            <div class="param-item" v-if="backtestData.backtestParams.fees">
              <span class="param-label">卖出手续费:</span>
              <span class="param-value">{{ (backtestData.backtestParams.fees.sellFeeRate * 100).toFixed(4) }}%</span>
            </div>
            <div class="param-item" v-if="backtestData.backtestParams.fees">
              <span class="param-label">印花税:</span>
              <span class="param-value">{{ (backtestData.backtestParams.fees.stampTaxRate * 100).toFixed(4) }}%</span>
            </div>
            <div class="param-item">
              <span class="param-label">滑点:</span>
              <span class="param-value">{{ (backtestData.backtestParams.slippage * 100).toFixed(4) }}%</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- No data -->
    <div v-else class="no-data">
      <el-empty description="回测数据不存在或已被删除">
        <el-button type="primary" @click="goBack">返回列表</el-button>
      </el-empty>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Download, Refresh } from '@element-plus/icons-vue'
import { createChart } from 'lightweight-charts'
import axios from 'axios'
import { getApiBaseUrl } from '@/config/api'
import { toUnixSeconds } from '@/utils/tvTime'

const route = useRoute()
const router = useRouter()

// Refs
const loading = ref(true)
const chartLoading = ref(false)
const backtestData = ref(null)
const klineData = ref([])
const klineLoadError = ref('')
const klineChartRef = ref(null)
const equityChartRef = ref(null)

// Chart instances (not reactive - mutable objects)
let klineChart = null
let klineSeries = null
let equityChart = null
let equitySeries = null

// Table state
const tradeFilter = ref('all')
const currentPage = ref(1)
const pageSize = ref(10)
const sortProp = ref('date')
const sortOrder = ref('ascending')

// Computed: signal statistics
const signalStats = computed(() => {
  const trades = backtestData.value?.trades || []
  const sellTrades = trades.filter(t => t.type === 'sell')
  const buyTrades = trades.filter(t => t.type === 'buy')
  const winTrades = sellTrades.filter(t => (t.profit || 0) > 0)
  const loseTrades = sellTrades.filter(t => (t.profit || 0) < 0)

  const avgWin = winTrades.length > 0
    ? winTrades.reduce((s, t) => s + (t.profit || 0), 0) / winTrades.length
    : 0
  const avgLoss = loseTrades.length > 0
    ? Math.abs(loseTrades.reduce((s, t) => s + (t.profit || 0), 0) / loseTrades.length)
    : 0

  // Average holding days: pair buy→sell and compute day difference
  let totalHoldDays = 0
  let pairCount = 0
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].type === 'sell' && trades[i].timestamp) {
      // Find preceding buy
      for (let j = i - 1; j >= 0; j--) {
        if (trades[j].type === 'buy' && trades[j].timestamp) {
          totalHoldDays += (trades[i].timestamp - trades[j].timestamp) / 86400
          pairCount++
          break
        }
      }
    }
  }

  return {
    totalTrades: trades.length,
    buyCount: buyTrades.length,
    sellCount: sellTrades.length,
    winCount: winTrades.length,
    loseCount: loseTrades.length,
    profitFactor: avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '-',
    avgHoldDays: pairCount > 0 ? Math.round(totalHoldDays / pairCount) : '-',
    maxProfit: sellTrades.length > 0 ? Math.max(...sellTrades.map(t => t.profit || 0)) : 0,
    maxLoss: sellTrades.length > 0 ? Math.min(...sellTrades.map(t => t.profit || 0)) : 0,
  }
})

// Computed: filtered and sorted trades
const filteredTrades = computed(() => {
  let trades = backtestData.value?.trades || []
  if (tradeFilter.value !== 'all') {
    trades = trades.filter(t => t.type === tradeFilter.value)
  }

  // Sort
  const prop = sortProp.value
  const asc = sortOrder.value === 'ascending' ? 1 : -1
  trades = [...trades].sort((a, b) => {
    const va = a[prop] ?? 0
    const vb = b[prop] ?? 0
    if (typeof va === 'string') return va.localeCompare(vb) * asc
    return (va - vb) * asc
  })

  return trades
})

// Computed: paginated trades
const paginatedTrades = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredTrades.value.slice(start, start + pageSize.value)
})

// Reset page when filter changes
watch(tradeFilter, () => { currentPage.value = 1 })

// Lifecycle
onMounted(async () => {
  await loadBacktestDetail()
  if (backtestData.value) {
    await loadKlineData()
    await nextTick()
    initCharts()
  }
})

onBeforeUnmount(() => {
  destroyCharts()
})

// ─── Data loading ───

async function loadBacktestDetail() {
  loading.value = true
  try {
    const backtestId = route.params.id
    if (!backtestId || backtestId === 'undefined' || backtestId === 'null') {
      ElMessage.error('无效的回测ID')
      return
    }

    // Try backend API first
    try {
      const { default: request } = await import('@/utils/request')
      const res = await request({ url: `/backtest/${backtestId}`, method: 'get' })
      if (res?.success && res.data) {
        const bt = res.data
        backtestData.value = {
          ...bt,
          strategyName: bt.strategy?.name || bt.strategyName || bt.name,
          strategyType: bt.strategy?.type || bt.strategyType || 'trend',
          symbol: Array.isArray(bt.symbols) ? bt.symbols.join(',') : (bt.symbols || bt.symbol || ''),
          totalReturn: parseFloat(bt.totalReturn) || 0,
          annualizedReturn: parseFloat(bt.annualizedReturn) || 0,
          maxDrawdown: parseFloat(bt.maxDrawdown) || 0,
          winRate: parseFloat(bt.winRate) || 0,
          sharpeRatio: bt.results?.sharpeRatio ?? bt.sharpeRatio ?? null,
          trades: Array.isArray(bt.trades) ? bt.trades : [],
        }
        return
      }
    } catch (_apiErr) {
      // Fall through to localStorage
    }

    // Fallback: localStorage
    const storedResults = localStorage.getItem('backtestResults')
    if (storedResults) {
      const allResults = JSON.parse(storedResults)
      const result = allResults.find(item =>
        item.id === backtestId ||
        String(item.id) === String(backtestId) ||
        Number(item.id) === Number(backtestId)
      )
      if (result) {
        backtestData.value = result
        return
      }
    }

    ElMessage.warning('未找到指定的回测结果')
  } catch (error) {
    console.error('加载回测详情失败:', error)
    ElMessage.error('加载回测详情失败')
  } finally {
    loading.value = false
  }
}

async function loadKlineData() {
  const bt = backtestData.value
  if (!bt?.symbol || !bt.startDate || !bt.endDate) return

  chartLoading.value = true
  try {
    const periodMap = { '1d': 'daily', '1w': 'weekly', '1M': 'monthly' }
    const period = periodMap[bt.period] || 'daily'

    const response = await axios.get(`${getApiBaseUrl()}/comprehensive-data/kline`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      params: {
        symbol: bt.symbol,
        startDate: bt.startDate,
        endDate: bt.endDate,
        period,
      },
      timeout: 30000,
    })

    if (response.data.kline && response.data.kline.length > 0) {
      klineData.value = response.data.kline.map(item => ({
        time: toUnixSeconds(item.time || item.date || item.timestamp),
        open: parseFloat(item.open),
        high: parseFloat(item.high),
        low: parseFloat(item.low),
        close: parseFloat(item.close),
        volume: parseInt(item.volume || 0),
      })).filter(k => k.time && k.open > 0)
        .sort((a, b) => a.time - b.time)
      return
    }
  } catch (err) {
    console.warn('K-line API failed:', err.message)
    klineLoadError.value = `K线数据加载失败: ${err.message}`
  } finally {
    chartLoading.value = false
  }

  // API failed — set empty, charts section will show error message
  klineData.value = []
}

// ─── Charts ───

function initCharts() {
  initKlineChart()
  initEquityChart()
}

function destroyCharts() {
  // Disconnect ResizeObservers to prevent leaks (use refs, not getElementById)
  const klineEl = klineChartRef.value
  if (klineEl && klineEl._ro) { klineEl._ro.disconnect(); klineEl._ro = null }
  const equityEl = equityChartRef.value
  if (equityEl && equityEl._ro) { equityEl._ro.disconnect(); equityEl._ro = null }

  if (klineChart) { klineChart.remove(); klineChart = null; klineSeries = null }
  if (equityChart) { equityChart.remove(); equityChart = null; equitySeries = null }
}

function chartTheme() {
  return {
    layout: { background: { color: '#1e222d' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#2b2f3a' }, horzLines: { color: '#2b2f3a' } },
    rightPriceScale: { borderColor: '#2b2f3a' },
    timeScale: {
      borderColor: '#2b2f3a',
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: { mode: 0 },
  }
}

function initKlineChart() {
  const container = klineChartRef.value
  if (!container) return

  klineChart = createChart(container, {
    width: container.clientWidth,
    height: 450,
    ...chartTheme(),
  })

  klineSeries = klineChart.addCandlestickSeries({
    upColor: '#ef5350',
    downColor: '#26a69a',
    borderVisible: false,
    wickUpColor: '#ef5350',
    wickDownColor: '#26a69a',
  })

  if (klineData.value.length > 0) {
    klineSeries.setData(klineData.value)
    addTradeMarkers()
    klineChart.timeScale().fitContent()
  }

  // Responsive resize
  const ro = new ResizeObserver(() => {
    if (klineChart && container.clientWidth > 0) {
      klineChart.applyOptions({ width: container.clientWidth })
    }
  })
  ro.observe(container)
  container._ro = ro
}

function addTradeMarkers() {
  if (!klineSeries) return
  const trades = backtestData.value?.trades || []
  if (trades.length === 0) return

  const markers = trades
    .filter(t => t.timestamp)
    .map(t => ({
      time: t.timestamp,
      position: t.type === 'buy' ? 'belowBar' : 'aboveBar',
      color: t.type === 'buy' ? '#26a69a' : '#ef5350',
      shape: t.type === 'buy' ? 'arrowUp' : 'arrowDown',
      text: t.type === 'buy' ? 'B' : 'S',
    }))
    .sort((a, b) => a.time - b.time)

  if (markers.length > 0) {
    klineSeries.setMarkers(markers)
  }
}

function initEquityChart() {
  const container = equityChartRef.value
  if (!container) return

  const trades = backtestData.value?.trades || []
  const initialCapital = backtestData.value?.initialCapital || 100000

  // Build equity curve data points
  const equityPoints = []
  let capital = initialCapital

  // Add starting point
  if (trades.length > 0 && trades[0].timestamp) {
    equityPoints.push({ time: trades[0].timestamp, value: capital })
  }

  for (const trade of trades) {
    if (trade.type === 'sell' && trade.timestamp) {
      capital += (trade.profit || 0)
      equityPoints.push({ time: trade.timestamp, value: parseFloat(capital.toFixed(2)) })
    }
  }

  if (equityPoints.length < 2) return

  equityChart = createChart(container, {
    width: container.clientWidth,
    height: 150,
    ...chartTheme(),
    rightPriceScale: {
      borderColor: '#2b2f3a',
      scaleMargins: { top: 0.1, bottom: 0.1 },
    },
  })

  const finalCapital = equityPoints[equityPoints.length - 1]?.value || initialCapital
  const lineColor = finalCapital >= initialCapital ? '#26a69a' : '#ef5350'

  equitySeries = equityChart.addLineSeries({
    color: lineColor,
    lineWidth: 2,
    lastValueVisible: true,
    priceLineVisible: false,
  })

  // Add baseline (initial capital)
  equityChart.addLineSeries({
    color: '#555',
    lineWidth: 1,
    lineStyle: 2, // dashed
    lastValueVisible: false,
    priceLineVisible: false,
  }).setData(equityPoints.map(p => ({ time: p.time, value: initialCapital })))

  equitySeries.setData(equityPoints)
  equityChart.timeScale().fitContent()

  const ro = new ResizeObserver(() => {
    if (equityChart && container.clientWidth > 0) {
      equityChart.applyOptions({ width: container.clientWidth })
    }
  })
  ro.observe(container)
  container._ro = ro
}

// ─── Table helpers ───

function handleSortChange({ prop, order }) {
  sortProp.value = prop || 'date'
  sortOrder.value = order || 'ascending'
}

function handlePageChange(page) {
  currentPage.value = page
}

function handlePageSizeChange(size) {
  pageSize.value = size
  currentPage.value = 1
}

function getTableSummary({ columns, data }) {
  const sums = []
  columns.forEach((col, index) => {
    if (index === 0) { sums[index] = '合计'; return }
    if (col.property === 'quantity') {
      sums[index] = data.reduce((s, r) => s + (r.quantity || 0), 0)
      return
    }
    if (col.label === '费用') {
      const total = data.reduce((s, r) => s + (r.fee || 0) + (r.stampTax || 0), 0)
      sums[index] = total.toFixed(2)
      return
    }
    if (col.property === 'profit') {
      const total = data.reduce((s, r) => s + (r.type === 'sell' ? (r.profit || 0) : 0), 0)
      sums[index] = (total >= 0 ? '+' : '') + total.toFixed(2)
      return
    }
    sums[index] = ''
  })
  return sums
}

// ─── Navigation & actions ───

function goBack() {
  router.back()
}

function refreshDetail() {
  destroyCharts()
  klineData.value = []
  loadBacktestDetail().then(async () => {
    if (backtestData.value) {
      await loadKlineData()
      await nextTick()
      initCharts()
    }
  })
}

function exportReport() {
  if (!backtestData.value) { ElMessage.warning('没有可导出的数据'); return }
  const content = generateReportContent()
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `回测报告_${backtestData.value.strategyName}_${backtestData.value.symbol}_${new Date().toISOString().split('T')[0]}.txt`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  ElMessage.success('报告导出成功')
}

function generateReportContent() {
  const d = backtestData.value
  const stats = signalStats.value
  let text = `回测报告
========

基本信息
--------
策略名称: ${d.strategyName}
策略类型: ${getStrategyTypeLabel(d.strategyType)}
交易标的: ${d.symbol}
回测周期: ${d.startDate} 至 ${d.endDate}
回测时间: ${formatDateTime(d.createdAt)}

收益指标
--------
初始资金: ${formatAmount(d.initialCapital)}
期末资金: ${formatAmount(d.finalCapital)}
总收益率: ${formatPercent(d.totalReturn)}
年化收益率: ${formatPercent(d.annualizedReturn)}

风险指标
--------
最大回撤: ${formatPercent(d.maxDrawdown)}
夏普比率: ${d.sharpeRatio?.toFixed(2) || '-'}
胜率: ${formatPercent(d.winRate)}

交易信号总览
--------
总交易笔数: ${stats.totalTrades}
买入次数: ${stats.buyCount}
卖出次数: ${stats.sellCount}
盈利笔数: ${stats.winCount}
亏损笔数: ${stats.loseCount}
盈亏比: ${stats.profitFactor}
平均持仓天数: ${stats.avgHoldDays}

逐笔交易记录
--------
`

  const trades = d.trades || []
  trades.forEach(t => {
    const dir = t.type === 'buy' ? '买入' : '卖出'
    const profit = t.type === 'sell' ? ` 盈亏:${t.profit?.toFixed(2)}` : ''
    text += `${t.date}  ${dir}  价格:${t.price?.toFixed(2)}  数量:${t.quantity}${profit}\n`
  })

  text += `\n生成时间: ${new Date().toLocaleString('zh-CN')}`
  return text
}

// ─── Format helpers ───

function getStrategyTypeColor(type) {
  const map = { trend: 'primary', momentum: 'warning', mean_reversion: 'success', reversal: 'success', arbitrage: 'info', market_making: 'danger' }
  return map[type] || 'info'
}

function getStrategyTypeLabel(type) {
  const map = { trend: '趋势策略', momentum: '动量策略', mean_reversion: '均值回归', reversal: '反转策略', arbitrage: '套利策略', market_making: '做市策略' }
  return map[type] || type
}

function getDataSourceLabel(source) {
  const map = { akshare: 'AKShare实时', database: '数据库', enhanced_mock: '模拟数据', mock: '模拟数据', tick_csv: 'Tick CSV' }
  return map[source] || source || '未知'
}

function getProfitClass(value) {
  if (value > 0) return 'profit-positive'
  if (value < 0) return 'profit-negative'
  return 'profit-neutral'
}

function getSharpeClass(value) {
  if (value > 1) return 'sharpe-excellent'
  if (value > 0.5) return 'sharpe-good'
  if (value > 0) return 'sharpe-fair'
  return 'sharpe-poor'
}

function formatPercent(value) {
  if (value == null || isNaN(value)) return '-'
  return `${value > 0 ? '+' : ''}${Number(value).toFixed(2)}%`
}

function formatAmount(value) {
  if (value == null || isNaN(value)) return '-'
  const num = Number(value)
  if (Math.abs(num) >= 10000) return `${(num / 10000).toFixed(2)}万`
  return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}
</script>

<style scoped>
.backtest-detail {
  padding: 20px;
  background: #f5f7fa;
  min-height: 100vh;
}

/* ── Header ── */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding: 16px 20px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,.08);
}
.header-left { display: flex; align-items: center; gap: 15px; }
.title-info h2 { margin: 0 0 2px; color: #303133; font-size: 20px; font-weight: 600; }
.subtitle { color: #909399; font-size: 13px; }
.header-right { display: flex; gap: 8px; }

/* ── Loading ── */
.loading-container { background: white; padding: 20px; border-radius: 8px; }

/* ── Content ── */
.detail-content { display: flex; flex-direction: column; gap: 16px; }

/* ── Cards ── */
.info-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.info-card, .table-card, .params-card, .chart-section, .signal-overview {
  background: white;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,.08);
  overflow: hidden;
}
.card-header {
  padding: 12px 20px;
  background: #fafbfc;
  border-bottom: 1px solid #ebeef5;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-header h3 { margin: 0; color: #303133; font-size: 15px; font-weight: 600; }
.sub-header { border-top: 1px solid #ebeef5; }
.card-content { padding: 16px 20px; }
.chart-hint { color: #909399; font-size: 12px; }

/* ── Info grid ── */
.info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.info-item { display: flex; flex-direction: column; gap: 4px; }
.info-item .label { color: #909399; font-size: 12px; }
.info-item .value { color: #303133; font-weight: 500; font-size: 13px; }

/* ── Metrics ── */
.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }
.metric-item { text-align: center; padding: 12px 8px; background: #f8f9fa; border-radius: 6px; }
.metric-label { color: #909399; font-size: 12px; margin-bottom: 6px; }
.metric-value { font-size: 18px; font-weight: 600; font-family: 'Consolas', 'Monaco', monospace; }

/* ── Charts ── */
.chart-body { padding: 0; }
.kline-chart { width: 100%; height: 450px; }
.equity-body { padding: 0; }
.equity-chart { width: 100%; height: 150px; }

/* ── Signal overview ── */
.signal-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.stat-item {
  text-align: center;
  padding: 14px 8px;
  background: #f8f9fa;
  border-radius: 6px;
  border-left: 3px solid #dcdfe6;
}
.stat-item.buy { border-left-color: #26a69a; }
.stat-item.sell { border-left-color: #ef5350; }
.stat-item.win { border-left-color: #ef5350; }
.stat-item.lose { border-left-color: #26a69a; }
.stat-number { font-size: 20px; font-weight: 700; color: #303133; font-family: 'Consolas', monospace; }
.stat-label { font-size: 12px; color: #909399; margin-top: 4px; }

/* ── Table ── */
.table-controls { display: flex; align-items: center; gap: 12px; }
.record-count { color: #909399; font-size: 12px; }
.pagination-wrapper { margin-top: 12px; display: flex; justify-content: flex-end; }
.reason-text { color: #606266; font-size: 12px; }

/* ── Params ── */
.params-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.param-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px; background: #f8f9fa; border-radius: 4px;
}
.param-label { color: #606266; font-size: 13px; }
.param-value { color: #303133; font-weight: 500; font-family: 'Consolas', monospace; }

/* ── Utility classes ── */
.symbol-code {
  font-family: 'Consolas', monospace; font-weight: 600; color: #409eff;
  background: #f0f9ff; padding: 2px 6px; border-radius: 4px; font-size: 12px;
}
.profit-positive { color: #ef5350; font-weight: 600; }
.profit-negative { color: #26a69a; font-weight: 600; }
.profit-neutral { color: #909399; }
.drawdown-text { color: #26a69a; }
.win-rate { color: #409eff; font-weight: 500; }
.sharpe-excellent { color: #ef5350; font-weight: 600; }
.sharpe-good { color: #ed8936; }
.sharpe-fair { color: #38b2ac; }
.sharpe-poor { color: #26a69a; }

/* ── No data ── */
.no-data {
  background: white; padding: 60px 20px; border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,.08); text-align: center;
}

/* ── Responsive ── */
@media (max-width: 768px) {
  .backtest-detail { padding: 12px; }
  .page-header { flex-direction: column; gap: 10px; align-items: flex-start; }
  .info-cards { grid-template-columns: 1fr; }
  .signal-stats { grid-template-columns: repeat(2, 1fr); }
  .kline-chart { height: 300px; }
  .equity-chart { height: 120px; }
}
</style>
