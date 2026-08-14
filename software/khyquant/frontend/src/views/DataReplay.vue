<template>
  <div class="data-replay-page">
    <el-card class="replay-header">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2 style="margin:0;">数据回放 & 模拟交易</h2>
        <el-tag type="info">沙盒模式 — 不涉及真实资金</el-tag>
      </div>
    </el-card>

    <!-- Setup -->
    <el-card v-if="!sessionId" class="setup-card" style="margin-top:16px;">
      <h3>配置回放参数</h3>
      <el-form :model="replayConfig" label-width="100px">
        <el-form-item label="数据源">
          <el-radio-group v-model="replayConfig.dataSource" @change="onDataSourceChange">
            <el-radio-button value="mock">模拟数据</el-radio-button>
            <el-radio-button value="futures-tick">期货Tick数据(CSV)</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <!-- Mock data config -->
        <template v-if="replayConfig.dataSource === 'mock'">
          <el-form-item label="交易标的">
            <el-input v-model="replayConfig.symbol" placeholder="如 sh000300 或 rb_main" style="width:200px" />
          </el-form-item>
          <el-form-item label="开始日期">
            <el-date-picker v-model="replayConfig.startDate" type="date" value-format="YYYY-MM-DD" />
          </el-form-item>
          <el-form-item label="结束日期">
            <el-date-picker v-model="replayConfig.endDate" type="date" value-format="YYYY-MM-DD" />
          </el-form-item>
        </template>

        <!-- Futures tick data config -->
        <template v-if="replayConfig.dataSource === 'futures-tick'">
          <el-form-item label="交易日期">
            <el-select
              v-model="replayConfig.tickDate"
              placeholder="选择交易日期"
              style="width:200px"
              @change="onTickDateChange"
              :loading="ftLoading"
            >
              <el-option
                v-for="d in ftDates"
                :key="d"
                :label="formatTickDate(d)"
                :value="d"
              />
            </el-select>
            <el-button style="margin-left:8px" @click="refreshFuturesIndex" :loading="ftLoading" size="small" plain>
              刷新
            </el-button>
          </el-form-item>
          <el-form-item label="合约品种">
            <el-select
              v-model="replayConfig.symbol"
              filterable
              placeholder="搜索合约"
              style="width:200px"
              :loading="ftLoading"
            >
              <el-option
                v-for="s in ftSymbols"
                :key="s"
                :label="s"
                :value="s"
              />
            </el-select>
            <span style="margin-left:8px;font-size:12px;color:#909399;">{{ ftSymbols.length }} 个合约可用</span>
          </el-form-item>
        </template>

        <el-form-item label="K线周期">
          <el-select v-model="replayConfig.period" style="width:120px">
            <template v-if="replayConfig.dataSource === 'futures-tick'">
              <el-option label="1秒" value="1s" />
              <el-option label="1分钟" value="1m" />
              <el-option label="5分钟" value="5m" />
              <el-option label="15分钟" value="15m" />
              <el-option label="30分钟" value="30m" />
              <el-option label="1小时" value="1h" />
            </template>
            <template v-else>
              <el-option label="日线" value="daily" />
              <el-option label="1分钟" value="1min" />
              <el-option label="5分钟" value="5min" />
            </template>
          </el-select>
        </el-form-item>
        <el-form-item label="自动策略">
          <el-select v-model="replayConfig.strategyId" placeholder="选择策略(可选)" clearable style="width:200px">
            <el-option
              v-for="s in availableStrategies"
              :key="s.id"
              :label="s.name"
              :value="s.id"
            />
          </el-select>
          <span style="margin-left: 8px; font-size: 12px; color: #909399;">选择策略以在回放过程中自动生成交易信号</span>
        </el-form-item>
        <el-form-item label="初始资金">
          <el-input-number v-model="replayConfig.initialCash" :min="10000" :step="100000" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="startReplay" :loading="loading">开始回放</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- Replay Console -->
    <div v-if="sessionId" class="replay-console">
      <!-- Data Source Indicator -->
      <el-tag
        :type="replayConfig.dataSource === 'futures-tick' ? 'success' : 'warning'"
        style="margin-top:16px;"
      >
        {{ replayConfig.dataSource === 'futures-tick' ? 'Tick CSV' : 'Mock' }}
        {{ replayConfig.dataSource === 'futures-tick' ? `| ${replayConfig.tickDate} | ${replayConfig.symbol}` : `| ${replayConfig.symbol}` }}
      </el-tag>
      <!-- Account Info -->
      <el-row :gutter="12" style="margin-top:16px;">
        <el-col :span="6">
          <el-card class="account-card">
            <div class="account-num">¥{{ account.cash?.toLocaleString() }}</div>
            <div class="account-label">可用资金</div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card class="account-card">
            <div class="account-num" :style="{color: totalReturn >= 0 ? '#67c23a' : '#f56c6c'}">
              {{ totalReturn >= 0 ? '+' : '' }}{{ totalReturn.toFixed(2) }}%
            </div>
            <div class="account-label">总收益率</div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card class="account-card">
            <div class="account-num">{{ progress }}%</div>
            <div class="account-label">回放进度</div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card class="account-card">
            <div class="account-num">{{ tradeHistory.length }}</div>
            <div class="account-label">交易次数</div>
          </el-card>
        </el-col>
      </el-row>

      <!-- Progress Controls -->
      <el-card style="margin-top:12px;">
        <el-progress :percentage="progress" :stroke-width="12" />
        <div style="margin-top:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <el-button @click="stepBack" :disabled="currentIndex === 0">上一根</el-button>
          <el-button type="primary" @click="isPlaying ? pauseReplay() : playReplay()">
            {{ isPlaying ? '暂停' : '播放' }}
          </el-button>
          <el-button @click="stepForward">下一根</el-button>
          <el-button @click="stepForward10">+10根</el-button>
          <el-select v-model="playSpeed" style="width:100px">
            <el-option label="0.5x" :value="2000" />
            <el-option label="1x" :value="1000" />
            <el-option label="2x" :value="500" />
            <el-option label="5x" :value="200" />
            <el-option label="10x" :value="100" />
          </el-select>
          <span style="color:#909399; font-size:13px;">当前: {{ currentCandle?.time }}</span>
          <el-button type="danger" plain @click="endReplay" style="margin-left:auto;">结束回放</el-button>
        </div>
      </el-card>

      <!-- Chart Area — real lightweight-charts candlestick chart -->
      <el-card style="margin-top:12px;">
        <div ref="chartContainerRef" style="height:450px; background:#131722; border-radius:4px;"></div>
      </el-card>

      <!-- Order Form -->
      <el-card style="margin-top:12px;">
        <h4 style="margin:0 0 12px;">手动下单</h4>
        <el-form :inline="true">
          <el-form-item label="方向">
            <el-radio-group v-model="orderForm.side">
              <el-radio-button value="buy">买入</el-radio-button>
              <el-radio-button value="sell">卖出</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="数量">
            <el-input-number v-model="orderForm.quantity" :min="1" :step="100" style="width:130px" />
          </el-form-item>
          <el-form-item label="价格">
            <el-input-number v-model="orderForm.price" :precision="2" style="width:130px" />
          </el-form-item>
          <el-form-item>
            <el-button
              :type="orderForm.side === 'buy' ? 'danger' : 'success'"
              @click="placeOrder"
            >
              {{ orderForm.side === 'buy' ? '买入' : '卖出' }}
            </el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- Trade History -->
      <el-card style="margin-top:12px;">
        <h4 style="margin:0 0 12px;">交易记录</h4>
        <el-table :data="tradeHistory" size="small" max-height="200">
          <el-table-column label="方向" width="70">
            <template #default="{row}">
              <el-tag :type="row.side === 'buy' ? 'danger' : 'success'" size="small">
                {{ row.side === 'buy' ? '买入' : '卖出' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="80" />
          <el-table-column label="价格" width="100">
            <template #default="{row}">¥{{ row.price }}</template>
          </el-table-column>
          <el-table-column label="金额" width="120">
            <template #default="{row}">¥{{ row.amount?.toLocaleString() }}</template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/api/request'
import { createChart } from 'lightweight-charts'
import { useStrategyStore } from '@/stores/strategyStore'
import { useFuturesTickData } from '@/composables/useFuturesTickData'

const strategyStore = useStrategyStore()
const availableStrategies = ref([])

// Futures tick data composable
const {
  availableDates: ftDates,
  availableSymbols: ftSymbols,
  loading: ftLoading,
  loadDates: loadFtDates,
  loadSymbols: loadFtSymbols,
  refreshIndex: refreshFuturesIndex,
  formatDate: formatTickDate,
} = useFuturesTickData()

const sessionId = ref(null)
const loading = ref(false)
const isPlaying = ref(false)
const playSpeed = ref(1000)
const currentIndex = ref(0)
const totalCandles = ref(0)
const chartData = ref([])
const currentCandle = ref(null)
const tradeHistory = ref([])
let playTimer = null

// Chart refs
const chartContainerRef = ref(null)
let chart = null
let candleSeries = null
let volumeSeries = null

const account = reactive({ cash: 1000000, positions: {} })
const replayConfig = reactive({
  symbol: 'sh000300',
  startDate: '2020-01-01',
  endDate: new Date().toISOString().split('T')[0],
  period: 'daily',
  initialCash: 1000000,
  strategyId: null,
  dataSource: 'mock',
  tickDate: null, // YYYYMMDD for futures-tick mode
})
const orderForm = reactive({ side: 'buy', quantity: 100, price: 0 })
let syncingStrategySelection = false

const progress = computed(() => totalCandles.value > 0 ? Math.round(currentIndex.value / totalCandles.value * 100) : 0)
const totalReturn = computed(() => (account.cash - replayConfig.initialCash) / replayConfig.initialCash * 100)

const normalizeStrategyId = (value) => {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

const findStrategyById = (strategyId) => {
  const normalizedTarget = normalizeStrategyId(strategyId)
  if (!normalizedTarget) return null
  const list = Array.isArray(strategyStore.strategies) ? strategyStore.strategies : []
  const fromStore = list.find((item) => normalizeStrategyId(item?.id) === normalizedTarget)
  if (fromStore) return fromStore

  const fromOptions = availableStrategies.value.find((item) => normalizeStrategyId(item?.id) === normalizedTarget)
  if (fromOptions) {
    return {
      id: fromOptions.id,
      name: fromOptions.name,
      type: 'template',
      source: 'replay-selector'
    }
  }

  return null
}

const rebuildAvailableStrategies = () => {
  const merged = []
  const seen = new Set()
  const pushUnique = (item) => {
    if (!item || item.id === undefined || item.id === null) return
    const key = normalizeStrategyId(item.id)
    if (!key || seen.has(key)) return
    seen.add(key)
    merged.push({
      id: item.id,
      name: item.name || String(item.id)
    })
  }

  // Keep built-in replay option always visible.
  pushUnique({ id: 'ema-crossover', name: 'EMA 5/20 Crossover (built-in)' })

  const strategyList = Array.isArray(strategyStore.strategies) ? strategyStore.strategies : []
  strategyList.forEach(pushUnique)

  // Include the currently selected strategy even if it is a temporary smart suggestion.
  if (strategyStore.selectedStrategy) {
    pushUnique(strategyStore.selectedStrategy)
  }

  availableStrategies.value = merged
}

// Initialize the chart after the container is available
const initChart = () => {
  if (!chartContainerRef.value || chart) return

  chart = createChart(chartContainerRef.value, {
    width: chartContainerRef.value.clientWidth,
    height: 450,
    layout: {
      background: { color: '#131722' },
      textColor: '#d1d4dc',
    },
    grid: {
      vertLines: { color: '#1e222d' },
      horzLines: { color: '#1e222d' },
    },
    crosshair: { mode: 0 },
    rightPriceScale: { borderColor: '#2B2B43' },
    timeScale: {
      borderColor: '#2B2B43',
      timeVisible: true,
    },
  })

  candleSeries = chart.addCandlestickSeries({
    upColor: '#ef5350',
    downColor: '#26a69a',
    borderUpColor: '#ef5350',
    borderDownColor: '#26a69a',
    wickUpColor: '#ef5350',
    wickDownColor: '#26a69a',
  })

  volumeSeries = chart.addHistogramSeries({
    color: '#26a69a',
    priceFormat: { type: 'volume' },
    priceScaleId: '',
  })
  volumeSeries.priceScale().applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  })

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    if (chart && chartContainerRef.value) {
      chart.applyOptions({ width: chartContainerRef.value.clientWidth })
    }
  })
  resizeObserver.observe(chartContainerRef.value)
}

// Normalize time for lightweight-charts: intraday uses Unix seconds, daily uses YYYY-MM-DD
const normalizeChartTime = (d) => {
  // If time is already a Unix timestamp (number), use it directly
  if (typeof d.time === 'number' && d.time > 1000000000) {
    return d.time > 9999999999 ? Math.floor(d.time / 1000) : d.time
  }
  // If timestamp field exists as epoch ms
  if (d.timestamp && typeof d.timestamp === 'number' && d.timestamp > 1000000000) {
    return Math.floor(d.timestamp / 1000)
  }
  // For daily data, use date string
  const timeStr = String(d.time || d.date || '')
  if (timeStr.match(/^\d{4}-\d{2}-\d{2}$/)) return timeStr
  // For datetime strings, convert to unix seconds
  const parsed = new Date(timeStr)
  if (!isNaN(parsed.getTime())) return Math.floor(parsed.getTime() / 1000)
  return timeStr.substring(0, 10)
}

const isIntradayMode = () => {
  return replayConfig.dataSource === 'futures-tick'
}

// Update chart when chartData changes
watch(chartData, (newData) => {
  if (!candleSeries || !newData || newData.length === 0) return

  const useIntraday = isIntradayMode()

  const normalized = newData
    .filter(d => d && (d.time !== undefined || d.date || d.timestamp))
    .map(d => ({
      time: normalizeChartTime(d),
      open: parseFloat(d.open) || 0,
      high: parseFloat(d.high) || 0,
      low: parseFloat(d.low) || 0,
      close: parseFloat(d.close) || 0,
    }))
    .filter(d => {
      if (typeof d.time === 'number') return d.time > 0 && d.open > 0
      return typeof d.time === 'string' && d.time.match(/^\d{4}-\d{2}-\d{2}$/) && d.open > 0
    })
    .sort((a, b) => {
      if (typeof a.time === 'number' && typeof b.time === 'number') return a.time - b.time
      return String(a.time).localeCompare(String(b.time))
    })

  const volumes = newData
    .filter(d => d && (d.time !== undefined || d.date || d.timestamp))
    .map(d => ({
      time: normalizeChartTime(d),
      value: parseInt(d.volume) || 0,
      color: (parseFloat(d.close) || 0) >= (parseFloat(d.open) || 0) ? 'rgba(239,83,80,0.5)' : 'rgba(38,166,154,0.5)',
    }))
    .filter(d => typeof d.time === 'number' ? d.time > 0 : (typeof d.time === 'string' && d.time.match(/^\d{4}-\d{2}-\d{2}$/)))
    .sort((a, b) => {
      if (typeof a.time === 'number' && typeof b.time === 'number') return a.time - b.time
      return String(a.time).localeCompare(String(b.time))
    })

  if (normalized.length > 0) {
    candleSeries.setData(normalized)
    if (volumeSeries && volumes.length > 0) {
      volumeSeries.setData(volumes)
    }
    chart.timeScale().fitContent()
  }
}, { deep: true })

const onDataSourceChange = async (val) => {
  if (val === 'futures-tick') {
    replayConfig.period = '1m'
    await loadFtDates()
    if (ftDates.value.length > 0 && !replayConfig.tickDate) {
      replayConfig.tickDate = ftDates.value[ftDates.value.length - 1]
      await loadFtSymbols(replayConfig.tickDate)
    }
  } else {
    replayConfig.period = 'daily'
  }
}

const onTickDateChange = async (date) => {
  replayConfig.symbol = ''
  if (date) await loadFtSymbols(date)
}

const startReplay = async () => {
  loading.value = true
  try {
    const payload = { ...replayConfig }

    // Set data source params
    if (payload.dataSource === 'futures-tick') {
      payload.date = payload.tickDate
      if (!payload.symbol || !payload.date) {
        ElMessage.warning('Please select a trading date and instrument')
        loading.value = false
        return
      }
    }

    const selectedFromStore = strategyStore.selectedStrategy
    if (!payload.strategyId && selectedFromStore?.id !== undefined && selectedFromStore?.id !== null) {
      payload.strategyId = selectedFromStore.id
    }

    const res = await request.post('/replay/start', payload)
    if (res.success) {
      sessionId.value = res.sessionId
      totalCandles.value = res.totalCandles
      ElMessage.success(`回放会话已创建，共 ${res.totalCandles} 根K线`)
      // Initialize chart after DOM updates
      await nextTick()
      initChart()
      await stepForward()
    }
  } catch (e) {
    ElMessage.error('创建回放失败: ' + e.message)
  } finally {
    loading.value = false
  }
}

const stepForward = async (count = 1) => {
  try {
    const res = await request.get(`/replay/${sessionId.value}/next`, { params: { count } })
    if (res.success) {
      // Push new candles — do not replace the array
      if (res.candles?.length > 0) {
        res.candles.forEach(c => chartData.value.push(c))
        // Trigger reactivity
        chartData.value = [...chartData.value]
      }
      currentIndex.value = res.currentIndex
      currentCandle.value = res.candles[res.candles.length - 1]
      if (currentCandle.value) orderForm.price = currentCandle.value.close
      Object.assign(account, res.account)
      if (res.isFinished) { pauseReplay(); ElMessage.success('回放完成！') }
    }
  } catch (e) { console.error(e) }
}

const stepForward10 = () => stepForward(10)
// TODO: [Integration-Unresolved] 需人工审查 —— 后端回放仅支持前进（routes/replay.js 只有
// GET /:sessionId/next，无 /prev）。按「不增删后端核心逻辑」约束，前端暂保持诚实降级提示；
// 如需真正后退，须先由人工评估为回放引擎补 /prev 步进或快照回滚能力。
const stepBack = () => ElMessage.info('单步后退暂未支持：回放引擎当前仅能前进，请点击「重新开始」从头回放')

const playReplay = () => {
  isPlaying.value = true
  playTimer = setInterval(() => stepForward(1), playSpeed.value)
}

const pauseReplay = () => {
  isPlaying.value = false
  if (playTimer) { clearInterval(playTimer); playTimer = null }
}

const placeOrder = async () => {
  try {
    const res = await request.post(`/replay/${sessionId.value}/trade`, orderForm)
    if (res.success) {
      tradeHistory.value.unshift({ ...orderForm, amount: orderForm.quantity * orderForm.price })
      Object.assign(account, res.account)
      ElMessage.success(`${orderForm.side === 'buy' ? '买入' : '卖出'} 成功`)
    } else {
      ElMessage.error(res.message)
    }
  } catch (e) { ElMessage.error('下单失败') }
}

const endReplay = async () => {
  pauseReplay()
  try {
    const res = await request.get(`/replay/${sessionId.value}/summary`)
    if (res.success) {
      ElMessage.success(`回放结束！总收益: ${res.summary.totalReturn}，交易 ${res.summary.tradeCount} 次`)
    }
  } catch (e) { /* ignore */ }
  // Cleanup chart
  if (chart) {
    chart.remove()
    chart = null
    candleSeries = null
    volumeSeries = null
  }
  sessionId.value = null
  chartData.value = []
  currentIndex.value = 0
}

onMounted(async () => {
  // Load strategies for the selector
  if (strategyStore.strategies.length === 0) {
    await strategyStore.loadStrategies()
  }
  rebuildAvailableStrategies()

  if (strategyStore.selectedStrategy?.id !== undefined && strategyStore.selectedStrategy?.id !== null) {
    replayConfig.strategyId = strategyStore.selectedStrategy.id
  }

  // Pre-load futures tick dates (non-blocking)
  loadFtDates().catch(() => {})
})

watch(
  () => strategyStore.strategies,
  () => {
    rebuildAvailableStrategies()
  },
  { deep: true }
)

watch(
  () => strategyStore.selectedStrategy,
  (strategy) => {
    if (syncingStrategySelection) return
    syncingStrategySelection = true
    try {
      rebuildAvailableStrategies()
      replayConfig.strategyId = strategy?.id ?? null
    } finally {
      syncingStrategySelection = false
    }
  },
  { deep: true }
)

watch(
  () => replayConfig.strategyId,
  (newStrategyId, oldStrategyId) => {
    if (syncingStrategySelection) return
    if (normalizeStrategyId(newStrategyId) === normalizeStrategyId(oldStrategyId)) return

    syncingStrategySelection = true
    try {
      const strategy = findStrategyById(newStrategyId)
      strategyStore.selectStrategy(strategy || null)
    } finally {
      syncingStrategySelection = false
    }
  }
)

onUnmounted(() => {
  pauseReplay()
  if (chart) {
    chart.remove()
    chart = null
  }
})
</script>

<style scoped>
.data-replay-page {
  padding: 0;
}
.account-card {
  text-align: center;
}
.account-num {
  font-size: 22px;
  font-weight: 700;
  color: #303133;
}
.account-label {
  font-size: 13px;
  color: #909399;
  margin-top: 4px;
}
</style>
