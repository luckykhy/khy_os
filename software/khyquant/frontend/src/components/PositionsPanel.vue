<template>
  <div class="positions-panel">
    <div class="panel-header">
      <span>💼 持仓</span>
      <el-button size="small" @click="loadPositions" :loading="loading">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </div>
    
    <div class="panel-content">
      <el-table 
        :data="positions" 
        size="small" 
        :max-height="300"
        v-loading="loading"
        empty-text="暂无持仓"
      >
        <el-table-column prop="symbol" label="代码" width="80" />
        <el-table-column prop="symbolName" label="名称" width="100" />
        <el-table-column prop="totalQuantity" label="数量" width="70" align="right" />
        <el-table-column prop="avgCost" label="成本" width="70" align="right">
          <template #default="{ row }">
            {{ row.avgCost.toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column prop="currentPrice" label="现价" width="70" align="right">
          <template #default="{ row }">
            {{ row.currentPrice.toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column prop="unrealizedProfit" label="盈亏" width="100" align="right">
          <template #default="{ row }">
            <span :class="row.unrealizedProfit >= 0 ? 'profit-up' : 'profit-down'">
              {{ row.unrealizedProfit >= 0 ? '+' : '' }}{{ row.unrealizedProfit.toFixed(2) }}
              <br />
              ({{ row.unrealizedProfitPercent.toFixed(2) }}%)
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="70" fixed="right">
          <template #default="{ row }">
            <el-button 
              size="small" 
              type="danger" 
              @click="quickClose(row)"
              :loading="closingPosition === row.symbol"
            >
              平仓
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      
      <!-- 账户信息摘要 -->
      <div class="account-summary" v-if="accountInfo">
        <div class="summary-item">
          <span class="label">可用资金:</span>
          <span class="value">¥{{ formatNumber(accountInfo.availableFunds) }}</span>
        </div>
        <div class="summary-item">
          <span class="label">持仓市值:</span>
          <span class="value">¥{{ formatNumber(accountInfo.positionValue) }}</span>
        </div>
        <div class="summary-item">
          <span class="label">总盈亏:</span>
          <span class="value" :class="accountInfo.totalProfit >= 0 ? 'profit-up' : 'profit-down'">
            {{ accountInfo.totalProfit >= 0 ? '+' : '' }}¥{{ formatNumber(accountInfo.totalProfit) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import request from '@/utils/request'

const emit = defineEmits(['position-closed'])

const positions = ref([])
const accountInfo = ref(null)
const loading = ref(false)
const closingPosition = ref(null)

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

// 快速平仓
const quickClose = async (position) => {
  try {
    await ElMessageBox.confirm(
      `确定要平仓 ${position.symbolName}(${position.symbol}) 全部 ${position.totalQuantity} 股吗？`,
      '确认平仓',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    closingPosition.value = position.symbol
    
    // 提交卖出订单
    const tradeData = {
      symbol: position.symbol,
      side: 'sell',
      quantity: position.totalQuantity,
      price: position.currentPrice,
      type: 'paper'
    }
    
    const response = await request.post('/trades', tradeData)
    
    // 🔥 修复：request拦截器已经返回了response.data，所以response就是数据本身
    if (response.success) {
      ElMessage.success(`${position.symbolName} 平仓成功`)
      await loadPositions() // 刷新持仓
      await loadAccountInfo() // 刷新账户信息
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

// 格式化数字
const formatNumber = (num) => {
  if (num === null || num === undefined) return '0.00'
  return parseFloat(num).toFixed(2)
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
.positions-panel {
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

.profit-up {
  color: #ff4444;
  font-weight: 600;
}

.profit-down {
  color: #00aa00;
  font-weight: 600;
}

.account-summary {
  margin-top: 15px;
  padding: 12px;
  background: #2a2a2a;
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.summary-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.summary-item .label {
  color: #888;
}

.summary-item .value {
  color: #fff;
  font-weight: 600;
}

:deep(.el-button--small) {
  padding: 4px 8px;
  font-size: 12px;
}
</style>
