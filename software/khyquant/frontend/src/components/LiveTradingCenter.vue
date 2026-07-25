<template>
  <div class="live-trading-center">
    <!-- 头部 -->
    <div class="center-header">
      <div class="header-left">
        <span class="title">💹 实时交易中心</span>
        <el-badge :value="pendingCount" :hidden="pendingCount === 0" type="warning">
          <el-tag size="small" type="info">{{ orders.length }} 笔订单</el-tag>
        </el-badge>
      </div>
      <div class="header-right">
        <el-button-group size="small">
          <el-button :type="filterStatus === 'all' ? 'primary' : ''" @click="filterStatus = 'all'">
            全部
          </el-button>
          <el-button :type="filterStatus === 'pending' ? 'primary' : ''" @click="filterStatus = 'pending'">
            未成交 <el-badge :value="pendingCount" :hidden="pendingCount === 0" />
          </el-button>
          <el-button :type="filterStatus === 'partial' ? 'primary' : ''" @click="filterStatus = 'partial'">
            部分成交
          </el-button>
          <el-button :type="filterStatus === 'filled' ? 'primary' : ''" @click="filterStatus = 'filled'">
            已成交
          </el-button>
        </el-button-group>
        <el-button size="small" @click="clearFilledOrders" :disabled="filledCount === 0">
          <el-icon><Delete /></el-icon>
          清空已成交
        </el-button>
      </div>
    </div>

    <!-- 订单列表 -->
    <div class="orders-container">
      <transition-group name="order-list" tag="div">
        <div 
          v-for="order in filteredOrders" 
          :key="order.id"
          class="order-card"
          :class="[
            `status-${order.status}`,
            `side-${order.side}`,
            { 'is-futures': order.isFutures }
          ]"
        >
          <!-- 订单状态指示条 -->
          <div class="status-bar" :style="{ width: getStatusProgress(order) + '%' }"></div>
          
          <!-- 订单内容 -->
          <div class="order-content">
            <!-- 左侧：基本信息 -->
            <div class="order-left">
              <div class="order-symbol">
                <span class="symbol-code">{{ order.symbol }}</span>
                <el-tag :type="order.side === 'buy' ? 'danger' : 'success'" size="small">
                  {{ getDirectionText(order) }}
                </el-tag>
                <el-tag v-if="order.isFutures" type="warning" size="small">
                  {{ order.offset === 'open' ? '开仓' : '平仓' }}
                </el-tag>
              </div>
              
              <div class="order-details">
                <span class="detail-item">
                  <span class="label">类型:</span>
                  <span class="value type">{{ getOrderTypeLabel(order.orderType) }}</span>
                </span>
                <span class="detail-item" v-if="order.strategyName">
                  <span class="label">策略:</span>
                  <span class="value strategy">{{ order.strategyName }}</span>
                </span>
                <span class="detail-item">
                  <span class="label">价格:</span>
                  <span class="value price">{{ order.orderType === 'market' ? '市价' : '¥' + order.price.toFixed(2) }}</span>
                </span>
                <span class="detail-item">
                  <span class="label">数量:</span>
                  <span class="value">{{ order.quantity }} {{ order.isFutures ? '手' : '股' }}</span>
                </span>
                <span class="detail-item">
                  <span class="label">金额:</span>
                  <span class="value amount">¥{{ (order.price * order.quantity).toFixed(2) }}</span>
                </span>
              </div>
            </div>

            <!-- 中间：状态信息 -->
            <div class="order-middle">
              <div class="status-info">
                <el-tag :type="getStatusType(order.status)" size="large" effect="dark">
                  {{ getStatusText(order.status) }}
                </el-tag>
                <div class="fill-progress" v-if="order.status !== 'pending'">
                  <span class="filled">已成交: {{ order.filledQuantity || 0 }}</span>
                  <span class="remaining" v-if="order.status === 'partial'">
                    剩余: {{ order.quantity - (order.filledQuantity || 0) }}
                  </span>
                </div>
              </div>
              
              <!-- 期货特有信息 -->
              <div v-if="order.isFutures" class="futures-info">
                <span class="info-item">
                  <span class="label">保证金:</span>
                  <span class="value">¥{{ (order.price * order.quantity * order.marginRatio).toFixed(2) }}</span>
                </span>
              </div>
            </div>

            <!-- 右侧：时间和操作 -->
            <div class="order-right">
              <div class="time-info">
                <div class="create-time">
                  <el-icon><Clock /></el-icon>
                  {{ formatTime(order.createdAt) }}
                </div>
                <div v-if="order.filledAt" class="filled-time">
                  <el-icon><Check /></el-icon>
                  {{ formatTime(order.filledAt) }}
                </div>
              </div>
              
              <div class="order-actions">
                <el-button 
                  v-if="order.status === 'pending' || order.status === 'partial'"
                  size="small" 
                  type="danger" 
                  @click="cancelOrder(order)"
                >
                  撤单
                </el-button>
                <el-button 
                  v-if="order.status === 'filled' && !order.isClosed"
                  size="small" 
                  type="warning" 
                  @click="closePosition(order)"
                >
                  平仓
                </el-button>
                <el-button 
                  v-if="order.status === 'filled'"
                  size="small" 
                  type="info" 
                  @click="viewOrderDetail(order)"
                >
                  详情
                </el-button>
              </div>
            </div>
          </div>

          <!-- 动画效果层 -->
          <div v-if="order.status === 'partial'" class="filling-animation"></div>
        </div>
      </transition-group>

      <!-- 空状态 -->
      <div v-if="filteredOrders.length === 0" class="empty-state">
        <el-icon :size="48"><DocumentCopy /></el-icon>
        <p>暂无{{ getFilterStatusText() }}订单</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox, ElLoading } from 'element-plus'
import { Clock, Check, Delete, DocumentCopy } from '@element-plus/icons-vue'
import { tradeAPI } from '@/api/trade'

// 订单列表
const orders = ref([])
const filterStatus = ref('all')

// 统计数据
const pendingCount = computed(() => orders.value.filter(o => o.status === 'pending').length)
const filledCount = computed(() => orders.value.filter(o => o.status === 'filled').length)

// 过滤后的订单
const filteredOrders = computed(() => {
  if (filterStatus.value === 'all') return orders.value
  return orders.value.filter(o => o.status === filterStatus.value)
})

// 添加新订单（从下单面板接收）
const addOrder = (orderData) => {
  const newOrder = {
    id: Date.now() + Math.random(),
    ...orderData,
    status: 'pending',
    filledQuantity: 0,
    createdAt: new Date(),
    filledAt: null
  }
  
  orders.value.unshift(newOrder)
  ElMessage.success('订单已提交')
  
  // 模拟订单状态流转
  simulateOrderFilling(newOrder)
}

// 模拟订单成交过程
const simulateOrderFilling = (order) => {
  // 1-3秒后开始部分成交
  setTimeout(() => {
    const orderIndex = orders.value.findIndex(o => o.id === order.id)
    if (orderIndex === -1) return
    
    const currentOrder = orders.value[orderIndex]
    if (currentOrder.status === 'cancelled') return
    
    // 部分成交 30%-70%
    const partialFillRatio = 0.3 + Math.random() * 0.4
    currentOrder.filledQuantity = Math.floor(currentOrder.quantity * partialFillRatio)
    currentOrder.status = 'partial'
    
    ElMessage.info(`订单 ${order.symbol} 部分成交 ${currentOrder.filledQuantity}`)
    
    // 再过2-4秒完全成交
    setTimeout(() => {
      const idx = orders.value.findIndex(o => o.id === order.id)
      if (idx === -1) return
      
      const ord = orders.value[idx]
      if (ord.status === 'cancelled') return
      
      ord.filledQuantity = ord.quantity
      ord.status = 'filled'
      ord.filledAt = new Date()
      
      ElMessage.success(`订单 ${order.symbol} 已完全成交`)
    }, 2000 + Math.random() * 2000)
    
  }, 1000 + Math.random() * 2000)
}

// 撤单
const cancelOrder = (order) => {
  const index = orders.value.findIndex(o => o.id === order.id)
  if (index !== -1) {
    orders.value[index].status = 'cancelled'
    ElMessage.warning(`订单 ${order.symbol} 已撤销`)
  }
}

// 平仓
const closePosition = async (order) => {
  try {
    const { value } = await ElMessageBox.prompt(
      `持仓数量: ${order.quantity}，请输入平仓数量（输入 0 或留空表示全仓平仓）`, 
      '平仓操作', 
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        inputPattern: /^\d*$/,
        inputErrorMessage: '请输入有效的数量',
        inputPlaceholder: '留空表示全仓平仓'
      }
    )
    
    const closeQuantity = value ? parseInt(value) : order.quantity
    if (closeQuantity > order.quantity) {
      ElMessage.error('平仓数量不能超过持仓数量')
      return
    }
    
    // 调用真实的平仓API
    const closeType = (closeQuantity === 0 || closeQuantity === order.quantity) ? 'full' : 'partial'
    const actualQuantity = closeQuantity === 0 ? order.quantity : closeQuantity
    
    // 获取当前价格（这里需要从实际市场数据获取）
    const currentPrice = order.price * (1 + (Math.random() - 0.5) * 0.1) // 模拟当前价格
    
    const response = await tradeAPI.closePosition(order.id, {
      closeType,
      quantity: actualQuantity,
      closePrice: currentPrice
    })
    
    if (response.success) {
      // 更新本地订单状态
      const index = orders.value.findIndex(o => o.id === order.id)
      if (index !== -1) {
        if (closeType === 'full') {
          orders.value[index].isClosed = true
          ElMessage.success(`${order.symbol} 全仓平仓成功`)
        } else {
          orders.value[index].quantity -= actualQuantity
          ElMessage.success(`${order.symbol} 平仓 ${actualQuantity} 成功，剩余 ${orders.value[index].quantity}`)
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

// 清空已成交订单
const clearFilledOrders = () => {
  orders.value = orders.value.filter(o => o.status !== 'filled')
  ElMessage.success('已清空已成交订单')
}

// 查看订单详情
// 凭据：直接响应用户「查看详情」意图，且需向后端 /trading/order/:id 拉取（网络往返可能 >1.5s），
// 故以单行 Loading 透明反馈等待过程，成功后只呈现关键字段摘要，原始字段折叠进 <details> 降噪。
const viewOrderDetail = async (order) => {
  const esc = (v) => String(v ?? '—')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const loading = ElLoading.service({ text: `检索订单详情 ${order.symbol}…` })
  try {
    const response = await tradeAPI.getOrderDetail(order.id)
    if (!response?.success || !response.data) {
      throw new Error(response?.message || '返回数据为空')
    }
    const d = response.data
    const dir = d.direction || d.side
    const dirText = dir === 'buy' ? '买入' : dir === 'sell' ? '卖出' : (dir || '—')
    const created = d.created_at ? new Date(d.created_at).toLocaleString('zh-CN') : '—'
    const rows = [
      ['合约', `${d.symbolName || ''} ${d.symbol || ''}`.trim() || '—'],
      ['方向', dirText],
      ['状态', getStatusText(d.status)],
      ['委托价', d.price ?? '—'],
      ['数量', d.quantity ?? '—'],
      ['已成交', d.filledQuantity ?? d.filled_quantity ?? 0],
      ['策略', d.strategy?.name || '手动'],
      ['下单时间', created],
    ]
    const summary = rows
      .map(([k, v]) => `<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:#909399">${esc(k)}</span><span>${esc(v)}</span></div>`)
      .join('')
    const raw = esc(JSON.stringify(d, null, 2))
    const html = `${summary}<details style="margin-top:8px"><summary style="cursor:pointer;color:#909399">原始字段</summary><pre style="max-height:200px;overflow:auto;font-size:12px;margin:4px 0 0">${raw}</pre></details>`
    ElMessageBox.alert(html, `订单详情 · ${order.symbol}`, {
      dangerouslyUseHTMLString: true,
      confirmButtonText: '关闭',
    })
  } catch (error) {
    // 精准报错闭环：[动作] + [目标] + [人话原因] + [建议]
    const reason = error.response?.status === 404
      ? '该订单不存在或已被清理'
      : (error.response?.data?.message || error.message || '网络异常')
    ElMessage.error(`查看订单详情失败 · 订单 ${order.symbol}：${reason}。请稍后重试或刷新列表`)
  } finally {
    loading.close()
  }
}

// 获取状态进度
const getStatusProgress = (order) => {
  if (order.status === 'pending') return 0
  if (order.status === 'partial') return (order.filledQuantity / order.quantity) * 100
  if (order.status === 'filled') return 100
  return 0
}

// 获取状态类型
const getStatusType = (status) => {
  const types = {
    pending: 'info',
    partial: 'warning',
    filled: 'success',
    cancelled: 'danger'
  }
  return types[status] || 'info'
}

// 获取状态文本
const getStatusText = (status) => {
  const texts = {
    pending: '未成交',
    partial: '部分成交',
    filled: '已成交',
    cancelled: '已撤销'
  }
  return texts[status] || status
}

// 获取方向文本
const getDirectionText = (order) => {
  if (order.isFutures) {
    if (order.offset === 'open') {
      return order.side === 'buy' ? '买开' : '卖开'
    } else {
      return order.side === 'buy' ? '买平' : '卖平'
    }
  }
  return order.side === 'buy' ? '买入' : '卖出'
}

// 获取过滤状态文本
const getFilterStatusText = () => {
  const texts = {
    all: '',
    pending: '未成交',
    partial: '部分成交',
    filled: '已成交'
  }
  return texts[filterStatus.value] || ''
}

// 获取订单类型标签
const getOrderTypeLabel = (orderType) => {
  const labels = {
    limit: '限价',
    market: '市价',
    counterparty: '对手价',
    queue: '排队价',
    best5: '最优五档',
    bestOwn: '最优本方',
    twap: 'TWAP',
    vwap: 'VWAP',
    strategy: '策略'
  }
  return labels[orderType] || orderType
}

// 格式化时间
const formatTime = (date) => {
  if (!date) return '-'
  const d = new Date(date)
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

// 监听下单事件
onMounted(() => {
  // 监听来自下单面板的订单
  window.addEventListener('new-order', (event) => {
    addOrder(event.detail)
  })
})

onUnmounted(() => {
  window.removeEventListener('new-order', () => {})
})

// 暴露方法供父组件调用
defineExpose({
  addOrder
})
</script>

<style scoped>
.live-trading-center {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: 
    linear-gradient(to bottom, #0f1419, #0a0e13),
    repeating-linear-gradient(
      90deg,
      transparent,
      transparent 3px,
      rgba(16, 185, 129, 0.02) 3px,
      rgba(16, 185, 129, 0.02) 6px
    );
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid rgba(16, 185, 129, 0.2);
  position: relative;
}

.live-trading-center::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: 
    radial-gradient(circle at 20% 30%, rgba(16, 185, 129, 0.05) 1px, transparent 1px),
    radial-gradient(circle at 60% 50%, rgba(59, 130, 246, 0.05) 1px, transparent 1px),
    radial-gradient(circle at 80% 70%, rgba(16, 185, 129, 0.05) 1px, transparent 1px);
  background-size: 100% 100%;
  opacity: 0.6;
  pointer-events: none;
}

/* 头部 */
.center-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  background: 
    linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(5, 150, 105, 0.15)),
    rgba(26, 26, 26, 0.9);
  border-bottom: 2px solid rgba(16, 185, 129, 0.3);
  backdrop-filter: blur(10px);
  position: relative;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title {
  font-size: 16px;
  font-weight: 700;
  color: #10b981;
  text-shadow: 0 0 10px rgba(16, 185, 129, 0.4);
}

.header-right {
  display: flex;
  gap: 12px;
}

/* 订单容器 */
.orders-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  position: relative;
  z-index: 1;
}

/* 订单卡片 */
.order-card {
  background: rgba(26, 26, 26, 0.8);
  border-radius: 8px;
  margin-bottom: 12px;
  border: 1px solid rgba(16, 185, 129, 0.2);
  overflow: hidden;
  position: relative;
  transition: all 0.3s ease;
}

.order-card:hover {
  transform: translateX(4px);
  border-color: rgba(16, 185, 129, 0.4);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.2);
}

/* 状态指示条 */
.status-bar {
  position: absolute;
  top: 0;
  left: 0;
  height: 3px;
  background: linear-gradient(90deg, #10b981, #059669);
  transition: width 0.5s ease;
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.5);
}

.order-card.status-filled .status-bar {
  background: linear-gradient(90deg, #10b981, #34d399);
}

.order-card.status-partial .status-bar {
  background: linear-gradient(90deg, #f59e0b, #fbbf24);
}

/* 订单内容 */
.order-content {
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 12px;
  position: relative;
  z-index: 1;
}

.order-left {
  width: 100%;
}

.order-symbol {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.symbol-code {
  font-size: 14px;
  font-weight: 700;
  color: #e5e7eb;
  font-family: 'Consolas', monospace;
}

.order-details {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.detail-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.detail-item .label {
  color: #9ca3af;
  min-width: 50px;
}

.detail-item .value {
  color: #e5e7eb;
  font-weight: 600;
  font-family: 'Consolas', monospace;
  text-align: right;
}

.detail-item .value.price {
  color: #10b981;
}

.detail-item .value.type {
  color: #8b5cf6;
  font-size: 11px;
}

.detail-item .value.strategy {
  color: #f59e0b;
  font-size: 11px;
  font-weight: 600;
}

.detail-item .value.amount {
  color: #3b82f6;
}

/* 中间状态区 */
.order-middle {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding-top: 8px;
  border-top: 1px solid rgba(16, 185, 129, 0.1);
}

.status-info {
  flex: 1;
}

.fill-progress {
  font-size: 11px;
  color: #9ca3af;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
}

.fill-progress .filled {
  color: #10b981;
  font-weight: 600;
}

.futures-info {
  font-size: 11px;
  color: #f59e0b;
}

/* 右侧时间和操作 */
.order-right {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding-top: 8px;
  border-top: 1px solid rgba(16, 185, 129, 0.1);
}

.time-info {
  font-size: 11px;
  color: #9ca3af;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.create-time,
.filled-time {
  display: flex;
  align-items: center;
  gap: 4px;
}

.filled-time {
  color: #10b981;
}

.order-actions {
  display: flex;
  gap: 6px;
}

/* 成交动画 */
.filling-animation {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(90deg, transparent, rgba(16, 185, 129, 0.1), transparent);
  animation: filling 2s infinite;
  pointer-events: none;
}

@keyframes filling {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

/* 列表动画 */
.order-list-enter-active {
  animation: slideIn 0.5s ease;
}

.order-list-leave-active {
  animation: slideOut 0.3s ease;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes slideOut {
  from {
    opacity: 1;
    transform: translateX(0);
  }
  to {
    opacity: 0;
    transform: translateX(20px);
  }
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: #6b7280;
}

.empty-state p {
  margin-top: 16px;
  font-size: 14px;
}

/* 滚动条 */
.orders-container::-webkit-scrollbar {
  width: 6px;
}

.orders-container::-webkit-scrollbar-track {
  background: rgba(16, 185, 129, 0.05);
}

.orders-container::-webkit-scrollbar-thumb {
  background: rgba(16, 185, 129, 0.3);
  border-radius: 3px;
}

.orders-container::-webkit-scrollbar-thumb:hover {
  background: rgba(16, 185, 129, 0.5);
}
</style>
