<template>
  <div class="collapsible-position-bar">
    <!-- 调试信息 - 移动端显示 -->
    <div v-if="true" class="debug-info">
      状态: {{ isExpanded ? '展开' : '收起' }} | 持仓: {{ positions.length }}
    </div>
    
    <!-- 右侧触发按钮 -->
    <button
      class="position-trigger-btn"
      :class="{ 'active': isExpanded }"
      @click="togglePanel"
      @touchstart.prevent="togglePanel"
    >
      <span class="vertical-text">{{ activeTab === 'pending' ? '委托' : '持仓' }}</span>
      <span v-if="pendingOrders.length > 0" class="pending-badge">{{ pendingOrders.length }}</span>
    </button>

    <!-- 底部持仓面板 -->
    <transition name="slide-up">
      <div v-if="isExpanded" class="position-panel">
        <!-- 可滚动内容区域 -->
        <div class="panel-scroll-content">
          <div class="panel-content">
            <!-- Tab switcher -->
            <div class="panel-tabs">
              <button class="tab-btn" :class="{ active: activeTab === 'positions' }" @click="activeTab = 'positions'">
                持仓 ({{ positions.length }})
              </button>
              <button class="tab-btn" :class="{ active: activeTab === 'pending' }" @click="activeTab = 'pending'">
                委托 ({{ pendingOrders.length }})
              </button>
            </div>

            <!-- Positions tab -->
            <template v-if="activeTab === 'positions'">
            <!-- 左侧：账户全景卡片 -->
            <div class="account-summary-card">
              <div class="summary-header">账户概览</div>
            
              <!-- 总浮动盈亏 -->
              <div class="total-profit">
                <div class="profit-label">浮动盈亏</div>
                <div class="profit-value" :class="totalProfitClass">
                  <span class="arrow">{{ totalProfit >= 0 ? '▲' : '▼' }}</span>
                  <span class="amount">{{ formatMoney(Math.abs(totalProfit)) }}</span>
                </div>
                <div class="profit-percent" :class="totalProfitClass">
                  {{ totalProfitPercent >= 0 ? '+' : '' }}{{ totalProfitPercent.toFixed(2) }}%
                </div>
              </div>

              <!-- 可用资金 -->
              <div class="available-funds">
                <span class="label">可用资金</span>
                <span class="value">¥{{ formatMoney(availableFunds) }}</span>
              </div>

              <!-- 风险率（仅期货） -->
              <div v-if="hasFuturesPosition" class="risk-rate">
                <span class="label">风险率</span>
                <span class="value" :class="riskRateClass">{{ riskRate.toFixed(2) }}%</span>
              </div>
            </div>

            <!-- 右侧：持仓卡片流 -->
            <div class="positions-scroll-container">
              <div class="positions-cards">
                <div 
                  v-for="position in positions" 
                  :key="position.id"
                  class="position-card"
                  :class="{ 'selected': selectedPositionId === position.id, 'highlight': position.isUpdating }"
                  @click="selectPosition(position)"
                >
                  <!-- 平仓按钮（悬停显示） -->
                  <button class="close-btn" @click.stop="closePosition(position)">
                    平仓
                  </button>

                  <!-- 第一行：品种信息 -->
                  <div class="card-row row-1">
                    <div class="symbol-info">
                      <span class="symbol-code">{{ position.symbol }}</span>
                      <span class="symbol-name">{{ position.name }}</span>
                    </div>
                    <div class="direction-tag" :class="getDirectionClass(position)">
                      {{ getDirectionText(position) }}
                    </div>
                  </div>

                  <!-- 第二行：持仓成本 -->
                  <div class="card-row row-2">
                    <div class="cost-info">
                      <span class="label">均价</span>
                      <span class="value">{{ position.avgPrice.toFixed(2) }}</span>
                    </div>
                    <div class="quantity-info">
                      <span class="label">数量</span>
                      <span class="value">{{ position.quantity }}{{ position.isFutures ? '手' : '股' }}</span>
                    </div>
                  </div>

                  <!-- 第三行：实时盈亏 -->
                  <div class="card-row row-3">
                    <div class="profit-info" :class="getProfitClass(position)">
                      <div class="profit-amount">
                        {{ position.profit >= 0 ? '+' : '' }}{{ formatMoney(Math.abs(position.profit)) }}
                      </div>
                      <div class="profit-percent">
                        {{ position.profitPercent >= 0 ? '+' : '' }}{{ position.profitPercent.toFixed(2) }}%
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 无持仓提示 -->
                <div v-if="positions.length === 0" class="empty-positions">
                  <span>暂无持仓</span>
                </div>
              </div>
            </div>
            </template>

            <!-- Pending orders tab -->
            <template v-if="activeTab === 'pending'">
            <div class="pending-orders-container">
              <div class="pending-orders-cards">
                <div
                  v-for="order in pendingOrders"
                  :key="order.id"
                  class="pending-order-card"
                >
                  <button class="cancel-btn" @click.stop="cancelPendingOrder(order)">
                    撤单
                  </button>
                  <div class="card-row row-1">
                    <div class="symbol-info">
                      <span class="symbol-code">{{ order.symbol }}</span>
                    </div>
                    <div class="order-type-tag" :class="order.side === 'buy' ? 'tag-buy' : 'tag-sell'">
                      {{ order.side === 'buy' ? '买入' : '卖出' }}
                    </div>
                  </div>
                  <div class="card-row row-2">
                    <div class="cost-info">
                      <span class="label">委托价</span>
                      <span class="value">{{ Number(order.price).toFixed(2) }}</span>
                    </div>
                    <div class="quantity-info">
                      <span class="label">数量</span>
                      <span class="value">{{ order.quantity }}股</span>
                    </div>
                  </div>
                  <div class="card-row row-3">
                    <div class="order-time">
                      {{ formatOrderTime(order.createdAt) }}
                    </div>
                    <div class="order-status pending-status">待成交</div>
                  </div>
                </div>

                <div v-if="pendingOrders.length === 0" class="empty-positions">
                  <span>暂无委托单</span>
                </div>
              </div>
            </div>
            </template>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'

// Props
const props = defineProps({
  positions: {
    type: Array,
    default: () => []
  },
  availableFunds: {
    type: Number,
    default: 100000
  },
  currentPrices: {
    type: Object,
    default: () => ({})
  }
})

// Emits
const emit = defineEmits(['select-position', 'close-position'])

// 响应式数据
const isExpanded = ref(false)
const selectedPositionId = ref(null)
const activeTab = ref('positions')
const pendingOrders = ref([])
let pendingPollTimer = null

// 切换面板展开/收起
const togglePanel = (event) => {
  console.log('🔥🔥🔥 togglePanel 被调用 🔥🔥🔥')
  console.log('🔥 事件类型:', event?.type)
  console.log('🔥 事件目标:', event?.target)
  console.log('🔥 当前状态 isExpanded:', isExpanded.value)
  console.log('🔥 持仓数量:', props.positions.length)
  console.log('🔥 DOM 元素存在:', document.querySelector('.position-panel') ? '是' : '否')
  
  // 阻止事件冒泡和默认行为
  if (event) {
    event.preventDefault()
    event.stopPropagation()
  }
  
  isExpanded.value = !isExpanded.value
  
  console.log('🔥 切换后状态 isExpanded:', isExpanded.value)
  console.log('🔥🔥🔥 togglePanel 执行完毕 🔥🔥🔥')
  
  // 移动端触觉反馈
  if (window.navigator && window.navigator.vibrate) {
    window.navigator.vibrate(20)
  }
  
  // 视觉反馈 - 临时改变按钮颜色
  const btn = event?.currentTarget || event?.target
  if (btn) {
    btn.style.transform = 'translateY(-50%) scale(0.95)'
    setTimeout(() => {
      btn.style.transform = 'translateY(-50%) scale(1)'
    }, 100)
  }
}

// 计算总浮动盈亏
const totalProfit = computed(() => {
  return props.positions.reduce((sum, pos) => sum + pos.profit, 0)
})

// 计算总盈亏百分比
const totalProfitPercent = computed(() => {
  const totalCost = props.positions.reduce((sum, pos) => sum + (pos.avgPrice * pos.quantity), 0)
  if (totalCost === 0) return 0
  return (totalProfit.value / totalCost) * 100
})

// 总盈亏样式类
const totalProfitClass = computed(() => {
  return totalProfit.value >= 0 ? 'profit-positive' : 'profit-negative'
})

// 是否有期货持仓
const hasFuturesPosition = computed(() => {
  return props.positions.some(pos => pos.isFutures)
})

// 风险率（简化计算）
const riskRate = computed(() => {
  if (!hasFuturesPosition.value) return 0
  const totalMargin = props.positions
    .filter(pos => pos.isFutures)
    .reduce((sum, pos) => sum + (pos.avgPrice * pos.quantity * 0.15), 0)
  if (totalMargin === 0) return 0
  return (totalMargin / props.availableFunds) * 100
})

// 风险率样式类
const riskRateClass = computed(() => {
  if (riskRate.value > 80) return 'risk-high'
  if (riskRate.value > 50) return 'risk-medium'
  return 'risk-low'
})

// 选择持仓
const selectPosition = (position) => {
  selectedPositionId.value = position.id
  emit('select-position', position)
}

// 平仓操作
const closePosition = async (position) => {
  try {
    await ElMessageBox.confirm(
      `确定要平仓 ${position.symbol} ${position.name} 吗？`,
      '平仓确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    emit('close-position', position)
  } catch {
    // 用户取消
  }
}

// 获取方向文本
const getDirectionText = (position) => {
  if (position.isFutures) {
    return position.direction === 'long' ? '多' : '空'
  }
  return '持有'
}

// 获取方向样式类
const getDirectionClass = (position) => {
  if (position.isFutures) {
    return position.direction === 'long' ? 'direction-long' : 'direction-short'
  }
  return 'direction-hold'
}

// 获取盈亏样式类
const getProfitClass = (position) => {
  return position.profit >= 0 ? 'profit-positive' : 'profit-negative'
}

// 格式化金额
const formatMoney = (amount) => {
  return amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Load pending orders from backend
const loadPendingOrders = async () => {
  try {
    const res = await request.get('/trading/pending')
    if (res && res.data) {
      pendingOrders.value = res.data
    } else if (Array.isArray(res)) {
      pendingOrders.value = res
    }
  } catch {
    // silent - pending orders are optional
  }
}

// Cancel a pending order
const cancelPendingOrder = async (order) => {
  try {
    await ElMessageBox.confirm(
      `Cancel pending ${order.side === 'buy' ? 'buy' : 'sell'} order for ${order.symbol}?`,
      'Cancel Order',
      { confirmButtonText: 'Confirm', cancelButtonText: 'Back', type: 'warning' }
    )
    await request.post(`/trading/cancel/${order.id}`)
    ElMessage.success('Order cancelled')
    loadPendingOrders()
  } catch {
    // user cancelled dialog
  }
}

// Format order time
const formatOrderTime = (dateStr) => {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

// Poll pending orders when expanded on pending tab
watch([() => isExpanded.value, () => activeTab.value], ([expanded, tab]) => {
  if (expanded && tab === 'pending') {
    loadPendingOrders()
    pendingPollTimer = setInterval(loadPendingOrders, 5000)
  } else {
    if (pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null }
  }
})

// Also load on first expand
watch(() => isExpanded.value, (val) => {
  if (val) loadPendingOrders()
}, { once: true })

onMounted(() => {
  loadPendingOrders()
})

onUnmounted(() => {
  if (pendingPollTimer) clearInterval(pendingPollTimer)
})

// 监听持仓数据变化，添加高亮动画
watch(() => props.positions, (newPositions, oldPositions) => {
  if (!oldPositions) return
  
  newPositions.forEach((newPos, index) => {
    const oldPos = oldPositions[index]
    if (oldPos && newPos.profit !== oldPos.profit) {
      // 触发高亮动画
      newPos.isUpdating = true
      setTimeout(() => {
        newPos.isUpdating = false
      }, 500)
    }
  })
}, { deep: true })
</script>

<style scoped>
.collapsible-position-bar {
  position: relative;
}

/* 调试信息 */
.debug-info {
  position: fixed;
  top: 10px;
  right: 10px;
  background: rgba(239, 68, 68, 0.9);
  color: white;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 12px;
  z-index: 999999;
  pointer-events: none;
  font-family: monospace;
}

@media (min-width: 769px) {
  .debug-info {
    display: none; /* PC端隐藏 */
  }
}

/* 右侧触发按钮 */
.position-trigger-btn {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 80px;
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  border: none;
  border-radius: 4px 0 0 4px;
  cursor: pointer;
  z-index: 99999; /* 大幅提高 z-index */
  box-shadow: -2px 0 8px rgba(239, 68, 68, 0.3);
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent; /* 移除移动端点击高亮 */
  touch-action: manipulation; /* 优化触摸响应 */
  user-select: none; /* 防止文本选择 */
  -webkit-user-select: none;
}

.position-trigger-btn:hover {
  width: 24px;
  box-shadow: -4px 0 12px rgba(239, 68, 68, 0.5);
}

.position-trigger-btn.active {
  background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
}

.vertical-text {
  writing-mode: vertical-rl;
  color: white;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 2px;
}

/* 底部持仓面板 */
.position-panel {
  position: fixed !important;
  bottom: 0 !important;
  left: 0 !important;
  right: 0 !important; /* 移动端全宽 */
  height: 200px !important; /* 增加高度 */
  background: rgba(255, 255, 255, 0.98) !important;
  backdrop-filter: blur(10px);
  border-top: 2px solid #ef4444 !important; /* 红色边框，方便调试 */
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.3) !important;
  z-index: 999999 !important; /* 超高z-index */
  pointer-events: auto !important;
  display: flex !important;
  flex-direction: column;
  -webkit-transform: translateZ(0);
  transform: translateZ(0);
}

/* 移动端适配 */
@media (max-width: 768px) {
  .position-panel {
    right: 0 !important;
    height: 250px !important; /* 增加高度 */
    border-top: 3px solid #ef4444 !important; /* 加粗边框便于调试 */
  }
  
  .position-trigger-btn {
    width: 50px !important; /* 移动端加宽触发按钮 */
    height: 100px !important;
    font-size: 16px !important;
    right: 0 !important;
    border-radius: 8px 0 0 8px !important;
    box-shadow: -4px 0 12px rgba(239, 68, 68, 0.5) !important;
  }
  
  .vertical-text {
    font-size: 20px !important;
    font-weight: 700 !important;
    letter-spacing: 4px !important;
  }
  
  /* 移动端账户卡片调整 */
  .account-summary-card {
    width: 200px !important;
  }
  
  /* 移动端持仓卡片调整 */
  .position-card {
    width: 200px !important;
  }
}

/* 可滚动内容区域 */
.panel-scroll-content {
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 10px;
}

.panel-scroll-content::-webkit-scrollbar {
  height: 6px;
}

.panel-scroll-content::-webkit-scrollbar-track {
  background: #f3f4f6;
  border-radius: 3px;
}

.panel-scroll-content::-webkit-scrollbar-thumb {
  background: #d1d5db;
  border-radius: 3px;
}

.panel-scroll-content::-webkit-scrollbar-thumb:hover {
  background: #9ca3af;
}

.panel-content {
  display: flex;
  height: 100%;
  gap: 12px;
  min-width: min-content;
}

/* 左侧账户全景卡片 */
.account-summary-card {
  width: 240px;
  flex-shrink: 0;
  background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%);
  border-radius: 8px;
  padding: 12px 14px;
  border: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.summary-header {
  font-size: 13px;
  font-weight: 600;
  color: #6b7280;
  margin-bottom: 4px;
}

.total-profit {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.profit-label {
  font-size: 12px;
  color: #9ca3af;
  margin-bottom: 5px;
}

.profit-value {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 28px;
  font-weight: 700;
  font-family: 'Consolas', monospace;
}

.profit-value .arrow {
  font-size: 18px;
}

.profit-percent {
  font-size: 14px;
  font-weight: 600;
  margin-top: 3px;
}

.profit-positive {
  color: #ef4444;
}

.profit-negative {
  color: #10b981;
}

.available-funds,
.risk-rate {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  padding: 5px 0;
  border-top: 1px solid #e5e7eb;
}

.available-funds .label,
.risk-rate .label {
  color: #6b7280;
}

.available-funds .value {
  color: #374151;
  font-weight: 600;
  font-family: 'Consolas', monospace;
}

.risk-rate .value {
  font-weight: 600;
  font-family: 'Consolas', monospace;
}

.risk-low {
  color: #10b981;
}

.risk-medium {
  color: #f59e0b;
}

.risk-high {
  color: #ef4444;
}

/* 右侧持仓卡片流 */
.positions-scroll-container {
  flex: 1;
  overflow: visible;
  min-width: 0;
}

.positions-cards {
  display: flex;
  gap: 10px;
  height: 100%;
  padding: 2px;
}

/* 持仓卡片 */
.position-card {
  width: 220px;
  flex-shrink: 0;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 10px 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.position-card:hover {
  border-color: #3b82f6;
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.2);
  transform: translateY(-1px);
}

.position-card.selected {
  border-color: #3b82f6;
  background: rgba(59, 130, 246, 0.05);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.position-card.highlight {
  animation: highlight-pulse 0.5s ease;
}

@keyframes highlight-pulse {
  0%, 100% {
    background: white;
  }
  50% {
    background: rgba(251, 191, 36, 0.2);
  }
}

/* 平仓按钮 */
.close-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  padding: 2px 6px;
  font-size: 10px;
  background: #ef4444;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.position-card:hover .close-btn {
  opacity: 1;
}

.close-btn:hover {
  background: #dc2626;
}

/* 卡片行 */
.card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* 第一行：品种信息 */
.row-1 {
  margin-bottom: 2px;
}

.symbol-info {
  display: flex;
  align-items: center;
  gap: 4px;
}

.symbol-code {
  font-size: 14px;
  font-weight: 700;
  color: #1f2937;
  font-family: 'Consolas', monospace;
}

.symbol-name {
  font-size: 12px;
  color: #6b7280;
}

.direction-tag {
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 4px;
}

.direction-long {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.direction-short {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.direction-hold {
  background: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

/* 第二行：持仓成本 */
.row-2 {
  padding: 4px 0;
  border-top: 1px solid #f3f4f6;
  border-bottom: 1px solid #f3f4f6;
}

.cost-info,
.quantity-info {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}

.cost-info .label,
.quantity-info .label {
  color: #9ca3af;
}

.cost-info .value,
.quantity-info .value {
  color: #374151;
  font-weight: 600;
  font-family: 'Consolas', monospace;
}

/* 第三行：实时盈亏 */
.row-3 {
  margin-top: 2px;
}

.profit-info {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.profit-amount {
  font-size: 16px;
  font-weight: 700;
  font-family: 'Consolas', monospace;
}

.profit-percent {
  font-size: 13px;
  font-weight: 600;
  font-family: 'Consolas', monospace;
}

/* 无持仓提示 */
.empty-positions {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: #9ca3af;
  font-size: 14px;
}

/* Panel tabs */
.panel-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
  padding-right: 8px;
  border-right: 1px solid #e5e7eb;
  margin-right: 4px;
}

.tab-btn {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  cursor: pointer;
  background: #f9fafb;
  color: #6b7280;
  transition: all 0.2s;
  white-space: nowrap;
}

.tab-btn.active {
  background: #3b82f6;
  color: white;
  border-color: #3b82f6;
}

.tab-btn:hover:not(.active) {
  background: #f3f4f6;
  color: #374151;
}

/* Pending badge on trigger button */
.pending-badge {
  position: absolute;
  top: 4px;
  left: 50%;
  transform: translateX(-50%);
  background: #f59e0b;
  color: white;
  font-size: 10px;
  font-weight: 700;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  writing-mode: horizontal-tb;
}

/* Pending orders */
.pending-orders-container {
  flex: 1;
  overflow: visible;
  min-width: 0;
}

.pending-orders-cards {
  display: flex;
  gap: 10px;
  height: 100%;
  padding: 2px;
}

.pending-order-card {
  width: 220px;
  flex-shrink: 0;
  background: white;
  border: 1px solid #fbbf24;
  border-radius: 6px;
  padding: 10px 12px;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cancel-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  padding: 2px 8px;
  font-size: 10px;
  background: #f59e0b;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.2s;
}

.cancel-btn:hover {
  background: #d97706;
}

.order-type-tag {
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 4px;
}

.tag-buy {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.tag-sell {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.order-time {
  font-size: 11px;
  color: #9ca3af;
  font-family: 'Consolas', monospace;
}

.pending-status {
  font-size: 11px;
  font-weight: 600;
  color: #f59e0b;
}

/* 滑动动画 */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.slide-up-enter-from {
  transform: translateY(100%);
  opacity: 0;
}

.slide-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>
