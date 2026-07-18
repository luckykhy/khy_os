<template>
  <div class="enhanced-positions-panel">
    <div class="panel-header">
      <span>💼 持仓明细</span>
      <el-button size="small" @click="loadPositions" :loading="loading">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </div>
    
    <div class="panel-content">
      <el-table 
        :data="positions" 
        size="small" 
        :max-height="400"
        v-loading="loading"
        empty-text="暂无持仓"
        :row-class-name="getRowClassName"
      >
        <el-table-column prop="symbol" label="代码" width="90" fixed="left" />
        <el-table-column prop="symbolName" label="名称" width="100" />
        <el-table-column prop="direction" label="方向" width="60" align="center">
          <template #default="{ row }">
            <el-tag :type="row.direction === 'long' ? 'danger' : 'success'" size="small">
              {{ row.direction === 'long' ? '多' : '空' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="totalQuantity" label="总量" width="80" align="right">
          <template #default="{ row }">
            {{ row.totalQuantity }} {{ row.unit || '股' }}
          </template>
        </el-table-column>
        <el-table-column prop="availableQuantity" label="可用" width="80" align="right">
          <template #default="{ row }">
            {{ row.availableQuantity }} {{ row.unit || '股' }}
          </template>
        </el-table-column>
        <el-table-column prop="avgCost" label="成本价" width="90" align="right">
          <template #default="{ row }">
            {{ row.avgCost.toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column prop="currentPrice" label="现价" width="90" align="right">
          <template #default="{ row }">
            <span :class="getPriceChangeClass(row)">
              {{ row.currentPrice.toFixed(2) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="unrealizedProfit" label="浮动盈亏" width="120" align="right">
          <template #default="{ row }">
            <div :class="row.unrealizedProfit >= 0 ? 'profit-up' : 'profit-down'">
              <div class="profit-amount">
                {{ row.unrealizedProfit >= 0 ? '+' : '' }}{{ row.unrealizedProfit.toFixed(2) }}
              </div>
              <div class="profit-percent">
                ({{ row.unrealizedProfitPercent.toFixed(2) }}%)
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button-group size="small">
              <el-button 
                type="primary"
                @click="showCloseDialog(row)"
                :loading="closingPosition === row.symbol"
              >
                平仓
              </el-button>
              <el-button 
                type="danger"
                @click="quickCloseAll(row)"
                :loading="closingPosition === row.symbol"
              >
                全平
              </el-button>
            </el-button-group>
          </template>
        </el-table-column>
      </el-table>
      
      <!-- 账户信息摘要 -->
      <div class="account-summary" v-if="accountInfo">
        <div class="summary-row">
          <div class="summary-item">
            <span class="label">总资产:</span>
            <span class="value highlight">¥{{ formatNumber(accountInfo.totalAssets) }}</span>
          </div>
          <div class="summary-item">
            <span class="label">可用资金:</span>
            <span class="value">¥{{ formatNumber(accountInfo.availableFunds) }}</span>
          </div>
        </div>
        <div class="summary-row">
          <div class="summary-item">
            <span class="label">持仓市值:</span>
            <span class="value">¥{{ formatNumber(accountInfo.positionValue) }}</span>
          </div>
          <div class="summary-item">
            <span class="label">冻结资金:</span>
            <span class="value">¥{{ formatNumber(accountInfo.frozenFunds) }}</span>
          </div>
        </div>
        <div class="summary-row total-row">
          <div class="summary-item">
            <span class="label">总盈亏:</span>
            <span class="value" :class="accountInfo.totalProfit >= 0 ? 'profit-up' : 'profit-down'">
              {{ accountInfo.totalProfit >= 0 ? '+' : '' }}¥{{ formatNumber(Math.abs(accountInfo.totalProfit)) }}
            </span>
          </div>
          <div class="summary-item">
            <span class="label">盈亏比:</span>
            <span class="value" :class="accountInfo.profitRate >= 0 ? 'profit-up' : 'profit-down'">
              {{ accountInfo.profitRate >= 0 ? '+' : '' }}{{ accountInfo.profitRate.toFixed(2) }}%
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 平仓对话框 -->
    <el-dialog
      v-model="closeDialogVisible"
      title="平仓"
      width="500px"
      :close-on-click-modal="false"
    >
      <div v-if="selectedPosition" class="close-dialog-content">
        <div class="position-info">
          <div class="info-row">
            <span class="label">合约:</span>
            <span class="value">{{ selectedPosition.symbolName }} ({{ selectedPosition.symbol }})</span>
          </div>
          <div class="info-row">
            <span class="label">方向:</span>
            <span class="value">
              <el-tag :type="selectedPosition.direction === 'long' ? 'danger' : 'success'" size="small">
                {{ selectedPosition.direction === 'long' ? '多头' : '空头' }}
              </el-tag>
            </span>
          </div>
          <div class="info-row">
            <span class="label">持仓量:</span>
            <span class="value">{{ selectedPosition.totalQuantity }} {{ selectedPosition.unit || '股' }}</span>
          </div>
          <div class="info-row">
            <span class="label">可平量:</span>
            <span class="value">{{ selectedPosition.availableQuantity }} {{ selectedPosition.unit || '股' }}</span>
          </div>
          <div class="info-row">
            <span class="label">成本价:</span>
            <span class="value">{{ selectedPosition.avgCost.toFixed(2) }}</span>
          </div>
          <div class="info-row">
            <span class="label">现价:</span>
            <span class="value">{{ selectedPosition.currentPrice.toFixed(2) }}</span>
          </div>
        </div>

        <el-divider />

        <el-form :model="closeForm" label-width="100px">
          <el-form-item label="平仓数量">
            <el-input-number
              v-model="closeForm.quantity"
              :min="getMinCloseQuantity()"
              :max="selectedPosition.availableQuantity"
              :step="getCloseQuantityStep()"
              style="width: 100%;"
            />
          </el-form-item>
          <el-form-item label="平仓价格">
            <el-radio-group v-model="closeForm.priceType" style="margin-bottom: 8px;">
              <el-radio-button label="market">市价</el-radio-button>
              <el-radio-button label="limit">限价</el-radio-button>
            </el-radio-group>
            <el-input-number
              v-if="closeForm.priceType === 'limit'"
              v-model="closeForm.price"
              :precision="2"
              :step="0.01"
              style="width: 100%; margin-top: 8px;"
            />
          </el-form-item>
          <el-form-item label="快捷选择">
            <el-button-group size="small">
              <el-button @click="setCloseQuantity(0.25)">1/4</el-button>
              <el-button @click="setCloseQuantity(0.5)">1/2</el-button>
              <el-button @click="setCloseQuantity(0.75)">3/4</el-button>
              <el-button @click="setCloseQuantity(1)">全部</el-button>
            </el-button-group>
          </el-form-item>
        </el-form>

        <div class="close-estimate">
          <div class="estimate-item">
            <span class="label">预估成交额:</span>
            <span class="value">¥{{ formatNumber(estimatedCloseAmount) }}</span>
          </div>
          <div class="estimate-item">
            <span class="label">预估盈亏:</span>
            <span class="value" :class="estimatedProfit >= 0 ? 'profit-up' : 'profit-down'">
              {{ estimatedProfit >= 0 ? '+' : '' }}¥{{ formatNumber(Math.abs(estimatedProfit)) }}
            </span>
          </div>
        </div>
      </div>

      <template #footer>
        <span class="dialog-footer">
          <el-button @click="closeDialogVisible = false">取消</el-button>
          <el-button 
            type="primary" 
            @click="confirmClose"
            :loading="closingPosition !== null"
          >
            确认平仓
          </el-button>
        </span>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import request from '@/utils/request'

const emit = defineEmits(['position-closed'])

const positions = ref([])
const accountInfo = ref(null)
const loading = ref(false)
const closingPosition = ref(null)
const closeDialogVisible = ref(false)
const selectedPosition = ref(null)

const closeForm = ref({
  quantity: 0,
  priceType: 'market',
  price: 0
})

// 加载持仓
const loadPositions = async () => {
  loading.value = true
  try {
    const response = await request.get('/trading/positions')
    if (response.success) {
      positions.value = response.data || []
      console.log('✅ 持仓加载成功:', positions.value.length, '个')
    }
  } catch (error) {
    console.error('❌ 加载持仓失败:', error)
    ElMessage.error('加载持仓失败')
  } finally {
    loading.value = false
  }
}

// 加载账户信息
const loadAccountInfo = async () => {
  try {
    const response = await request.get('/trading/account')
    if (response.success) {
      accountInfo.value = response.data
    }
  } catch (error) {
    console.error('❌ 加载账户信息失败:', error)
  }
}

// 显示平仓对话框
const showCloseDialog = (position) => {
  selectedPosition.value = position
  closeForm.value = {
    quantity: position.availableQuantity,
    priceType: 'market',
    price: position.currentPrice
  }
  closeDialogVisible.value = true
}

// 设置平仓数量
const setCloseQuantity = (ratio) => {
  if (!selectedPosition.value) return
  const quantity = Math.floor(selectedPosition.value.availableQuantity * ratio)
  closeForm.value.quantity = quantity
}

// 获取最小平仓数量
const getMinCloseQuantity = () => {
  if (!selectedPosition.value) return 1
  return selectedPosition.value.unit === '手' ? 1 : 100
}

// 获取平仓数量步进
const getCloseQuantityStep = () => {
  if (!selectedPosition.value) return 1
  return selectedPosition.value.unit === '手' ? 1 : 100
}

// 预估平仓金额
const estimatedCloseAmount = computed(() => {
  if (!selectedPosition.value) return 0
  const price = closeForm.value.priceType === 'market' 
    ? selectedPosition.value.currentPrice 
    : closeForm.value.price
  return price * closeForm.value.quantity
})

// 预估盈亏
const estimatedProfit = computed(() => {
  if (!selectedPosition.value) return 0
  const price = closeForm.value.priceType === 'market' 
    ? selectedPosition.value.currentPrice 
    : closeForm.value.price
  const direction = selectedPosition.value.direction === 'long' ? 1 : -1
  return (price - selectedPosition.value.avgCost) * closeForm.value.quantity * direction
})

// 确认平仓
const confirmClose = async () => {
  if (!selectedPosition.value) return

  if (closeForm.value.quantity <= 0) {
    ElMessage.error('请输入有效的平仓数量')
    return
  }

  if (closeForm.value.quantity > selectedPosition.value.availableQuantity) {
    ElMessage.error('平仓数量超过可用数量')
    return
  }

  closingPosition.value = selectedPosition.value.symbol

  try {
    const tradeData = {
      symbol: selectedPosition.value.symbol,
      side: selectedPosition.value.direction === 'long' ? 'sell' : 'buy',
      offset: 'close',
      quantity: closeForm.value.quantity,
      price: closeForm.value.priceType === 'market' 
        ? selectedPosition.value.currentPrice 
        : closeForm.value.price,
      orderType: closeForm.value.priceType,
      type: 'paper'
    }

    const response = await request.post('/trades', tradeData)

    if (response.success) {
      ElMessage.success(`${selectedPosition.value.symbolName} 平仓成功`)
      closeDialogVisible.value = false
      await loadPositions()
      await loadAccountInfo()
      emit('position-closed', selectedPosition.value)
    } else {
      throw new Error(response.message || '平仓失败')
    }
  } catch (error) {
    console.error('❌ 平仓失败:', error)
    ElMessage.error(`平仓失败: ${error.message}`)
  } finally {
    closingPosition.value = null
  }
}

// 快速全部平仓
const quickCloseAll = async (position) => {
  try {
    await ElMessageBox.confirm(
      `确定要全部平仓 ${position.symbolName}(${position.symbol}) 的 ${position.availableQuantity} ${position.unit || '股'}吗？`,
      '确认全部平仓',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    closingPosition.value = position.symbol

    const tradeData = {
      symbol: position.symbol,
      side: position.direction === 'long' ? 'sell' : 'buy',
      offset: 'close',
      quantity: position.availableQuantity,
      price: position.currentPrice,
      orderType: 'market',
      type: 'paper'
    }

    const response = await request.post('/trades', tradeData)

    if (response.success) {
      ElMessage.success(`${position.symbolName} 全部平仓成功`)
      await loadPositions()
      await loadAccountInfo()
      emit('position-closed', position)
    } else {
      throw new Error(response.message || '平仓失败')
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('❌ 平仓失败:', error)
      ElMessage.error(`平仓失败: ${error.message}`)
    }
  } finally {
    closingPosition.value = null
  }
}

// 获取行样式
const getRowClassName = ({ row }) => {
  return row.direction === 'long' ? 'long-position' : 'short-position'
}

// 获取价格变化样式
const getPriceChangeClass = (row) => {
  const change = row.currentPrice - row.avgCost
  if (row.direction === 'long') {
    return change > 0 ? 'price-up' : change < 0 ? 'price-down' : ''
  } else {
    return change < 0 ? 'price-up' : change > 0 ? 'price-down' : ''
  }
}

// 格式化数字
const formatNumber = (num) => {
  if (num === null || num === undefined) return '0.00'
  return parseFloat(num).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// 初始化
onMounted(() => {
  loadPositions()
  loadAccountInfo()
})

// 暴露方法供父组件调用
defineExpose({
  loadPositions,
  loadAccountInfo
})
</script>

<style scoped>
.enhanced-positions-panel {
  background: #1a1a1a;
  border-radius: 4px;
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 15px;
  background: linear-gradient(to bottom, #2a2a2a, #1a1a1a);
  border-bottom: 1px solid #333;
  font-weight: 600;
  color: #fff;
}

.panel-content {
  padding: 10px;
}

:deep(.el-table) {
  background: transparent;
  color: #ccc;
}

:deep(.el-table th) {
  background: #2a2a2a;
  color: #ccc;
  font-weight: 600;
}

:deep(.el-table tr) {
  background: transparent;
}

:deep(.el-table td) {
  border-bottom: 1px solid #333;
}

:deep(.el-table__empty-text) {
  color: #666;
}

:deep(.long-position) {
  background: rgba(255, 68, 68, 0.05);
}

:deep(.short-position) {
  background: rgba(0, 170, 0, 0.05);
}

.price-up {
  color: #ff4444;
  font-weight: 600;
}

.price-down {
  color: #00aa00;
  font-weight: 600;
}

.profit-up {
  color: #ff4444;
  font-weight: 600;
}

.profit-down {
  color: #00aa00;
  font-weight: 600;
}

.profit-amount {
  font-size: 14px;
}

.profit-percent {
  font-size: 12px;
  opacity: 0.8;
}

.account-summary {
  margin-top: 15px;
  padding: 12px;
  background: #2a2a2a;
  border-radius: 4px;
}

.summary-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}

.summary-row.total-row {
  border-top: 1px solid #444;
  padding-top: 12px;
  margin-top: 12px;
}

.summary-item {
  display: flex;
  gap: 8px;
  font-size: 13px;
}

.summary-item .label {
  color: #888;
}

.summary-item .value {
  color: #fff;
  font-weight: 600;
}

.summary-item .value.highlight {
  color: #ffa500;
  font-size: 15px;
}

.close-dialog-content {
  color: #ccc;
}

.position-info {
  background: #2a2a2a;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 16px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 14px;
}

.info-row .label {
  color: #888;
}

.info-row .value {
  color: #fff;
  font-weight: 500;
}

.close-estimate {
  background: #1f1f1f;
  border-radius: 6px;
  padding: 12px;
  margin-top: 16px;
}

.estimate-item {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 14px;
}

.estimate-item .label {
  color: #888;
}

.estimate-item .value {
  color: #fff;
  font-weight: 600;
  font-size: 15px;
}

:deep(.el-button--small) {
  padding: 4px 8px;
  font-size: 12px;
}

:deep(.el-dialog) {
  background: #1a1a1a;
}

:deep(.el-dialog__header) {
  background: #2a2a2a;
  border-bottom: 1px solid #333;
}

:deep(.el-dialog__title) {
  color: #fff;
}

:deep(.el-dialog__body) {
  background: #1a1a1a;
}

:deep(.el-form-item__label) {
  color: #ccc;
}

:deep(.el-input-number .el-input__inner) {
  background: #2a2a2a;
  border-color: #444;
  color: #fff;
}
</style>
