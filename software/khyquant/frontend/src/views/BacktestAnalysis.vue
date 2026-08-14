<template>
  <div class="backtest-analysis">
    <!-- 页面标题 -->
    <div class="page-header">
      <div class="header-content">
        <h2>回测分析</h2>
        <p>查看历史回测结果和分析报告</p>
      </div>
      <div class="header-actions">
        <el-button 
          v-if="selectedResults.length > 0" 
          type="danger" 
          @click="batchDeleteResults"
          :loading="deleting"
        >
          <el-icon><Delete /></el-icon>
          批量删除 ({{ selectedResults.length }})
        </el-button>
        <el-button 
          v-if="displayResults.length > 0" 
          type="warning" 
          @click="clearAllResults"
          :loading="deleting"
        >
          <el-icon><Delete /></el-icon>
          清空全部
        </el-button>
        <el-button type="primary" @click="refreshData" :loading="loading">
          <el-icon><Refresh /></el-icon>
          刷新数据
        </el-button>
      </div>
    </div>

    <!-- 批量操作工具栏 -->
    <div v-if="displayResults.length > 0" class="batch-toolbar">
      <div class="batch-left">
        <el-checkbox 
          v-model="selectAll" 
          @change="handleSelectAll"
          :indeterminate="isIndeterminate"
        >
          全选
        </el-checkbox>
        <span class="selected-count">
          已选择 {{ selectedResults.length }} / {{ displayResults.length }} 项
        </span>
      </div>
      <div class="batch-right">
        <el-button 
          v-if="selectedResults.length > 0" 
          type="danger" 
          size="small"
          @click="batchDeleteResults"
          :loading="deleting"
        >
          删除选中项
        </el-button>
      </div>
    </div>

    <!-- 统计概览 -->
    <div class="stats-overview" v-if="displayResults.length > 0">
      <div class="stat-card">
        <div class="stat-value">{{ displayResults.length }}</div>
        <div class="stat-label">回测总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" :class="avgReturnClass">{{ avgReturn }}%</div>
        <div class="stat-label">平均收益率</div>
      </div>
      <div class="stat-card">
        <div class="stat-value success">{{ winningStrategies }}</div>
        <div class="stat-label">盈利策略</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ bestStrategy?.strategyName || '-' }}</div>
        <div class="stat-label">最佳策略</div>
      </div>
    </div>

    <!-- 回测结果卡片列表 -->
    <div class="results-container" v-loading="loading">
      <div 
        v-for="result in displayResults" 
        :key="result.id"
        class="result-card"
        :class="{ 'selected': selectedResults.includes(result.id) }"
      >
        <!-- 选择框 -->
        <div class="card-selector">
          <el-checkbox 
            :model-value="selectedResults.includes(result.id)"
            @change="handleSelectResult(result.id, $event)"
          />
        </div>

        <!-- 新结果标识 -->
        <div v-if="isNewResult(result)" class="new-badge">
          <el-tag type="success" size="small" effect="dark">
            <el-icon><Star /></el-icon>
            新
          </el-tag>
        </div>

        <!-- 卡片头部 -->
        <div class="card-header">
          <div class="strategy-info">
            <h3 class="strategy-name">{{ getDisplayStrategyName(result) }}</h3>
            <div class="strategy-meta">
              <el-tag :type="getStrategyTypeColor(result.strategyType)" size="small">
                {{ getStrategyTypeLabel(result.strategyType) }}
              </el-tag>
              <span class="symbol-tag">{{ result.symbol }}</span>
              <span class="period-tag">{{ result.period }}</span>
            </div>
          </div>
          <div class="card-actions">
            <el-button type="primary" size="small" @click="showDetailDialog(result)">
              查看结果
            </el-button>
            <el-button type="info" size="small" @click="viewBacktestDetail(result)">
              详情页面
            </el-button>
            <el-button 
              type="danger" 
              size="small" 
              @click="deleteResult(result)"
              :loading="deleting"
            >
              <el-icon><Delete /></el-icon>
              删除
            </el-button>
          </div>
        </div>

        <!-- 基本信息 -->
        <div class="card-content">
          <div class="info-row">
            <div class="info-item">
              <span class="label">交易标的</span>
              <span class="value symbol">{{ result.symbol }}</span>
            </div>
            <div class="info-item">
              <span class="label">回测周期</span>
              <span class="value">{{ result.startDate }} 至 {{ result.endDate }}</span>
            </div>
            <div class="info-item">
              <span class="label">创建时间</span>
              <span class="value">{{ formatDateTime(result.createdAt) }}</span>
            </div>
          </div>

          <!-- 关键指标 -->
          <div class="metrics-grid">
            <div class="metric-item">
              <div class="metric-label">初始资金</div>
              <div class="metric-value">{{ formatAmount(result.initialCapital) }}</div>
            </div>
            <div class="metric-item">
              <div class="metric-label">期末资金</div>
              <div class="metric-value">{{ formatAmount(result.finalCapital) }}</div>
            </div>
            <div class="metric-item">
              <div class="metric-label">总收益率</div>
              <div class="metric-value" :class="getProfitClass(result.totalReturn)">
                {{ formatPercent(result.totalReturn) }}
              </div>
            </div>
            <div class="metric-item">
              <div class="metric-label">年化收益率</div>
              <div class="metric-value" :class="getProfitClass(result.annualizedReturn)">
                {{ formatPercent(result.annualizedReturn) }}
              </div>
            </div>
            <div class="metric-item">
              <div class="metric-label">最大回撤</div>
              <div class="metric-value drawdown">{{ formatPercent(result.maxDrawdown) }}</div>
            </div>
            <div class="metric-item">
              <div class="metric-label">胜率</div>
              <div class="metric-value win-rate">{{ formatPercent(result.winRate) }}</div>
            </div>
            <div class="metric-item">
              <div class="metric-label">交易次数</div>
              <div class="metric-value">{{ result.totalTrades }}</div>
            </div>
            <div class="metric-item">
              <div class="metric-label">夏普比率</div>
              <div class="metric-value" :class="getSharpeClass(result.sharpeRatio)">
                {{ result.sharpeRatio?.toFixed(2) || '-' }}
              </div>
            </div>
          </div>

          <!-- 收益曲线预览 -->
          <div class="chart-preview">
            <div class="chart-title">收益曲线预览</div>
            <div class="mini-chart" :ref="el => setChartRef(result.id, el)"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!loading && displayResults.length === 0" class="empty-state">
      <div class="empty-state-custom">
        <img src="/empty-state.jpg" alt="暂无数据" class="empty-image" />
        <h3 class="empty-text">暂无回测结果</h3>
        <p class="empty-description">请在股票交易界面执行回测后查看结果</p>
        <el-button type="primary" @click="$router.push('/trading')">
          前往交易界面
        </el-button>
      </div>
    </div>

    <!-- 详细结果弹窗 -->
    <el-dialog
      v-model="detailDialogVisible"
      :title="`回测结果详情 - ${selectedResult?.strategyName || ''}`"
      width="90%"
      :close-on-click-modal="false"
      :close-on-press-escape="true"
      class="detail-dialog"
    >
      <div v-if="selectedResult" class="dialog-content">
        <!-- 基本信息卡片 -->
        <div class="detail-section">
          <h3 class="section-title">基本信息</h3>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">策略名称</span>
              <span class="detail-value">{{ getDisplayStrategyName(selectedResult) }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">策略类型</span>
              <el-tag :type="getStrategyTypeColor(selectedResult.strategyType)">
                {{ getStrategyTypeLabel(selectedResult.strategyType) }}
              </el-tag>
            </div>
            <div class="detail-item">
              <span class="detail-label">交易标的</span>
              <span class="detail-value symbol-badge">{{ selectedResult.symbol }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">回测周期</span>
              <span class="detail-value">{{ selectedResult.startDate }} 至 {{ selectedResult.endDate }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">创建时间</span>
              <span class="detail-value">{{ formatDateTime(selectedResult.createdAt) }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">回测状态</span>
              <el-tag type="success">已完成</el-tag>
            </div>
          </div>
        </div>

        <!-- 收益指标 -->
        <div class="detail-section">
          <h3 class="section-title">收益指标</h3>
          <div class="metrics-showcase">
            <div class="showcase-item">
              <div class="showcase-label">初始资金</div>
              <div class="showcase-value primary">{{ formatAmount(selectedResult.initialCapital) }}</div>
            </div>
            <div class="showcase-item">
              <div class="showcase-label">期末资金</div>
              <div class="showcase-value primary">{{ formatAmount(selectedResult.finalCapital) }}</div>
            </div>
            <div class="showcase-item">
              <div class="showcase-label">总收益</div>
              <div class="showcase-value" :class="getProfitClass(selectedResult.totalReturn)">
                {{ formatAmount((selectedResult.finalCapital || 0) - (selectedResult.initialCapital || 0)) }}
              </div>
            </div>
            <div class="showcase-item">
              <div class="showcase-label">总收益率</div>
              <div class="showcase-value large" :class="getProfitClass(selectedResult.totalReturn)">
                {{ formatPercent(selectedResult.totalReturn) }}
              </div>
            </div>
            <div class="showcase-item">
              <div class="showcase-label">年化收益率</div>
              <div class="showcase-value large" :class="getProfitClass(selectedResult.annualizedReturn)">
                {{ formatPercent(selectedResult.annualizedReturn) }}
              </div>
            </div>
            <div class="showcase-item">
              <div class="showcase-label">基准收益率</div>
              <div class="showcase-value">{{ formatPercent(selectedResult.benchmarkReturn || 0) }}</div>
            </div>
          </div>
        </div>

        <!-- 风险指标 -->
        <div class="detail-section">
          <h3 class="section-title">风险指标</h3>
          <div class="metrics-showcase">
            <div class="showcase-item">
              <div class="showcase-label">最大回撤</div>
              <div class="showcase-value drawdown-text">{{ formatPercent(selectedResult.maxDrawdown) }}</div>
            </div>
            <div class="showcase-item">
              <div class="showcase-label">夏普比率</div>
              <div class="showcase-value" :class="getSharpeClass(selectedResult.sharpeRatio)">
                {{ selectedResult.sharpeRatio?.toFixed(2) || '-' }}
              </div>
            </div>
            <div class="showcase-item">
              <div class="showcase-label">胜率</div>
              <div class="showcase-value win-rate">{{ formatPercent(selectedResult.winRate) }}</div>
            </div>
            <div class="showcase-item">
              <div class="showcase-label">盈亏比</div>
              <div class="showcase-value">{{ selectedResult.profitLossRatio?.toFixed(2) || '-' }}</div>
            </div>
            <div class="showcase-item">
              <div class="showcase-label">交易次数</div>
              <div class="showcase-value">{{ selectedResult.totalTrades }}次</div>
            </div>
            <div class="showcase-item">
              <div class="showcase-label">平均持仓天数</div>
              <div class="showcase-value">{{ selectedResult.avgHoldingDays?.toFixed(1) || '-' }}天</div>
            </div>
          </div>
        </div>

        <!-- 交易记录 -->
        <div class="detail-section" v-if="selectedResult.trades && selectedResult.trades.length > 0">
          <h3 class="section-title">交易记录 <span class="record-count">(共{{ selectedResult.trades.length }}笔)</span></h3>
          <div class="trades-table">
            <el-table 
              :data="selectedResult.trades.slice(0, 10)" 
              size="small"
              stripe
              max-height="300"
            >
              <el-table-column prop="id" label="序号" width="60" align="center" />
              <el-table-column prop="date" label="日期" width="100" align="center" />
              <el-table-column prop="type" label="方向" width="60" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.type === 'buy' ? 'success' : 'danger'" size="small">
                    {{ row.type === 'buy' ? '买入' : '卖出' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="price" label="价格" width="80" align="right">
                <template #default="{ row }">
                  {{ row.price?.toFixed(2) }}
                </template>
              </el-table-column>
              <el-table-column prop="quantity" label="数量" width="80" align="right" />
              <el-table-column prop="return" label="收益率" width="90" align="right">
                <template #default="{ row }">
                  <span :class="getProfitClass(row.return)">
                    {{ formatPercent(row.return) }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column prop="cumulativeReturn" label="累计收益率" width="100" align="right">
                <template #default="{ row }">
                  <span :class="getProfitClass(row.cumulativeReturn)">
                    {{ formatPercent(row.cumulativeReturn) }}
                  </span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <!-- 月度收益 -->
        <div class="detail-section" v-if="selectedResult.monthlyReturns && selectedResult.monthlyReturns.length > 0">
          <h3 class="section-title">月度收益</h3>
          <div class="monthly-returns">
            <div 
              v-for="month in selectedResult.monthlyReturns.slice(0, 6)" 
              :key="month.month"
              class="monthly-item"
            >
              <div class="month-label">{{ month.month }}</div>
              <div class="month-return" :class="getProfitClass(month.return)">
                {{ formatPercent(month.return) }}
              </div>
            </div>
          </div>
        </div>

        <!-- 回测参数 -->
        <div class="detail-section" v-if="selectedResult.backtestParams">
          <h3 class="section-title">回测参数</h3>
          <div class="params-grid">
            <div class="param-item">
              <span class="param-label">初始资金</span>
              <span class="param-value">{{ formatAmount(selectedResult.backtestParams.initialCapital) }}</span>
            </div>
            <div class="param-item" v-if="selectedResult.backtestParams.fees">
              <span class="param-label">买入手续费</span>
              <span class="param-value">{{ (selectedResult.backtestParams.fees.buyFeeRate * 100).toFixed(4) }}%</span>
            </div>
            <div class="param-item" v-if="selectedResult.backtestParams.fees">
              <span class="param-label">卖出手续费</span>
              <span class="param-value">{{ (selectedResult.backtestParams.fees.sellFeeRate * 100).toFixed(4) }}%</span>
            </div>
            <div class="param-item" v-if="selectedResult.backtestParams.fees">
              <span class="param-label">印花税</span>
              <span class="param-value">{{ (selectedResult.backtestParams.fees.stampTaxRate * 100).toFixed(4) }}%</span>
            </div>
            <div class="param-item">
              <span class="param-label">滑点</span>
              <span class="param-value">{{ (selectedResult.backtestParams.slippage * 100).toFixed(4) }}%</span>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="exportDetailReport" type="success">
            <el-icon><Download /></el-icon>
            导出报告
          </el-button>
          <el-button @click="viewBacktestDetail(selectedResult)" type="primary">
            <el-icon><View /></el-icon>
            查看完整详情
          </el-button>
          <el-button @click="detailDialogVisible = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Delete, Download, View, Star } from '@element-plus/icons-vue'
import { useStrategyStore } from '@/stores/strategyStore'

const router = useRouter()
const strategyStore = useStrategyStore()

// 响应式数据
const loading = ref(false)
const deleting = ref(false)
const displayResults = ref([])
const chartRefs = ref({})
const selectedResults = ref([])
const selectAll = ref(false)
const detailDialogVisible = ref(false)
const selectedResult = ref(null)

// 计算属性
const avgReturn = computed(() => {
  if (!Array.isArray(displayResults.value) || displayResults.value.length === 0) return 0
  const total = displayResults.value.reduce((sum, item) => sum + (item.totalReturn || 0), 0)
  return (total / displayResults.value.length).toFixed(2)
})

const avgReturnClass = computed(() => {
  const value = parseFloat(avgReturn.value)
  return value >= 0 ? 'success' : 'danger'
})

const winningStrategies = computed(() => {
  return displayResults.value.filter(item => (item.totalReturn || 0) > 0).length
})

const bestStrategy = computed(() => {
  if (!Array.isArray(displayResults.value) || displayResults.value.length === 0) return null
  return displayResults.value.reduce((best, current) => {
    return (current.totalReturn || 0) > (best.totalReturn || 0) ? current : best
  })
})

// 批量选择相关计算属性
const isIndeterminate = computed(() => {
  const selectedCount = selectedResults.value.length
  return selectedCount > 0 && selectedCount < displayResults.value.length
})

// 生命周期
onMounted(async () => {
  // 🔥 从后端 API 加载回测结果
  await loadBacktestResults()
  
  // 🔥 监听新的回测完成事件
  strategyStore.on('backtestCompleted', handleBacktestCompleted)
  
  // 检查URL参数，如果有showDetail=true，则自动显示详情
  const urlParams = new URLSearchParams(window.location.search)
  const resultId = urlParams.get('resultId')
  const showDetail = urlParams.get('showDetail')
  const autoShow = urlParams.get('autoShow') // 新增：自动显示最新结果
  
  if (resultId && showDetail === 'true') {
    // 延迟执行，确保数据已加载
    setTimeout(() => {
      const result = displayResults.value.find(r => r.id == resultId)
      if (result) {
        console.log('🎯 自动显示指定回测详情:', result.strategyName)
        showDetailDialog(result)
      } else {
        console.warn('⚠️ 未找到指定的回测结果:', resultId)
        ElMessage.warning('未找到指定的回测结果')
      }
    }, 500)
  } else if (autoShow === 'latest') {
    // 自动显示最新的回测结果
    setTimeout(() => {
      if (displayResults.value.length > 0) {
        const latestResult = displayResults.value[0] // 已按时间排序，第一个是最新的
        console.log('🎯 自动显示最新回测详情:', latestResult.strategyName)
        showDetailDialog(latestResult)
        
        // 清除URL参数，避免重复触发
        const newUrl = window.location.pathname + window.location.hash
        window.history.replaceState({}, '', newUrl)
      }
    }, 800)
  }
})

onUnmounted(() => {
  // 🔥 清理事件监听
  strategyStore.off('backtestCompleted', handleBacktestCompleted)
})

// 🔥 处理新的回测完成
function handleBacktestCompleted(data) {
  console.log('🎉 收到新的回测完成事件:', data)
  
  // 重新加载回测结果
  loadBacktestResults()
  
  // 显示通知
  ElMessage.success(`策略 "${data.strategy.name}" 回测完成`)
  
  // 可选：自动显示最新结果
  setTimeout(() => {
    if (displayResults.value.length > 0) {
      const latestResult = displayResults.value[0]
      showDetailDialog(latestResult)
    }
  }, 500)
}

// 设置图表引用
function setChartRef(id, el) {
  if (el) {
    chartRefs.value[id] = el
    nextTick(() => {
      renderMiniChart(id)
    })
  }
}

// 渲染迷你图表
function renderMiniChart(resultId) {
  const chartEl = chartRefs.value[resultId]
  if (!chartEl) return

  const result = displayResults.value.find(r => r.id === resultId)
  if (!result) return

  // 生成简单的收益曲线数据
  const days = 30
  const data = []
  let cumReturn = 0
  
  for (let i = 0; i < days; i++) {
    const dailyReturn = (Math.random() - 0.5) * 2 // -1% 到 +1%
    cumReturn += dailyReturn
    data.push(cumReturn)
  }

  // 简单的SVG图表
  const width = chartEl.offsetWidth || 200
  const height = 60
  const maxValue = Math.max(...data)
  const minValue = Math.min(...data)
  const range = maxValue - minValue || 1

  let pathData = ''
  data.forEach((value, index) => {
    const x = (index / (days - 1)) * width
    const y = height - ((value - minValue) / range) * height
    pathData += index === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`
  })

  const color = cumReturn >= 0 ? '#f56c6c' : '#67c23a'
  
  chartEl.innerHTML = `
    <svg width="${width}" height="${height}" style="display: block;">
      <path d="${pathData}" stroke="${color}" stroke-width="2" fill="none"/>
      <circle cx="${width}" cy="${height - ((data[data.length - 1] - minValue) / range) * height}" r="3" fill="${color}"/>
    </svg>
  `
}

// 加载回测结果
async function loadBacktestResults() {
  loading.value = true
  try {
    // 优先从后端 API 拉取
    const { default: request } = await import('@/utils/request')
    const res = await request({ url: '/backtest', method: 'get', params: { page: 1, pageSize: 100 } })
    let results = []
    if (res?.success && res.data?.list?.length) {
      // 将后端字段映射为前端展示字段
      results = res.data.list.map(bt => ({
        ...bt,
        strategyName: bt.strategy?.name || bt.name,
        strategyType: bt.strategy?.type || 'trend',
        symbol: Array.isArray(bt.symbols) ? bt.symbols.join(',') : (bt.symbols || ''),
        totalReturn: parseFloat(bt.totalReturn) || 0,
        annualizedReturn: parseFloat(bt.annualizedReturn) || 0,
        maxDrawdown: parseFloat(bt.maxDrawdown) || 0,
        winRate: parseFloat(bt.winRate) || 0,
        sharpeRatio: bt.results?.sharpeRatio || null,
      }))
    } else {
      // 降级：从 strategyStore 内存取
      results = strategyStore.getAllBacktestResults?.() || []
    }

    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    displayResults.value = results
    console.log('✅ 回测结果加载完成:', displayResults.value.length, '条')

    nextTick(() => {
      displayResults.value.forEach(result => renderMiniChart(result.id))
    })
  } catch (error) {
    console.error('❌ 加载回测结果失败:', error)
    displayResults.value = []
  } finally {
    loading.value = false
  }
}

// 显示详细结果弹窗
function showDetailDialog(result) {
  selectedResult.value = result
  detailDialogVisible.value = true
  console.log('显示详细结果弹窗:', result.strategyName)
}

// 导出详细报告
function exportDetailReport() {
  if (!selectedResult.value) {
    ElMessage.warning('没有可导出的数据')
    return
  }
  
  const reportContent = generateDetailReport(selectedResult.value)
  
  const blob = new Blob([reportContent], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `详细回测报告_${getDisplayStrategyName(selectedResult.value)}_${selectedResult.value.symbol}_${new Date().toISOString().split('T')[0]}.txt`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  
  ElMessage.success('详细报告导出成功')
}

// 生成详细报告内容
function generateDetailReport(data) {
  return `
KHY-Quant 回测详细报告
=====================

基本信息
--------
策略名称: ${getDisplayStrategyName(data)}
策略类型: ${getStrategyTypeLabel(data.strategyType)}
交易标的: ${data.symbol}
回测周期: ${data.startDate} 至 ${data.endDate}
创建时间: ${formatDateTime(data.createdAt)}

收益指标
--------
初始资金: ${formatAmount(data.initialCapital)}
期末资金: ${formatAmount(data.finalCapital)}
总收益: ${formatAmount((data.finalCapital || 0) - (data.initialCapital || 0))}
总收益率: ${formatPercent(data.totalReturn)}
年化收益率: ${formatPercent(data.annualizedReturn)}
基准收益率: ${formatPercent(data.benchmarkReturn || 0)}

风险指标
--------
最大回撤: ${formatPercent(data.maxDrawdown)}
夏普比率: ${data.sharpeRatio?.toFixed(2) || '-'}
胜率: ${formatPercent(data.winRate)}
盈亏比: ${data.profitLossRatio?.toFixed(2) || '-'}
交易次数: ${data.totalTrades}次
平均持仓天数: ${data.avgHoldingDays?.toFixed(1) || '-'}天

交易记录
--------
${data.trades?.map((trade, index) => 
  `${index + 1}. ${trade.date} ${trade.type === 'buy' ? '买入' : '卖出'} ${trade.price?.toFixed(2)} ${trade.quantity} 收益率:${formatPercent(trade.return)} 累计:${formatPercent(trade.cumulativeReturn)}`
).join('\n') || '无交易记录'}

月度收益
--------
${data.monthlyReturns?.map(month => 
  `${month.month}: ${formatPercent(month.return)}`
).join('\n') || '无月度收益数据'}

回测参数
--------
初始资金: ${formatAmount(data.backtestParams?.initialCapital || data.initialCapital)}
买入手续费: ${data.backtestParams?.fees ? (data.backtestParams.fees.buyFeeRate * 100).toFixed(4) + '%' : '0.0003%'}
卖出手续费: ${data.backtestParams?.fees ? (data.backtestParams.fees.sellFeeRate * 100).toFixed(4) + '%' : '0.0013%'}
印花税: ${data.backtestParams?.fees ? (data.backtestParams.fees.stampTaxRate * 100).toFixed(4) + '%' : '0.1%'}
滑点: ${data.backtestParams ? (data.backtestParams.slippage * 100).toFixed(4) + '%' : '0.01%'}

报告生成时间: ${new Date().toLocaleString('zh-CN')}
生成工具: KHY-Quant 量化交易系统
  `.trim()
}
function viewBacktestDetail(row) {
  console.log('🔍 查看回测详情:', row)
  
  // 🔥 严格验证ID - 确保ID存在且有效
  if (!row.id || row.id === 'undefined' || row.id === 'null' || row.id === '') {
    console.error('❌ 回测结果缺少有效ID:', {
      id: row.id,
      strategyName: row.strategyName,
      symbol: row.symbol
    })
    ElMessage.error('回测结果缺少ID，无法查看详情。请重新运行回测。')
    return
  }
  
  console.log('✅ ID验证通过:', row.id)
  
  try {
    // 跳转到回测详情页面，使用正确的路由路径
    router.push({
      name: 'BacktestDetail',
      params: { id: row.id },
      query: { 
        strategy: getDisplayStrategyName(row),
        symbol: row.symbol 
      }
    })
    console.log('✅ 成功导航到回测详情页面，ID:', row.id)
  } catch (error) {
    console.error('❌ 导航失败:', error)
    // 备用方案：使用hash路由
    const detailUrl = `#/backtest-detail/${row.id}`
    window.location.href = detailUrl
    console.log('🔄 使用备用导航方案:', detailUrl)
  }
}

// 刷新数据
async function refreshData() {
  await loadBacktestResults()
}

// 批量选择处理
function handleSelectAll(value) {
  if (value) {
    selectedResults.value = displayResults.value.map(item => item.id)
  } else {
    selectedResults.value = []
  }
}

function handleSelectResult(resultId, checked) {
  if (checked) {
    if (!selectedResults.value.includes(resultId)) {
      selectedResults.value.push(resultId)
    }
  } else {
    const index = selectedResults.value.indexOf(resultId)
    if (index > -1) {
      selectedResults.value.splice(index, 1)
    }
  }
  
  // 更新全选状态
  selectAll.value = selectedResults.value.length === displayResults.value.length
}

// 删除单个回测结果
async function deleteResult(result) {
  try {
    await ElMessageBox.confirm(
      `确定要删除回测结果"${getDisplayStrategyName(result)} - ${result.symbol}"吗？`,
      '删除确认',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger'
      }
    )
    
    deleting.value = true
    
    // 🔥 使用 strategyStore 删除
    const success = strategyStore.deleteBacktestResult(result.id)
    
    if (success) {
      // 更新显示数据
      displayResults.value = displayResults.value.filter(item => item.id !== result.id)
      
      // 从选中列表中移除
      const selectedIndex = selectedResults.value.indexOf(result.id)
      if (selectedIndex > -1) {
        selectedResults.value.splice(selectedIndex, 1)
      }
      
      ElMessage.success('删除成功')
    } else {
      ElMessage.error('删除失败')
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除失败:', error)
      ElMessage.error('删除失败')
    }
  } finally {
    deleting.value = false
  }
}

// 批量删除回测结果
async function batchDeleteResults() {
  if (selectedResults.value.length === 0) {
    ElMessage.warning('请先选择要删除的回测结果')
    return
  }
  
  try {
    await ElMessageBox.confirm(
      `确定要删除选中的 ${selectedResults.value.length} 个回测结果吗？`,
      '批量删除确认',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger'
      }
    )
    
    deleting.value = true
    
    // 🔥 使用 strategyStore 批量删除
    const success = strategyStore.batchDeleteBacktestResults(selectedResults.value)
    
    if (success) {
      // 更新显示数据
      displayResults.value = displayResults.value.filter(item => !selectedResults.value.includes(item.id))
      
      ElMessage.success(`成功删除 ${selectedResults.value.length} 个回测结果`)
      
      // 清空选中状态
      selectedResults.value = []
      selectAll.value = false
    } else {
      ElMessage.error('批量删除失败')
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('批量删除失败:', error)
      ElMessage.error('批量删除失败')
    }
  } finally {
    deleting.value = false
  }
}

// 清空所有回测结果
async function clearAllResults() {
  try {
    await ElMessageBox.confirm(
      `确定要清空所有 ${displayResults.value.length} 个回测结果吗？此操作不可恢复！`,
      '清空全部确认',
      {
        confirmButtonText: '确定清空',
        cancelButtonText: '取消',
        type: 'error',
        confirmButtonClass: 'el-button--danger'
      }
    )
    
    deleting.value = true
    
    // 🔥 使用 strategyStore 清空
    const success = strategyStore.clearAllBacktestResults()
    
    if (success) {
      // 清空显示数据
      displayResults.value = []
      selectedResults.value = []
      selectAll.value = false
      
      ElMessage.success('已清空所有回测结果')
    } else {
      ElMessage.error('清空失败')
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('清空失败:', error)
      ElMessage.error('清空失败')
    }
  } finally {
    deleting.value = false
  }
}

// 工具方法
function getStrategyTypeColor(type) {
  const colorMap = {
    'trend': 'primary',
    'momentum': 'warning',
    'mean_reversion': 'success',
    'arbitrage': 'info',
    'market_making': 'danger'
  }
  return colorMap[type] || 'info'
}

function getStrategyTypeLabel(type) {
  const labelMap = {
    'trend': '趋势策略',
    'momentum': '动量策略',
    'mean_reversion': '均值回归',
    'arbitrage': '套利策略',
    'market_making': '做市策略'
  }
  return labelMap[type] || type || '趋势策略'
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
  if (value === undefined || value === null) return '-'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatAmount(value) {
  if (!value) return '-'
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)}万`
  }
  return value.toLocaleString('zh-CN')
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  try {
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      month: '2-digit',
      day: '2-digit'
    })
  } catch (error) {
    return dateStr
  }
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-'
  try {
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch (error) {
    return dateStr
  }
}

// 判断是否为新结果（5分钟内创建的）
function isNewResult(result) {
  if (!result.createdAt) return false
  const now = new Date()
  const created = new Date(result.createdAt)
  const diffMinutes = (now - created) / (1000 * 60)
  return diffMinutes <= 5 // 5分钟内算新结果
}

// 获取显示用的策略名称
function getDisplayStrategyName(result) {
  // 🔥 优先使用策略名称，如果为空或无效则生成默认名称
  if (result.strategyName && result.strategyName.trim() !== '' && 
      result.strategyName !== 'undefined' && result.strategyName !== 'null' &&
      result.strategyName !== '策略' && result.strategyName !== '量化策略') {
    return result.strategyName
  }
  
  // 🔥 检查是否有原始策略信息
  if (result.originalStrategy && result.originalStrategy.name) {
    const originalName = result.originalStrategy.name
    if (originalName && originalName.trim() !== '' && 
        originalName !== 'undefined' && originalName !== 'null') {
      return originalName
    }
  }
  
  // 🔥 根据策略类型生成具体名称
  const typeMap = {
    'macd': 'MACD策略',
    'rsi': 'RSI策略',
    'ma': '均线策略',
    'breakout': '突破策略',
    'trend': '趋势策略',
    'momentum': '动量策略',
    'mean_reversion': '均值回归策略',
    'arbitrage': '套利策略',
    'market_making': '做市策略',
    'bollinger': '布林带策略'
  }
  
  const strategyType = result.strategyType || result.originalStrategy?.type || 'trend'
  const baseName = typeMap[strategyType] || `${strategyType.toUpperCase()}策略`
  
  // 🔥 添加时间信息使名称更具体
  const date = result.createdAt ? ` (${new Date(result.createdAt).toLocaleDateString()})` : ''
  
  return `${baseName}${date}`
}
</script>

<style scoped>
.backtest-analysis {
  padding: 20px;
  background: #f5f7fa;
  min-height: 100vh;
}

/* 页面标题 */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding: 20px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.header-left h2 {
  margin: 0 0 5px 0;
  color: #303133;
  font-size: 24px;
  font-weight: 600;
}

.subtitle {
  color: #909399;
  font-size: 14px;
}

/* 筛选区域 */
.filter-section {
  margin-bottom: 20px;
  padding: 20px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

/* 表格区域 */
.table-section {
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  overflow: hidden;
}

.backtest-table {
  width: 100%;
  font-size: 13px;
}

.backtest-table :deep(.el-table__row) {
  cursor: pointer;
  height: 45px;
}

.backtest-table :deep(.el-table__row:hover) {
  background-color: #f0f9ff;
}

.backtest-table :deep(.el-table__header-wrapper) {
  background: #f8f9fa;
}

.backtest-table :deep(.el-table th) {
  background: #f8f9fa !important;
  color: #606266;
  font-weight: 600;
  font-size: 12px;
  border-bottom: 2px solid #e4e7ed;
}

.backtest-table :deep(.el-table td) {
  border-bottom: 1px solid #f0f0f0;
  padding: 8px 0;
}

/* 策略信息 */
.strategy-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.strategy-name {
  font-weight: 500;
  color: #303133;
  font-size: 13px;
}

/* 周期信息 */
.period-info {
  font-size: 12px;
  color: #606266;
  line-height: 1.4;
}

/* 标的代码 */
.symbol-code {
  font-family: 'Consolas', 'Monaco', monospace;
  font-weight: 600;
  color: #409eff;
  background: #f0f9ff;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
}

/* 金额样式 */
.amount-text {
  font-family: 'Consolas', 'Monaco', monospace;
  font-weight: 500;
  color: #303133;
}

/* 收益率样式 */
.profit-positive {
  color: #f56565;
  font-weight: 600;
  font-family: 'Consolas', 'Monaco', monospace;
}

.profit-negative {
  color: #48bb78;
  font-weight: 600;
  font-family: 'Consolas', 'Monaco', monospace;
}

.profit-neutral {
  color: #909399;
  font-family: 'Consolas', 'Monaco', monospace;
}

/* 回撤样式 */
.drawdown-text {
  color: #48bb78;
  font-weight: 500;
  font-family: 'Consolas', 'Monaco', monospace;
}

/* 胜率样式 */
.win-rate {
  color: #409eff;
  font-weight: 500;
  font-family: 'Consolas', 'Monaco', monospace;
}

/* 夏普比率样式 */
.sharpe-excellent {
  color: #f56565;
  font-weight: 600;
  font-family: 'Consolas', 'Monaco', monospace;
}

.sharpe-good {
  color: #ed8936;
  font-weight: 500;
  font-family: 'Consolas', 'Monaco', monospace;
}

.sharpe-fair {
  color: #38b2ac;
  font-family: 'Consolas', 'Monaco', monospace;
}

.sharpe-poor {
  color: #48bb78;
  font-family: 'Consolas', 'Monaco', monospace;
}

/* 分页 */
.pagination-wrapper {
  padding: 20px;
  display: flex;
  justify-content: center;
}
</style>

<style scoped>
.backtest-analysis {
  padding: 20px;
  background: #0a0a0a;
  min-height: 100vh;
}

/* 页面标题 - 专业深色主题 */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  padding: 24px;
  background: linear-gradient(to bottom, #1a1a1a, #0a0a0a);
  border: 1px solid #333;
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}

.header-content h2 {
  margin: 0 0 8px 0;
  color: #ffffff;
  font-size: 28px;
  font-weight: 600;
}

.header-content p {
  margin: 0;
  color: #999;
  font-size: 16px;
}

.header-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

/* 批量操作工具栏 */
.batch-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding: 16px 20px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: var(--radius-md);
  border-left: 4px solid #00aaff;
}

.batch-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.selected-count {
  color: #ffffff;
  font-size: 14px;
  font-weight: 500;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.batch-right {
  display: flex;
  gap: 8px;
}

/* 统计概览 */
.stats-overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 20px;
  margin-bottom: 24px;
}

.stat-card {
  background: #1a1a1a;
  padding: 24px;
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  border: 1px solid #333;
  text-align: center;
  transition: all 0.3s ease;
}

.stat-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 20px rgba(0, 170, 255, 0.3);
  border-color: #00aaff;
}

.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: #00aaff;
  margin-bottom: 8px;
}

.stat-value.success {
  color: #10b981;
}

.stat-value.danger {
  color: #ef4444;
}

.stat-label {
  font-size: 14px;
  color: #999;
  font-weight: 600;
}

/* 结果容器 */
.results-container {
  display: grid;
  gap: 20px;
}

/* 结果卡片 */
.result-card {
  background: #1a1a1a;
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  cursor: pointer;
  position: relative;
  border: 1px solid #333;
  transform: translateZ(0);
}

.result-card::after {
  content: '';
  position: absolute;
  right: 30px;
  bottom: 30px;
  font-size: 120px;
  opacity: 0.03;
  pointer-events: none;
  z-index: 0;
}

.result-card:hover {
  transform: translateY(-8px) scale(1.02);
  box-shadow: 0 12px 32px rgba(0, 170, 255, 0.3);
  border-color: #00aaff;
}

.result-card.selected {
  border-color: #00aaff;
  box-shadow: 0 8px 24px rgba(0, 170, 255, 0.4);
  transform: translateY(-4px);
}

.result-card.selected:hover {
  transform: translateY(-10px) scale(1.02);
}

/* 新增：卡片状态指示器 */
.result-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  background: linear-gradient(90deg, #10b981 0%, #059669 50%, #10b981 100%);
  opacity: 0;
  transition: opacity 0.3s ease;
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4);
}

.result-card:hover::before,
.result-card.selected::before {
  opacity: 1;
}

/* 新增：卡片动画效果 */
@keyframes cardAppear {
  from {
    opacity: 0;
    transform: translateY(20px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.result-card {
  animation: cardAppear 0.5s ease-out;
}

/* 新增：卡片加载状态 */
.result-card.loading {
  pointer-events: none;
  opacity: 0.7;
}

.result-card.loading::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(26, 26, 26, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

/* 卡片选择框 */
.card-selector {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 10;
  background: rgba(26, 26, 26, 0.9);
  border-radius: 4px;
  padding: 4px;
  backdrop-filter: blur(4px);
}

/* 新结果标识 */
.new-badge {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 10;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.05);
  }
  100% {
    transform: scale(1);
  }
}

/* 卡片头部 - 专业深色主题 */
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 20px 24px 20px 60px;
  background: linear-gradient(to bottom, #2a2a2a, #1a1a1a);
  border-bottom: 1px solid #333;
  color: #ffffff;
  position: relative;
  overflow: hidden;
}

.card-header::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: 
    repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(255, 255, 255, 0.02) 2px,
      rgba(255, 255, 255, 0.02) 4px
    ),
    repeating-linear-gradient(
      90deg,
      transparent,
      transparent 2px,
      rgba(255, 255, 255, 0.02) 2px,
      rgba(255, 255, 255, 0.02) 4px
    );
  opacity: 0.3;
  pointer-events: none;
}

.card-header::after {
  content: '';
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 64px;
  opacity: 0.05;
}

.strategy-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}

.strategy-name {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.3;
  color: #ffffff;
}

.strategy-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.symbol-tag {
  background: rgba(0, 170, 255, 0.2);
  color: #00aaff;
  padding: 2px 8px;
  border-radius: var(--radius-md);
  font-size: 12px;
  font-weight: 500;
  font-family: 'Consolas', 'Monaco', monospace;
  border: 1px solid rgba(0, 170, 255, 0.3);
}

.period-tag {
  background: rgba(255, 255, 255, 0.1);
  color: #999;
  padding: 2px 6px;
  border-radius: var(--radius-md);
  font-size: 11px;
  font-weight: 500;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.card-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

/* 卡片内容 */
.card-content {
  padding: 24px;
  background: #1a1a1a;
}
/* 信息行 */
.info-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid #333;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-item .label {
  font-size: 12px;
  color: #999;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.info-item .value {
  font-size: 14px;
  color: #ffffff;
  font-weight: 500;
}

.info-item .value.symbol {
  font-family: 'Consolas', 'Monaco', monospace;
  color: #00aaff;
  background: rgba(0, 170, 255, 0.1);
  padding: 4px 8px;
  border-radius: 4px;
  display: inline-block;
  border: 1px solid rgba(0, 170, 255, 0.3);
}

/* 指标网格 */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.metric-item {
  text-align: center;
  padding: 16px;
  background: #0a0a0a;
  border-radius: 8px;
  border: 1px solid #333;
  transition: all 0.2s ease;
}

.metric-item:hover {
  background: #2a2a2a;
  border-color: #00aaff;
}

.metric-label {
  font-size: 12px;
  color: #999;
  margin-bottom: 8px;
  font-weight: 600;
}

.metric-value {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  font-family: 'Consolas', 'Monaco', monospace;
}

/* 收益率颜色 */
.profit-positive {
  color: #10b981 !important;
}

.profit-negative {
  color: #ef4444 !important;
}

.profit-neutral {
  color: #999 !important;
}

/* 回撤颜色 */
.drawdown {
  color: #ef4444 !important;
}

/* 胜率颜色 */
.win-rate {
  color: #00aaff !important;
}

/* 夏普比率颜色 */
.sharpe-excellent {
  color: #10b981 !important;
}

.sharpe-good {
  color: #3b82f6 !important;
}

.sharpe-fair {
  color: #f59e0b !important;
}

.sharpe-poor {
  color: #ef4444 !important;
}

/* 图表预览 */
.chart-preview {
  border-top: 1px solid #333;
  padding-top: 20px;
}

.chart-title {
  font-size: 14px;
  color: #ffffff;
  font-weight: 600;
  margin-bottom: 12px;
}

.mini-chart {
  height: 60px;
  background: #0a0a0a;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #333;
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 80px 20px;
  background: #1a1a1a;
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  border: 1px solid #333;
}

.empty-icon {
  font-size: 64px;
  margin-bottom: 20px;
}

.empty-state h3 {
  margin: 0 0 12px 0;
  color: #ffffff;
  font-size: 20px;
  font-weight: 600;
}

.empty-state p {
  margin: 0 0 24px 0;
  color: #999;
  font-size: 16px;
}

/* 自定义空状态样式 */
.empty-state-custom {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
}

.empty-image {
  width: 200px;
  height: auto;
  max-width: 100%;
  border-radius: 8px;
  margin-bottom: 20px;
  opacity: 0.9;
}

.empty-text {
  font-size: 20px;
  color: #ffffff;
  margin: 0 0 12px 0;
  font-weight: 600;
}

.empty-description {
  font-size: 16px;
  color: #999;
  margin: 0 0 24px 0;
}

/* 响应式设计 */
@media (max-width: 768px) {
  .backtest-analysis {
    padding: 12px;
  }
  
  .page-header {
    flex-direction: column;
    gap: 16px;
    text-align: center;
  }
  
  .header-actions {
    flex-wrap: wrap;
    justify-content: center;
  }
  
  .batch-toolbar {
    flex-direction: column;
    gap: 12px;
    text-align: center;
  }
  
  .stats-overview {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .card-header {
    flex-direction: column;
    gap: 12px;
    text-align: center;
    padding: 20px 24px;
  }
  
  .card-actions {
    flex-wrap: wrap;
    justify-content: center;
  }
  
  .info-row {
    grid-template-columns: 1fr;
  }
  
  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* 加载状态 */
.el-loading-mask {
  border-radius: var(--radius-md);
}

/* 按钮样式 */
.el-button {
  border-radius: 8px;
  font-weight: 500;
}

/* 标签样式 */
.el-tag {
  border-radius: var(--radius-sm);
  font-weight: 500;
}

/* 详细结果弹窗样式 */
.detail-dialog :deep(.el-dialog) {
  border-radius: var(--radius-md);
  overflow: hidden;
}

.detail-dialog :deep(.el-dialog) {
  background: #1a1a1a;
  border: 1px solid #333;
}

.detail-dialog :deep(.el-dialog__header) {
  background: linear-gradient(to bottom, #2a2a2a, #1a1a1a);
  color: white;
  padding: 20px 24px;
  margin: 0;
  border-bottom: 1px solid #333;
}

.detail-dialog :deep(.el-dialog__title) {
  color: white;
  font-size: 18px;
  font-weight: 600;
}

.detail-dialog :deep(.el-dialog__headerbtn .el-dialog__close) {
  color: white;
  font-size: 20px;
}

.detail-dialog :deep(.el-dialog__body) {
  padding: 0;
  max-height: 70vh;
  overflow-y: auto;
  background: #1a1a1a;
}

.dialog-content {
  padding: 24px;
}

.detail-section {
  margin-bottom: 32px;
}

.detail-section:last-child {
  margin-bottom: 0;
}

.section-title {
  margin: 0 0 16px 0;
  color: #ffffff;
  font-size: 16px;
  font-weight: 600;
  padding-bottom: 8px;
  border-bottom: 2px solid #333;
  display: flex;
  align-items: center;
  gap: 8px;
}

.record-count {
  color: #999;
  font-size: 12px;
  font-weight: normal;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 16px;
}

.detail-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  background: #0a0a0a;
  border-radius: 8px;
  border: 1px solid #333;
}

.detail-label {
  font-size: 12px;
  color: #999;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.detail-value {
  font-size: 14px;
  color: #ffffff;
  font-weight: 500;
}

.symbol-badge {
  font-family: 'Consolas', 'Monaco', monospace;
  color: #00aaff;
  background: rgba(0, 170, 255, 0.1);
  padding: 4px 8px;
  border-radius: 4px;
  display: inline-block;
  font-weight: 600;
  border: 1px solid rgba(0, 170, 255, 0.3);
}

.metrics-showcase {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
}

/* Element Plus 深色主题覆盖 */
:deep(.el-button) {
  background: #333;
  border-color: #555;
  color: #ccc;
}

:deep(.el-button:hover) {
  background: #555;
  border-color: #777;
  color: #00aaff;
}

:deep(.el-button--primary) {
  background: #00aaff;
  border-color: #00aaff;
  color: white;
}

:deep(.el-button--primary:hover) {
  background: #0099ee;
  border-color: #0099ee;
}

:deep(.el-button--danger) {
  background: #ef4444;
  border-color: #ef4444;
}

:deep(.el-button--danger:hover) {
  background: #dc2626;
  border-color: #dc2626;
}

:deep(.el-checkbox__label) {
  color: #ffffff;
}

:deep(.el-tag) {
  border-radius: var(--radius-sm);
}

/* 滚动条样式 */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: #1a1a1a;
}

::-webkit-scrollbar-thumb {
  background: #555;
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: #777;
}

.showcase-item {
  text-align: center;
  padding: 20px 16px;
  background: #0a0a0a;
  border: 1px solid #333;
  border-radius: var(--radius-md);
  transition: all 0.3s ease;
}

.showcase-item:hover {
  border-color: #00aaff;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 170, 255, 0.3);
  background: #1a1a1a;
}

.showcase-label {
  font-size: 12px;
  color: #999;
  margin-bottom: 8px;
  font-weight: 500;
}

.showcase-value {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  font-family: 'Consolas', 'Monaco', monospace;
}

.showcase-value.large {
  font-size: 24px;
}

.showcase-value.primary {
  color: #00aaff;
}

.trades-table {
  background: white;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #e4e7ed;
}

.more-trades {
  padding: 12px;
  text-align: center;
  background: #f8f9fa;
  border-top: 1px solid #e4e7ed;
}

.monthly-returns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
}

.monthly-item {
  text-align: center;
  padding: 16px 12px;
  background: white;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
}

.month-label {
  font-size: 12px;
  color: #909399;
  margin-bottom: 6px;
}

.month-return {
  font-size: 16px;
  font-weight: 600;
  font-family: 'Consolas', 'Monaco', monospace;
}

.params-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.param-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: white;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
}

.param-label {
  color: #606266;
  font-size: 13px;
  font-weight: 500;
}

.param-value {
  color: #303133;
  font-weight: 600;
  font-family: 'Consolas', 'Monaco', monospace;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  background: #f8f9fa;
  border-top: 1px solid #e4e7ed;
}

/* 响应式弹窗 */
@media (max-width: 768px) {
  .detail-dialog :deep(.el-dialog) {
    width: 95% !important;
    margin: 5vh auto !important;
  }
  
  .detail-grid {
    grid-template-columns: 1fr;
  }
  
  .metrics-showcase {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .monthly-returns {
    grid-template-columns: repeat(3, 1fr);
  }
  
  .params-grid {
    grid-template-columns: 1fr;
  }
  
  .dialog-footer {
    flex-direction: column;
  }
}
</style>