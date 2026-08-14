<template>
  <div class="recent-trades-panel">
    <div class="panel-header">
      <span>📝 最近交易</span>
      <div class="header-actions">
        <el-button size="small" @click="loadTrades" :loading="loading">
          <el-icon><Refresh /></el-icon>
        </el-button>
        <el-button size="small" type="primary" @click="goToTradesPage">
          查看全部
        </el-button>
      </div>
    </div>
    
    <div class="panel-content">
      <el-table 
        :data="trades" 
        size="small" 
        :max-height="250"
        v-loading="loading"
        empty-text="暂无交易记录"
      >
        <el-table-column prop="symbol" label="代码" width="80" />
        <el-table-column prop="side" label="方向" width="60">
          <template #default="{ row }">
            <el-tag :type="row.side === 'buy' ? 'success' : 'danger'" size="small">
              {{ row.side === 'buy' ? '买' : '卖' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="quantity" label="数量" width="70" align="right" />
        <el-table-column prop="price" label="价格" width="70" align="right">
          <template #default="{ row }">
            {{ row.price.toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column prop="amount" label="金额" width="90" align="right">
          <template #default="{ row }">
            {{ row.amount.toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="时间" width="140">
          <template #default="{ row }">
            {{ formatDateTime(row.createdAt) }}
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import request from '@/utils/request'

const router = useRouter()

const trades = ref([])
const loading = ref(false)

// 加载最近交易
const loadTrades = async () => {
  loading.value = true
  try {
    const response = await request.get('/trades', {
      params: {
        page: 1,
        pageSize: 10
      }
    })
    
    if (response.success) {
      trades.value = response.data.trades || response.data.list || []
      console.log('✅ 最近交易加载成功:', trades.value.length, '条')
    }
  } catch (error) {
    console.error('❌ 加载交易记录失败:', error)
    ElMessage.error('加载交易记录失败')
  } finally {
    loading.value = false
  }
}

// 跳转到交易记录页面
const goToTradesPage = () => {
  router.push('/trades')
}

// 格式化日期时间
const formatDateTime = (dateStr) => {
  if (!dateStr) return '-'
  try {
    const date = new Date(dateStr)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${month}-${day} ${hour}:${minute}`
  } catch (error) {
    return dateStr
  }
}

// 初始化
onMounted(() => {
  loadTrades()
})

// 暴露方法供父组件调用
defineExpose({
  loadTrades
})
</script>

<style scoped>
.recent-trades-panel {
  background: 
    linear-gradient(to bottom, #0f1419, #0a0e13),
    repeating-linear-gradient(
      90deg,
      transparent,
      transparent 2px,
      rgba(16, 185, 129, 0.03) 2px,
      rgba(16, 185, 129, 0.03) 4px
    );
  border-radius: 8px;
  overflow: hidden;
  margin-top: 15px;
  border: 1px solid rgba(16, 185, 129, 0.2);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.1);
  position: relative;
}

.recent-trades-panel::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: 
    /* 数据流动线条 */
    linear-gradient(90deg, transparent 0%, rgba(16, 185, 129, 0.05) 50%, transparent 100%),
    /* K线图案 */
    linear-gradient(to top, transparent 70%, rgba(16, 185, 129, 0.08) 73%, rgba(16, 185, 129, 0.08) 77%, transparent 80%),
    linear-gradient(to top, transparent 50%, rgba(239, 68, 68, 0.08) 53%, rgba(239, 68, 68, 0.08) 57%, transparent 60%),
    /* 数据点 */
    radial-gradient(circle at 15% 25%, rgba(16, 185, 129, 0.1) 1px, transparent 1px),
    radial-gradient(circle at 45% 45%, rgba(59, 130, 246, 0.1) 1px, transparent 1px),
    radial-gradient(circle at 75% 35%, rgba(16, 185, 129, 0.1) 1px, transparent 1px);
  background-size: 
    200% 100%,
    15px 100%,
    15px 100%,
    100% 100%,
    100% 100%,
    100% 100%;
  background-position: 
    0 0,
    10% 0,
    30% 0,
    0 0,
    0 0,
    0 0;
  opacity: 0.4;
  pointer-events: none;
  animation: dataFlow 20s linear infinite;
}

@keyframes dataFlow {
  0% {
    background-position: 0 0, 10% 0, 30% 0, 0 0, 0 0, 0 0;
  }
  100% {
    background-position: 200% 0, 10% 0, 30% 0, 0 0, 0 0, 0 0;
  }
}

.recent-trades-panel::after {
  content: '💱';
  position: absolute;
  right: 15px;
  bottom: 15px;
  font-size: 80px;
  opacity: 0.03;
  pointer-events: none;
  z-index: 0;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  background: 
    linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(5, 150, 105, 0.15)),
    linear-gradient(to bottom, rgba(42, 42, 42, 0.8), rgba(26, 26, 26, 0.8));
  border-bottom: 2px solid rgba(16, 185, 129, 0.3);
  font-weight: 600;
  color: #10b981;
  font-size: 14px;
  position: relative;
  z-index: 1;
  backdrop-filter: blur(10px);
  text-shadow: 0 0 10px rgba(16, 185, 129, 0.3);
}

.panel-header::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, #10b981, transparent);
  opacity: 0.5;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.panel-content {
  padding: 12px;
  position: relative;
  z-index: 1;
}

:deep(.el-table) {
  background: transparent;
  color: #e5e7eb;
  border-radius: 6px;
  overflow: hidden;
}

:deep(.el-table th) {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
  font-weight: 600;
  border-bottom: 2px solid rgba(16, 185, 129, 0.3);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

:deep(.el-table tr) {
  background: transparent;
  transition: all 0.3s ease;
}

:deep(.el-table tr:hover) {
  background: rgba(16, 185, 129, 0.05);
  transform: translateX(2px);
}

:deep(.el-table td) {
  border-bottom: 1px solid rgba(16, 185, 129, 0.1);
  font-size: 13px;
  padding: 10px 0;
}

:deep(.el-table__empty-text) {
  color: #6b7280;
}

:deep(.el-button--small) {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 4px;
  transition: all 0.3s ease;
}

:deep(.el-button--primary) {
  background: linear-gradient(135deg, #10b981, #059669);
  border: none;
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
}

:deep(.el-button--primary:hover) {
  background: linear-gradient(135deg, #059669, #047857);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
  transform: translateY(-1px);
}

:deep(.el-tag) {
  border-radius: 4px;
  font-weight: 600;
  font-size: 11px;
  padding: 2px 8px;
}

:deep(.el-tag--success) {
  background: rgba(16, 185, 129, 0.2);
  border-color: rgba(16, 185, 129, 0.4);
  color: #10b981;
}

:deep(.el-tag--danger) {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.4);
  color: #ef4444;
}

/* 数字列样式 */
:deep(.el-table__body td:nth-child(3)),
:deep(.el-table__body td:nth-child(4)),
:deep(.el-table__body td:nth-child(5)) {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-weight: 500;
}

/* 加载动画 */
:deep(.el-loading-mask) {
  background: rgba(10, 14, 19, 0.8);
  backdrop-filter: blur(4px);
}

:deep(.el-loading-spinner .circular) {
  stroke: #10b981;
}
</style>
