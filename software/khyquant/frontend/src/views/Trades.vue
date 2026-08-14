<template>
  <div class="trades-page">
    <!-- 账户概览 - 重新设计 -->
    <div class="account-overview-modern">
      <div class="overview-card">
        <div class="card-icon total-assets"><span class="icon-text">总资产</span></div>
        <div class="card-content">
          <div class="card-label">总资产</div>
          <div class="card-value">¥{{ formatNumber(accountInfo.totalAssets) }}</div>
        </div>
      </div>
      <div class="overview-card">
        <div class="card-icon available-funds"><span class="icon-text">可用</span></div>
        <div class="card-content">
          <div class="card-label">可用资金</div>
          <div class="card-value">¥{{ formatNumber(accountInfo.availableFunds) }}</div>
        </div>
      </div>
      <div class="overview-card">
        <div class="card-icon total-profit"><span class="icon-text">盈亏</span></div>
        <div class="card-content">
          <div class="card-label">总盈亏</div>
          <div class="card-value" :class="getProfitClass(accountInfo.totalProfit)">
            {{ accountInfo.totalProfit >= 0 ? '+' : '' }}¥{{ formatNumber(accountInfo.totalProfit) }}
          </div>
        </div>
      </div>
      <div class="overview-card">
        <div class="card-icon today-profit"><span class="icon-text">今日</span></div>
        <div class="card-content">
          <div class="card-label">今日盈亏</div>
          <div class="card-value" :class="getProfitClass(accountInfo.todayProfit)">
            {{ accountInfo.todayProfit >= 0 ? '+' : '' }}¥{{ formatNumber(accountInfo.todayProfit) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 快速交易按钮区 -->
    <div class="quick-trade-section">
      <el-button 
        type="danger" 
        size="large"
        class="quick-trade-btn buy-btn"
        @click="quickBuy"
      >
        <el-icon><TrendCharts /></el-icon>
        买入
      </el-button>
      <el-button 
        type="success" 
        size="large"
        class="quick-trade-btn sell-btn"
        @click="quickSell"
      >
        <el-icon><Sell /></el-icon>
        卖出
      </el-button>
    </div>

    <!-- 交易记录 - 重新设计 -->
    <div class="trades-card-modern">
      <!-- 头部工具栏 -->
      <div class="trades-header">
        <div class="header-left">
          <el-icon class="title-icon"><Document /></el-icon>
          <span class="title">交易记录</span>
          <el-tag size="small" type="info">{{ pagination.total }} 笔</el-tag>
        </div>
        <div class="header-right">
          <el-button size="small" @click="showCreateDialog = true" type="primary">
            <el-icon><Plus /></el-icon>
            新建
          </el-button>
          <el-button size="small" @click="refreshData">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </div>

      <!-- 筛选条件 - 紧凑设计 -->
      <div class="filter-section-modern">
        <el-input
          v-model="filters.symbol"
          placeholder="代码"
          clearable
          @input="handleFilter"
          size="small"
          style="width: 120px;"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        
        <el-select v-model="filters.side" placeholder="方向" clearable @change="handleFilter" size="small" style="width: 100px;">
          <el-option label="全部" value="" />
          <el-option label="买入" value="buy" />
          <el-option label="卖出" value="sell" />
        </el-select>
        
        <el-select v-model="filters.status" placeholder="状态" clearable @change="handleFilter" size="small" style="width: 110px;">
          <el-option label="全部" value="" />
          <el-option label="已成交" value="filled" />
          <el-option label="待成交" value="pending" />
          <el-option label="已取消" value="cancelled" />
        </el-select>
        
        <el-select v-model="filters.type" placeholder="类型" clearable @change="handleFilter" size="small" style="width: 110px;">
          <el-option label="全部" value="" />
          <el-option label="模拟" value="paper" />
          <el-option label="回测" value="backtest" />
          <el-option label="实盘" value="live" />
        </el-select>
        
        <el-date-picker
          v-model="dateRange"
          type="datetimerange"
          range-separator="至"
          start-placeholder="开始"
          end-placeholder="结束"
          format="YYYY-MM-DD HH:mm"
          value-format="YYYY-MM-DD HH:mm:ss"
          @change="handleDateChange"
          size="small"
          style="width: 340px;"
        />
        
        <el-button @click="resetFilters" size="small">重置</el-button>
      </div>

      <!-- 交易列表 - 优化表格 -->
      <div class="table-container">
        <el-table
          v-loading="loading"
          :data="trades"
          style="width: 100%"
          :height="tableHeight"
          stripe
          @sort-change="handleSortChange"
          @row-click="viewDetail"
        >
          <el-table-column type="index" label="#" width="50" align="center" fixed="left" />
          
          <el-table-column prop="createdAt" label="时间" min-width="140" sortable align="center">
            <template #default="{ row }">
              <div class="time-cell">
                <div class="date">{{ formatDate(row.createdAt) }}</div>
                <div class="time">{{ formatTime(row.createdAt) }}</div>
              </div>
            </template>
          </el-table-column>
          
          <el-table-column prop="symbol" label="代码" min-width="100" sortable align="center">
            <template #default="{ row }">
              <div class="symbol-cell">
                <span class="symbol-code">{{ row.symbol }}</span>
                <span class="symbol-name">{{ row.symbolName }}</span>
              </div>
            </template>
          </el-table-column>
          
          <el-table-column prop="side" label="方向" width="80" sortable align="center">
            <template #default="{ row }">
              <el-tag :type="row.side === 'buy' ? 'danger' : 'success'" size="small">
                {{ row.side === 'buy' ? '买' : '卖' }}
              </el-tag>
            </template>
          </el-table-column>
          
          <el-table-column prop="quantity" label="数量" min-width="90" sortable align="right">
            <template #default="{ row }">
              <span class="quantity-value">{{ formatNumber(row.quantity) }}</span>
            </template>
          </el-table-column>
          
          <el-table-column prop="price" label="成交价" min-width="90" sortable align="right">
            <template #default="{ row }">
              <span class="price-value">¥{{ formatNumber(row.price, 2) }}</span>
            </template>
          </el-table-column>
          
          <el-table-column label="现价" min-width="90" align="right">
            <template #default="{ row }">
              <div class="current-price-cell">
                <span class="current-price-value">¥{{ formatNumber(getCurrentPrice(row.symbol), 2) }}</span>
                <span :class="['price-change', getPriceChangeClass(row)]">
                  {{ getPriceChange(row) }}
                </span>
              </div>
            </template>
          </el-table-column>
          
          <el-table-column prop="amount" label="金额" min-width="110" sortable align="right">
            <template #default="{ row }">
              <span class="amount-value">¥{{ formatNumber(row.amount, 2) }}</span>
            </template>
          </el-table-column>
          
          <el-table-column prop="status" label="状态" width="90" sortable align="center">
            <template #default="{ row }">
              <el-tag :type="getStatusType(row.status)" size="small">
                {{ getStatusText(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          
          <el-table-column prop="type" label="类型" width="80" sortable align="center">
            <template #default="{ row }">
              <el-tag :type="getTypeType(row.type)" size="small">
                {{ getTypeText(row.type) }}
              </el-tag>
            </template>
          </el-table-column>
          
          <el-table-column label="盈亏" min-width="120" align="right">
            <template #default="{ row }">
              <div class="profit-cell">
                <div class="profit-label">{{ row.isClosed ? '最终盈亏' : '浮动盈亏' }}</div>
                <div :class="['profit-amount', getProfitClass(row)]">
                  {{ getProfitAmount(row) }}
                </div>
                <div class="profit-percent">{{ getProfitPercent(row) }}</div>
              </div>
            </template>
          </el-table-column>
          
          <el-table-column prop="isClosed" label="交易状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="row.isClosed ? 'info' : 'success'" size="small">
                {{ row.isClosed ? '已结束' : '进行中' }}
              </el-tag>
            </template>
          </el-table-column>
          
          <el-table-column prop="strategy" label="策略" min-width="120" align="center">
            <template #default="{ row }">
              <span class="strategy-name">{{ row.strategy?.name || '-' }}</span>
            </template>
          </el-table-column>
          
          <el-table-column label="操作" width="140" fixed="right" align="center">
            <template #default="{ row }">
              <el-button size="small" text @click.stop="viewDetail(row)">详情</el-button>
              <el-button
                v-if="row.status === 'pending'"
                size="small"
                text
                type="danger"
                @click.stop="cancelOrder(row)"
              >
                取消
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
      <div class="pagination-section-modern">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="pagination.total"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </div>

    <!-- 新建交易对话框 -->
    <el-dialog
      v-model="showCreateDialog"
      title="新建交易"
      width="500px"
      @close="resetCreateForm"
    >
      <el-form
        ref="createFormRef"
        :model="createForm"
        :rules="createRules"
        label-width="80px"
      >
        <el-form-item label="股票代码" prop="symbol">
          <el-input v-model="createForm.symbol" placeholder="请输入股票代码" />
        </el-form-item>
        <el-form-item label="交易方向" prop="side">
          <el-select v-model="createForm.side" placeholder="请选择交易方向">
            <el-option label="买入" value="buy" />
            <el-option label="卖出" value="sell" />
          </el-select>
        </el-form-item>
        <el-form-item label="数量" prop="quantity">
          <el-input-number
            v-model="createForm.quantity"
            :min="1"
            :step="100"
            placeholder="请输入数量"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="价格" prop="price">
          <el-input-number
            v-model="createForm.price"
            :min="0.01"
            :step="0.01"
            :precision="2"
            placeholder="请输入价格"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="交易类型" prop="type">
          <el-select v-model="createForm.type" placeholder="请选择交易类型">
            <el-option label="模拟交易" value="paper" />
            <el-option label="实盘交易" value="live" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="handleCreateTrade" :loading="createLoading">
          创建
        </el-button>
      </template>
    </el-dialog>

    <!-- 交易详情对话框 -->
    <el-dialog
      v-model="showDetailDialog"
      title="交易详情"
      width="600px"
    >
      <div v-if="selectedTrade">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="订单号">{{ selectedTrade.id }}</el-descriptions-item>
          <el-descriptions-item label="股票代码">{{ selectedTrade.symbol }}</el-descriptions-item>
          <el-descriptions-item label="股票名称">{{ selectedTrade.symbolName }}</el-descriptions-item>
          <el-descriptions-item label="交易方向">
            <el-tag :type="selectedTrade.side === 'buy' ? 'success' : 'danger'" size="small">
              {{ selectedTrade.side === 'buy' ? '买入' : '卖出' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="数量">{{ formatNumber(selectedTrade.quantity) }}</el-descriptions-item>
          <el-descriptions-item label="价格">¥{{ formatNumber(selectedTrade.price, 2) }}</el-descriptions-item>
          <el-descriptions-item label="金额">¥{{ formatNumber(selectedTrade.amount, 2) }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="getStatusType(selectedTrade.status)" size="small">
              {{ getStatusText(selectedTrade.status) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="类型">
            <el-tag :type="getTypeType(selectedTrade.type)" size="small">
              {{ getTypeText(selectedTrade.type) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="策略">{{ selectedTrade.strategy?.name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDate(selectedTrade.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="成交时间">{{ selectedTrade.filledAt ? formatDate(selectedTrade.filledAt) : '-' }}</el-descriptions-item>
        </el-descriptions>
      </div>
    </el-dialog>

    <!-- 平仓对话框 -->
    <el-dialog
      v-model="showCloseDialog"
      title="平仓操作"
      width="500px"
      @close="resetCloseForm"
    >
      <div v-if="selectedTrade" class="close-dialog-content">
        <el-alert
          :title="`${selectedTrade.symbol} - ${selectedTrade.symbolName}`"
          type="info"
          :closable="false"
          style="margin-bottom: 20px;"
        >
          <template #default>
            <div class="trade-info">
              <span>持仓数量: {{ selectedTrade.quantity }}</span>
              <span>成交价: ¥{{ formatNumber(selectedTrade.price, 2) }}</span>
              <span>现价: ¥{{ formatNumber(getCurrentPrice(selectedTrade.symbol), 2) }}</span>
              <span :class="['profit-info', getProfitClass(selectedTrade)]">
                浮动盈亏: {{ getProfitAmount(selectedTrade) }}
              </span>
            </div>
          </template>
        </el-alert>

        <el-form
          ref="closeFormRef"
          :model="closeForm"
          :rules="closeRules"
          label-width="100px"
        >
          <el-form-item label="平仓方式">
            <el-radio-group v-model="closeForm.closeType">
              <el-radio label="full">全仓平仓</el-radio>
              <el-radio label="partial">部分平仓</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item 
            v-if="closeForm.closeType === 'partial'" 
            label="平仓数量" 
            prop="quantity"
          >
            <el-input-number
              v-model="closeForm.quantity"
              :min="1"
              :max="closeForm.maxQuantity"
              :step="1"
              placeholder="请输入平仓数量"
              style="width: 100%"
            />
            <div class="quantity-hint">
              可平仓数量: {{ closeForm.maxQuantity }}
            </div>
          </el-form-item>

          <el-form-item v-else label="平仓数量">
            <el-input :value="selectedTrade.quantity" disabled />
          </el-form-item>

          <el-form-item label="预计盈亏">
            <div :class="['estimated-profit', getProfitClass(selectedTrade)]">
              {{ getProfitAmount(selectedTrade) }} ({{ getProfitPercent(selectedTrade) }})
            </div>
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <el-button @click="showCloseDialog = false">取消</el-button>
        <el-button type="warning" @click="handleClosePosition">
          确认平仓
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search, Document, TrendCharts, Sell } from '@element-plus/icons-vue'
import { tradeAPI } from '@/api/trade'
import { getRealtimeData } from '@/api/marketData'

// 数据状态
const loading = ref(false)
const createLoading = ref(false)
const trades = ref([])
const tableHeight = ref(600)
const accountInfo = ref({
  totalAssets: 0,
  availableFunds: 0,
  totalProfit: 0,
  todayProfit: 0
})

// 当前价格数据（从市场数据服务获取）
const currentPrices = ref({})

// 对话框状态
const showCreateDialog = ref(false)
const showDetailDialog = ref(false)
const showCloseDialog = ref(false)
const selectedTrade = ref(null)

// 平仓表单
const closeForm = reactive({
  closeType: 'full', // full: 全仓, partial: 部分
  quantity: 0,
  maxQuantity: 0
})

const closeFormRef = ref()
const closeRules = {
  quantity: [
    { required: true, message: '请输入平仓数量', trigger: 'blur' },
    { type: 'number', min: 1, message: '数量必须大于0', trigger: 'blur' },
    { 
      validator: (rule, value, callback) => {
        if (value > closeForm.maxQuantity) {
          callback(new Error(`数量不能超过${closeForm.maxQuantity}`))
        } else {
          callback()
        }
      }, 
      trigger: 'blur' 
    }
  ]
}

// 筛选条件
const filters = reactive({
  symbol: '',
  side: '',
  status: '',
  type: '',
  startDate: '',
  endDate: ''
})

const dateRange = ref([])

// 分页
const pagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0
})

// 创建交易表单
const createForm = reactive({
  symbol: '',
  side: '',
  quantity: 100,
  price: 0,
  type: 'paper'
})

const createFormRef = ref()
const createRules = {
  symbol: [
    { required: true, message: '请输入股票代码', trigger: 'blur' }
  ],
  side: [
    { required: true, message: '请选择交易方向', trigger: 'change' }
  ],
  quantity: [
    { required: true, message: '请输入数量', trigger: 'blur' },
    { type: 'number', min: 1, message: '数量必须大于0', trigger: 'blur' }
  ],
  price: [
    { required: true, message: '请输入价格', trigger: 'blur' },
    { type: 'number', min: 0.01, message: '价格必须大于0', trigger: 'blur' }
  ],
  type: [
    { required: true, message: '请选择交易类型', trigger: 'change' }
  ]
}

// 方法
const fetchTrades = async () => {
  try {
    loading.value = true
    const params = {
      page: pagination.page,
      pageSize: pagination.pageSize,
      ...filters
    }

    const response = await tradeAPI.getTrades(params)
    if (response.success) {
      trades.value = response.data.list
      pagination.total = response.data.total
    }
  } catch (error) {
    ElMessage.error('获取交易记录失败')
    console.error('获取交易记录失败:', error)
  } finally {
    loading.value = false
  }
}

const fetchAccountInfo = async () => {
  try {
    const response = await tradeAPI.getAccount()
    if (response.success) {
      accountInfo.value = response.data
    }
  } catch (error) {
    console.error('获取账户信息失败:', error)
  }
}

const refreshData = () => {
  fetchTrades()
  fetchAccountInfo()
}

const handleFilter = () => {
  pagination.page = 1
  fetchTrades()
}

const handleDateChange = (dates) => {
  if (dates && dates.length === 2) {
    filters.startDate = dates[0]
    filters.endDate = dates[1]
  } else {
    filters.startDate = ''
    filters.endDate = ''
  }
  handleFilter()
}

const resetFilters = () => {
  Object.keys(filters).forEach(key => {
    filters[key] = ''
  })
  dateRange.value = []
  handleFilter()
}

const handleSortChange = ({ prop, order }) => {
  // 这里可以实现服务端排序
  fetchTrades()
}

const handleSizeChange = (size) => {
  pagination.pageSize = size
  pagination.page = 1
  fetchTrades()
}

const handleCurrentChange = (page) => {
  pagination.page = page
  fetchTrades()
}

const handleCreateTrade = async () => {
  try {
    await createFormRef.value.validate()
    createLoading.value = true

    const response = await tradeAPI.createTrade(createForm)
    if (response.success) {
      ElMessage.success('交易创建成功')
      showCreateDialog.value = false
      await fetchTrades()
      await fetchAccountInfo()
    }
  } catch (error) {
    if (error.response?.data?.message) {
      ElMessage.error(error.response.data.message)
    } else {
      ElMessage.error('创建交易失败')
    }
    console.error('创建交易失败:', error)
  } finally {
    createLoading.value = false
  }
}

const viewDetail = (trade) => {
  selectedTrade.value = trade
  showDetailDialog.value = true
}

const cancelOrder = async (trade) => {
  try {
    await ElMessageBox.confirm(
      `确定要取消订单 ${trade.id} 吗？`,
      '确认取消',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const response = await tradeAPI.cancelOrder(trade.id)
    if (response.success) {
      ElMessage.success('订单取消成功')
      await fetchTrades()
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('取消订单失败')
      console.error('取消订单失败:', error)
    }
  }
}

const closePosition = async (trade) => {
  selectedTrade.value = trade
  closeForm.closeType = 'full'
  closeForm.quantity = trade.quantity
  closeForm.maxQuantity = trade.quantity
  showCloseDialog.value = true
}

const handleClosePosition = async () => {
  try {
    if (closeForm.closeType === 'partial') {
      await closeFormRef.value.validate()
    }
    
    // 获取当前价格用于计算盈亏
    const currentPrice = getCurrentPrice(selectedTrade.value.symbol)
    
    const closeData = {
      tradeId: selectedTrade.value.id,
      closeType: closeForm.closeType,
      quantity: closeForm.closeType === 'full' ? selectedTrade.value.quantity : closeForm.quantity,
      closePrice: currentPrice // 添加平仓价格
    }

    // 调用平仓API
    const response = await tradeAPI.closePosition(selectedTrade.value.id, closeData)
    if (response.success) {
      ElMessage.success(`${selectedTrade.value.symbol} 平仓成功`)
      showCloseDialog.value = false
      await fetchTrades()
      await fetchAccountInfo()
    }
  } catch (error) {
    if (error.response?.data?.message) {
      ElMessage.error(error.response.data.message)
    } else if (error !== 'cancel') {
      ElMessage.error('平仓失败')
    }
    console.error('平仓失败:', error)
  }
}

const resetCloseForm = () => {
  closeForm.closeType = 'full'
  closeForm.quantity = 0
  closeForm.maxQuantity = 0
  closeFormRef.value?.resetFields()
}

const getCurrentPrice = (symbol) => {
  return currentPrices.value[symbol] || 0
}

const getPriceChange = (trade) => {
  const currentPrice = getCurrentPrice(trade.symbol)
  if (!currentPrice || trade.status !== 'filled') return '-'
  
  const change = currentPrice - trade.price
  const changePercent = (change / trade.price * 100).toFixed(2)
  const sign = change >= 0 ? '+' : ''
  
  return `${sign}${changePercent}%`
}

const getPriceChangeClass = (trade) => {
  const currentPrice = getCurrentPrice(trade.symbol)
  if (!currentPrice || trade.status !== 'filled') return ''
  
  const change = currentPrice - trade.price
  if (change > 0) return 'price-up'
  if (change < 0) return 'price-down'
  return ''
}

const getProfitAmount = (trade) => {
  if (trade.isClosed) {
    // 已平仓，显示实际盈亏
    return trade.profit ? `${trade.profit >= 0 ? '+' : ''}¥${formatNumber(Math.abs(trade.profit), 2)}` : '¥0.00'
  }
  
  // 持仓中，计算实时盈亏
  const currentPrice = getCurrentPrice(trade.symbol)
  if (!currentPrice || trade.status !== 'filled') return '¥0.00'
  
  let profit = 0
  if (trade.side === 'buy') {
    profit = (currentPrice - trade.price) * trade.quantity
  } else {
    profit = (trade.price - currentPrice) * trade.quantity
  }
  
  const sign = profit >= 0 ? '+' : ''
  return `${sign}¥${formatNumber(Math.abs(profit), 2)}`
}

const getProfitPercent = (trade) => {
  if (trade.isClosed && trade.profit) {
    const percent = (trade.profit / (trade.price * trade.quantity) * 100)
    return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`
  }
  
  const currentPrice = getCurrentPrice(trade.symbol)
  if (!currentPrice || trade.price === 0 || trade.status !== 'filled') return '0.00%'
  
  let profitPercent = 0
  if (trade.side === 'buy') {
    profitPercent = ((currentPrice - trade.price) / trade.price * 100)
  } else {
    profitPercent = ((trade.price - currentPrice) / trade.price * 100)
  }
  
  const sign = profitPercent >= 0 ? '+' : ''
  return `${sign}${profitPercent.toFixed(2)}%`
}

const getProfitClass = (trade) => {
  let profit = 0
  
  if (trade.isClosed) {
    profit = trade.profit || 0
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

const resetCreateForm = () => {
  createForm.symbol = ''
  createForm.side = ''
  createForm.quantity = 100
  createForm.price = 0
  createForm.type = 'paper'
  createFormRef.value?.resetFields()
}

// 快速买入
const quickBuy = () => {
  createForm.side = 'buy'
  showCreateDialog.value = true
}

// 快速卖出
const quickSell = () => {
  createForm.side = 'sell'
  showCreateDialog.value = true
}

const formatNumber = (num, decimals = 0) => {
  if (num === null || num === undefined) return '0'
  return Number(num).toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

const formatDate = (dateString) => {
  if (!dateString) return '-'
  const d = new Date(dateString)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const formatTime = (dateString) => {
  if (!dateString) return '-'
  const d = new Date(dateString)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const getStatusType = (status) => {
  const statusTypes = {
    pending: 'warning',
    filled: 'success',
    cancelled: 'info',
    rejected: 'danger'
  }
  return statusTypes[status] || 'info'
}

const getStatusText = (status) => {
  const statusTexts = {
    pending: '待成交',
    filled: '已成交',
    cancelled: '已取消',
    rejected: '已拒绝'
  }
  return statusTexts[status] || status
}

const getTypeType = (type) => {
  const typeTypes = {
    paper: 'primary',
    backtest: 'info',
    live: 'success'
  }
  return typeTypes[type] || 'info'
}

const getTypeText = (type) => {
  const typeTexts = {
    paper: '模拟',
    backtest: '回测',
    live: '实盘'
  }
  return typeTexts[type] || type
}

// 生命周期
onMounted(() => {
  refreshData()
  // 计算表格高度
  tableHeight.value = window.innerHeight - 450
})
</script>

<style scoped>
.trades-page {
  padding: 20px;
  background: linear-gradient(135deg, #f5f7fa 0%, #e8f5e9 100%);
  min-height: 100vh;
  position: relative;
}

.trades-page::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: 
    linear-gradient(rgba(16, 185, 129, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(16, 185, 129, 0.03) 1px, transparent 1px);
  background-size: 20px 20px;
  pointer-events: none;
  z-index: 0;
}

.trades-page > * {
  position: relative;
  z-index: 1;
}

/* 账户概览 - 现代设计 */
.account-overview-modern {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}

.overview-card {
  background: linear-gradient(135deg, #ffffff 0%, #f9fafb 100%);
  border-radius: var(--radius-md);
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  transition: all 0.3s ease;
  border: 1px solid rgba(16, 185, 129, 0.1);
}

.overview-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.15);
}

.card-icon {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  flex-shrink: 0;
}

.card-icon .icon-text {
  color: white;
  font-weight: 700;
  font-size: 14px;
  text-shadow: 0 1px 2px rgba(0,0,0,0.2);
}

.card-icon.total-assets {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
}

.card-icon.available-funds {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
}

.card-icon.total-profit {
  background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
}

.card-icon.today-profit {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
}

.card-content {
  flex: 1;
  min-width: 0;
}

.card-label {
  font-size: 13px;
  color: #6b7280;
  margin-bottom: 6px;
  font-weight: 500;
}

.card-value {
  font-size: 22px;
  font-weight: 700;
  color: #1f2937;
  font-family: 'Consolas', monospace;
}

.profit-positive {
  color: #ef4444 !important;
}

.profit-negative {
  color: #10b981 !important;
}

/* 交易记录卡片 - 现代设计 */
.trades-card-modern {
  background: #ffffff;
  border-radius: var(--radius-md);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  border: 1px solid rgba(16, 185, 129, 0.1);
}

/* 头部工具栏 */
.trades-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #e5e7eb;
  background: linear-gradient(135deg, #f9fafb 0%, #ffffff 100%);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title-icon {
  font-size: 18px;
  color: #10b981;
}

.title {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 筛选区域 - 紧凑设计 */
.filter-section-modern {
  padding: 12px 20px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 表格容器 */
.table-container {
  padding: 0;
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
  padding: 10px 0;
}

:deep(.el-table td) {
  padding: 10px 0;
}

:deep(.el-table__row) {
  cursor: pointer;
  transition: background-color 0.2s;
}

:deep(.el-table__row:hover) {
  background-color: rgba(16, 185, 129, 0.03);
}

/* 表格单元格样式 */
.time-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.time-cell .date {
  font-size: 12px;
  color: #374151;
  font-weight: 500;
}

.time-cell .time {
  font-size: 11px;
  color: #9ca3af;
}

.symbol-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.symbol-code {
  font-size: 13px;
  font-weight: 700;
  color: #1f2937;
  font-family: 'Consolas', monospace;
}

.symbol-name {
  font-size: 11px;
  color: #6b7280;
}

.quantity-value,
.price-value,
.amount-value {
  font-family: 'Consolas', monospace;
  font-weight: 600;
  color: #1f2937;
  font-size: 12px;
}

/* 现价单元格 */
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

.strategy-name {
  font-size: 12px;
  color: #6b7280;
}

/* 盈亏单元格 */
.profit-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.profit-label {
  font-size: 10px;
  color: #9ca3af;
  font-weight: 500;
}

.profit-amount {
  font-family: 'Consolas', monospace;
  font-weight: 700;
  font-size: 13px;
}

.profit-percent {
  font-family: 'Consolas', monospace;
  font-size: 10px;
  color: #9ca3af;
  font-weight: 600;
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

/* 分页 */
.pagination-section-modern {
  padding: 16px 20px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  justify-content: flex-end;
  background: #f9fafb;
}

:deep(.el-pagination) {
  font-size: 13px;
}

/* 对话框样式 */
:deep(.el-dialog__header) {
  background: linear-gradient(135deg, #f9fafb 0%, #ffffff 100%);
  border-bottom: 1px solid #e5e7eb;
}

:deep(.el-descriptions-item__label) {
  font-weight: 600;
  color: #374151;
  background: #f9fafb;
}

:deep(.el-descriptions-item__content) {
  color: #1f2937;
}

/* 平仓对话框 */
.close-dialog-content {
  padding: 10px 0;
}

.trade-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: #374151;
}

.trade-info span {
  display: flex;
  justify-content: space-between;
}

.profit-info {
  font-weight: 700;
  font-size: 14px;
}

.quantity-hint {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 4px;
}

.estimated-profit {
  font-family: 'Consolas', monospace;
  font-weight: 700;
  font-size: 16px;
}

/* 响应式设计 */
@media (max-width: 1400px) {
  .account-overview-modern {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 768px) {
  .account-overview-modern {
    grid-template-columns: 1fr;
  }
  
  .filter-section-modern {
    flex-direction: column;
    align-items: stretch;
  }
  
  .filter-section-modern > * {
    width: 100% !important;
  }
}
</style>
