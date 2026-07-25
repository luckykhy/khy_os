<template>
  <div class="dashboard">
    <!-- 欢迎横幅 -->
    <div class="welcome-banner">
      <div class="welcome-content">
        <h1 class="welcome-title">欢迎回来！</h1>
        <p class="welcome-subtitle">开始您的量化交易之旅</p>
      </div>
      
      <!-- 呼叫小K按钮 -->
      <button class="call-ai-btn" @click="callAIAssistant" title="呼叫小K智能助手">
        <div class="ai-icon-wrapper">
          <img src="/robot-avatar.jpg" alt="小K" class="ai-avatar" />
          <div class="ai-pulse"></div>
        </div>
        <span class="ai-text">呼叫小K</span>
      </button>
      
      <!-- 局域网访问信息 -->
      <div class="lan-access-info" v-if="lanIpAddress">
        <div class="lan-ip-label">
          <el-icon><Monitor /></el-icon>
          <span>其它设备可访问下面这个IP进行登录</span>
        </div>
        <div class="lan-ip-address" @click="copyLanUrl">
          <span class="ip-text">{{ lanAccessUrl }}</span>
          <el-icon class="copy-icon"><CopyDocument /></el-icon>
        </div>
        <div class="lan-qr-code" v-if="showQrCode">
          <canvas ref="qrCodeCanvas"></canvas>
        </div>
        <el-button 
          size="small" 
          text 
          @click="toggleQrCode"
          class="qr-toggle-btn"
        >
          <el-icon><Picture /></el-icon>
          {{ showQrCode ? '隐藏' : '显示' }}二维码
        </el-button>
      </div>
      
      <div class="welcome-actions">
        <el-button type="primary" size="large" @click="router.push('/strategies')">
          <el-icon><Plus /></el-icon>
          创建策略
        </el-button>
        <el-button size="large" @click="router.push('/trading')">
          <el-icon><TrendCharts /></el-icon>
          开始交易
        </el-button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-grid" v-loading="loading">
      <div class="stat-card stat-card-primary hover-lift">
        <div class="stat-icon-wrapper gradient-bg-primary">
          <el-icon class="stat-icon-large"><Document /></el-icon>
        </div>
        <div class="stat-content">
          <div class="stat-value">{{ stats.strategies }}</div>
          <div class="stat-label">策略总数</div>
        </div>
        <div class="stat-trend" v-if="trends.strategies !== 0">
          <el-icon :class="trends.strategies > 0 ? 'text-up' : 'text-down'">
            <CaretTop v-if="trends.strategies > 0" />
            <CaretBottom v-else />
          </el-icon>
          <span :class="trends.strategies > 0 ? 'text-up' : 'text-down'">
            {{ Math.abs(trends.strategies) }}%
          </span>
        </div>
      </div>
      <div class="stat-card stat-card-success hover-lift">
        <div class="stat-icon-wrapper gradient-bg-success">
          <el-icon class="stat-icon-large"><DataAnalysis /></el-icon>
        </div>
        <div class="stat-content">
          <div class="stat-value">{{ stats.backtests }}</div>
          <div class="stat-label">回测次数</div>
        </div>
        <div class="stat-trend" v-if="trends.backtests !== 0">
          <el-icon :class="trends.backtests > 0 ? 'text-up' : 'text-down'">
            <CaretTop v-if="trends.backtests > 0" />
            <CaretBottom v-else />
          </el-icon>
          <span :class="trends.backtests > 0 ? 'text-up' : 'text-down'">
            {{ Math.abs(trends.backtests) }}%
          </span>
        </div>
      </div>
      <div class="stat-card stat-card-warning hover-lift">
        <div class="stat-icon-wrapper gradient-bg-warning">
          <el-icon class="stat-icon-large"><ShoppingCart /></el-icon>
        </div>
        <div class="stat-content">
          <div class="stat-value">{{ stats.trades }}</div>
          <div class="stat-label">交易记录</div>
        </div>
        <div class="stat-trend" v-if="trends.trades !== 0">
          <el-icon :class="trends.trades > 0 ? 'text-up' : 'text-down'">
            <CaretTop v-if="trends.trades > 0" />
            <CaretBottom v-else />
          </el-icon>
          <span :class="trends.trades > 0 ? 'text-up' : 'text-down'">
            {{ Math.abs(trends.trades) }}%
          </span>
        </div>
      </div>
    </div>

    <el-row :gutter="20" class="handover-row">
      <el-col :xs="24" :sm="24" :md="24">
        <el-card class="content-card hover-lift handover-card">
          <template #header>
            <div class="card-header-custom">
              <div class="card-title-wrapper">
                <el-icon class="card-icon"><Monitor /></el-icon>
                <span class="card-title-text">跨设备交接快照</span>
                <el-tag
                  v-if="handoverSnapshot?.generated_at"
                  size="small"
                  type="info"
                  style="margin-left: 10px"
                >
                  {{ formatDateTime(handoverSnapshot.generated_at) }}
                </el-tag>
                <el-tag
                  size="small"
                  :type="handoverRealtimeTagType"
                  style="margin-left: 10px"
                >
                  {{ handoverRealtimeTagText }}
                </el-tag>
              </div>
              <el-button link type="primary" @click="loadHandoverSnapshot(true)" :disabled="handoverLoading">
                <el-icon><Refresh /></el-icon>
                {{ handoverLoading ? '刷新中（步骤 1/1）' : '刷新快照' }}
              </el-button>
            </div>
          </template>

          <div v-if="handoverLoading" class="handover-loading">
            <el-icon class="handover-loading-icon"><Loading /></el-icon>
            <span>正在读取交接快照（步骤 1/1：汇总任务、审批与保留策略状态）</span>
          </div>

          <div v-else-if="handoverError" class="handover-error">
            <el-alert
              :title="handoverError"
              type="warning"
              :closable="false"
              show-icon
            />
          </div>

          <div v-else class="handover-content">
            <div class="handover-metrics-grid">
              <div class="handover-metric-item">
                <span class="metric-label">活动大型任务</span>
                <span class="metric-value">{{ handoverSummary.active_large_task_count }}</span>
              </div>
              <div class="handover-metric-item">
                <span class="metric-label">待审批</span>
                <span class="metric-value">{{ handoverSummary.pending_remote_approval_count }}</span>
              </div>
              <div class="handover-metric-item">
                <span class="metric-label">活跃远程会话</span>
                <span class="metric-value">{{ handoverSummary.active_remote_session_count }}</span>
              </div>
              <div class="handover-metric-item">
                <span class="metric-label">待办</span>
                <span class="metric-value">{{ handoverSummary.pending_todo_count }}</span>
              </div>
              <div class="handover-metric-item">
                <span class="metric-label">队列深度</span>
                <span class="metric-value">{{ handoverSummary.queue_depth }}</span>
              </div>
              <div class="handover-metric-item">
                <span class="metric-label">Retention 变更</span>
                <span class="metric-value">{{ handoverSummary.retention_policy_change_count }}</span>
              </div>
            </div>

            <div class="handover-retention-block">
              <div class="handover-retention-header">
                <span class="retention-title">最近保留策略调整</span>
                <el-tag size="small" type="warning">
                  {{ recentRetentionChanges.length }} 条
                </el-tag>
              </div>
              <div v-if="recentRetentionChanges.length > 0" class="retention-change-list">
                <div
                  v-for="item in recentRetentionChanges"
                  :key="item.retention_event_id"
                  class="retention-change-item"
                >
                  <div class="retention-change-main">
                    <el-tag :type="item.changed ? 'warning' : 'info'" size="small">
                      {{ item.changed ? '已变更' : '审计' }}
                    </el-tag>
                    <span class="retention-actor">{{ formatRetentionActor(item) }}</span>
                  </div>
                  <div class="retention-change-meta">
                    <span>#{{ item.retention_event_id }}</span>
                    <span>{{ formatDateTime(item.at) }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="retention-empty">
                当前窗口内未出现新的保留策略修改。
              </div>
            </div>

            <div v-if="handoverRealtimeLastEventAt" class="handover-realtime-meta">
              最近实时事件: {{ formatDateTime(handoverRealtimeLastEventAt) }}
            </div>
            <div v-if="handoverRealtimeLastError" class="handover-realtime-error">
              实时同步告警: {{ handoverRealtimeLastError }}
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
    
    <!-- 内容区域 -->
    <el-row :gutter="20" class="content-row">
      <!-- 市场行情 -->
      <el-col :xs="24" :sm="24" :md="24" class="market-quotes-col">
        <el-card class="content-card hover-lift" v-loading="quotesLoading">
          <template #header>
            <div class="card-header-custom">
              <div class="card-title-wrapper">
                <el-icon class="card-icon"><Histogram /></el-icon>
                <span class="card-title-text">实时行情</span>
                <el-button 
                  link 
                  type="primary" 
                  @click="showSearchDialog = true"
                  style="margin-left: 8px"
                >
                  <el-icon><Search /></el-icon>
                  搜索
                </el-button>
                <el-tag size="small" type="success" style="margin-left: 10px" v-if="currentCategory === 'all'">
                  共 {{ totalItems }} 个标的
                </el-tag>
                <el-tag size="small" type="success" style="margin-left: 10px" v-else>
                  {{ getCategoryName(currentCategory) }}: {{ totalItems }} 个
                </el-tag>
                <el-tag 
                  v-if="marketQuotes.length > 0 && marketQuotes[0].dataSource" 
                  size="small" 
                  :type="getDataSourceType(marketQuotes[0].dataSource)"
                  style="margin-left: 10px"
                >
                  {{ marketQuotes[0].dataSource }}
                </el-tag>
              </div>
              <div class="header-actions">
                <el-button 
                  link 
                  :type="currentCategory === 'favorite' ? 'success' : 'primary'" 
                  @click="switchCategory('favorite')"
                >
                  <el-icon><Star /></el-icon>
                  {{ currentCategory === 'favorite' ? '✓ 自选' : '自选' }}
                </el-button>
                <el-button 
                  link 
                  :type="currentCategory === 'all' ? 'success' : 'primary'" 
                  @click="switchCategory('all')"
                >
                  <el-icon><Grid /></el-icon>
                  {{ currentCategory === 'all' ? '✓ 所有' : '所有' }}
                </el-button>
                <el-button 
                  link 
                  :type="currentCategory === 'stock' ? 'success' : 'primary'" 
                  @click="switchCategory('stock')"
                >
                  <el-icon><List /></el-icon>
                  {{ currentCategory === 'stock' ? '✓ 股票' : '股票' }}
                </el-button>
                <el-button 
                  link 
                  :type="currentCategory === 'index' ? 'success' : 'primary'" 
                  @click="switchCategory('index')"
                >
                  <el-icon><TrendCharts /></el-icon>
                  {{ currentCategory === 'index' ? '✓ 指数' : '指数' }}
                </el-button>
                <el-button 
                  link 
                  :type="currentCategory === 'etf' ? 'success' : 'primary'" 
                  @click="switchCategory('etf')"
                >
                  <el-icon><Coin /></el-icon>
                  {{ currentCategory === 'etf' ? '✓ ETF' : 'ETF' }}
                </el-button>
                <el-button
                  link
                  :type="currentCategory === 'bond' ? 'success' : 'primary'"
                  @click="switchCategory('bond')"
                >
                  <el-icon><Document /></el-icon>
                  {{ currentCategory === 'bond' ? '✓ 可转债' : '可转债' }}
                </el-button>
                <el-button
                  link
                  :type="currentCategory === 'futures' ? 'success' : 'primary'"
                  @click="switchCategory('futures')"
                >
                  <el-icon><Histogram /></el-icon>
                  {{ currentCategory === 'futures' ? '✓ 期货' : '期货' }}
                </el-button>
                <el-button link type="primary" @click="loadMarketQuotes" :loading="quotesLoading">
                  <el-icon><Refresh /></el-icon>
                  刷新
                </el-button>
              </div>
            </div>
          </template>
          <div v-if="displayedQuotes.length === 0 && !quotesLoading" class="empty-state-quotes">
            <div class="empty-icon">
              <el-icon :size="80" color="#909399"><TrendCharts /></el-icon>
            </div>
            <div class="empty-title">暂无行情数据</div>
            <div class="empty-description">
              {{ currentCategory === 'favorite' ? '请先添加自选标的' : '正在加载行情数据...' }}
            </div>
            <div class="empty-actions" v-if="currentCategory === 'favorite'">
              <el-button size="large" @click="router.push('/trading')">
                <el-icon><View /></el-icon>
                前往交易页面
              </el-button>
            </div>
          </div>
          <div v-else-if="quotesLoading" class="empty-state-quotes">
            <div class="empty-icon">
              <el-icon :size="80" color="#409eff"><Loading /></el-icon>
            </div>
            <div class="empty-title">正在加载行情数据...</div>
            <div class="empty-description">正在从服务器获取最新行情快照</div>
          </div>
          <div v-else>
            <!-- 统一的行情列表显示 -->
            <div class="quotes-section">
              <div class="section-header">
                <el-icon v-if="currentCategory === 'all'"><Grid /></el-icon>
                <el-icon v-else-if="currentCategory === 'stock'"><List /></el-icon>
                <el-icon v-else-if="currentCategory === 'index'"><TrendCharts /></el-icon>
                <el-icon v-else-if="currentCategory === 'etf'"><Coin /></el-icon>
                <el-icon v-else-if="currentCategory === 'bond'"><Document /></el-icon>
                <span>{{ getCategoryName(currentCategory) }}</span>
                <el-tag size="small" type="success">共 {{ totalItems }} 个标的</el-tag>
                <el-tag size="small" type="info" v-if="totalItems > pageSize">第 {{ currentPage }} 页</el-tag>
              </div>
              <div class="quotes-list">
                <div 
                  v-for="quote in displayedQuotes" 
                  :key="quote.symbol" 
                  class="quote-item"
                  @click="viewQuoteDetail(quote)"
                >
                  <div class="quote-left">
                    <div class="quote-name">
                      {{ quote.name }}
                      <el-tag v-if="quote.isDemo" size="small" type="info" style="margin-left:4px;font-size:10px;">模拟</el-tag>
                    </div>
                    <div class="quote-code">{{ quote.symbol }}</div>
                  </div>
                  <div class="quote-right">
                    <div class="quote-price-info">
                      <div class="quote-price" :class="getChangeClass(quote.change)">
                        {{ quote.price.toFixed(quote.type === 'etf' ? 3 : 2) }}
                      </div>
                      <div class="quote-change" :class="getChangeClass(quote.change)">
                        {{ quote.change > 0 ? '+' : '' }}{{ quote.changePercent.toFixed(2) }}%
                      </div>
                    </div>
                    <el-button
                      :icon="isFavorite(quote.symbol) ? StarFilled : Star"
                      :type="isFavorite(quote.symbol) ? 'warning' : 'default'"
                      size="small"
                      circle
                      @click="toggleFavorite(quote.symbol, $event)"
                      class="favorite-btn"
                      :title="isFavorite(quote.symbol) ? '取消自选' : '加入自选标的'"
                    />
                  </div>
                </div>
              </div>
              <!-- 分页组件 -->
              <div v-if="totalItems > pageSize" class="pagination-wrapper">
                <el-pagination
                  v-model:current-page="currentPage"
                  :page-size="pageSize"
                  :total="totalItems"
                  layout="total, prev, pager, next"
                  @current-change="handlePageChange"
                />
              </div>
            </div>
          </div>
        </el-card>
      </el-col>
      
      <el-col :xs="24" :sm="24" :md="24">
        <el-card class="content-card hover-lift" v-loading="loading">
          <template #header>
            <div class="card-header-custom">
              <div class="card-title-wrapper">
                <el-icon class="card-icon"><TrendCharts /></el-icon>
                <span class="card-title-text">最近策略</span>
              </div>
              <el-button link type="primary" @click="router.push('/strategies')">
                查看全部
                <el-icon><ArrowRight /></el-icon>
              </el-button>
            </div>
          </template>
          <div v-if="recentStrategies.length === 0" class="empty-state">
            <div class="empty-state-custom">
              <img src="/empty-state.jpg" alt="暂无数据" class="empty-image" />
              <p class="empty-text">暂无策略数据</p>
              <el-button type="primary" @click="router.push('/strategies')">
                创建第一个策略
              </el-button>
            </div>
          </div>
          <el-table v-else :data="recentStrategies" style="width: 100%" :show-header="true">
            <el-table-column prop="name" label="策略名称" min-width="120">
              <template #default="scope">
                <div class="strategy-name">
                  <el-icon color="#409eff"><Document /></el-icon>
                  <span>{{ scope.row.name }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="type" label="类型" width="100">
              <template #default="scope">
                <el-tag size="small" type="info">{{ scope.row.type }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="80">
              <template #default="scope">
                <el-tag 
                  size="small" 
                  :type="scope.row.status === 'active' ? 'success' : 'info'"
                >
                  {{ scope.row.status === 'active' ? '活跃' : '草稿' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" align="center">
              <template #default="scope">
                <el-button link type="primary" size="small" @click="viewStrategy(scope.row)">
                  查看
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 搜索对话框 -->
    <el-dialog
      v-model="showSearchDialog"
      title="搜索标的"
      width="600px"
      :close-on-click-modal="false"
    >
      <div class="search-dialog-content">
        <el-input
          v-model="searchKeyword"
          placeholder="输入股票代码或名称搜索..."
          clearable
          @input="handleSearch"
          size="large"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        
        <div class="search-results" v-loading="searchLoading">
          <div v-if="searchResults.length === 0 && searchKeyword" class="empty-search">
            <div class="empty-state-custom">
              <img src="/empty-state.jpg" alt="暂无数据" class="empty-image" />
              <p class="empty-text">未找到匹配的标的</p>
            </div>
          </div>
          <div v-else-if="searchResults.length === 0" class="search-tips">
            <el-icon :size="48" color="#909399"><Search /></el-icon>
            <p>输入股票代码或名称开始搜索</p>
            <div class="search-examples">
              <span>例如: </span>
              <el-tag size="small" @click="searchKeyword = '贵州茅台'">贵州茅台</el-tag>
              <el-tag size="small" @click="searchKeyword = '600519'">600519</el-tag>
              <el-tag size="small" @click="searchKeyword = '沪深300'">沪深300</el-tag>
            </div>
          </div>
          <div v-else class="search-result-list">
            <div 
              v-for="item in searchResults" 
              :key="item.symbol"
              class="search-result-item"
              @click="handleSelectSearchResult(item)"
            >
              <div class="result-left">
                <div class="result-name">{{ item.name }}</div>
                <div class="result-code">{{ item.symbol }}</div>
              </div>
              <div class="result-right">
                <el-tag size="small" :type="item.type === 'index' ? 'primary' : 'success'">
                  {{ item.type === 'index' ? '指数' : item.type === 'stock' ? 'A股' : '期货' }}
                </el-tag>
                <el-button
                  :icon="isFavorite(item.symbol) ? StarFilled : Star"
                  :type="isFavorite(item.symbol) ? 'warning' : 'default'"
                  size="small"
                  circle
                  @click.stop="toggleFavorite(item.symbol, $event)"
                  :title="isFavorite(item.symbol) ? '取消自选' : '加入自选标的'"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { 
  Plus, 
  TrendCharts, 
  Document, 
  DataAnalysis, 
  ShoppingCart,
  CaretTop,
  CaretBottom,
  Histogram,
  Loading,
  Refresh,
  ArrowRight,
  View,
  DataLine,
  List,
  Star,
  StarFilled,
  Search,
  Grid,
  Coin,
  Monitor,
  CopyDocument,
  Picture
} from '@element-plus/icons-vue'
import axios from 'axios'
import { useDashboardHandover } from '@/composables/useDashboardHandover'
import { useDashboardLanAccess } from '@/composables/useDashboardLanAccess'
import { useDashboardQuotes } from '@/composables/useDashboardQuotes'

const router = useRouter()

const {
  lanIpAddress,
  lanAccessUrl,
  showQrCode,
  qrCodeCanvas,
  getLanIpAddress,
  copyLanUrl,
  toggleQrCode
} = useDashboardLanAccess()

const stats = ref({
  strategies: 0,
  backtests: 0,
  trades: 0
})

const trends = ref({
  strategies: 0,
  backtests: 0,
  trades: 0
})

const recentStrategies = ref([])
const recentBacktests = ref([])
const loading = ref(true)

const {
  handoverLoading,
  handoverError,
  handoverSnapshot,
  handoverSummary,
  recentRetentionChanges,
  handoverRealtimeLastEventAt,
  handoverRealtimeLastError,
  handoverRealtimeTagType,
  handoverRealtimeTagText,
  loadHandoverSnapshot,
  startHandoverSseSync,
  stopHandoverSseSync
} = useDashboardHandover()

const {
  marketQuotes,
  currentCategory,
  quotesLoading,
  currentPage,
  pageSize,
  totalItems,
  showSearchDialog,
  searchKeyword,
  searchResults,
  searchLoading,
  displayedQuotes,
  loadMarketQuotes,
  switchCategory,
  handlePageChange,
  toggleFavorite,
  isFavorite,
  loadFavoriteStocks,
  loadFavoriteQuotesData,
  handleSearch,
  handleSelectSearchResult,
  startAutoRefresh,
  cleanupQuotes,
  getCategoryName,
  getDataSourceType
} = useDashboardQuotes({
  onSearchSelect: (item) => {
    router.push(`/trading?symbol=${item.symbol}`)
  }
})

// 加载主页数据
const loadDashboardData = async () => {
  try {
    loading.value = true
    const token = localStorage.getItem('token')
    
    if (!token) {
      ElMessage.error('请先登录')
      router.push('/login')
      return
    }

    const response = await axios.get('/api/dashboard/stats', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })

    if (response.data.success) {
      const data = response.data.data;
      
      console.log('📊 后端返回的数据:', {
        stats: data.stats,
        strategiesCount: data.recentStrategies?.length,
        backtestsCount: data.recentBacktests?.length,
        backtests: data.recentBacktests
      })
      
      // 更新统计数据
      stats.value = data.stats
      trends.value = data.trends
      
      // 更新最近策略
      recentStrategies.value = data.recentStrategies.map(s => ({
        id: s.id,
        name: s.name,
        type: getStrategyTypeLabel(s.type),
        status: s.status,
        language: s.language,
        updatedAt: formatDate(s.updatedAt)
      }))
      
      // 更新最近回测
      recentBacktests.value = data.recentBacktests.map(b => ({
        id: b.id,
        name: b.name,
        status: b.status,
        totalReturn: b.totalReturn,
        createdAt: formatDate(b.createdAt)
      }))
      
      console.log('✅ 主页数据加载成功:', {
        strategies: recentStrategies.value.length,
        backtests: recentBacktests.value.length,
        stats: stats.value
      })
    }
  } catch (error) {
    console.error('加载主页数据失败:', error)
    ElMessage.error(error.response?.data?.message || '加载数据失败')
  } finally {
    loading.value = false
  }
}

// 格式化日期
const formatDate = (dateString) => {
  if (!dateString) return '-'
  const date = new Date(dateString)
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

const formatDateTime = (dateString) => {
  if (!dateString) return '-'
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

const formatRetentionActor = (item) => {
  if (!item || typeof item !== 'object') return 'system'
  const actor = item.actor || 'system'
  const source = item.source ? ` / ${item.source}` : ''
  return `${actor}${source}`
}

// 获取策略类型标签
const getStrategyTypeLabel = (type) => {
  const typeMap = {
    'trend': '趋势',
    'mean_reversion': '均值回归',
    'breakout': '突破',
    'custom': '自定义',
    'grid': '网格',
    'arbitrage': '套利'
  }
  return typeMap[type] || type || '自定义'
}

// 查看策略详情
const viewStrategy = (strategy) => {
  router.push(`/strategies?id=${strategy.id}`)
}

// 查看回测详情
const viewBacktest = (backtest) => {
  router.push(`/backtest-analysis?id=${backtest.id}`)
}

// 查看标的详情
const viewQuoteDetail = (quote) => {
  // 跳转到交易界面,并传递股票代码
  router.push(`/trading?symbol=${quote.symbol}`)
}

// 获取涨跌颜色类
const getChangeClass = (change) => {
  if (change > 0) return 'price-up'
  if (change < 0) return 'price-down'
  return 'price-neutral'
}

// 呼叫AI助手
const callAIAssistant = () => {
  // 触发全局事件显示AI助手
  window.dispatchEvent(new Event('show-ai-assistant'))
  ElMessage.success('小K助手已唤出')
}

onMounted(async () => {
  // 🔥 步骤0: 获取局域网IP
  await getLanIpAddress()
  
  // 🔥 步骤1: 加载自选标的列表
  await loadFavoriteStocks()
  
  // 🔥 步骤2: 加载Dashboard统计数据
  loadDashboardData()

  // 🔥 步骤2.1: 加载跨设备交接快照
  if (localStorage.getItem('token')) {
    loadHandoverSnapshot()
    startHandoverSseSync()
  } else {
    handoverRealtimeLastError.value = '请先登录后启用交接快照实时同步'
  }
  
  // 🔥 步骤3: 自动加载自选标的的行情数据
  console.log('📊 自动加载自选标的行情数据...')
  await loadFavoriteQuotesData()
  
  // 🔥 步骤4: 切换到自选标的分类显示
  currentCategory.value = 'favorite'
  
  // 🔥 步骤5: 启动定时刷新
  startAutoRefresh()
})

onUnmounted(() => {
  cleanupQuotes()
  stopHandoverSseSync()
})
</script>

<style scoped>
.dashboard {
  padding: 0;
}

.handover-row {
  margin-bottom: var(--card-gap);
}

.handover-card {
  border: 1px solid rgba(64, 158, 255, 0.16);
}

.handover-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

.handover-metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: var(--spacing-md);
}

.handover-metric-item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: linear-gradient(180deg, rgba(64, 158, 255, 0.05) 0%, rgba(64, 158, 255, 0.01) 100%);
}

.metric-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.metric-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.1;
}

.handover-retention-block {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
  background: #fff;
}

.handover-retention-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-sm);
}

.retention-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.retention-change-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.retention-change-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--spacing-sm) var(--spacing-md);
}

.retention-change-main {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.retention-actor {
  font-size: 13px;
  color: var(--text-primary);
}

.retention-change-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  font-size: 12px;
  color: var(--text-secondary);
}

.retention-empty {
  font-size: 13px;
  color: var(--text-secondary);
}

.handover-error {
  padding-bottom: var(--spacing-xs);
}

.handover-realtime-meta {
  font-size: 12px;
  color: var(--text-secondary);
}

.handover-realtime-error {
  font-size: 12px;
  color: #e6a23c;
}

.handover-loading {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.handover-loading-icon {
  color: var(--primary-color);
  animation: rotating 1.6s linear infinite;
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Welcome banner: fluid, capped height */
.welcome-banner {
  background: url('/dashboard-bg.jpg') center/cover no-repeat;
  border-radius: var(--radius-xl);
  padding: var(--content-padding) var(--spacing-xl);
  margin-bottom: var(--card-gap);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--card-gap);
  box-shadow: var(--shadow-lg);
  color: white;
  position: relative;
  overflow: visible;
  width: 100%;
  min-height: 140px;
  flex-wrap: wrap;
}

.welcome-banner::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.4) 0%, rgba(118, 75, 162, 0.4) 100%);
  z-index: 1;
  border-radius: inherit;
}

.welcome-content {
  flex: 1;
  position: relative;
  z-index: 2;
}

.welcome-title {
  font-size: 32px;
  font-weight: 700;
  margin: 0 0 var(--spacing-sm) 0;
  color: white;
  text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
}

.welcome-subtitle {
  font-size: 16px;
  margin: 0;
  opacity: 0.95;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
}

.welcome-actions {
  display: flex;
  gap: var(--spacing-md);
  position: relative;
  z-index: 2;
}

.welcome-actions :deep(.el-button) {
  height: 44px;
  padding: 0 var(--spacing-lg);
  font-size: 16px;
  border-radius: var(--radius-md);
}

.welcome-actions :deep(.el-button--primary) {
  background: white;
  color: #667eea;
  border: none;
}

.welcome-actions :deep(.el-button--primary:hover) {
  background: rgba(255, 255, 255, 0.9);
  transform: translateY(-2px);
}

/* 局域网访问信息 */
.lan-access-info {
  position: relative;
  z-index: 2;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  border-radius: var(--radius-md);
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  min-width: 280px;
  overflow: visible;
}

.lan-ip-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: 13px;
  opacity: 0.9;
  font-weight: 500;
}

.lan-ip-address {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  background: rgba(255, 255, 255, 0.2);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.3s ease;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 14px;
  font-weight: 600;
}

.lan-ip-address:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: translateY(-1px);
}

.lan-ip-address .ip-text {
  flex: 1;
  user-select: all;
}

.lan-ip-address .copy-icon {
  opacity: 0.7;
  transition: opacity 0.3s ease;
}

.lan-ip-address:hover .copy-icon {
  opacity: 1;
}

.lan-qr-code {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 14px;
  background: white;
  border-radius: var(--radius-sm);
  margin-top: var(--spacing-xs);
  overflow: visible;
  min-height: 212px;
}

.lan-qr-code canvas {
  display: block;
  width: 200px;
  height: 200px;
  max-width: 100%;
  min-height: 200px;
  border-radius: var(--radius-xs);
}

.qr-toggle-btn {
  color: white !important;
  opacity: 0.9;
}

.qr-toggle-btn:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1) !important;
}

/* 呼叫小K按钮 */
.call-ai-btn {
  position: absolute;
  right: 32px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
  border: 3px solid #FFD700;
  border-radius: 50px;
  color: #FFD700;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 4px 16px rgba(255, 215, 0, 0.3);
  z-index: 10;
}

.call-ai-btn:hover {
  transform: translateY(-50%) scale(1.05);
  box-shadow: 0 8px 24px rgba(255, 215, 0, 0.5);
  border-color: #FFA500;
  color: #FFA500;
}

.call-ai-btn:active {
  transform: translateY(-50%) scale(0.98);
}

.ai-icon-wrapper {
  position: relative;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
}

.ai-avatar {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid #FFD700;
}

.ai-pulse {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 2px solid #FFD700;
  animation: ai-pulse 2s ease-out infinite;
}

@keyframes ai-pulse {
  0% {
    transform: scale(1);
    opacity: 1;
  }
  100% {
    transform: scale(1.5);
    opacity: 0;
  }
}

.ai-text {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  letter-spacing: 0.5px;
}

/* 响应式:移动端调整按钮位置 */
@media (max-width: 768px) {
  .call-ai-btn {
    right: 16px;
    padding: 10px 16px;
    font-size: 14px;
  }
  
  .ai-icon-wrapper {
    width: 32px;
    height: 32px;
  }
  
  .ai-text {
    display: none;
  }
}

.welcome-actions :deep(.el-button--primary:hover) {
  background: rgba(255, 255, 255, 0.9);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.welcome-actions :deep(.el-button--default) {
  background: rgba(255, 255, 255, 0.2);
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.3);
  backdrop-filter: blur(10px);
}

.welcome-actions :deep(.el-button--default:hover) {
  background: rgba(255, 255, 255, 0.3);
  transform: translateY(-2px);
}

/* Stats grid: fluid auto-fit */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--card-gap);
  margin-bottom: var(--card-gap);
}

/* 统计卡片 */
.stat-card {
  background: white;
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  box-shadow: var(--shadow-sm);
  transition: all var(--transition-base);
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border-light);
}

.stat-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  background: linear-gradient(90deg, var(--primary-color), var(--primary-light));
}

.stat-card-primary::before {
  background: linear-gradient(90deg, #409eff, #66b1ff);
}

.stat-card-success::before {
  background: linear-gradient(90deg, #67c23a, #85ce61);
}

.stat-card-warning::before {
  background: linear-gradient(90deg, #e6a23c, #ebb563);
}

.stat-card-danger::before {
  background: linear-gradient(90deg, #f56c6c, #f78989);
}

.stat-icon-wrapper {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--spacing-md);
  box-shadow: var(--shadow-md);
}

.stat-icon-large {
  font-size: 28px;
  color: white;
}

.stat-content {
  margin-bottom: var(--spacing-sm);
}

.stat-value {
  font-size: 36px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1;
  margin-bottom: var(--spacing-xs);
}

.stat-label {
  font-size: 14px;
  color: var(--text-secondary);
  font-weight: 500;
}

.stat-trend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  font-weight: 600;
}

/* Content row */
.content-row {
  margin-top: var(--card-gap);
}

/* 内容卡片 */
.content-card {
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-light);
  transition: all var(--transition-base);
}

.content-card :deep(.el-card__header) {
  background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
  border-bottom: 2px solid var(--border-light);
  padding: var(--spacing-md) var(--spacing-lg);
}

.card-header-custom {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-title-wrapper {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.card-icon {
  font-size: 20px;
  color: var(--primary-color);
}

.card-title-text {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

/* 策略名称 */
.strategy-name {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

/* 表格优化 */
.content-card :deep(.el-table) {
  font-size: 14px;
}

.content-card :deep(.el-table th) {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-weight: 600;
}

.content-card :deep(.el-table td) {
  padding: 12px 0;
}

.content-card :deep(.el-table__row:hover) {
  background: var(--bg-secondary);
}

/* 响应式 */
@media (max-width: 768px) {
  .welcome-banner {
    flex-direction: column;
    text-align: center;
    padding: var(--spacing-xl) var(--spacing-lg);
  }
  
  .welcome-title {
    font-size: 24px;
  }
  
  .welcome-actions {
    margin-top: var(--spacing-lg);
    width: 100%;
    flex-direction: column;
  }
  
  .welcome-actions :deep(.el-button) {
    width: 100%;
  }
  
  /* 移动端局域网访问信息 */
  .lan-access-info {
    width: 100%;
    min-width: auto;
    order: 2; /* 放在中间位置 */
  }
  
  .lan-ip-address {
    font-size: 13px;
  }
  
  .lan-qr-code canvas {
    width: 160px !important;
    height: 160px !important;
    min-height: 160px !important;
  }
  
  .stat-value {
    font-size: 28px;
  }
  
  .content-row {
    margin-top: var(--spacing-lg);
  }
  
  .quote-item {
    padding: var(--spacing-sm) var(--spacing-md);
  }
  
  .quote-name {
    font-size: 14px;
  }
  
  .quote-price {
    font-size: 16px;
  }
}

@media (max-width: 480px) {
  .quote-price {
    font-size: 15px;
  }
  
  .quote-change {
    font-size: 12px;
  }
}

/* 搜索对话框样式 */
.search-dialog-content {
  padding: var(--spacing-md) 0;
}

.search-dialog-content .el-input {
  margin-bottom: var(--spacing-lg);
}

.search-results {
  min-height: 300px;
  max-height: 500px;
  overflow-y: auto;
}

.empty-search {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 300px;
}

.search-tips {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  color: var(--text-secondary);
}

.search-tips p {
  margin: var(--spacing-md) 0;
  font-size: 16px;
}

.search-examples {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-md);
}

.search-examples .el-tag {
  cursor: pointer;
  transition: all var(--transition-base);
}

.search-examples .el-tag:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}

.search-result-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.search-result-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md);
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-base);
  border: 1px solid var(--border-light);
}

.search-result-item:hover {
  background: var(--bg-tertiary);
  transform: translateX(4px);
  box-shadow: var(--shadow-sm);
  border-color: var(--primary-color);
}

.result-left {
  flex: 1;
}

.result-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.result-code {
  font-size: 13px;
  color: var(--text-secondary);
  font-family: 'Courier New', monospace;
}

.result-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

/* 市场行情列表 */
.market-quotes-col {
  margin-bottom: var(--spacing-xl);
}

.header-actions {
  display: flex;
  gap: var(--spacing-sm);
  align-items: center;
}

/* 行情列表样式 - 简洁版 */
.quotes-list {
  padding: 0;
}

.quote-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--border-light);
  cursor: pointer;
  transition: all var(--transition-base);
}

.quote-item:hover {
  background: var(--bg-secondary);
}

.quote-item:last-child {
  border-bottom: none;
}

.quote-left {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.quote-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.quote-code {
  font-size: 12px;
  color: var(--text-tertiary);
}

.quote-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.quote-price-info {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.quote-price {
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}

.quote-change {
  font-size: 13px;
  font-weight: 600;
}

.favorite-btn {
  flex-shrink: 0;
  transition: all var(--transition-base);
}

.favorite-btn:hover {
  transform: scale(1.1);
}

.favorite-btn :deep(.el-icon) {
  font-size: 16px;
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

/* 空状态样式 */
.empty-state {
  padding: var(--spacing-xl) 0;
  text-align: center;
}

.empty-state :deep(.el-empty__description) {
  color: var(--text-secondary);
  font-size: 14px;
}

.empty-state :deep(.el-button) {
  margin-top: var(--spacing-md);
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
  font-size: 16px;
  color: #909399;
  margin-bottom: 20px;
  font-weight: 500;
}

/* 行情空状态样式 */
.empty-state-quotes {
  padding: var(--spacing-3xl) var(--spacing-xl);
  text-align: center;
  background: linear-gradient(135deg, #f5f7fa 0%, #e8eef5 100%);
  border-radius: var(--radius-lg);
  margin: var(--spacing-md);
}

.empty-icon {
  margin-bottom: var(--spacing-lg);
  opacity: 0.6;
}

.empty-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: var(--spacing-sm);
}

.empty-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: var(--spacing-xl);
}

.empty-actions {
  display: flex;
  gap: var(--spacing-md);
  justify-content: center;
  flex-wrap: wrap;
}

.empty-actions :deep(.el-button) {
  min-width: 140px;
  height: 44px;
  font-size: 15px;
  border-radius: var(--radius-md);
}

.empty-actions :deep(.el-button--primary) {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

.empty-actions :deep(.el-button--primary:hover) {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(102, 126, 234, 0.5);
}

.empty-actions :deep(.el-button--default) {
  background: white;
  border: 1px solid var(--border-base);
}

.empty-actions :deep(.el-button--default:hover) {
  border-color: var(--primary-color);
  color: var(--primary-color);
  transform: translateY(-2px);
}

/* 加载状态优化 */
:deep(.el-loading-mask) {
  background-color: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(2px);
}

/* 自选标的区域样式 */
.favorite-section {
  background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  margin-top: var(--spacing-md);
  box-shadow: 0 4px 12px rgba(245, 87, 108, 0.15);
}

.favorite-section .section-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-md);
  color: white;
  font-size: 18px;
  font-weight: 600;
}

.favorite-section .section-header .el-icon {
  font-size: 24px;
}

.favorite-section .empty-favorites {
  background: rgba(255, 255, 255, 0.95);
  border-radius: var(--radius-md);
  padding: var(--spacing-xl);
  text-align: center;
}

.favorite-section .quotes-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--spacing-md);
}

.favorite-section .quote-item {
  background: rgba(255, 255, 255, 0.95);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-base);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.favorite-section .quote-item:hover {
  transform: translateY(-4px);
  box-shadow: 0 6px 20px rgba(245, 87, 108, 0.25);
  background: white;
}

/* 指数区域样式 */
.index-section {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  margin-top: var(--spacing-md);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.15);
}

.index-section .section-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-md);
  color: white;
  font-size: 18px;
  font-weight: 600;
}

.index-section .section-header .el-icon {
  font-size: 24px;
}

.index-section .quotes-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--spacing-md);
}

.index-section .quote-item {
  background: rgba(255, 255, 255, 0.95);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-base);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.index-section .quote-item:hover {
  transform: translateY(-4px);
  box-shadow: 0 6px 20px rgba(102, 126, 234, 0.25);
  background: white;
}

/* A股区域样式 */
.a-stock-section {
  margin-top: var(--spacing-md);
}

.section-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md) var(--spacing-lg);
  background: linear-gradient(135deg, #f5f7fa 0%, #e8eef5 100%);
  border-radius: var(--radius-md);
  margin-bottom: var(--spacing-md);
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-header .el-icon {
  font-size: 20px;
  color: var(--primary-color);
}

/* 分页样式 */
.pagination-wrapper {
  display: flex;
  justify-content: center;
  padding: var(--spacing-lg) 0;
  margin-top: var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

.pagination-wrapper :deep(.el-pagination) {
  font-weight: 500;
}

.pagination-wrapper :deep(.el-pager li) {
  min-width: 32px;
  height: 32px;
  line-height: 32px;
  border-radius: var(--radius-sm);
}

.pagination-wrapper :deep(.el-pager li.is-active) {
  background: var(--primary-color);
  color: white;
}

</style>
