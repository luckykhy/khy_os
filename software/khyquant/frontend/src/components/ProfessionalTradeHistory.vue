<template>
  <div class="professional-trade-history" :class="{ 'horizontal-mode': horizontal }">
    <!-- 头部工具栏 -->
    <div class="history-header">
      <div class="header-left">
        <el-icon class="title-icon"><Document /></el-icon>
        <span class="title">交易记录</span>
        <el-tag size="small" type="info">{{ filteredTrades.length }} 笔</el-tag>
      </div>
      <div class="header-right">
        <!-- 筛选器 -->
        <el-select v-model="filterType" placeholder="类型" size="small" style="width: 100px;">
          <el-option label="全部" value="all" />
          <el-option label="买入" value="buy" />
          <el-option label="卖出" value="sell" />
        </el-select>
        
        <el-select v-model="filterOrderType" placeholder="方式" size="small" style="width: 110px;">
          <el-option label="全部" value="all" />
          <el-option label="限价" value="limit" />
          <el-option label="市价" value="market" />
          <el-option label="对手价" value="counterparty" />
          <el-option label="排队价" value="queue" />
          <el-option label="最优五档" value="best5" />
          <el-option label="最优本方" value="bestOwn" />
          <el-option label="TWAP" value="twap" />
          <el-option label="VWAP" value="vwap" />
          <el-option label="策略" value="strategy" />
        </el-select>
        
        <el-button size="small" @click="refreshTrades" :loading="loading">
          <el-icon><Refresh /></el-icon>
        </el-button>
        
        <el-button size="small" @click="exportTrades">
          <el-icon><Download /></el-icon>
        </el-button>
      </div>
    </div>

    <!-- 交易表格 -->
    <div class="trade-table-container">
      <el-table
        :data="paginatedTrades"
        style="width: 100%"
        :height="tableHeight"
        stripe
        v-loading="loading"
        @row-click="handleRowClick"
        :row-class-name="getRowClassName"
      >
        <!-- 序号 -->
        <el-table-column type="index" label="#" width="50" align="center" fixed="left" />
        
        <!-- 时间 -->
        <el-table-column prop="createdAt" label="时间" min-width="140" align="center">
          <template #default="{ row }">
            <div class="time-cell">
              <div class="date">{{ formatDate(row.createdAt) }}</div>
              <div class="time">{{ formatTime(row.createdAt) }}</div>
            </div>
          </template>
        </el-table-column>
        
        <!-- 标的 -->
        <el-table-column prop="symbol" label="标的" min-width="100" align="center">
          <template #default="{ row }">
            <div class="symbol-cell">
              <span class="symbol-code">{{ row.symbol }}</span>
            </div>
          </template>
        </el-table-column>
        
        <!-- 方向 -->
        <el-table-column prop="side" label="方向" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.side === 'buy' ? 'danger' : 'success'" size="small">
              {{ row.side === 'buy' ? '买' : '卖' }}
            </el-tag>
          </template>
        </el-table-column>
        
        <!-- 下单方式 -->
        <el-table-column prop="orderType" label="方式" min-width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="getOrderTypeColor(row.orderType)" size="small">
              {{ getOrderTypeLabel(row.orderType) }}
            </el-tag>
          </template>
        </el-table-column>
        
        <!-- 成交价 -->
        <el-table-column prop="price" label="成交价" min-width="90" align="right">
          <template #default="{ row }">
            <span class="price-value">{{ formatPrice(row.price) }}</span>
          </template>
        </el-table-column>
        
        <!-- 现价 -->
        <el-table-column label="现价" min-width="90" align="right">
          <template #default="{ row }">
            <div class="current-price-cell">
              <span class="current-price-value">{{ formatPrice(getCurrentPrice(row.symbol)) }}</span>
              <span :class="['price-change', getPriceChangeClass(row)]">
                {{ getPriceChangePercent(row) }}
              </span>
            </div>
          </template>
        </el-table-column>
        
        <!-- 数量 -->
        <el-table-column prop="quantity" label="数量" min-width="80" align="right">
          <template #default="{ row }">
            <span class="quantity-value">{{ row.quantity }}</span>
          </template>
        </el-table-column>
        
        <!-- 盈亏 -->
        <el-table-column label="盈亏" min-width="110" align="right">
          <template #default="{ row }">
            <div class="profit-cell">
              <div class="profit-label">{{ row.isClosed ? '最终' : '浮动' }}</div>
              <div :class="['profit-amount', getProfitClass(row)]">
                {{ getProfitAmount(row) }}
              </div>
            </div>
          </template>
        </el-table-column>
        
        <!-- 订单状态 -->
        <el-table-column prop="status" label="订单" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)" size="small">
              {{ getStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        
        <!-- 交易状态 -->
        <el-table-column prop="isClosed" label="交易" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.isClosed ? 'info' : 'success'" size="small">
              {{ row.isClosed ? '已结束' : '进行中' }}
            </el-tag>
          </template>
        </el-table-column>
        
        <!-- 操作 -->
        <el-table-column label="操作" width="120" align="center" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text @click.stop="viewDetail(row)">
              详情
            </el-button>
            <el-button 
              v-if="row.status === 'filled' && !row.isClosed"
              size="small" 
              text 
              type="warning"
              @click.stop="closePosition(row)"
            >
              平仓
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 分页 -->
    <div class="pagination-container">
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="filteredTrades.length"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="handleSizeChange"
        @current-change="handleCurrentChange"
      />
    </div>

    <!-- 交易详情对话框 -->
    <el-dialog
      v-model="showDetailDialog"
      title="交易详情"
      width="600px"
      :close-on-click-modal="false"
    >
      <div v-if="selectedTrade" class="trade-detail">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="交易时间">
            {{ formatDateTime(selectedTrade.createdAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="标的代码">
            {{ selectedTrade.symbol }}
          </el-descriptions-item>
          <el-descriptions-item label="交易方向">
            <el-tag :type="selectedTrade.side === 'buy' ? 'danger' : 'success'">
              {{ getDirectionText(selectedTrade) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="下单方式">
            <el-tag :type="getOrderTypeColor(selectedTrade.orderType)">
              {{ getOrderTypeLabel(selectedTrade.orderType) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="成交价格">
            ¥{{ formatPrice(selectedTrade.price) }}
          </el-descriptions-item>
          <el-descriptions-item label="成交数量">
            {{ selectedTrade.quantity }} {{ selectedTrade.isFutures ? '手' : '股' }}
          </el-descriptions-item>
          <el-descriptions-item label="成交金额">
            ¥{{ formatPrice(parseFloat(selectedTrade.price) * parseFloat(selectedTrade.quantity)) }}
          </el-descriptions-item>
          <el-descriptions-item label="当前价格">
            ¥{{ formatPrice(getCurrentPrice(selectedTrade.symbol)) }}
          </el-descriptions-item>
          <el-descriptions-item label="盈亏金额" :span="2">
            <span :class="['profit-value', getProfitClass(selectedTrade)]">
              {{ getProfitAmount(selectedTrade) }} ({{ getProfitPercent(selectedTrade) }})
            </span>
          </el-descriptions-item>
          <el-descriptions-item v-if="selectedTrade.strategyName" label="策略名称" :span="2">
            {{ selectedTrade.strategyName }}
          </el-descriptions-item>
          <el-descriptions-item label="订单状态">
            <el-tag :type="getStatusType(selectedTrade.status)">
              {{ getStatusText(selectedTrade.status) }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { 
  Document, Refresh, Download, View, TrendCharts
} from '@element-plus/icons-vue'
import { tradeAPI } from '@/api/trade'
import { ensureArray, addArrayWatchGuard, validateApiArrayField } from '@/utils/arrayGuards'

// Props
const props = defineProps({
  horizontal: {
    type: Boolean,
    default: false
  }
})

// 响应式数据
const trades = ref([])

// 🔥 添加 watch 守卫，确保 trades 始终是数组
addArrayWatchGuard(trades, 'trades', watch)
const loading = ref(false)
const filterType = ref('all')
const filterOrderType = ref('all')
const currentPage = ref(1)
const pageSize = ref(20)
const tableHeight = ref(600)
const showDetailDialog = ref(false)
const selectedTrade = ref(null)

// 模拟当前价格数据（实际应该从市场数据服务获取）
const currentPrices = ref({
  '000001': 10.85,
  '000300': 4250.50,
  'sh000300': 4250.50
})

// 过滤后的交易
const filteredTrades = computed(() => {
  // 🔥 确保 trades.value 是数组
  let result = ensureArray(trades.value, [], 'trades')

  // 按类型筛选
  if (filterType.value !== 'all') {
    result = result.filter(t => t.side === filterType.value)
  }

  // 按下单方式筛选
  if (filterOrderType.value !== 'all') {
    result = result.filter(t => t.orderType === filterOrderType.value)
  }

  return result
})

// 分页后的交易
const paginatedTrades = computed(() => {
  // 🔥 确保 filteredTrades.value 是数组
  const filtered = ensureArray(filteredTrades.value, [], 'filteredTrades')
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return filtered.slice(start, end)
})

// 方法
function getDirectionText(trade) {
  if (trade.isFutures) {
    if (trade.offset === 'open') {
      return trade.side === 'buy' ? '买开' : '卖开'
    } else {
      return trade.side === 'buy' ? '买平' : '卖平'
    }
  }
  return trade.side === 'buy' ? '买入' : '卖出'
}

function getOrderTypeLabel(type) {
  const labels = {
    limit: '限价单',
    market: '市价单',
    counterparty: '对手价',
    queue: '排队价',
    best5: '最优五档',
    bestOwn: '最优本方',
    twap: 'TWAP',
    vwap: 'VWAP',
    strategy: '策略下单'
  }
  return labels[type] || type
}

function getOrderTypeColor(type) {
  const colors = {
    limit: 'primary',
    market: 'success',
    counterparty: 'warning',
    queue: 'info',
    best5: 'danger',
    bestOwn: '',
    twap: 'warning',
    vwap: 'warning',
    strategy: 'danger'
  }
  return colors[type] || ''
}

function getStatusType(status) {
  const types = {
    pending: 'info',
    filled: 'success',
    partial: 'warning',
    cancelled: 'danger'
  }
  return types[status] || 'info'
}

function getStatusText(status) {
  const texts = {
    pending: '待成交',
    filled: '已成交',
    partial: '部分成交',
    cancelled: '已撤销'
  }
  return texts[status] || status
}

function getCurrentPrice(symbol) {
  return currentPrices.value[symbol] || 0
}

// 🔥 新增：安全的价格格式化函数
function formatPrice(value) {
  const num = parseFloat(value)
  if (isNaN(num)) {
    console.warn('⚠️ formatPrice: 无效的价格值:', value)
    return '0.00'
  }
  return num.toFixed(2)
}

function getPriceChangePercent(trade) {
  const currentPrice = getCurrentPrice(trade.symbol)
  const tradePrice = parseFloat(trade.price)
  
  if (!currentPrice || currentPrice === 0 || isNaN(tradePrice) || tradePrice === 0) {
    return '0.00%'
  }
  
  const change = ((currentPrice - tradePrice) / tradePrice * 100).toFixed(2)
  return change >= 0 ? `+${change}%` : `${change}%`
}

function getPriceChangeClass(trade) {
  const currentPrice = getCurrentPrice(trade.symbol)
  const tradePrice = parseFloat(trade.price)
  
  if (!currentPrice || isNaN(tradePrice)) return ''
  
  if (currentPrice > tradePrice) return 'price-up'
  if (currentPrice < tradePrice) return 'price-down'
  return ''
}

function getProfitAmount(trade) {
  const tradePrice = parseFloat(trade.price)
  const tradeQuantity = parseFloat(trade.quantity)
  
  if (isNaN(tradePrice) || isNaN(tradeQuantity)) {
    return '¥0.00'
  }
  
  if (trade.isClosed && trade.profit !== undefined) {
    // 已平仓，显示实际盈亏
    const profit = parseFloat(trade.profit)
    if (isNaN(profit)) return '¥0.00'
    
    const sign = profit >= 0 ? '+' : ''
    return `${sign}¥${profit.toFixed(2)}`
  }
  
  // 持仓中，计算实时盈亏
  const currentPrice = getCurrentPrice(trade.symbol)
  if (!currentPrice || trade.status !== 'filled') return '¥0.00'
  
  let profit = 0
  if (trade.side === 'buy') {
    profit = (currentPrice - tradePrice) * tradeQuantity
  } else {
    profit = (tradePrice - currentPrice) * tradeQuantity
  }
  
  const sign = profit >= 0 ? '+' : ''
  return `${sign}¥${profit.toFixed(2)}`
}

function getProfitPercent(trade) {
  const currentPrice = getCurrentPrice(trade.symbol)
  const tradePrice = parseFloat(trade.price)
  
  if (!currentPrice || isNaN(tradePrice) || tradePrice === 0) {
    return '0.00%'
  }
  
  let profitPercent = 0
  if (trade.side === 'buy') {
    profitPercent = ((currentPrice - tradePrice) / tradePrice * 100)
  } else {
    profitPercent = ((tradePrice - currentPrice) / tradePrice * 100)
  }
  
  const sign = profitPercent >= 0 ? '+' : ''
  return `${sign}${profitPercent.toFixed(2)}%`
}

function getProfitClass(trade) {
  let profit = 0
  
  if (trade.isClosed && trade.profit !== undefined) {
    profit = trade.profit
  } else {
    const currentPrice = getCurrentPrice(trade.symbol)
    if (currentPrice && trade.status === 'filled') {
      if (trade.side === 'buy') {
        profit = currentPrice - trade.price
      } else {
        profit = trade.price - currentPrice
      }
    }
  }
  
  if (profit > 0) return 'profit-positive'
  if (profit < 0) return 'profit-negative'
  return 'profit-neutral'
}

function getRowClassName({ row }) {
  return row.side === 'buy' ? 'buy-row' : 'sell-row'
}

function formatDate(date) {
  if (!date) return '-'
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatTime(date) {
  if (!date) return '-'
  const d = new Date(date)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function formatDateTime(date) {
  if (!date) return '-'
  return `${formatDate(date)} ${formatTime(date)}`
}

function handleRowClick(row) {
  selectedTrade.value = row
  showDetailDialog.value = true
}

function viewDetail(trade) {
  selectedTrade.value = trade
  showDetailDialog.value = true
}

async function closePosition(trade) {
  try {
    const { value } = await ElMessageBox.prompt(
      `持仓数量: ${trade.quantity}，请输入平仓数量（输入 0 或留空表示全仓平仓）`, 
      '平仓操作', 
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        inputPattern: /^\d*$/,
        inputErrorMessage: '请输入有效的数量',
        inputPlaceholder: '留空表示全仓平仓'
      }
    )
    
    const closeQuantity = value ? parseInt(value) : trade.quantity
    if (closeQuantity > trade.quantity) {
      ElMessage.error('平仓数量不能超过持仓数量')
      return
    }
    
    // 调用真实的平仓API
    const closeType = (closeQuantity === 0 || closeQuantity === trade.quantity) ? 'full' : 'partial'
    const actualQuantity = closeQuantity === 0 ? trade.quantity : closeQuantity
    
    // 获取当前价格（这里需要从实际市场数据获取）
    const currentPrice = trade.price * (1 + (Math.random() - 0.5) * 0.1) // 模拟当前价格
    
    const response = await tradeAPI.closePosition(trade.id, {
      closeType,
      quantity: actualQuantity,
      closePrice: currentPrice
    })
    
    if (response.success) {
      // 更新本地交易状态
      const index = trades.value.findIndex(t => t.id === trade.id)
      if (index !== -1) {
        if (closeType === 'full') {
          trades.value[index].isClosed = true
          ElMessage.success(`${trade.symbol} 全仓平仓成功`)
        } else {
          trades.value[index].quantity -= actualQuantity
          ElMessage.success(`${trade.symbol} 平仓 ${actualQuantity} 成功，剩余 ${trades.value[index].quantity}`)
        }
      }
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('平仓失败:', error)
      ElMessage.error(error.response?.data?.message || '平仓失败')
    }
  }
}

function handleSizeChange(size) {
  pageSize.value = size
  currentPage.value = 1
}

function handleCurrentChange(page) {
  currentPage.value = page
}

async function refreshTrades() {
  loading.value = true
  try {
    // 🔥 调用后端API加载真实数据
    const response = await tradeAPI.getTrades()
    if (response.success) {
      trades.value = response.data || []
      ElMessage.success('刷新成功')
    }
  } catch (error) {
    console.error('刷新失败:', error)
    ElMessage.error('刷新失败')
  } finally {
    loading.value = false
  }
}

// 导出交易记录
// 凭据：直接响应用户「导出」意图；数据已在 filteredTrades 本地就绪，为纯客户端 CSV 组装
// （耗时 <1.5s，无需 Loading 控件），完成后只给一行结果摘要，避免过程污染。
function exportTrades() {
  const rows = filteredTrades.value || []
  if (!rows.length) {
    ElMessage.warning('导出交易记录：当前筛选结果为空，请调整筛选条件后再试')
    return
  }
  try {
    const esc = (v) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const headers = ['时间', '标的', '方向', '方式', '成交价', '数量', '盈亏', '订单状态', '交易状态']
    const lines = rows.map((r) => [
      `${formatDate(r.createdAt)} ${formatTime(r.createdAt)}`.trim(),
      r.symbol || '',
      r.side === 'buy' ? '买' : '卖',
      getOrderTypeLabel(r.orderType),
      formatPrice(r.price),
      r.quantity ?? '',
      getProfitAmount(r),
      getStatusText(r.status),
      r.isClosed ? '已结束' : '进行中',
    ].map(esc).join(','))
    // 前置 BOM 让 Excel 正确识别 UTF-8 中文
    const csv = '﻿' + [headers.join(','), ...lines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    a.href = url
    a.download = `交易记录_${stamp}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    ElMessage.success(`✔ 已导出 ${rows.length} 笔交易记录`)
  } catch (error) {
    // 精准报错闭环：[动作] + [目标] + [人话原因] + [建议]
    const reason = error.message || '浏览器不支持本地下载'
    ElMessage.error(`导出交易记录失败：${reason}。请改用 Chrome/Edge 或检查下载权限`)
  }
}

// 初始化
onMounted(async () => {
  // 计算表格高度 - 减去头部、分页等高度
  tableHeight.value = window.innerHeight - 400
  
  // 🔥 从后端加载真实交易记录
  await loadTrades()
  
  // 🔥 监听新订单事件
  window.addEventListener('new-order', handleNewOrder)
})

// 🔥 新增：加载交易记录
async function loadTrades() {
  loading.value = true
  try {
    const response = await tradeAPI.getTrades()
    if (response.success) {
      // 🔥 使用 validateApiArrayField 验证响应数据，正确的路径是 data.list
      trades.value = validateApiArrayField(response, 'data.list', [])
      console.log('✅ 加载交易记录成功:', trades.value.length, '条')
    } else {
      trades.value = []
    }
  } catch (error) {
    console.error('❌ 加载交易记录失败:', error)
    trades.value = []
    ElMessage.error('加载交易记录失败')
  } finally {
    loading.value = false
  }
}

// 🔥 新增：处理新订单事件
function handleNewOrder(event) {
  const newTrade = event.detail
  console.log('📥 收到新订单:', newTrade)
  
  // 添加到列表顶部
  trades.value.unshift(newTrade)
  
  // 刷新当前页
  currentPage.value = 1
}

// 🔥 组件卸载时清理事件监听
onUnmounted(() => {
  window.removeEventListener('new-order', handleNewOrder)
})
</script>

<style scoped>
.professional-trade-history {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
}

/* 头部 */
.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid #e5e7eb;
  background: #f9fafb;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-icon {
  font-size: 16px;
  color: #3b82f6;
}

.title {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 表格容器 */
.trade-table-container {
  flex: 1;
  overflow: auto;
  padding: 12px;
}

/* 表格样式优化 */
:deep(.el-table) {
  font-size: 12px;
}

:deep(.el-table th) {
  background: #f5f7fa;
  color: #606266;
  font-weight: 600;
  font-size: 12px;
  padding: 8px 0;
}

:deep(.el-table td) {
  padding: 8px 0;
}

:deep(.el-table__body-wrapper) {
  overflow-x: auto;
}

/* 表格单元格样式 */
.time-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
}

.time-cell .date {
  font-size: 11px;
  color: #374151;
  font-weight: 500;
}

.time-cell .time {
  font-size: 10px;
  color: #9ca3af;
}

.symbol-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.symbol-code {
  font-size: 12px;
  font-weight: 600;
  color: #1f2937;
  font-family: 'Consolas', monospace;
}

.price-value {
  font-family: 'Consolas', monospace;
  font-weight: 600;
  color: #1f2937;
  font-size: 12px;
}

.current-price-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.current-price-value {
  font-family: 'Consolas', monospace;
  font-weight: 700;
  color: #1f2937;
  font-size: 12px;
}

.price-change {
  font-family: 'Consolas', monospace;
  font-size: 10px;
  font-weight: 600;
}

.price-change.price-up {
  color: #ef4444;
}

.price-change.price-down {
  color: #10b981;
}

.quantity-value {
  font-family: 'Consolas', monospace;
  color: #6b7280;
  font-size: 12px;
}

.profit-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.profit-label {
  font-size: 9px;
  color: #9ca3af;
  font-weight: 500;
}

.profit-amount {
  font-family: 'Consolas', monospace;
  font-weight: 700;
  font-size: 12px;
}

.profit-positive {
  color: #ef4444;
}

.profit-negative {
  color: #10b981;
}

.profit-neutral {
  color: #6b7280;
}

/* 行样式 */
:deep(.buy-row) {
  background: rgba(239, 68, 68, 0.02);
}

:deep(.sell-row) {
  background: rgba(16, 185, 129, 0.02);
}

:deep(.el-table__row:hover) {
  cursor: pointer;
}

/* 分页 */
.pagination-container {
  padding: 10px 12px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  justify-content: flex-end;
  background: #f9fafb;
}

:deep(.el-pagination) {
  font-size: 12px;
}

:deep(.el-pagination .el-pager li) {
  min-width: 28px;
  height: 28px;
  line-height: 28px;
  font-size: 12px;
}

/* 详情对话框 */
.trade-detail {
  padding: 16px 0;
}

.profit-value {
  font-weight: 700;
  font-size: 16px;
}

/* 横向模式样式 */
.horizontal-mode {
  height: 100%;
}

.horizontal-mode .trade-table-container {
  overflow-x: auto;
  overflow-y: hidden;
}

.horizontal-mode :deep(.el-table) {
  display: block;
  overflow-x: auto;
}

.horizontal-mode :deep(.el-table__body-wrapper) {
  overflow-x: auto;
  overflow-y: hidden;
}

.horizontal-mode :deep(.el-table__body) {
  display: flex;
  flex-direction: row;
}

.horizontal-mode :deep(.el-table__row) {
  display: flex;
  flex-direction: column;
  min-width: 200px;
  border-right: 1px solid #e5e7eb;
}

.horizontal-mode :deep(.el-table__cell) {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid #e5e7eb;
  min-height: 40px;
}

.horizontal-mode :deep(.el-table th.el-table__cell) {
  background: #f5f7fa;
  font-weight: 600;
}

.horizontal-mode .pagination-container {
  justify-content: center;
  padding: 8px 12px;
}
</style>
