<template>
  <div class="smart-trading" :class="{ 'is-mobile': isMobileDevice }">

    <!-- ===== MOBILE LAYOUT ===== -->
    <template v-if="isMobileDevice">
      <!-- Mobile top bar -->
      <div class="m-top-bar">
        <h3 class="m-title">Smart Trading</h3>
        <div class="m-top-actions">
          <button class="m-icon-btn" @click="refreshAllData"><el-icon :size="20"><Refresh /></el-icon></button>
          <button class="m-icon-btn" @click="openSettings"><el-icon :size="20"><Setting /></el-icon></button>
        </div>
      </div>

      <!-- Mobile agent card carousel -->
      <div class="m-agent-carousel">
        <div
          v-for="source in availableSources"
          :key="source.key"
          class="m-agent-card"
          :class="{ active: source.key === currentSource.key, disabled: !source.enabled }"
          @click="expandedAgent = source"
        >
          <div class="m-card-header">
            <span class="m-source-dot" :class="source.statusClass">●</span>
            <span class="m-source-name">{{ source.name }}</span>
          </div>
          <div class="m-card-stats">
            <span>{{ source.successRate }}%</span>
            <span class="m-status-text">{{ getStatusText(source.status) }}</span>
          </div>
        </div>
      </div>

      <!-- Mobile trading content (full width) -->
      <div class="m-trading-content">
        <ProfessionalTradingInterface
          :height="500"
          :symbol="selectedSymbol"
          @contract-change="handleContractChange"
          @period-change="handlePeriodChange"
          @data-source-change="handleTradingDataSourceChange"
          @signal-loaded="handleSignalLoaded"
          @order-placed="handleOrderPlaced"
        />
      </div>

      <!-- Full-width Start Analysis button -->
      <div class="m-action-bar">
        <button class="m-analyze-btn" @click="refreshAllData">Start Analysis</button>
      </div>

      <!-- Fixed bottom chat input -->
      <div class="m-chat-bar">
        <input
          v-model="mobileChatInput"
          class="m-chat-input"
          placeholder="Ask about data sources..."
          @keyup.enter="ElMessage.info(mobileChatInput); mobileChatInput = ''"
        />
        <button class="m-chat-send" @click="ElMessage.info(mobileChatInput); mobileChatInput = ''">
          <el-icon :size="20"><Refresh /></el-icon>
        </button>
      </div>

      <!-- Full-screen agent detail overlay -->
      <Teleport to="body">
        <Transition name="m-expand">
          <div v-if="expandedAgent" class="m-agent-overlay" @click.self="expandedAgent = null">
            <div class="m-agent-detail">
              <div class="m-detail-header">
                <h3>{{ expandedAgent.name }}</h3>
                <button class="m-close-btn" @click="expandedAgent = null">&times;</button>
              </div>
              <div class="m-detail-body">
                <div class="m-detail-row"><span>Status</span><span :class="expandedAgent.statusClass">{{ getStatusText(expandedAgent.status) }}</span></div>
                <div class="m-detail-row"><span>Success Rate</span><span>{{ expandedAgent.successRate }}%</span></div>
                <div class="m-detail-row"><span>Response Time</span><span>{{ expandedAgent.responseTime || '--' }}ms</span></div>
                <button
                  class="m-switch-btn"
                  :disabled="!expandedAgent.enabled"
                  @click="handleSidebarSourceChange(expandedAgent.key); expandedAgent = null"
                >Switch to this source</button>
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>
    </template>

    <!-- ===== DESKTOP LAYOUT ===== -->
    <template v-else>

    <!-- 顶部状态栏 -->
    <div class="status-bar">
      <div class="status-left">
        <h2>🤖 智能交易系统</h2>
        <span class="system-status">系统运行正常</span>
      </div>
      
      <div class="status-center">
        <!-- 全局数据源状态 -->
        <DataSourceIndicator
          :source-name="currentSource.name"
          :status="connectionStatus"
          :quality="dataQuality"
          :success-rate="currentSource.successRate"
          :response-time="currentSource.responseTime"
          :last-update="lastUpdate"
          :current-source="currentSource.key"
          :available-sources="availableSources"
          @source-change="handleGlobalDataSourceChange"
          @manage="openDataSourceManagement"
          class="global-data-source"
        />
      </div>
      
      <div class="status-right">
        <el-button size="small" @click="refreshAllData">
          <el-icon><Refresh /></el-icon>
          刷新数据
        </el-button>
        <el-button size="small" @click="openSettings">
          <el-icon><Setting /></el-icon>
          设置
        </el-button>
      </div>
    </div>

    <!-- 主要交易区域 -->
    <div class="trading-main">
      <!-- 左侧导航栏 -->
      <div class="sidebar">
        <div class="sidebar-section">
          <h3>📊 数据源管理</h3>
          <div class="data-source-list">
            <div 
              v-for="source in availableSources" 
              :key="source.key"
              class="source-item"
              :class="{ 
                'active': source.key === currentSource.key,
                'disabled': !source.enabled || source.status === 'disconnected'
              }"
              @click="handleSidebarSourceChange(source.key)"
            >
              <div class="source-info">
                <span class="source-icon" :class="source.statusClass">●</span>
                <span class="source-name">{{ source.name }}</span>
              </div>
              <div class="source-stats">
                <span class="success-rate">{{ source.successRate }}%</span>
                <span class="status-text">{{ getStatusText(source.status) }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="sidebar-section">
          <h3>⚡ 快速操作</h3>
          <div class="quick-actions">
            <el-button size="small" @click="testAllSources" :loading="testing">
              测试所有数据源
            </el-button>
            <el-button size="small" @click="optimizeDataSource">
              优化数据源
            </el-button>
            <el-button size="small" @click="viewDataSourceHistory">
              查看历史
            </el-button>
          </div>
        </div>

        <div class="sidebar-section">
          <h3>📈 数据统计</h3>
          <div class="data-stats">
            <div class="stat-item">
              <span class="label">今日请求:</span>
              <span class="value">{{ todayRequests }}</span>
            </div>
            <div class="stat-item">
              <span class="label">成功率:</span>
              <span class="value">{{ overallSuccessRate }}%</span>
            </div>
            <div class="stat-item">
              <span class="label">平均延迟:</span>
              <span class="value">{{ averageLatency }}ms</span>
            </div>
            <div class="stat-item">
              <span class="label">数据质量:</span>
              <span class="value" :class="dataQualityClass">{{ dataQualityText }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 中间交易界面 -->
      <div class="trading-content">
        <ProfessionalTradingInterface
          :height="800"
          :symbol="selectedSymbol"
          @contract-change="handleContractChange"
          @period-change="handlePeriodChange"
          @data-source-change="handleTradingDataSourceChange"
          @signal-loaded="handleSignalLoaded"
          @order-placed="handleOrderPlaced"
        />
      </div>

      <!-- 右侧信息面板 -->
      <div class="info-panel">
        <div class="panel-section">
          <h3>🔄 数据源同步状态</h3>
          <div class="sync-status">
            <div class="sync-item">
              <span class="label">全局数据源:</span>
              <span class="value">{{ currentSource.name }}</span>
            </div>
            <div class="sync-item">
              <span class="label">交易界面:</span>
              <span class="value">{{ tradingDataSource || '同步中...' }}</span>
            </div>
            <div class="sync-item">
              <span class="label">同步状态:</span>
              <span class="value" :class="syncStatusClass">{{ syncStatusText }}</span>
            </div>
          </div>
        </div>

        <div class="panel-section">
          <h3>📊 实时监控</h3>
          <div class="monitor-data">
            <div class="monitor-item">
              <span class="label">数据更新频率:</span>
              <span class="value">{{ updateFrequency }}</span>
            </div>
            <div class="monitor-item">
              <span class="label">连接数:</span>
              <span class="value">{{ connectionCount }}</span>
            </div>
            <div class="monitor-item">
              <span class="label">缓存命中率:</span>
              <span class="value">{{ cacheHitRate }}%</span>
            </div>
          </div>
        </div>

        <div class="panel-section">
          <h3>⚠️ 系统提醒</h3>
          <div class="alerts">
            <div 
              v-for="alert in systemAlerts" 
              :key="alert.id"
              class="alert-item"
              :class="alert.type"
            >
              <el-icon class="alert-icon">
                <Warning v-if="alert.type === 'warning'" />
                <InfoFilled v-else-if="alert.type === 'info'" />
                <CircleCheckFilled v-else />
              </el-icon>
              <span class="alert-text">{{ alert.message }}</span>
              <span class="alert-time">{{ formatTime(alert.time) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    </template><!-- end desktop -->
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Setting, Warning, InfoFilled, CircleCheckFilled } from '@element-plus/icons-vue'
import ProfessionalTradingInterface from '@/components/ProfessionalTradingInterface.vue'
import DataSourceIndicator from '@/components/DataSourceIndicator.vue'
import { useDataSource } from '@/services/dataSourceService'
import { isMobile as checkMobile } from '@/utils/device'

// 使用数据源服务
const {
  currentSource,
  availableSources,
  dataQuality,
  connectionStatus,
  lastUpdate,
  switchDataSource,
  refreshSourceStatus,
  on: onDataSourceEvent,
  off: offDataSourceEvent
} = useDataSource()

// Device detection
const isMobileDevice = ref(false)
const updateDevice = () => { isMobileDevice.value = checkMobile() }

// Mobile state
const expandedAgent = ref(null) // which agent card is expanded full-screen
const mobileChatInput = ref('')

// 响应式数据
const selectedSymbol = ref('IF2609')
const tradingDataSource = ref('')
const testing = ref(false)

// 统计数据
const todayRequests = ref(1247)
const overallSuccessRate = ref(92)
const averageLatency = ref(156)
const updateFrequency = ref('1秒')
const connectionCount = ref(3)
const cacheHitRate = ref(87)

// 系统提醒
const systemAlerts = ref([
  {
    id: 1,
    type: 'info',
    message: '数据源已切换到东方财富',
    time: new Date(Date.now() - 300000)
  },
  {
    id: 2,
    type: 'warning',
    message: 'Yahoo Finance连接不稳定',
    time: new Date(Date.now() - 600000)
  },
  {
    id: 3,
    type: 'success',
    message: '系统性能优化完成',
    time: new Date(Date.now() - 900000)
  }
])

// 计算属性
const dataQualityClass = computed(() => {
  const qualityMap = {
    high: 'quality-high',
    medium: 'quality-medium',
    low: 'quality-low',
    simulated: 'quality-simulated'
  }
  return qualityMap[dataQuality.value] || 'quality-unknown'
})

const dataQualityText = computed(() => {
  const qualityMap = {
    high: '高质量',
    medium: '中等',
    low: '低质量',
    simulated: '模拟'
  }
  return qualityMap[dataQuality.value] || '未知'
})

const syncStatusClass = computed(() => {
  return tradingDataSource.value === currentSource.value.name ? 'sync-ok' : 'sync-warning'
})

const syncStatusText = computed(() => {
  return tradingDataSource.value === currentSource.value.name ? '✅ 已同步' : '⚠️ 不同步'
})

// 方法
async function handleGlobalDataSourceChange(sourceKey) {
  try {
    await switchDataSource(sourceKey)
    ElMessage.success(`全局数据源已切换到${currentSource.value.name}`)
    
    // 添加系统提醒
    systemAlerts.value.unshift({
      id: Date.now(),
      type: 'info',
      message: `全局数据源已切换到${currentSource.value.name}`,
      time: new Date()
    })
    
    // 保持最多10条提醒
    if (systemAlerts.value.length > 10) {
      systemAlerts.value = systemAlerts.value.slice(0, 10)
    }
    
  } catch (error) {
    ElMessage.error(error.message)
  }
}

async function handleSidebarSourceChange(sourceKey) {
  const source = availableSources.value.find(s => s.key === sourceKey)
  if (!source.enabled || source.status === 'disconnected') {
    ElMessage.warning('该数据源当前不可用')
    return
  }
  
  await handleGlobalDataSourceChange(sourceKey)
}

function handleTradingDataSourceChange(data) {
  tradingDataSource.value = data.name
  
  // 检查同步状态
  if (data.name !== currentSource.value.name) {
    ElMessage.warning('交易界面数据源与全局设置不同步')
  }
}

function handleContractChange(contract) {
  selectedSymbol.value = contract
}

function handlePeriodChange(period) {
  console.log('周期变更:', period)
}

function handleSignalLoaded(signals) {
  console.log('信号加载:', signals.length)
}

function handleOrderPlaced(order) {
  console.log('订单提交:', order)
}

async function refreshAllData() {
  try {
    await refreshSourceStatus()
    ElMessage.success('数据刷新完成')
  } catch (error) {
    ElMessage.error('数据刷新失败')
  }
}

function openSettings() {
  ElMessage.info('打开系统设置')
}

function openDataSourceManagement() {
  // 跳转到数据源管理页面
  if (window.$router) {
    window.$router.push('/data-source-management')
  } else {
    window.open('/data-source-management', '_blank')
  }
}

async function testAllSources() {
  testing.value = true
  
  try {
    // 模拟测试所有数据源
    for (const source of availableSources.value) {
      if (source.enabled) {
        console.log(`测试数据源: ${source.name}`)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    
    ElMessage.success('所有数据源测试完成')
    
    // 添加测试完成提醒
    systemAlerts.value.unshift({
      id: Date.now(),
      type: 'success',
      message: '数据源连接测试完成',
      time: new Date()
    })
    
  } catch (error) {
    ElMessage.error('数据源测试失败')
  } finally {
    testing.value = false
  }
}

function optimizeDataSource() {
  ElMessage.info('正在优化数据源配置...')
  
  setTimeout(() => {
    ElMessage.success('数据源优化完成')
    systemAlerts.value.unshift({
      id: Date.now(),
      type: 'success',
      message: '数据源性能优化完成',
      time: new Date()
    })
  }, 2000)
}

function viewDataSourceHistory() {
  ElMessage.info('打开数据源历史记录')
}

function getStatusText(status) {
  const statusMap = {
    connected: '已连接',
    warning: '警告',
    disconnected: '已断开'
  }
  return statusMap[status] || '未知'
}

function formatTime(time) {
  return time.toLocaleTimeString()
}

// 生命周期
onMounted(() => {
  updateDevice()
  window.addEventListener('resize', updateDevice)

  // 监听数据源变更事件
  onDataSourceEvent('source-changed', (data) => {
    console.log('数据源变更:', data)
  })

  onDataSourceEvent('data-updated', (data) => {
    console.log('数据更新:', data)
  })
})

onUnmounted(() => {
  window.removeEventListener('resize', updateDevice)
  // 清理事件监听器
  offDataSourceEvent('source-changed')
  offDataSourceEvent('data-updated')
})
</script>

<style scoped>
.smart-trading {
  height: 100vh;
  background: #0d1421;
  color: #d1d4dc;
  display: flex;
  flex-direction: column;
}

/* 顶部状态栏 */
.status-bar {
  height: 60px;
  background: linear-gradient(to right, #1e2329, #2b2b43);
  border-bottom: 1px solid #2b2b43;
  display: flex;
  align-items: center;
  padding: 0 20px;
  justify-content: space-between;
}

.status-left h2 {
  margin: 0;
  font-size: 18px;
  color: #f0b90b;
}

.system-status {
  font-size: 12px;
  color: #67C23A;
  margin-left: 12px;
}

.status-center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.global-data-source {
  background: rgba(255, 255, 255, 0.05);
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.status-right {
  display: flex;
  gap: 8px;
}

/* 主要交易区域 */
.trading-main {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* 左侧导航栏 */
.sidebar {
  width: 280px;
  background: #181a20;
  border-right: 1px solid #2b2b43;
  padding: 20px;
  overflow-y: auto;
}

.sidebar-section {
  margin-bottom: 24px;
}

.sidebar-section h3 {
  margin: 0 0 12px 0;
  font-size: 14px;
  color: #f0b90b;
  border-bottom: 1px solid #2b2b43;
  padding-bottom: 8px;
}

/* 数据源列表 */
.data-source-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-item {
  padding: 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.3s ease;
  border: 1px solid transparent;
}

.source-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.source-item.active {
  background: rgba(64, 158, 255, 0.1);
  border-color: #409EFF;
}

.source-item.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.source-info {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.source-icon {
  font-size: 8px;
}

.source-icon.source-connected { color: #67C23A; }
.source-icon.source-warning { color: #E6A23C; }
.source-icon.source-disconnected { color: #F56C6C; }

.source-name {
  font-weight: 500;
  font-size: 13px;
}

.source-stats {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #909399;
}

/* 快速操作 */
.quick-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.quick-actions .el-button {
  justify-content: flex-start;
}

/* 数据统计 */
.data-stats {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}

.stat-item .label {
  color: #909399;
}

.stat-item .value {
  font-weight: 500;
}

.quality-high { color: #67C23A; }
.quality-medium { color: #E6A23C; }
.quality-low { color: #F56C6C; }
.quality-simulated { color: #909399; }

/* 中间交易界面 */
.trading-content {
  flex: 1;
  background: #0d1421;
}

/* 右侧信息面板 */
.info-panel {
  width: 300px;
  background: #181a20;
  border-left: 1px solid #2b2b43;
  padding: 20px;
  overflow-y: auto;
}

.panel-section {
  margin-bottom: 24px;
}

.panel-section h3 {
  margin: 0 0 12px 0;
  font-size: 14px;
  color: #f0b90b;
  border-bottom: 1px solid #2b2b43;
  padding-bottom: 8px;
}

/* 同步状态 */
.sync-status,
.monitor-data {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sync-item,
.monitor-item {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}

.sync-item .label,
.monitor-item .label {
  color: #909399;
}

.sync-item .value,
.monitor-item .value {
  font-weight: 500;
}

.sync-ok { color: #67C23A; }
.sync-warning { color: #E6A23C; }

/* 系统提醒 */
.alerts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 200px;
  overflow-y: auto;
}

.alert-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 4px;
  font-size: 12px;
}

.alert-item.info {
  background: rgba(64, 158, 255, 0.1);
  border-left: 3px solid #409EFF;
}

.alert-item.warning {
  background: rgba(230, 162, 60, 0.1);
  border-left: 3px solid #E6A23C;
}

.alert-item.success {
  background: rgba(103, 194, 58, 0.1);
  border-left: 3px solid #67C23A;
}

.alert-icon {
  font-size: 14px;
}

.alert-text {
  flex: 1;
}

.alert-time {
  font-size: 10px;
  color: #909399;
}

/* ===== MOBILE STYLES ===== */
.smart-trading.is-mobile {
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: #0d1421;
  touch-action: manipulation;
}

/* Mobile top bar */
.m-top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  padding-top: calc(12px + env(safe-area-inset-top));
  background: #1e2329;
  border-bottom: 1px solid #2b2b43;
  flex-shrink: 0;
}
.m-title {
  margin: 0;
  font-size: 17px;
  color: #f0b90b;
  font-weight: 600;
}
.m-top-actions {
  display: flex;
  gap: 4px;
}
.m-icon-btn {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: #d1d4dc;
  cursor: pointer;
  border-radius: 8px;
  touch-action: manipulation;
}
.m-icon-btn:active { background: rgba(255, 255, 255, 0.08); }

/* Agent card carousel */
.m-agent-carousel {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  flex-shrink: 0;
}
.m-agent-carousel::-webkit-scrollbar { display: none; }

.m-agent-card {
  flex: 0 0 85vw;
  max-width: 320px;
  scroll-snap-align: start;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid #2b2b43;
  border-radius: 12px;
  padding: 14px 16px;
  cursor: pointer;
  touch-action: manipulation;
}
.m-agent-card:active { background: rgba(255, 255, 255, 0.08); }
.m-agent-card.active {
  border-color: #409EFF;
  background: rgba(64, 158, 255, 0.08);
}
.m-agent-card.disabled { opacity: 0.5; }

.m-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.m-source-dot { font-size: 10px; }
.m-source-dot.source-connected { color: #67C23A; }
.m-source-dot.source-warning { color: #E6A23C; }
.m-source-dot.source-disconnected { color: #F56C6C; }
.m-source-name { font-size: 15px; font-weight: 500; color: #fff; }

.m-card-stats {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: #909399;
}

/* Mobile trading content */
.m-trading-content {
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

/* Full-width action button */
.m-action-bar {
  padding: 8px 16px;
  flex-shrink: 0;
}
.m-analyze-btn {
  width: 100%;
  min-height: 48px;
  background: linear-gradient(135deg, #f0b90b, #d4a017);
  border: none;
  border-radius: 10px;
  color: #1e2329;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  touch-action: manipulation;
}
.m-analyze-btn:active { opacity: 0.85; }

/* Fixed bottom chat input */
.m-chat-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
  background: #1e2329;
  border-top: 1px solid #2b2b43;
  flex-shrink: 0;
  min-height: 60px;
}
.m-chat-input {
  flex: 1;
  padding: 10px 14px;
  background: #2a2a3a;
  border: 1px solid #3a3a4a;
  border-radius: 20px;
  color: #fff;
  font-size: 14px;
  outline: none;
  min-height: 44px;
}
.m-chat-input::placeholder { color: #666; }
.m-chat-input:focus { border-color: #409EFF; }
.m-chat-send {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #409EFF;
  border: none;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  touch-action: manipulation;
}
.m-chat-send:active { opacity: 0.8; }

/* Full-screen agent detail overlay */
.m-agent-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.m-agent-detail {
  width: 100%;
  max-width: 400px;
  background: #1e2329;
  border-radius: 16px;
  overflow: hidden;
}
.m-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #2b2b43;
}
.m-detail-header h3 { margin: 0; color: #f0b90b; font-size: 17px; }
.m-close-btn {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: #999;
  font-size: 24px;
  cursor: pointer;
}
.m-detail-body { padding: 20px; }
.m-detail-row {
  display: flex;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 14px;
  color: #d1d4dc;
}
.m-switch-btn {
  width: 100%;
  min-height: 48px;
  margin-top: 16px;
  background: #409EFF;
  border: none;
  border-radius: 10px;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
}
.m-switch-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.m-switch-btn:active:not(:disabled) { opacity: 0.8; }

/* Transitions */
.m-expand-enter-active, .m-expand-leave-active { transition: opacity 0.25s; }
.m-expand-enter-from, .m-expand-leave-to { opacity: 0; }

/* Hide desktop layout elements on mobile */
@media (max-width: 767px) {
  .status-bar, .trading-main { display: none; }
}
</style>