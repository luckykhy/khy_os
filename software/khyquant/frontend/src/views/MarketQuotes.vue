<template>
  <div class="market-quotes-page">
    <div class="page-header">
      <h1 class="page-title">
        <el-icon><Histogram /></el-icon>
        市场行情
      </h1>
      <div class="header-actions">
        <el-button @click="loadMarketQuotes" :loading="loading">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
      </div>
    </div>

    <el-card class="quotes-card" v-loading="loading">
      <template #header>
        <div class="card-header">
          <span>实时行情</span>
          <el-tag type="success">{{ marketQuotes.length }} 个标的</el-tag>
        </div>
      </template>

      <div v-if="marketQuotes.length === 0" class="empty-state">
        <div class="empty-state-custom">
          <img src="/empty-state.jpg" alt="暂无数据" class="empty-image" />
          <p class="empty-text">暂无行情数据</p>
          <el-button type="primary" @click="loadMarketQuotes">
            加载行情
          </el-button>
        </div>
      </div>

      <div v-else class="quotes-grid">
        <div 
          v-for="quote in marketQuotes" 
          :key="quote.symbol" 
          class="quote-card"
          @click="viewQuoteDetail(quote)"
        >
          <div class="quote-header">
            <div class="quote-info">
              <span class="quote-name">{{ quote.name }}</span>
              <span class="quote-symbol">{{ quote.symbol }}</span>
            </div>
            <el-tag size="small" :type="quote.type === 'index' ? 'warning' : 'info'">
              {{ quote.category }}
            </el-tag>
          </div>
          
          <div class="quote-price">
            <span class="price-value" :class="getChangeClass(quote.change)">
              {{ quote.price.toFixed(2) }}
            </span>
          </div>
          
          <div class="quote-change">
            <span class="change-value" :class="getChangeClass(quote.change)">
              <el-icon v-if="quote.change > 0"><CaretTop /></el-icon>
              <el-icon v-else-if="quote.change < 0"><CaretBottom /></el-icon>
              {{ quote.change > 0 ? '+' : '' }}{{ quote.change.toFixed(2) }}
            </span>
            <span class="change-percent" :class="getChangeClass(quote.change)">
              {{ quote.changePercent > 0 ? '+' : '' }}{{ quote.changePercent.toFixed(2) }}%
            </span>
          </div>
          
          <div class="quote-footer">
            <span class="quote-source">{{ quote.source }}</span>
            <span class="quote-time">{{ quote.time }}</span>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getMarketQuotes } from '@/api/marketData'
import { Histogram, Refresh, CaretTop, CaretBottom } from '@element-plus/icons-vue'

const router = useRouter()
const marketQuotes = ref([])
const loading = ref(false)
let refreshTimer = null

// 加载市场行情
const loadMarketQuotes = async () => {
  try {
    loading.value = true
    const response = await getMarketQuotes(20)
    
    if (response.data.success) {
      marketQuotes.value = response.data.data.quotes
    }
  } catch (error) {
    console.error('加载市场行情失败:', error)
    ElMessage.error('加载行情失败')
  } finally {
    loading.value = false
  }
}

// 查看标的详情
const viewQuoteDetail = (quote) => {
  router.push(`/trading?symbol=${quote.symbol}`)
}

// 获取涨跌颜色类
const getChangeClass = (change) => {
  if (change > 0) return 'price-up'
  if (change < 0) return 'price-down'
  return 'price-neutral'
}

// 启动定时刷新
const startAutoRefresh = () => {
  refreshTimer = setInterval(() => {
    loadMarketQuotes()
  }, 30000) // 30秒刷新一次
}

// 停止定时刷新
const stopAutoRefresh = () => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

onMounted(() => {
  loadMarketQuotes()
  startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
})
</script>

<style scoped>
.market-quotes-page {
  padding: 0;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-lg);
  padding: var(--spacing-lg);
  background: white;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.page-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.header-actions {
  display: flex;
  gap: var(--spacing-sm);
}

.quotes-card {
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 16px;
  font-weight: 600;
}

.quotes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--spacing-md);
}

.quote-card {
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
  cursor: pointer;
  transition: all var(--transition-base);
  border: 1px solid var(--border-light);
}

.quote-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
  border-color: var(--primary-color);
}

.quote-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--spacing-sm);
}

.quote-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.quote-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.quote-symbol {
  font-size: 12px;
  color: var(--text-tertiary);
}

.quote-price {
  margin: var(--spacing-sm) 0;
}

.price-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
}

.price-up {
  color: #f56c6c;
}

.price-down {
  color: #67c23a;
}

.price-neutral {
  color: var(--text-primary);
}

.quote-change {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
}

.change-value,
.change-percent {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 2px;
}

.quote-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: var(--spacing-sm);
  border-top: 1px solid var(--border-light);
  margin-top: var(--spacing-sm);
}

.quote-source,
.quote-time {
  font-size: 11px;
  color: var(--text-tertiary);
}

.quote-source {
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
}

.empty-state {
  padding: var(--spacing-2xl) 0;
  text-align: center;
}

@media (max-width: 768px) {
  .quotes-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 480px) {
  .quotes-grid {
    grid-template-columns: 1fr;
  }
}
</style>
