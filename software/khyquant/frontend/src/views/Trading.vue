<template>

  <div class="professional-trading" :class="{ 'mobile-mode': isMobile }">

    <!-- 顶部股票信息栏 -->

    <div class="stock-info-bar" :class="{ 'mobile': isMobile }">

      <!-- PC端股票选择器 -->

      <div class="stock-selector" v-if="!isMobile">

        <el-select

          v-model="selectedSymbol"

          placeholder="选择标的"

          @change="onSymbolChange"

          class="symbol-select"

          filterable
          remote
          :remote-method="remoteSearchSymbol"
          :loading="symbolSearchLoading"

        >

          <!-- 🔥 显示所有标的,不再限制为自选标的 -->

          <el-option

            v-for="symbol in safeSymbolList"

            :key="symbol.code"

            :label="`${symbol.code} ${symbol.name}`"

            :value="symbol.code"

          >

            <span class="option-code">{{ symbol.code }}</span>

            <span class="option-name">{{ symbol.name }}</span>

            <!-- 🔥 如果是自选标的,显示星标 -->

            <el-icon v-if="isFavoriteSymbol(symbol.code)" style="color: #f7ba2a; margin-left: 8px;">

              <StarFilled />

            </el-icon>

          </el-option>

          <template v-if="safeSymbolList.length === 0">

            <el-option disabled value="" label="正在加载标的列表..." />

          </template>

        </el-select>

      </div>



      <!-- Mobile symbol quick-select -->

      <div v-if="isMobile" class="mobile-symbol-chip" @click="showMobileSymbolPicker = true">

        <span>{{ currentStock.code }}</span>

        <el-icon :size="14"><ArrowDown /></el-icon>

      </div>



      <!-- 移动端紧凑布局 -->

      <div class="current-stock" :class="{ 'mobile': isMobile }">

        <span class="symbol">{{ currentStock.code }}</span>

        <span class="name" v-if="!isMobile">{{ currentStock.name }}</span>

        <span class="price" :class="getPriceClass(currentStock.change)">

          {{ currentStock.price || '--' }}

        </span>

        <span class="change" :class="getPriceClass(currentStock.change)">

          {{ currentStock.change > 0 ? '+' : '' }}{{ currentStock.change || '--' }}

          ({{ currentStock.changePercent || '--' }}%)

        </span>

        <span v-if="currentStock.dataSource" class="data-source-badge" :class="{ 'real-data': currentStock.dataSource !== '增强模拟数据' }">

          {{ currentStock.dataSource }}

        </span>

      </div>

      

      <!-- Replay mode toggle -->

      <el-button

        v-if="!isMobile"

        :type="isReplayMode ? 'warning' : ''"

        size="small"

        @click="toggleReplayMode"

        style="margin-left: 12px;"

      >

        {{ isReplayMode ? '退出回放' : '数据回放' }}

      </el-button>



      <!-- 移动端隐藏详细信息 -->

      <div class="stock-details" v-if="!isMobile">

        <span class="detail-item">开: <span class="value">{{ currentStock.open }}</span></span>

        <span class="detail-item">高: <span class="value price-up">{{ currentStock.high }}</span></span>

        <span class="detail-item">低: <span class="value price-down">{{ currentStock.low }}</span></span>

        <span class="detail-item">昨收: <span class="value">{{ currentStock.prevClose }}</span></span>

        <span class="detail-item">量: <span class="value">{{ formatVolume(currentStock.volume) }}</span></span>

        <span class="detail-item">额: <span class="value">{{ formatAmount(currentStock.amount) }}</span></span>

      </div>

    </div>



    <!-- 主要内容区域 -->

    <div class="main-content">

      <!-- 左侧智能策略面板 - 移动端隐藏 -->

      <div class="left-panel" v-if="!isMobile" :class="{ 'is-collapsed': isLeftPanelCollapsed }">

        <IntelligentStrategySelector

          v-if="!isLeftPanelCollapsed"

          :current-symbol="selectedSymbol"

          :market-data="currentStock"

          :external-strategies="selectorStrategies"

          @strategy-selected="handleStrategySelected"

          @strategy-applied="handleStrategyApplied"

          @signals-generated="handleSignalsGenerated"

        />

        

        <!-- 左侧面板收缩按钮 -->

        <div class="left-panel-toggle-btn" @click="toggleLeftPanel">

          <el-icon>

            <DArrowRight v-if="isLeftPanelCollapsed" />

            <DArrowLeft v-else />

          </el-icon>

        </div>

      </div>



      <!-- 中间K线图区域 -->

      <div class="center-panel" :class="{ 'full-width': isLeftPanelCollapsed || isMobile }">

        <!-- 策略信号控制栏 -->

        <div class="strategy-control-bar" v-if="loadedStrategy">

          <div class="strategy-info">

            <span class="strategy-name">{{ loadedStrategy.name }}</span>

            <el-tag :type="getStrategyStatusColor(loadedStrategy.status)" size="small">

              {{ getStrategyStatusText(loadedStrategy.status) }}

            </el-tag>

            <span class="strategy-symbol">{{ currentStock.code }}</span>

          </div>

          <div class="strategy-actions">

            <el-button size="small" @click="refreshStrategySignals" :loading="loadingSignals">

              <el-icon><Refresh /></el-icon>

              刷新信号

            </el-button>

            <el-button size="small" type="danger" @click="unloadStrategy">

              卸载策略

            </el-button>

          </div>

        </div>



        <!-- Replay mode control bar -->

        <transition name="slide-down">

          <div v-if="isReplayMode" class="replay-control-bar">

            <!-- Left: config -->

            <div class="replay-config">

              <el-button

                type="warning"

                size="small"

                @click="toggleReplayMode"

              >

                退出回放

              </el-button>

              <el-radio-group v-model="replayDataSource" size="small" @change="onReplayDataSourceChange">

                <el-radio-button value="mock">模拟</el-radio-button>

                <el-radio-button value="futures-tick">Tick</el-radio-button>

              </el-radio-group>

              <template v-if="replayDataSource === 'mock'">

                <el-date-picker

                  v-model="replayStartDate"

                  type="date"

                  placeholder="开始日期"

                  value-format="YYYY-MM-DD"

                  size="small"

                  style="width: 140px;"

                />

              </template>

              <template v-if="replayDataSource === 'futures-tick'">

                <el-select v-model="replayTickDate" placeholder="日期" size="small" style="width:130px;" @change="onReplayTickDateChange" :loading="replayFtLoading">

                  <el-option v-for="d in replayFtDates" :key="d" :label="formatReplayTickDate(d)" :value="d" />

                </el-select>

                <el-select v-model="selectedSymbol" filterable placeholder="合约" size="small" style="width:120px;" :loading="replayFtLoading">

                  <el-option v-for="s in replayFtSymbols" :key="s" :label="s" :value="s" />

                </el-select>

              </template>

              <el-select v-model="replayStrategy" placeholder="策略（可选）" size="small" style="width: 150px;" clearable>

                <el-option

                  v-for="s in selectorStrategies"

                  :key="s.id || s.type"

                  :label="s.name"

                  :value="s.id || s.type"

                />

              </el-select>

              <el-button type="primary" size="small" @click="startReplay" :loading="replayLoading">

                开始回放

              </el-button>

            </div>



            <!-- Center: playback controls (only show after session started) -->

            <div v-if="replaySessionId" class="replay-controls">

              <el-button size="small" @click="replayStep(1)" :disabled="replayIndex <= 0">+1</el-button>

              <el-button

                :type="replayPlaying ? 'warning' : 'primary'"

                size="small"

                @click="replayPlaying ? pauseReplay() : playReplay()"

              >

                {{ replayPlaying ? '暂停' : '播放' }}

              </el-button>

              <el-button size="small" @click="replayStep(10)">+10</el-button>

              <el-select v-model="replaySpeed" size="small" style="width: 80px;">

                <el-option label="0.5x" :value="2000" />

                <el-option label="1x" :value="1000" />

                <el-option label="2x" :value="500" />

                <el-option label="5x" :value="200" />

                <el-option label="10x" :value="100" />

              </el-select>

              <span class="replay-info">

                {{ replayCurrentDate }} | {{ replayProgress }}% |

                <span style="color:#67c23a;">买入: {{ replayBuyCount }}</span> /

                <span style="color:#f56c6c;">卖出: {{ replaySellCount }}</span>

              </span>

            </div>



            <!-- Right: account -->

            <div v-if="replaySessionId" class="replay-account">

              <span>现金: <b style="color:#409eff;">{{ replayCash.toLocaleString() }}</b></span>

              <span style="margin-left:12px;">

                收益率:

                <b :style="{color: replayReturn >= 0 ? '#67c23a' : '#f56c6c'}">

                  {{ replayReturn >= 0 ? '+' : '' }}{{ replayReturn.toFixed(2) }}%

                </b>

              </span>

            </div>

          </div>

        </transition>



        <!-- 新的简洁交易界面 -->

        <div class="unified-interface-container">

          <SimpleTradingInterface

            :contract="selectedSymbol"

            :contract-name="currentStock.name"

            :period="currentPeriod"

            :signals="strategySignals"

            :auxiliary-data="strategyAuxiliaryData"

            :loaded-strategy="loadedStrategy"

            :current-price="currentStock.price"

            :available-funds="accountInfo.availableFunds"

            :replay-data="isReplayMode ? replayChartData : null"

            :replay-signals="replaySignals"

            :enabled-periods="enabledPeriods"

            @contract-change="handleContractChange"

            @period-change="handlePeriodChange"

            @signal-loaded="handleSignalLoaded"

            @order-placed="handleOrderPlaced"

            @price-update="handlePriceUpdate"

            @navigate-to-backtest-analysis="handleNavigateToBacktestAnalysis"

          />

        </div>



        <!-- Sub-charts removed — Bollinger Bands now overlaid on main chart -->

      </div>

    </div>



    <!-- Mobile: FAB trade button (bottom-right) -->

    <button

      v-if="isMobile && !mobileDrawerOpen"

      class="mobile-fab-trade"

      @click="mobileDrawerOpen = true"

    >

      <el-icon :size="24"><TrendCharts /></el-icon>

    </button>



    <!-- Mobile: FAB bot button (bottom-left) -->

    <button

      v-if="isMobile"

      class="mobile-fab-bot"

      @click="$emit('open-bot')"

    >

      <el-icon :size="20">

        <ChatDotRound />

      </el-icon>

    </button>



    <!-- Mobile: Symbol picker overlay -->

    <Teleport to="body">

      <Transition name="fade">

        <div v-if="showMobileSymbolPicker" class="mobile-symbol-overlay" @click.self="showMobileSymbolPicker = false">

          <div class="mobile-symbol-sheet">

            <div class="sheet-handle" />

            <h3 class="sheet-title">选择标的</h3>

            <input

              v-model="symbolSearchQuery"

              class="sheet-search"

              placeholder="搜索代码或名称..."

            />

            <div class="sheet-list">

              <div

                v-for="s in filteredMobileSymbols"

                :key="s.code"

                class="sheet-symbol-item"

                :class="{ active: s.code === selectedSymbol }"

                @click="onSymbolChange(s.code); showMobileSymbolPicker = false"

              >

                <span class="sym-code">{{ s.code }}</span>

                <span class="sym-name">{{ s.name }}</span>

              </div>

            </div>

          </div>

        </div>

      </Transition>

    </Teleport>



    <!-- Mobile: Bottom drawer -->

    <Teleport to="body">

      <Transition name="slide-up">

        <div v-if="isMobile && mobileDrawerOpen" class="mobile-drawer-overlay" @click.self="mobileDrawerOpen = false">

          <div

            class="mobile-bottom-drawer"

            :style="{ height: mobileDrawerHeight + 'vh' }"

            @touchstart="onDrawerTouchStart"

            @touchmove="onDrawerTouchMove"

            @touchend="onDrawerTouchEnd"

          >

            <div class="drawer-drag-handle" />

            <div class="drawer-content">

              <div class="drawer-section">

                <h3 class="drawer-section-title">Quick Trade — {{ currentStock.code }}</h3>

                <div class="drawer-price-row">

                  <span class="drawer-price" :class="getPriceClass(currentStock.change)">{{ currentStock.price || '--' }}</span>

                  <span class="drawer-change" :class="getPriceClass(currentStock.change)">

                    {{ currentStock.change > 0 ? '+' : '' }}{{ currentStock.changePercent || '0' }}%

                  </span>

                </div>

              </div>

              <div class="drawer-section">

                <div class="drawer-order-type">

                  <button

                    class="order-type-btn"

                    :class="{ active: mobileOrderSide === 'buy' }"

                    @click="mobileOrderSide = 'buy'"

                  >买入</button>

                  <button

                    class="order-type-btn sell"

                    :class="{ active: mobileOrderSide === 'sell' }"

                    @click="mobileOrderSide = 'sell'"

                  >卖出</button>

                </div>

                <div class="drawer-input-row">

                  <label>价格</label>

                  <input v-model.number="mobileOrderPrice" type="number" class="drawer-input" :placeholder="String(currentStock.price || 0)" />

                </div>

                <div class="drawer-input-row">

                  <label>数量</label>

                  <input v-model.number="mobileOrderQty" type="number" class="drawer-input" placeholder="100" />

                </div>

                <div class="drawer-quick-qty">

                  <button v-for="pct in [25, 50, 75, 100]" :key="pct" class="quick-qty-btn" @click="setQuickQty(pct)">{{ pct }}%</button>

                </div>

                <button

                  class="drawer-submit-btn"

                  :class="mobileOrderSide"

                  @click="submitMobileOrder"

                >

                  {{ mobileOrderSide === 'buy' ? '买入' : '卖出' }} {{ mobileOrderQty || 0 }} 股

                </button>

              </div>



              <!-- Positions panel (swipe up to reveal) -->

              <div class="drawer-section" v-if="mobileDrawerHeight >= 70">

                <h3 class="drawer-section-title">持仓</h3>

                <div class="drawer-positions-placeholder">

                  <span style="color: #888; font-size: 13px;">暂无持仓</span>

                </div>

              </div>

            </div>

          </div>

        </div>

      </Transition>

    </Teleport>



    <!-- 桌面端：底部状态栏 -->

    <div class="bottom-status" v-if="!isMobile">

      <div class="status-left">

        <span class="status-item">连接状态: 已连接</span>

        <span class="status-item">延迟: 15ms</span>

        <span class="status-item">更新时间: {{ lastUpdateTime }}</span>

      </div>

      <div class="status-right">

        <span class="status-item" v-if="selectedSymbol === 'sh000300'">

          {{ currentStock.name }}: {{ currentStock.price }} 

          <span :class="getPriceClass(currentStock.change)">

            ({{ currentStock.change > 0 ? '+' : '' }}{{ currentStock.changePercent }}%)

          </span>

        </span>

        <template v-else>

          <span class="status-item">当前: {{ currentStock.name }} {{ currentStock.price }}</span>

        </template>

      </div>

    </div>

  </div>

</template>



<script setup>
// ---------------------------------------------------------------------------
// Trading —— 主交易工作台页面（系统最核心的页面）
//
// 架构角色：属于前端交互层（对应论文第5.5节，图2）
//   这是整个量化交易系统的主操作界面，组合了多个子组件：
//   - ProfessionalTradingChart: 专业K线图（类TradingView风格）
//   - IntelligentStrategySelector: 智能策略适配面板（论文4.3节）
//   - SimpleTradingInterface: 下单与持仓管理面板
//   - TradingAgentsBotSimple: 多智能体AI助手浮动机器人（论文4.4节）
//
// 数据流向（事件驱动，对应论文3.1节核心链路）：
//   1. 用户选择股票代码 → onSymbolChange() → 更新 currentStock
//   2. K线数据通过 priceDataService 四级回退加载（论文4.5节，表15）
//   3. 策略信号从 IntelligentStrategySelector 组件 emit 发出
//   4. 交易订单通过 tradeAPI 提交 → 后端REST API → WebSocket推送确认
//
// 响应式设计：
//   使用 useResponsive() 组合式函数，自动适配 PC/平板/手机三种布局
// ---------------------------------------------------------------------------

// ==================== 依赖导入 ====================
// Vue 3 核心API（Composition API 风格）
import { ref, computed, onMounted, onUnmounted, nextTick, watch, defineAsyncComponent } from 'vue'
// Vue Router —— 页面跳转
import { useRouter } from 'vue-router'
// Element Plus UI 组件与图标
import { ElMessage } from 'element-plus'
import { Refresh, Loading, DArrowLeft, DArrowRight, TrendCharts, ArrowDown, ChatDotRound } from '@element-plus/icons-vue'

// ==================== 子组件导入 (lazy-loaded for performance) ====================
// 下单与持仓管理面板
const SimpleTradingInterface = defineAsyncComponent(() => import('@/components/SimpleTradingInterface.vue'))
// 智能策略适配面板（论文4.3节）
const IntelligentStrategySelector = defineAsyncComponent(() => import('@/components/IntelligentStrategySelector.vue'))

// Mobile components removed — using inline implementations

// ==================== 业务模块导入 ====================
// Pinia 策略状态管理
import { useStrategyStore } from '@/stores/strategyStore'
// 策略执行API（对应论文4.3节策略适配层）
import { executeStrategy } from '@/api/strategy'
// 统一的 Axios 请求封装（带拦截器、token注入）
import request from '@/utils/request'
// 数组安全工具（防止后端返回非数组导致前端崩溃）
import { ensureArray, addArrayWatchGuard, validateApiArrayField } from '@/utils/arrayGuards'
// 响应式布局组合式函数（PC/平板/手机三端适配）
import { useResponsive } from '@/composables/useResponsive'
// 期货实时Tick数据组合式函数
import { useFuturesTickData } from '@/composables/useFuturesTickData'
// 交易API（下单、撤单、查持仓）
import { tradeAPI } from '@/api/trade'
// 价格数据服务（封装了四级回退机制，论文4.5节表15）
import priceDataService from '@/services/priceDataService'
// 沙箱执行器（安全执行用户自定义策略代码）
import { executeSandbox } from '@/utils/sandboxExecute'



// ==================== 路由与响应式布局管理 ====================
// useRouter: Vue Router 实例，用于页面跳转
const router = useRouter()



// 响应式布局管理器（对应论文5.5节：PC/平板/手机三端自适应）
// isMobile/isTablet/isDesktop: 设备类型判断
// viewportMode: 当前视口模式（用于条件渲染不同布局）
const { isMobile, isTablet, isDesktop, isPortrait, isLandscape, viewportMode, getMobileConfig } = useResponsive()



// ==================== 移动端交互状态 ====================
// 底部抽屉面板（移动端专用，用于在小屏幕上展示下单界面）
const drawerState = ref('collapsed')



// 移动端底部抽屉的开关与高度控制
const mobileDrawerOpen = ref(false)

const mobileDrawerHeight = ref(40) // 40vh default, expandable to 80vh

const mobileOrderSide = ref('buy')

const mobileOrderPrice = ref(null)

const mobileOrderQty = ref(100)

const showMobileSymbolPicker = ref(false)

const symbolSearchQuery = ref('')



// Filtered symbols for mobile picker

const filteredMobileSymbols = computed(() => {

  const q = symbolSearchQuery.value.toLowerCase()

  const list = safeSymbolList.value

  if (!q) return list.slice(0, 50) // limit for performance

  return list.filter(s => s.code.toLowerCase().includes(q) || (s.name && s.name.toLowerCase().includes(q))).slice(0, 50)

})



// Drawer drag handling

let drawerTouchStartY = 0

let drawerTouchStartHeight = 0



const onDrawerTouchStart = (e) => {

  drawerTouchStartY = e.touches[0].clientY

  drawerTouchStartHeight = mobileDrawerHeight.value

}



const onDrawerTouchMove = (e) => {

  const dy = drawerTouchStartY - e.touches[0].clientY

  const dvh = (dy / window.innerHeight) * 100

  mobileDrawerHeight.value = Math.max(30, Math.min(85, drawerTouchStartHeight + dvh))

}



const onDrawerTouchEnd = () => {

  // Snap to 40 or 80

  if (mobileDrawerHeight.value > 60) {

    mobileDrawerHeight.value = 80

  } else {

    mobileDrawerHeight.value = 40

  }

}



const setQuickQty = (pct) => {

  const maxQty = Math.floor(accountInfo.value.availableFunds / (mobileOrderPrice.value || currentStock.value.price || 1))

  mobileOrderQty.value = Math.floor(maxQty * pct / 100 / 100) * 100 // round to 100

}



const submitMobileOrder = () => {

  const price = mobileOrderPrice.value || currentStock.value.price

  handleOrderPlaced({

    type: mobileOrderSide.value,

    price,

    volume: mobileOrderQty.value,

    symbol: selectedSymbol.value

  })

  mobileDrawerOpen.value = false

}



// Mobile strategy selector state

const showMobileStrategySelector = ref(false)



// ==================== 账户与交易核心状态 ====================
// 账户信息（资金、持仓、盈亏等，页面初始化时从后端拉取）
const accountInfo = ref({

  availableFunds: 100000,

  totalAssets: 180373,

  marketValue: 130373,

  todayProfit: 80373,

  profitRate: 44.65

})



// 🔥 获取账户信息

const fetchAccountInfo = async () => {

  try {

    const response = await tradeAPI.getAccount()

    if (response.success) {

      accountInfo.value = response.data

      console.log('✅ 账户信息已更新:', accountInfo.value)

    }

  } catch (error) {

    console.error('❌ 获取账户信息失败:', error)

    // 保持默认值，不影响用户体验

  }

}



// ==================== 标的列表与策略信号 ====================
// 金融工具列表（股票/期货/指数等，通过 loadSymbolList 加载）
const symbolList = ref([])



// 策略加载相关（对应论文4.3节：策略适配层）
const loadedStrategy = ref(null) // 当前加载的策略
const strategySignals = ref([]) // 策略信号（买入/卖出标记，叠加在K线图上）
const strategyAuxiliaryData = ref({}) // 策略辅助数据（如均线、MACD等指标）



// 🔥 添加watch守卫，确保数组变量始终是数组

addArrayWatchGuard(symbolList, 'symbolList', watch)

addArrayWatchGuard(strategySignals, 'strategySignals', watch)



// 🔥 安全的 symbolList 计算属性，确保始终返回数组

const safeSymbolList = computed(() => {
  // 有搜索结果时显示搜索结果，否则显示默认列表（限制数量避免卡顿）
  if (symbolSearchResults.value.length > 0) {
    return symbolSearchResults.value
  }
  const list = ensureArray(symbolList.value, [], 'symbolList')
  return list.slice(0, 200) // 默认只显示前200条，搜索时才显示更多
})



const indexList = computed(() => {

  const symbols = ensureArray(symbolList.value, [], 'symbolList')

  return symbols.filter(s => s.type === 'index')

})



const stockList = computed(() => {

  const symbols = ensureArray(symbolList.value, [], 'symbolList')

  return symbols.filter(s => s.type === 'stock')

})



const futuresList = computed(() => {

  const symbols = ensureArray(symbolList.value, [], 'symbolList')

  return symbols.filter(s => s.type === 'futures')

})



// 自选标的列表

const favoriteStocks = ref(new Set())

const symbolListLoading = ref(false) // 标的列表加载状态
const symbolSearchLoading = ref(false) // 远程搜索加载状态
const symbolSearchResults = ref([]) // 远程搜索结果

const loadingSymbols = ref(false) // 移动端标的加载状态



const favoriteList = computed(() => {

  // 🔥 确保 symbolList.value 是数组

  const symbols = ensureArray(symbolList.value, [], 'symbolList')

  

  // 如果symbolList还在加载或为空,返回空数组

  if (symbolListLoading.value || symbols.length === 0) {

    return []

  }

  

  // 如果没有自选标的,返回空数组

  if (favoriteStocks.value.size === 0) {

    return []

  }

  

  // 从symbolList中筛选出自选标的

  // 注意: favoriteStocks存储的是不带前缀的代码(如'600000'),而symbolList的code可能带前缀(如'sh600000')

  // 所以需要去掉前缀进行匹配

  const result = symbols.filter(s => {

    // 去掉sh/sz前缀

    const codeWithoutPrefix = s.code.replace(/^(sh|sz)/, '')

    

    // 尝试两种匹配方式:

    // 1. 直接匹配完整代码(如果favoriteStocks存储的是带前缀的)

    // 2. 匹配去掉前缀后的代码(如果favoriteStocks存储的是不带前缀的)

    return favoriteStocks.value.has(s.code) || favoriteStocks.value.has(codeWithoutPrefix)

  })

  

  return result

})



const selectedSymbol = ref('sh000300') // 默认选择沪深300



// 左侧面板收缩状态

const isLeftPanelCollapsed = ref(false)



// 切换左侧面板

const toggleLeftPanel = () => {

  isLeftPanelCollapsed.value = !isLeftPanelCollapsed.value

  

  console.log('📊 左侧面板折叠状态改变:', isLeftPanelCollapsed.value ? '已折叠' : '已展开')

  

  // 不再触发全局resize事件，避免影响右侧面板

  // 图表会通过CSS flex自动调整大小

}



// 界面切换 - 移除，现在使用统一界面

// const useProfessionalInterface = ref(false) // 已移除，使用统一界面



// 策略状态管理

const strategyStore = useStrategyStore()



// 注意：loadedStrategy、strategySignals、strategyAuxiliaryData 已在前面声明（第180-183行）

const showStrategySignals = ref(true) // 是否显示策略信号

const loadingSignals = ref(false) // 是否正在加载信号



// K线图数据（适配StrategyKLineChart格式）

const chartData = ref({

  kline: [],

  isMock: false,

  indicators: {

    ma5: [],

    ma10: [],

    ma20: [],

    ma30: []

  }

})



// 策略实时状态

const strategyRealTimeStats = ref({

  totalReturn: 0,

  todayReturn: 0,

  totalTrades: 0,

  winRate: 0,

  maxDrawdown: 0,

  sharpeRatio: 0

})



// 最新信号

const latestSignals = ref([])



// 策略运行状态更新定时器

let strategyStatusTimer = null



// 当前股票信息（初始值为0，等待SimpleTradingInterface发送真实价格）

const currentStock = ref({

  code: selectedSymbol.value, // 🔥 修复：使用 selectedSymbol 的值，而不是硬编码

  name: '加载中...', // 🔥 修复：初始值改为"加载中..."，等待真实数据

  price: 0,

  open: 0,

  high: 0,

  low: 0,

  volume: 0,

  amount: 0,

  change: 0,

  changePercent: 0,

  prevClose: 0,

  dataSource: '加载中...' // 新增：数据源标记

})



// 图表相关

const currentPeriod = ref('1d')

const lastUpdateTime = ref('')

const selectedIndicators = ref(['MA']) // 添加缺失的指标选择



// All possible period definitions
const allPeriodOptions = [
  { label: '1分', value: '1m' },
  { label: '5分', value: '5m' },
  { label: '15分', value: '15m' },
  { label: '30分', value: '30m' },
  { label: '1小时', value: '1h' },
  { label: '日线', value: '1d' },
  { label: '周线', value: '1w' },
  { label: '月线', value: '1M' }
]

// Enabled periods from admin settings (default: daily only)
const enabledPeriods = ref(['daily'])

const timePeriods = computed(() => {
  // Map setting values to UI values
  const settingToUi = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', 'daily': '1d', 'weekly': '1w', 'monthly': '1M' }
  const enabled = enabledPeriods.value.map(p => settingToUi[p] || p)
  return allPeriodOptions.filter(o => enabled.includes(o.value))
})



// 获取当前工具类型

const currentInstrumentType = computed(() => {

  // 🔥 确保 symbolList.value 是数组

  if (!Array.isArray(symbolList.value)) {

    return 'stock'

  }

  const symbol = symbolList.value.find(s => s.code === selectedSymbol.value)

  return symbol ? symbol.type : 'stock'

})



// 是否为指数

const isIndex = computed(() => currentInstrumentType.value === 'index')



// 是否为期货

const isFutures = computed(() => currentInstrumentType.value === 'futures')



// 计算属性

const getPriceClass = (change) => {

  if (change > 0) return 'price-up'

  if (change < 0) return 'price-down'

  return 'price-flat'

}



const priceChangeClass = computed(() => {

  return currentStock.value.change >= 0 ? 'price-up' : 'price-down'

})



const priceChangeText = computed(() => {

  const change = currentStock.value.change

  return `${change >= 0 ? '+' : ''}${change.toFixed(2)}`

})



const pricePercentText = computed(() => {

  const percent = currentStock.value.changePercent

  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`

})



// 方法

function formatVolume(volume) {

  if (!volume && volume !== 0) return '-'

  if (typeof volume !== 'number') return '-'

  if (volume >= 100000000) {

    return (volume / 100000000).toFixed(2) + '亿'

  } else if (volume >= 10000) {

    return (volume / 10000).toFixed(2) + '万'

  }

  return volume.toString()

}



function formatAmount(amount) {

  if (!amount && amount !== 0) return '-'

  if (typeof amount !== 'number') return '-'

  if (amount >= 100000000) {

    return (amount / 100000000).toFixed(2) + '亿'

  } else if (amount >= 10000) {

    return (amount / 10000).toFixed(2) + '万'

  }

  return amount.toString()

}



function formatTime(timestamp) {

  return timestamp

}



// 🔥 新增: 判断是否为自选标的

function isFavoriteSymbol(code) {

  // 去掉sh/sz前缀

  const codeWithoutPrefix = code.replace(/^(sh|sz)/, '')

  return favoriteStocks.value.has(code) || favoriteStocks.value.has(codeWithoutPrefix)

}



// ---------------------------------------------------------------------------
// onSymbolChange —— 股票/标的切换时的核心回调（论文3.1节，事件驱动链路）
//
// 触发场景：用户在下拉框中选择了新的股票代码
// 执行流程：
//   1. 更新 selectedSymbol 和 currentStock 响应式状态
//   2. SimpleTradingInterface 子组件监听到 symbol 变化后自动加载K线
//   3. 如果当前有已加载的策略，重新获取该策略在新标的上的信号
// ---------------------------------------------------------------------------
async function onSymbolChange(symbol) {

  console.log('🔄 切换股票:', symbol)

  selectedSymbol.value = symbol

  

  // 更新当前股票信息

  const symbolInfo = symbolList.value.find(s => s.code === symbol)

  if (symbolInfo) {

    currentStock.value.code = symbol

    currentStock.value.name = symbolInfo.name

    console.log('✅ 从symbolList找到股票名称:', symbolInfo.name)

  } else {

    // 🔥 备用方案：如果symbolList中找不到，使用映射表

    currentStock.value.code = symbol

    currentStock.value.name = getInstrumentNameFallback(symbol)

    console.warn('⚠️ symbolList中未找到股票，使用备用名称:', currentStock.value.name)

  }

  

  // 🔥 不再单独加载市场数据和实时行情

  // SimpleTradingInterface会自动加载K线数据，并通过handlePriceUpdate事件更新价格

  // 这样可以确保所有地方显示的价格都来自同一个数据源

  console.log('📊 等待SimpleTradingInterface加载数据并更新价格...')

  

  // 如果有加载的策略，重新获取信号

  if (loadedStrategy.value) {

    await loadStrategySignals(loadedStrategy.value, symbol)

  }

}



// 🔥 新增：备用的股票名称获取函数

function getInstrumentNameFallback(code) {

  // 标准化代码为小写

  const normalizedCode = code.toLowerCase()

  

  // 常见股票/指数代码映射（使用完整代码，包含前缀）

  const nameMap = {

    // 上海市场指数

    'sh000001': '上证指数',

    'sh000016': '上证50',

    'sh000300': '沪深300',

    'sh000688': '科创50',

    'sh000852': '中证1000',

    'sh000905': '中证500',

    // 深圳市场指数

    'sz399001': '深证成指',

    'sz399006': '创业板指',

    // ETF

    'sh510300': '沪深300ETF',

    'sh510500': '中证500ETF',

    'sh512100': '中证1000ETF',

    'sz159915': '创业板ETF',

    'sz159919': '沪深300ETF',

    'sh588000': '科创50ETF',

    // 上海市场股票

    'sh600000': '浦发银行',

    'sh600519': '贵州茅台',

    'sh601288': '农业银行',

    'sh601318': '中国平安',

    'sh601398': '工商银行',

    'sh601857': '中国石油',

    'sh601988': '中国银行',

    // 深圳市场股票

    'sz000001': '平安银行',

    'sz000002': '万科A',

    'sz000858': '五粮液',

    'sz002594': '比亚迪'

  }

  

  // 先尝试完整代码匹配

  if (nameMap[normalizedCode]) {

    return nameMap[normalizedCode]

  }

  

  // 移除前缀用于期货代码检测

  const cleanCode = code.replace(/^(sh|sz|SH|SZ)/, '')

  

  // 期货代码映射

  if (/^IF\d{4}$/.test(cleanCode)) return '沪深300股指期货'

  if (/^IC\d{4}$/.test(cleanCode)) return '中证500股指期货'

  if (/^IH\d{4}$/.test(cleanCode)) return '上证50股指期货'

  if (/^IM\d{4}$/.test(cleanCode)) return '中证1000股指期货'

  

  // 返回默认显示代码

  return `合约 ${code}`

}



// 🔥 新增：监听 selectedSymbol 变化，自动更新股票名称

watch(selectedSymbol, (newSymbol) => {

  console.log('👀 监听到 selectedSymbol 变化:', newSymbol)

  const symbolInfo = symbolList.value.find(s => s.code === newSymbol)

  if (symbolInfo) {

    currentStock.value.name = symbolInfo.name

    currentStock.value.code = newSymbol

    console.log('✅ watch更新股票名称:', symbolInfo.name)

  } else if (symbolList.value.length > 0) {

    // 只有在 symbolList 已加载的情况下才使用备用名称

    currentStock.value.name = getInstrumentNameFallback(newSymbol)

    currentStock.value.code = newSymbol

    console.log('⚠️ watch使用备用名称:', currentStock.value.name)

  }

})



// 策略相关方法

function getStrategyStatusColor(status) {

  const colorMap = {

    active: 'success',

    paused: 'warning',

    stopped: 'info',

    error: 'danger'

  }

  return colorMap[status] || 'info'

}



function getStrategyStatusText(status) {

  const textMap = {

    active: '运行中',

    paused: '已暂停',

    stopped: '已停止',

    error: '错误'

  }

  return textMap[status] || status

}



// 加载策略到交易界面

async function loadStrategyToTrading(strategy) {

  if (!strategy) return

  

  try {

    loadingSignals.value = true

    loadedStrategy.value = strategy

    

    console.log('🔄 加载策略到交易界面:', strategy.name)

    

    // 获取策略信号

    await loadStrategySignals(strategy, selectedSymbol.value)

    

    // 初始化策略状态

    await updateStrategyStats()

    updateLatestSignals()

    

    // 如果策略是运行状态，开始状态更新

    if (strategy.status === 'active') {

      startStrategyStatusUpdate()

    }

    

    ElMessage.success(`策略 "${strategy.name}" 已加载到交易界面`)

  } catch (error) {

    console.error('加载策略失败:', error)

    ElMessage.error('加载策略失败: ' + error.message)

    loadedStrategy.value = null

  } finally {

    loadingSignals.value = false

  }

}



// 获取策略信号

async function loadStrategySignals(strategy, symbol) {

  try {

    console.log('🔄 获取策略信号:', strategy.name, symbol)

    

    // 获取认证 token

    const token = localStorage.getItem('token')

    if (!token) {

      console.warn('⚠️ 未找到认证 token，尝试本地执行策略代码')

      // 如果没有 token，尝试本地执行策略代码

      await executeStrategyLocally(strategy, symbol)

      return

    }

    

    // 使用策略类型执行API而不是策略ID执行API

    // 注意：request的baseURL已经包含/api，所以这里不需要再加/api前缀

    const strategyType = strategy.type || strategy.id // 优先使用type，如果没有则使用id

    const response = await request.post(`/strategies/${strategyType}/execute`, {

      symbol: symbol,

      startDate: null,

      endDate: null

    }, {

      headers: {

        Authorization: `Bearer ${token}`

      },

      silentError: true,

      silentLoading: true

    })

    

    if (response.success) {

      // 🔥 使用validateApiArrayField验证信号数据

      strategySignals.value = validateApiArrayField(response, 'data.signals', [])

      strategyAuxiliaryData.value = response.data.auxiliaryData || {}

      

      console.log('✅ 策略信号加载成功:', {

        signals: strategySignals.value.length,

        auxiliaryData: Object.keys(strategyAuxiliaryData.value)

      })

    } else {

      throw new Error(response.message || '获取策略信号失败')

    }

  } catch (error) {

    console.error('❌ 获取策略信号失败:', error)

    

    // API call failed — always fall back to local strategy execution

    console.log('🔄 API 调用失败，尝试本地执行策略代码...')

    try {

      await executeStrategyLocally(strategy, symbol)

      return

    } catch (localError) {

      console.error('❌ 本地执行策略也失败:', localError)

    }

    

    // If local execution also failed, clear signals silently (do not throw)

    strategySignals.value = []

    strategyAuxiliaryData.value = {}

  }

}



// 本地执行策略代码

async function executeStrategyLocally(strategy, symbol) {

  try {

    console.log('🔄 本地执行策略代码:', strategy.name)



    if (!strategy.code) {

      throw new Error('策略代码为空')

    }



    // 生成模拟K线数据

    const mockKlineData = await generateKLineData(symbol) // 🔥 修复：添加await



    const params = strategy.parameters || {}

    // Execute via backend vm sandbox instead of browser new Function
    const result = await executeSandbox({
      code: strategy.code,
      klineData: mockKlineData,
      parameters: params,
      language: strategy.language || 'javascript'
    })



    console.log('✅ 策略执行完成')

    // executeSandbox always returns { signals, auxiliaryData }
    strategySignals.value = Array.isArray(result.signals) ? result.signals : []
    strategyAuxiliaryData.value = result.auxiliaryData || {}

    console.log('📊 信号数量:', strategySignals.value.length, '辅助线数量:', Object.keys(strategyAuxiliaryData.value).length)

    console.log('✅ 本地策略执行成功:', {

      signals: strategySignals.value.length,

      auxiliaryData: Object.keys(strategyAuxiliaryData.value),

      signalsPreview: Array.isArray(strategySignals.value) ? strategySignals.value.slice(0, 3) : []

    })

    

    ElMessage.success(`本地执行策略成功，生成 ${strategySignals.value.length} 个信号`)

    

  } catch (error) {

    console.error('❌ 本地执行策略失败:', error)

    throw error

  }

}



// 刷新策略信号

async function refreshStrategySignals() {

  if (!loadedStrategy.value) return

  

  try {

    loadingSignals.value = true

    await loadStrategySignals(loadedStrategy.value, selectedSymbol.value)

    ElMessage.success('策略信号已刷新')

  } catch (error) {

    ElMessage.error('刷新策略信号失败')

  } finally {

    loadingSignals.value = false

  }

}



// 切换策略信号显示

function toggleStrategySignals() {

  showStrategySignals.value = !showStrategySignals.value

  ElMessage.info(showStrategySignals.value ? '已显示策略信号' : '已隐藏策略信号')

}



// 🔥 强制显示信号 - 智能策略检测和信号传输（适配StrategyKLineChart）

function forceShowSignals() {

  console.log('🚀 强制显示信号被触发')

  

  // 优先使用已加载的策略，如果没有则使用选中的策略

  let targetStrategy = loadedStrategy.value || strategyStore.selectedStrategy

  

  if (!targetStrategy) {

    ElMessage.warning('⚠️ 请先在左侧面板选择一个策略')

    console.log('⚠️ 没有选择或加载的策略，无法显示信号')

    return

  }

  

  console.log('📊 使用策略:', targetStrategy.name)

  console.log('📊 策略来源:', loadedStrategy.value ? '已加载策略' : '选中策略')

  console.log('📊 当前选择的标的:', selectedSymbol.value)

  

  // 如果使用的是选中策略但未加载，先加载它

  if (!loadedStrategy.value && strategyStore.selectedStrategy) {

    console.log('🔄 自动加载选中的策略...')

    loadStrategyToTrading(strategyStore.selectedStrategy)

      .then(() => {

        // 加载成功后再次调用显示信号

        setTimeout(() => {

          forceShowSignalsInternal(loadedStrategy.value)

        }, 500)

      })

      .catch(error => {

        console.error('❌ 自动加载策略失败:', error)

        ElMessage.error('自动加载策略失败: ' + error.message)

      })

    return

  }

  

  // 直接显示信号

  forceShowSignalsInternal(targetStrategy)

}



// 内部信号显示函数 - 增强版本（适配StrategyKLineChart）

function forceShowSignalsInternal(strategy) {

  if (!strategy) return

  

  loadingSignals.value = true

  

  loadStrategySignals(strategy, selectedSymbol.value)

    .then(() => {

      console.log('✅ 策略信号重新加载成功')

      

      // 检查是否有信号数据

      if (strategySignals.value && strategySignals.value.length > 0) {

        console.log('📊 策略信号数据:', {

          count: strategySignals.value.length,

          signals: strategySignals.value

        })

        

        // 确保信号显示开启

        showStrategySignals.value = true

        

        ElMessage.success(`🎉 强制显示成功！显示了 ${strategySignals.value.length} 个策略信号`)

      } else {

        console.log('⚠️ 策略没有生成信号，使用备用测试信号')

        

        // 生成适配StrategyKLineChart格式的测试信号

        const fallbackSignals = generateTestSignalsForStrategyChart(strategy.name)

        

        strategySignals.value = fallbackSignals

        showStrategySignals.value = true

        

        ElMessage.warning(`⚠️ 策略暂无信号，显示了 ${fallbackSignals.length} 个测试信号`)

      }

    })

    .catch(error => {

      console.error('❌ 重新加载策略信号失败:', error)

      

      // 如果API调用失败，使用应急信号

      const emergencySignals = generateTestSignalsForStrategyChart(strategy.name, 2)

      

      strategySignals.value = emergencySignals

      showStrategySignals.value = true

      

      ElMessage.error(`❌ 策略信号加载失败，显示了 ${emergencySignals.length} 个应急信号`)

    })

    .finally(() => {

      loadingSignals.value = false

    })

}



// 生成适配StrategyKLineChart格式的测试信号

function generateTestSignalsForStrategyChart(strategyName, count = 6) {

  const signals = []

  

  // 使用与SimpleTradingInterface相同的时间生成逻辑

  const now = Math.floor(Date.now() / 1000)

  const daySeconds = 24 * 60 * 60

  const totalDays = 60

  

  console.log('📊 生成测试信号，策略:', strategyName, '数量:', count)

  

  // 生成分布均匀的信号

  for (let i = 0; i < count; i++) {

    // 在60天范围内均匀分布

    const dayOffset = Math.floor((totalDays * (i + 1)) / (count + 1))

    const signalTime = now - (totalDays - dayOffset) * daySeconds

    

    const signalType = i % 2 === 0 ? 'buy' : 'sell'

    

    // 生成合理的价格

    const basePrice = 4660

    const priceVariation = (Math.random() - 0.5) * 100

    const signalPrice = basePrice + priceVariation

    

    const signal = {

      id: `test-signal-${i}`,

      type: signalType,

      price: parseFloat(signalPrice.toFixed(2)),

      index: dayOffset,

      timestamp: signalTime * 1000, // 毫秒时间戳

      time: signalTime, // 秒时间戳，用于图表显示

      reason: `${strategyName} - ${signalType === 'buy' ? '买入' : '卖出'}信号 (第${dayOffset}天)`

    }

    

    signals.push(signal)

    

    console.log(`📍 生成信号 ${i + 1}:`, {

      type: signal.type,

      price: signal.price,

      time: new Date(signal.timestamp).toLocaleDateString(),

      chartTime: signal.time

    })

  }

  

  console.log('✅ 测试信号生成完成:', signals.length, '个信号')

  return signals

}

// 卸载策略

function unloadStrategy() {

  const strategyName = loadedStrategy.value?.name

  loadedStrategy.value = null

  strategySignals.value = []

  strategyAuxiliaryData.value = {}

  showStrategySignals.value = true

  

  // 清空策略状态

  strategyRealTimeStats.value = {

    totalReturn: 0,

    todayReturn: 0,

    totalTrades: 0,

    winRate: 0,

    maxDrawdown: 0,

    sharpeRatio: 0

  }

  latestSignals.value = []

  

  // 停止状态更新定时器

  if (strategyStatusTimer) {

    clearInterval(strategyStatusTimer)

    strategyStatusTimer = null

  }

  

  // 触发策略卸载事件

  strategyStore.emit('strategyUnloaded')

  

  ElMessage.info(`策略 "${strategyName}" 已卸载`)

}



// 刷新策略状态

async function refreshStrategyStatus() {

  if (!loadedStrategy.value) return

  

  try {

    // 更新策略统计数据

    await updateStrategyStats()

    

    // 更新最新信号

    updateLatestSignals()

    

    ElMessage.success('策略状态已刷新')

  } catch (error) {

    console.error('刷新策略状态失败:', error)

    ElMessage.error('刷新策略状态失败')

  }

}



// 更新策略统计数据

async function updateStrategyStats() {

  if (!loadedStrategy.value) return

  

  try {

    // 模拟实时统计数据（实际项目中应该从后端获取）

    const mockStats = {

      totalReturn: (Math.random() - 0.5) * 20, // -10% 到 +10%

      todayReturn: (Math.random() - 0.5) * 4,  // -2% 到 +2%

      totalTrades: Math.floor(Math.random() * 100) + 10,

      winRate: Math.floor(Math.random() * 40) + 50, // 50% 到 90%

      maxDrawdown: Math.random() * 10, // 0% 到 10%

      sharpeRatio: Math.random() * 2 + 0.5 // 0.5 到 2.5

    }

    

    strategyRealTimeStats.value = mockStats

  } catch (error) {

    console.error('更新策略统计失败:', error)

  }

}



// 更新最新信号

function updateLatestSignals() {

  // 🔥 确保 strategySignals.value 是数组

  if (!Array.isArray(strategySignals.value) || strategySignals.value.length === 0) {

    console.warn('⚠️ strategySignals 不是数组或为空:', typeof strategySignals.value)

    latestSignals.value = []

    return

  }

  

  // 获取最新的5个信号

  const recentSignals = strategySignals.value

    .slice(-5)

    .reverse()

    .map((signal, index) => ({

      id: `signal-${index}`,

      type: signal.type,

      price: signal.price,

      time: signal.time || signal.date,

      reason: signal.reason

    }))

  

  latestSignals.value = recentSignals

}



// 切换策略运行状态

async function toggleStrategyStatus() {

  if (!loadedStrategy.value) return

  

  try {

    if (loadedStrategy.value.status === 'active') {

      await strategyStore.stopStrategy(loadedStrategy.value.id)

      loadedStrategy.value.status = 'paused'

      ElMessage.success('策略已暂停')

      

      // 停止状态更新

      if (strategyStatusTimer) {

        clearInterval(strategyStatusTimer)

        strategyStatusTimer = null

      }

    } else {

      await strategyStore.startStrategy(loadedStrategy.value.id)

      loadedStrategy.value.status = 'active'

      ElMessage.success('策略已启动')

      

      // 开始状态更新

      startStrategyStatusUpdate()

    }

  } catch (error) {

    console.error('切换策略状态失败:', error)

    ElMessage.error('切换策略状态失败')

  }

}



// 开始策略状态更新

function startStrategyStatusUpdate() {

  if (strategyStatusTimer) {

    clearInterval(strategyStatusTimer)

  }

  

  // 立即更新一次

  updateStrategyStats()

  updateLatestSignals()

  

  // 每30秒更新一次状态

  strategyStatusTimer = setInterval(() => {

    if (loadedStrategy.value && loadedStrategy.value.status === 'active') {

      updateStrategyStats()

      updateLatestSignals()

    }

  }, 30000)

}



// 切换界面模式 - 已移除，现在使用统一界面

// function toggleInterface() {

//   useProfessionalInterface.value = !useProfessionalInterface.value

//   

//   if (useProfessionalInterface.value) {

//     ElMessage.success('🏛️ 已切换到专业交易界面')

//   } else {

//     ElMessage.info('📊 已返回标准交易界面')

//   }

// }



// 统一交易界面事件处理

function handleContractChange(contract) {

  console.log('统一界面 - 合约切换:', contract)

  selectedSymbol.value = contract

  onSymbolChange(contract)

}



function handlePeriodChange(period) {

  console.log('统一界面 - 周期切换:', period)

  currentPeriod.value = period

}



function handleSignalLoaded(signals) {

  console.log('统一界面 - 信号加载:', signals)

  strategySignals.value = signals

  ElMessage.success(`统一界面加载了 ${signals.length} 个交易信号`)

}



function handleOrderPlaced(order) {

  console.log('统一界面 - 订单提交:', order)

  ElMessage.success(`订单已提交: ${order.type} ${order.volume}手 @ ${order.price}`)

  

  // 🔥 刷新账户信息

  fetchAccountInfo()

  

  // 可以在这里调用实际的下单API

  // await submitOrder(order)

}



// 处理导航到回测分析页面

function handleNavigateToBacktestAnalysis() {

  console.log('导航到回测分析页面')

  

  try {

    router.push('/backtest')

    console.log('✅ 成功导航到回测分析页面')

  } catch (error) {

    console.error('❌ 导航失败:', error)

    // 备用方案

    window.location.href = '#/backtest'

  }

}



// 格式化信号时间

function formatSignalTime(time) {

  if (!time) return '--:--'

  

  try {

    const date = new Date(time)

    return date.toLocaleTimeString('zh-CN', { 

      hour: '2-digit', 

      minute: '2-digit' 

    })

  } catch (error) {

    return '--:--'

  }

}



// 获取收益颜色类

function getProfitClass(value) {

  if (value > 0) return 'profit-positive'

  if (value < 0) return 'profit-negative'

  return 'profit-neutral'

}



// 智能策略选择处理

function handleStrategySelected(strategy) {

  console.log('🎯 智能策略选择:', strategy?.name)

  

  if (strategy) {

    // 更新加载的策略

    loadedStrategy.value = strategy

    const selectionValue = getStrategySelectionValue(strategy)

    const currentSelectedId = normalizeStrategySelectionId(getStrategySelectionValue(strategyStore.selectedStrategy))

    const nextSelectedId = normalizeStrategySelectionId(selectionValue)

    syncingStrategySelection = true

    try {

      replayStrategy.value = selectionValue

      if (currentSelectedId !== nextSelectedId) {

        strategyStore.selectStrategy(strategy)

      }

    } finally {

      syncingStrategySelection = false

    }

    

    // 如果策略有代码，尝试执行获取信号

    if (strategy.code) {

      loadStrategySignals(strategy, selectedSymbol.value).catch((error) => {

        console.error('自动刷新策略信号失败:', error)

      })

    }

    

    ElMessage.success(`已选择策略: ${strategy.name}`)

  } else {

    // 清除策略

    loadedStrategy.value = null

    strategySignals.value = []

    strategyAuxiliaryData.value = {}

    const hasCurrentSelection = Boolean(strategyStore.selectedStrategy)

    syncingStrategySelection = true

    try {

      replayStrategy.value = null

      if (hasCurrentSelection) {

        strategyStore.selectStrategy(null)

      }

    } finally {

      syncingStrategySelection = false

    }

  }

}



function handleStrategyApplied(strategy) {

  console.log('🚀 智能策略应用:', strategy?.name)

  

  if (strategy) {

    // 直接设置加载的策略，不需要重新获取信号

    loadedStrategy.value = strategy

    const selectionValue = getStrategySelectionValue(strategy)

    const currentSelectedId = normalizeStrategySelectionId(getStrategySelectionValue(strategyStore.selectedStrategy))

    const nextSelectedId = normalizeStrategySelectionId(selectionValue)

    syncingStrategySelection = true

    try {

      replayStrategy.value = selectionValue

      if (currentSelectedId !== nextSelectedId) {

        strategyStore.selectStrategy(strategy)

      }

    } finally {

      syncingStrategySelection = false

    }

    

    // 初始化策略状态（不调用API）

    updateStrategyStatsLocal()

    

    ElMessage.success(`策略 "${strategy.name}" 已应用到交易界面`)

  }

}



// 本地更新策略统计数据（不调用API）

function updateStrategyStatsLocal() {

  if (!loadedStrategy.value) return

  

  // 模拟实时统计数据

  const mockStats = {

    totalReturn: (Math.random() - 0.5) * 20, // -10% 到 +10%

    todayReturn: (Math.random() - 0.5) * 4,  // -2% 到 +2%

    totalTrades: Math.floor(Math.random() * 100) + 10,

    winRate: Math.floor(Math.random() * 40) + 50, // 50% 到 90%

    maxDrawdown: Math.random() * 10, // 0% 到 10%

    sharpeRatio: Math.random() * 2 + 0.5 // 0.5 到 2.5

  }

  

  strategyRealTimeStats.value = mockStats

}



function handleSignalsGenerated(data) {

  console.log('📊 Trading.vue 接收到策略信号:', data)

  

  try {

    if (data && data.signals) {

      // 🔥 确保 signals 是数组

      const signals = Array.isArray(data.signals) ? data.signals : []

      

      // 更新策略信号

      strategySignals.value = signals

      

      // 🔥 新增：更新辅助线数据

      if (data.auxiliaryData && Object.keys(data.auxiliaryData).length > 0) {

        strategyAuxiliaryData.value = data.auxiliaryData

        console.log('✅ 辅助线数据已更新:', {

          auxiliaryLines: Object.keys(data.auxiliaryData).length,

          lineNames: Object.keys(data.auxiliaryData)

        })

      } else {

        strategyAuxiliaryData.value = {}

        console.log('⚠️ 没有辅助线数据')

      }

      

      // 确保信号显示开启

      showStrategySignals.value = true

      

      // 更新最新信号列表

      updateLatestSignalsFromData(signals)

      

      console.log('✅ 策略信号已更新:', {

        strategy: data.strategy.name,

        signalCount: signals.length,

        auxiliaryLineCount: Object.keys(strategyAuxiliaryData.value).length,

        signals: signals.length > 0 ? signals.slice(0, 3) : [] // 显示前3个信号用于调试

      })

      

      // 立即尝试显示信号

      console.log('🔄 立即尝试显示信号到SimpleTradingInterface')

      

      // 强制触发信号显示

      nextTick(() => {

        try {

          // 确保信号数据已经传递到SimpleTradingInterface

          setTimeout(() => {

            console.log('🎯 强制触发信号显示检查')

            

            // 检查SimpleTradingInterface是否接收到信号

            const simpleTradingInterface = document.querySelector('.simple-trading-interface')

            if (simpleTradingInterface) {

              console.log('✅ 找到SimpleTradingInterface组件')

              

              // 触发一个自定义事件来强制显示信号

              const event = new CustomEvent('forceDisplaySignals', {

                detail: { signals: data.signals }

              })

              simpleTradingInterface.dispatchEvent(event)

            } else {

              console.warn('⚠️ 未找到SimpleTradingInterface组件')

            }

          }, 200)

        } catch (displayError) {

          console.error('❌ 信号显示处理失败:', displayError)

          // 不显示错误消息给用户，因为主要功能已经完成

        }

      })

      

      // 显示成功消息

      if (Object.keys(strategyAuxiliaryData.value).length > 0) {

        ElMessage.success(`策略 "${data.strategy.name}" 生成了 ${data.signals.length} 个交易信号和 ${Object.keys(strategyAuxiliaryData.value).length} 条辅助线`)

      } else {

        ElMessage.success(`策略 "${data.strategy.name}" 生成了 ${data.signals.length} 个交易信号`)

      }

    } else {

      console.warn('⚠️ 接收到的信号数据格式不正确:', data)

      ElMessage.warning('策略信号数据格式不正确')

    }

  } catch (error) {

    console.error('❌ 处理策略信号失败:', error)

    ElMessage.error('处理策略信号时发生错误')

  }

}



// 从信号数据更新最新信号列表

function updateLatestSignalsFromData(signals) {

  // 🔥 确保 signals 是数组

  if (!Array.isArray(signals) || signals.length === 0) {

    console.warn('⚠️ signals 不是数组或为空:', typeof signals)

    latestSignals.value = []

    return

  }

  

  // 获取最新的5个信号

  const recentSignals = signals

    .slice(-5)

    .reverse()

    .map((signal, index) => ({

      id: `signal-${index}`,

      type: signal.type,

      price: signal.price,

      time: signal.time || signal.date || Date.now(),

      reason: signal.reason

    }))

  

  latestSignals.value = recentSignals

}



// 切换时间周期

const changePeriod = (period) => {

  currentPeriod.value = period

}



// 🔥 修改: 从数据库加载自选标的(支持降级到localStorage)

async function loadFavoriteStocks() {

  try {

    console.log('📂 从数据库加载自选标的...')

    

    // 1. 优先从数据库加载

    const response = await request.get('/favorites')

    

    if (response.success && response.data) {

      const favorites = response.data.map(f => f.symbol)

      favoriteStocks.value = new Set(favorites)

      console.log(`✅ 从数据库加载 ${favorites.length} 个自选标的`)

      

      // 2. 同步到localStorage作为备份

      localStorage.setItem('favoriteStocks', JSON.stringify(favorites))

      return

    }

  } catch (error) {

    console.error('从数据库加载自选标的失败:', error)

    

    // 降级: 从localStorage加载

    try {

      const saved = localStorage.getItem('favoriteStocks')

      if (saved) {

        const favorites = JSON.parse(saved)

        favoriteStocks.value = new Set(favorites)

        console.log(`⚠️ 从localStorage加载 ${favorites.length} 个自选标的`)

      } else {

        console.log('⚠️ 没有自选标的数据')

      }

    } catch (e) {

      console.error('从localStorage加载失败:', e)

    }

  }

}



// 🔥 新增: 加载金融工具列表（优化版，支持三级缓存）

// ---------------------------------------------------------------------------
// remoteSearchSymbol —— 远程搜索股票/期货代码（论文4.5节，接入与路由层）
//
// 用户在搜索框输入时触发，向后端 /comprehensive-data/instruments/search
// 发起模糊查询请求，支持按代码或名称匹配。
// 搜索失败时自动降级到本地 symbolList 进行前端过滤，保证可用性。
// ---------------------------------------------------------------------------
async function remoteSearchSymbol(query) {
  if (!query || query.trim().length < 1) {
    symbolSearchResults.value = []
    return
  }
  symbolSearchLoading.value = true
  try {
    const res = await request.get('/comprehensive-data/instruments/search', {
      params: { query: query.trim(), limit: 50 }
    })
    const items = res.data?.instruments || res.data?.results || (res.data?.data?.results) || res.data?.data || []
    symbolSearchResults.value = items.map(i => ({
      code: i.symbol || i.code,
      name: i.name,
      type: i.type || 'stock',
      market: i.market,
      category: i.category
    }))
  } catch (e) {
    // 搜索失败时降级到本地过滤
    const q = query.toLowerCase()
    const list = ensureArray(symbolList.value, [], 'symbolList')
    symbolSearchResults.value = list
      .filter(s => s.code.toLowerCase().includes(q) || (s.name && s.name.toLowerCase().includes(q)))
      .slice(0, 50)
  } finally {
    symbolSearchLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// loadSymbolList —— 加载金融工具（标的）列表（论文4.5节，数据治理层）
//
// 采用三级缓存策略，体现"数据四级回退"的前端部分：
//   第1级：内存缓存（symbolList.value 已有数据则直接返回）
//   第2级：localStorage 缓存（30分钟有效期）
//   第3级：后端 API /market/symbols（真实数据源）
//   降级兜底：内置默认标的列表（保证页面不会空白）
// ---------------------------------------------------------------------------
async function loadSymbolList(forceRefresh = false) {

  try {

    symbolListLoading.value = true // 🔥 设置加载状态

    console.log('📋 加载标的列表...')

    

    // 🔥 检查内存缓存

    if (!forceRefresh && symbolList.value.length > 0) {

      console.log(`✅ 使用内存缓存 (${symbolList.value.length}个标的)`)

      return

    }

    

    // 🔥 检查localStorage缓存

    const cached = localStorage.getItem('trading_symbol_list')

    if (!forceRefresh && cached) {

      try {

        const { data, timestamp } = JSON.parse(cached)

        const age = Date.now() - timestamp

        const ageMinutes = Math.floor(age / (1000 * 60))

        

        // 30分钟内的缓存直接使用

        if (ageMinutes < 30) {

          // 🔥 确保 data 是数组

          symbolList.value = Array.isArray(data) ? data : []

          console.log(`✅ 使用localStorage缓存 (${symbolList.value.length}个标的, ${ageMinutes}分钟前)`)

          return

        } else {

          console.log(`⚠️ localStorage缓存已过期 (${ageMinutes}分钟前)`)

        }

      } catch (e) {

        console.error('解析缓存失败:', e)

      }

    }

    

    console.log('🔍 从API加载标的列表...')

    

    // 🔥 从API获取标的列表

    const response = await request.get('/market/symbols', {

      params: {

        limit: 0, // 获取所有标的

        useCache: 'true'

      }

    })

    

    if (response.success && response.data && response.data.instruments) {

      // 🔥 使用validateApiArrayField验证响应数据

      const instruments = validateApiArrayField(response, 'data.instruments', [])

      

      // 转换为Trading页面需要的格式

      symbolList.value = instruments.map(item => ({

        code: item.code,

        name: item.name,

        type: item.type,

        category: item.category,

        market: item.code.startsWith('sh') || item.code.startsWith('6') ? 'SSE' : 'SZSE'

      }))

      

      // 🔥 保存到localStorage

      localStorage.setItem('trading_symbol_list', JSON.stringify({

        data: symbolList.value,

        timestamp: Date.now()

      }))

      

      console.log(`✅ 成功加载 ${symbolList.value.length} 个标的`)

      return

    }

    

    throw new Error('获取标的列表失败')

    

  } catch (error) {

    console.error('❌ 加载标的列表失败:', error)

    

    // 🔥 降级: 尝试从localStorage加载过期缓存

    const cached = localStorage.getItem('trading_symbol_list')

    if (cached) {

      try {

        const { data, timestamp } = JSON.parse(cached)

        const age = Date.now() - timestamp

        const ageHours = Math.floor(age / (1000 * 60 * 60))

        

        // 🔥 确保 data 是数组

        symbolList.value = Array.isArray(data) ? data : []

        console.log(`✅ 使用过期缓存 (${symbolList.value.length}个标的, ${ageHours}小时前)`)

        ElMessage.warning(`使用缓存数据 (${ageHours}小时前)`)

        return

      } catch (e) {

        console.error('解析缓存失败:', e)

      }

    }

    

    // 🔥 最终降级: 使用默认标的列表

    console.log('⚠️ 使用默认标的列表')

    symbolList.value = [

      { code: 'sh000001', name: '上证指数', type: 'index', category: '指数', market: 'SSE' },

      { code: 'sh000300', name: '沪深300', type: 'index', category: '指数', market: 'SSE' },

      { code: 'sz399001', name: '深证成指', type: 'index', category: '指数', market: 'SZSE' },

      { code: 'sz399006', name: '创业板指', type: 'index', category: '指数', market: 'SZSE' },

      { code: 'sh600519', name: '贵州茅台', type: 'stock', category: 'A股', market: 'SSE' },

      { code: 'sz000858', name: '五粮液', type: 'stock', category: 'A股', market: 'SZSE' },

      { code: 'sh600036', name: '招商银行', type: 'stock', category: 'A股', market: 'SSE' },

      { code: 'sz000001', name: '平安银行', type: 'stock', category: 'A股', market: 'SZSE' },

      { code: 'sh601318', name: '中国平安', type: 'stock', category: 'A股', market: 'SSE' },

      { code: 'sz000002', name: '万科A', type: 'stock', category: 'A股', market: 'SZSE' },

      { code: 'rb_main', name: '螺纹钢主力', type: 'futures', category: '期货', market: 'SHFE' },

      { code: 'IF_main', name: '沪深300股指', type: 'futures', category: '期货', market: 'CFFEX' },

      { code: 'au_main', name: '沪金主力', type: 'futures', category: '期货', market: 'SHFE' },

      { code: 'cu_main', name: '沪铜主力', type: 'futures', category: '期货', market: 'SHFE' },

      { code: 'sc_main', name: '原油主力', type: 'futures', category: '期货', market: 'INE' }

    ]

    

    ElMessage.error('加载标的列表失败,使用默认列表')

  } finally {

    symbolListLoading.value = false // 🔥 清除加载状态

  }

}



// ---------------------------------------------------------------------------
// generateMockMarketData —— 生成模拟行情快照（论文4.5节，四级回退的第四级）
//
// 当后端API和所有缓存均不可用时，使用随机算法生成一条仿真行情数据，
// 包含：当前价、开盘价、最高价、最低价、成交量、涨跌幅等字段。
// 目的：保证前端页面在任何情况下都有数据可展示，不会出现空白状态。
// ---------------------------------------------------------------------------
function generateMockMarketData(symbol) {

  const basePrice = symbol.includes('300') ? 4660 : 15

  const change = (Math.random() - 0.5) * (basePrice * 0.02)

  const current = basePrice + change

  

  return {

    symbol: symbol,

    current: parseFloat(current.toFixed(2)),

    open: parseFloat((current - (Math.random() - 0.5) * 0.5).toFixed(2)),

    high: parseFloat((current + Math.random() * 0.5).toFixed(2)),

    low: parseFloat((current - Math.random() * 0.5).toFixed(2)),

    volume: Math.floor(Math.random() * 10000000) + 1000000,

    amount: Math.floor(Math.random() * 1000000000) + 100000000,

    change: parseFloat(change.toFixed(2)),

    changePercent: parseFloat((change / basePrice * 100).toFixed(2))

  }

}



// ---------------------------------------------------------------------------
// generateKLineData —— 获取K线（蜡烛图）数据（论文4.5节，数据治理层）
//
// 通过 priceDataService.getKlineData() 向后端请求历史K线数据，
// priceDataService 内部实现了"四级回退"机制（论文表15）：
//   第1级：Redis缓存 → 第2级：数据库 → 第3级：AKShare实时爬取 → 第4级：本地模拟
// 获取到数据后，将日期字符串转换为秒级时间戳以适配前端图表库。
// 如果后端返回为空或请求失败，降级调用 generateLocalKLineData() 本地生成。
// ---------------------------------------------------------------------------
async function generateKLineData(symbol) {

  try {

    console.log(`📊 从后端获取K线数据: ${symbol}`)

    

    // 🔥 修复：从后端获取完整历史数据（不传startDate，让后端使用上市日期）

    const data = await priceDataService.getKlineData(symbol, {

      period: 'daily'

      // 不传startDate和endDate，让后端返回完整历史数据

    })

    

    if (!data || !data.kline || data.kline.length === 0) {

      console.warn('⚠️ 后端返回数据为空，使用本地模拟数据')

      return generateLocalKLineData(symbol)

    }

    

    console.log(`✅ 获取到${data.kline.length}条K线数据`)

    console.log(`   数据源: ${data.source}`)

    console.log(`   日期范围: ${data.kline[0].time} 到 ${data.kline[data.kline.length - 1].time}`)

    

    // 转换数据格式以适配图表

    const klineData = data.kline.map(item => {

      // 将日期字符串转换为时间戳

      const date = new Date(item.time)

      const timestamp = Math.floor(date.getTime() / 1000) // 秒级时间戳

      

      return {

        time: timestamp, // 秒级时间戳，用于图表显示

        timestamp: timestamp * 1000, // 毫秒时间戳，用于日期显示

        open: parseFloat(item.open),

        high: parseFloat(item.high),

        low: parseFloat(item.low),

        close: parseFloat(item.close),

        volume: parseInt(item.volume || 0),

        amount: parseInt(item.amount || item.volume * item.close || 0)

      }

    })

    

    return klineData

  } catch (error) {

    console.error('❌ 获取K线数据失败:', error)

    console.warn('⚠️ 使用本地模拟数据')

    return generateLocalKLineData(symbol)

  }

}



// ---------------------------------------------------------------------------
// generateLocalKLineData —— 本地生成模拟K线数据（四级回退的最终兜底）
//
// 当后端完全不可用时，在前端用随机游走算法生成历史K线，
// 确保图表组件始终有数据渲染，不会出现白屏。
// ---------------------------------------------------------------------------
function generateLocalKLineData(symbol) {

  const klineData = []

  const basePrice = symbol.includes('300') ? 4660 : 15

  let currentPrice = basePrice

  const now = Math.floor(Date.now() / 1000) // 秒级时间戳

  

  // 🔥 修复：生成更多历史数据（365天而不是60天）

  for (let i = 0; i < 365; i++) {

    const time = now - (365 - i) * 24 * 60 * 60 // 秒级时间戳

    

    const change = (Math.random() - 0.5) * (basePrice * 0.03)

    const open = currentPrice

    const close = open + change

    const high = Math.max(open, close) + Math.random() * (basePrice * 0.015)

    const low = Math.min(open, close) - Math.random() * (basePrice * 0.015)

    const volume = Math.floor(Math.random() * 2000000) + 500000

    const amount = volume * ((high + low) / 2)

    

    klineData.push({

      time: time, // 秒级时间戳，用于图表显示

      timestamp: time * 1000, // 毫秒时间戳，用于日期显示

      open: parseFloat(open.toFixed(2)),

      high: parseFloat(high.toFixed(2)),

      low: parseFloat(low.toFixed(2)),

      close: parseFloat(close.toFixed(2)),

      volume: volume,

      amount: amount

    })

    

    currentPrice = close

  }

  

  console.log('📊 生成本地模拟K线数据:', klineData.length, '条')

  return klineData

}



// 计算技术指标（适配StrategyKLineChart格式）

function calculateIndicators(klineData) {

  const indicators = {

    ma5: [],

    ma10: [],

    ma20: [],

    ma30: []

  }

  

  // 计算移动平均线

  const periods = [5, 10, 20, 30]

  periods.forEach(period => {

    const key = `ma${period}`

    for (let i = 0; i < klineData.length; i++) {

      if (i < period - 1) {

        indicators[key].push('-')

      } else {

        let sum = 0

        for (let j = 0; j < period; j++) {

          sum += klineData[i - j].close

        }

        indicators[key].push(parseFloat((sum / period).toFixed(2)))

      }

    }

  })

  

  return indicators

}



// 加载市场数据（使用真实API）

async function loadMarketData(symbol) {

  try {

    console.log(`🔄 加载 ${symbol} 的K线数据...`)

    

    // 调用真实的综合数据API

    const response = await request.get(`/comprehensive/data/${symbol}`, {

      params: {

        period: 'daily',

        includeIndicators: true

      }

    })

    

    // 后端返回格式: { success: true, data: { kline: [...], source: '...' } }

    const apiData = response.data || response

    

    if (apiData && apiData.kline && apiData.kline.length > 0) {

      // 转换API数据格式为图表需要的格式

      const klineData = apiData.kline.map(item => ({

        time: new Date(item.time).getTime() / 1000, // 转换为秒级时间戳

        timestamp: new Date(item.time).getTime(), // 毫秒时间戳

        open: parseFloat(item.open),

        high: parseFloat(item.high),

        low: parseFloat(item.low),

        close: parseFloat(item.close),

        volume: parseInt(item.volume || 0),

        amount: parseFloat(item.amount || 0)

      }))

      

      // 使用API返回的指标或重新计算

      const indicators = apiData.indicators || calculateIndicators(klineData)

      

      // 更新图表数据

      chartData.value = {

        kline: klineData,

        isMock: !!apiData.isMock,

        indicators: indicators

      }

      

      // 更新数据源标记

      const isRealData = apiData.source !== '增强模拟数据' && apiData.source !== '模拟数据' && !apiData.isMockData

      const isHistorical = apiData.isHistorical || false

      const historicalDate = apiData.historicalDate || null

      const daysOld = apiData.daysOld || 0

      

      // 🔥 根据数据类型设置数据源标记

      if (isHistorical) {

        currentStock.value.dataSource = `历史数据(${daysOld}天前)`

        currentStock.value.isHistorical = true

        currentStock.value.historicalDate = historicalDate

      } else if (isRealData) {

        currentStock.value.dataSource = '真实数据'

        currentStock.value.isHistorical = false

      } else {

        currentStock.value.dataSource = '增强模拟数据'

        currentStock.value.isHistorical = false

      }

      

      console.log(`✅ ${symbol} K线数据加载成功，共 ${klineData.length} 根K线`)

      console.log(`📊 数据来源: ${apiData.source || '未知'}`)

      console.log(`📊 是否真实数据: ${isRealData}`)

      

    } else {

      // 如果API失败，降级到增强模拟数据

      console.warn('⚠️ API返回数据格式错误，使用增强模拟数据')

      console.log('API返回数据:', apiData)

      const klineData = await generateKLineData(symbol)

      const indicators = calculateIndicators(klineData)

      chartData.value = {

        kline: klineData,

        isMock: true,

        indicators: indicators

      }

      currentStock.value.dataSource = '增强模拟数据'

    }



  } catch (error) {

    console.warn('加载市场数据失败,静默降级到模拟数据:', error?.message)

    const klineData = await generateKLineData(symbol)

    const indicators = calculateIndicators(klineData)

    chartData.value = {

      kline: klineData,

      isMock: true,

      indicators: indicators

    }

    currentStock.value.dataSource = '增强模拟数据'

  }

}



// 🔥 修复：不再单独加载实时行情，完全依赖SimpleTradingInterface的价格更新

// 这样可以确保左上角价格、K线图价格、测试页面价格完全一致

async function loadRealTimeQuote(symbol) {

  console.log(`📊 loadRealTimeQuote: 等待SimpleTradingInterface发送价格更新...`)

  // 不做任何操作，价格由SimpleTradingInterface通过handlePriceUpdate事件更新

  // 这样可以确保所有地方显示的价格都来自同一个数据源

}



// 刷新成交明细 - 移除，由UnifiedTradingInterface处理

// const refreshTrades = () => {

//   // 模拟添加新的成交记录

//   const newTrade = {

//     id: Date.now(),

//     time: new Date().toLocaleTimeString(),

//     price: currentStock.value.price + (Math.random() - 0.5) * 0.1,

//     volume: Math.floor(Math.random() * 500) + 100,

//     direction: Math.random() > 0.5 ? 'up' : 'down'

//   }

//   

//   recentTrades.value.unshift(newTrade)

//   if (recentTrades.value.length > 20) {

//     recentTrades.value.pop()

//   }

//   

//   ElMessage.success('成交明细已刷新')

// }



// 处理订单提交 - 移除，由UnifiedTradingInterface处理

// const handleOrderSubmitted = () => {

//   ElMessage.success('订单提交成功')

//   // 可以在这里刷新相关数据

//   refreshDepth()

//   refreshTrades()

// }



// 处理价格更新

const handlePriceUpdate = (priceData) => {

  console.log('📊 收到SimpleTradingInterface价格更新:', priceData)

  

  // 更新当前股票价格信息

  currentStock.value.price = priceData.price

  currentStock.value.open = priceData.open

  currentStock.value.high = priceData.high

  currentStock.value.low = priceData.low

  

  // 使用SimpleTradingInterface计算的涨跌幅

  if (priceData.change !== undefined && priceData.changePercent !== undefined) {

    currentStock.value.change = parseFloat(priceData.change.toFixed(2))

    currentStock.value.changePercent = parseFloat(priceData.changePercent.toFixed(2))

  }



  // Update data source label from child component

  if (priceData.dataSource) {

    currentStock.value.dataSource = priceData.dataSource

  }

  

  console.log('✅ 顶部价格已更新:', currentStock.value.price, currentStock.value.change, currentStock.value.changePercent + '%')

}



// 处理数据加载完成

const handleDataLoaded = (loadInfo) => {

  console.log('K线数据加载完成:', loadInfo)

  lastUpdateTime.value = new Date().toLocaleTimeString()

}



// 定时更新数据

let updateTimer = null



const updateData = () => {

  lastUpdateTime.value = new Date().toLocaleTimeString()

  // 不再模拟价格波动，价格由SimpleTradingInterface提供

}



onMounted(async () => {

  console.log('Professional Trading 页面加载...')

  // Load kline period settings from backend
  try {
    const res = await request.get('/settings/public', {
      params: { category: 'trading' },
      silentLoading: true
    })
    if (res?.success) {
      const payload = res.data
      const settings = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.trading) ? payload.trading : [])
      const setting = settings.find(s => s.key === 'kline.enabled_periods')
      const rawValue = setting ? (setting.value ?? setting.parsedValue ?? setting.defaultValue) : null
      let periods = null
      if (Array.isArray(rawValue)) {
        periods = rawValue
      } else if (typeof rawValue === 'string' && rawValue.trim()) {
        try {
          periods = JSON.parse(rawValue)
        } catch {
          periods = null
        }
      }

      if (Array.isArray(periods) && periods.length > 0) {
        enabledPeriods.value = periods
        console.log('✅ K线周期设置加载:', periods)
      }
    }
  } catch (err) {
    console.warn('K线周期设置加载失败，使用默认(日线):', err.message)
  }

  // 🔥 步骤0: 加载账户信息

  console.log('💰 步骤0: 加载账户信息...')

  await fetchAccountInfo()

  console.log(`✅ 账户信息加载完成: 可用资金 ¥${accountInfo.value.availableFunds}`)

  

  // 🔥 重要:先加载股票列表,再加载自选标的

  console.log('📋 步骤1: 加载股票列表...')

  await loadSymbolList()

  console.log(`✅ 股票列表加载完成: ${symbolList.value.length} 个标的`)

  

  // 🔥 新增：加载完symbolList后，立即更新当前股票名称

  const currentSymbolInfo = symbolList.value.find(s => s.code === selectedSymbol.value)

  if (currentSymbolInfo) {

    currentStock.value.name = currentSymbolInfo.name

    console.log('✅ 初始化当前股票名称:', currentSymbolInfo.name)

  } else {

    currentStock.value.name = getInstrumentNameFallback(selectedSymbol.value)

    console.log('⚠️ 使用备用名称:', currentStock.value.name)

  }

  

  // 加载自选标的列表

  console.log('📂 步骤2: 加载自选标的...')

  await loadFavoriteStocks()

  console.log(`✅ 自选标的加载完成: ${favoriteStocks.value.size} 个`)

  

  // 🔥 强制触发favoriteList计算

  console.log('🔄 步骤3: 触发favoriteList计算...')

  const favList = favoriteList.value

  console.log(`📊 favoriteList结果: ${favList.length} 个自选标的`)

  

  if (favList.length > 0) {

    console.log('✅ 自选标的列表:')

    favList.forEach(item => {

      console.log(`  - ${item.code} ${item.name}`)

    })

  } else {

    console.warn('⚠️ favoriteList为空!')

    console.log('调试信息:')

    console.log('  - symbolList.length:', symbolList.value.length)

    console.log('  - favoriteStocks.size:', favoriteStocks.value.size)

    console.log('  - favoriteStocks内容:', Array.from(favoriteStocks.value))

    console.log('  - symbolList前3个:', symbolList.value.slice(0, 3).map(s => s.code))

  }

  

  // 检查URL参数中是否有symbol

  const urlParams = new URLSearchParams(window.location.search)

  const symbolFromUrl = urlParams.get('symbol')

  console.log('🔍 URL参数检查:')

  console.log('   完整URL:', window.location.href)

  console.log('   search部分:', window.location.search)

  console.log('   解析的symbol:', symbolFromUrl)

  

  if (symbolFromUrl) {

    console.log('从URL参数加载股票:', symbolFromUrl)

    selectedSymbol.value = symbolFromUrl

    // 🔥 更新股票名称

    const urlSymbolInfo = symbolList.value.find(s => s.code === symbolFromUrl)

    if (urlSymbolInfo) {

      currentStock.value.name = urlSymbolInfo.name

      console.log('✅ URL参数股票名称:', urlSymbolInfo.name)

    } else {

      currentStock.value.name = getInstrumentNameFallback(symbolFromUrl)

      console.log('⚠️ URL参数使用备用名称:', currentStock.value.name)

    }

  } else {

    console.log('⚠️ 没有URL参数,使用默认值:', selectedSymbol.value)

  }

  

  // 🔥 不再单独加载市场数据

  // SimpleTradingInterface会自动加载K线数据，并通过handlePriceUpdate事件更新价格

  // 这样可以确保所有地方显示的价格都来自同一个数据源

  console.log('📊 等待SimpleTradingInterface加载数据并更新价格...')



  // 初始化更新时间

  updateData()



  // 定时更新时间戳（不再更新价格）

  updateTimer = setInterval(() => {

    updateData()

  }, 3000) // 每3秒更新一次时间



  // 同步策略管理 + replay 策略，供智能策略选择器统一使用

  try {

    await strategyStore.loadStrategies({ page: 1, pageSize: 200 })

  } catch (e) {

    console.warn('初始加载策略管理列表失败:', e?.message || e)

  }

  await loadReplayStrategyList()

  

  // 监听策略选择事件

  strategyStore.on('strategySelected', (strategy) => {

    if (!strategy || syncingStrategySelection) return

    const selectedId = normalizeStrategySelectionId(getStrategySelectionValue(strategy))

    const loadedId = normalizeStrategySelectionId(getStrategySelectionValue(loadedStrategy.value))

    if (selectedId && selectedId === loadedId) return

    loadStrategyToTrading(strategy)

  })

  

  // 监听策略更新事件

  strategyStore.on('strategyUpdated', (strategy) => {

    if (loadedStrategy.value && loadedStrategy.value.id === strategy.id) {

      loadedStrategy.value = strategy

      // 重新加载信号

      loadStrategySignals(strategy, selectedSymbol.value).catch((error) => {

        console.error('自动刷新策略信号失败:', error)

      })

    }

  })

  

  // 监听策略删除事件

  strategyStore.on('strategyDeleted', (strategy) => {

    if (loadedStrategy.value && loadedStrategy.value.id === strategy.id) {

      unloadStrategy()

    }

  })

})



// ===== Replay Mode =====

const isReplayMode = ref(false)

const replaySessionId = ref(null)

const replayLoading = ref(false)

const replayPlaying = ref(false)

const replaySpeed = ref(1000)

const replayStartDate = ref('2020-01-01')

const replayStrategy = ref(null)

const replayDataSource = ref('mock')

const replayTickDate = ref(null)



// Futures tick data composable for replay

const {

  availableDates: replayFtDates,

  availableSymbols: replayFtSymbols,

  loading: replayFtLoading,

  loadDates: loadReplayFtDates,

  loadSymbols: loadReplayFtSymbols,

  formatDate: formatReplayTickDate,

} = useFuturesTickData()

const replayIndex = ref(0)

const replayTotal = ref(0)

const replayCurrentDate = ref('')

const replayCash = ref(1000000)

const replayInitialCash = ref(1000000)

const replayBuyCount = ref(0)

const replaySellCount = ref(0)

const replayChartData = ref([])

const replaySignals = ref([])

const replayStrategyList = ref([])

let syncingStrategySelection = false

let replayTimer = null



const normalizeStrategySelectionId = (value) => {

  if (value === null || value === undefined || value === '') return null

  return String(value)

}



const getStrategySelectionValue = (strategy) => {

  if (!strategy || typeof strategy !== 'object') return null

  return strategy.id ?? strategy.type ?? null

}



const findStrategyBySelectionId = (strategyId) => {

  const normalizedTarget = normalizeStrategySelectionId(strategyId)

  if (!normalizedTarget) return null

  return selectorStrategies.value.find((item) => {

    const candidateId = getStrategySelectionValue(item)

    return normalizeStrategySelectionId(candidateId) === normalizedTarget

  }) || null

}



const selectorStrategies = computed(() => {

  const selectedFromStore = strategyStore.selectedStrategy ? [strategyStore.selectedStrategy] : []

  const loadedFromChart = loadedStrategy.value ? [loadedStrategy.value] : []

  const fromStore = Array.isArray(strategyStore.strategies) ? strategyStore.strategies : []

  const fromReplay = Array.isArray(replayStrategyList.value) ? replayStrategyList.value : []

  const merged = [...selectedFromStore, ...loadedFromChart, ...fromStore, ...fromReplay]

  const deduped = []

  const seen = new Set()



  for (const item of merged) {

    if (!item) continue

    const selectionId = normalizeStrategySelectionId(getStrategySelectionValue(item))

    const key = selectionId ? `selection:${selectionId}` : `name:${item.name || ''}`

    if (!seen.has(key)) {

      seen.add(key)

      deduped.push(item)

    }

  }



  return deduped

})



const replayProgress = computed(() =>

  replayTotal.value > 0 ? Math.round(replayIndex.value / replayTotal.value * 100) : 0

)

const replayReturn = computed(() =>

  replayInitialCash.value > 0 ? (replayCash.value - replayInitialCash.value) / replayInitialCash.value * 100 : 0

)



const loadReplayStrategyList = async () => {

  try {

    const res = await request.get('/strategies', {

      params: {

        page: 1,

        pageSize: 200

      }

    })

    // Backend returns { success, data: { list, total } }

    const list = res?.data?.list || res?.data || res || []

    replayStrategyList.value = Array.isArray(list) ? list : []

    console.log('Loaded replay strategies:', replayStrategyList.value.length)



    if (strategyStore.selectedStrategy) {

      const selectedValue = getStrategySelectionValue(strategyStore.selectedStrategy)

      if (selectedValue !== null && selectedValue !== undefined) {

        replayStrategy.value = selectedValue

      }

    }

  } catch (e) {

    console.error('Failed to load strategy list:', e)

    replayStrategyList.value = []

  }

}



const toggleReplayMode = async () => {

  if (isReplayMode.value) {

    stopReplay()

    isReplayMode.value = false

    replaySessionId.value = null

    replayChartData.value = []

    replaySignals.value = []

  } else {

    isReplayMode.value = true

    await loadReplayStrategyList()

  }

}



const onReplayDataSourceChange = async (val) => {

  if (val === 'futures-tick') {

    await loadReplayFtDates()

    if (replayFtDates.value.length > 0 && !replayTickDate.value) {

      replayTickDate.value = replayFtDates.value[replayFtDates.value.length - 1]

      await loadReplayFtSymbols(replayTickDate.value)

    }

  }

}



const onReplayTickDateChange = async (date) => {

  if (date) await loadReplayFtSymbols(date)

}



const startReplay = async () => {

  if (!selectedSymbol.value) {

    ElMessage.warning('请先选择标的')

    return

  }



  replayLoading.value = true

  replayChartData.value = []

  replaySignals.value = []

  replayBuyCount.value = 0

  replaySellCount.value = 0

  replayCash.value = 1000000

  replayInitialCash.value = 1000000



  try {

    const payload = {

      symbol: selectedSymbol.value,

      startDate: replayStartDate.value,

      period: currentPeriod.value === '1d' ? 'daily' : currentPeriod.value,

      strategyId: replayStrategy.value,

      dataSource: replayDataSource.value,

    }



    if (replayDataSource.value === 'futures-tick') {

      payload.date = replayTickDate.value

      payload.period = '1m'

      if (!payload.date) {

        ElMessage.warning('请选择交易日期')

        replayLoading.value = false

        return

      }

    }



    const res = await request.post('/replay/start', payload)



    if (res.success) {

      replaySessionId.value = res.sessionId

      replayTotal.value = res.totalCandles

      replayIndex.value = 0

      ElMessage.success(`回放已就绪：共 ${res.totalCandles} 根K线，起始日期 ${res.startDate}`)

      await replayStep(1)

    }

  } catch (e) {

    ElMessage.error('启动回放失败：' + e.message)

  } finally {

    replayLoading.value = false

  }

}



const replayStep = async (count = 1) => {

  if (!replaySessionId.value) return



  try {

    const res = await request.get(`/replay/${replaySessionId.value}/next`, {

      params: { count: Math.abs(count) }

    })



    if (res.success && res.candles?.length > 0) {

      replayChartData.value = [...replayChartData.value, ...res.candles]



      replayIndex.value = res.currentIndex

      const lastCandle = res.candles[res.candles.length - 1]

      replayCurrentDate.value = lastCandle?.date || lastCandle?.time || ''

      // 🔥 同步更新左上角价格显示
      if (lastCandle) {
        currentStock.value.price = parseFloat(lastCandle.close || lastCandle.c || 0)
        currentStock.value.open  = parseFloat(lastCandle.open  || lastCandle.o || 0)
        currentStock.value.high  = parseFloat(lastCandle.high  || lastCandle.h || 0)
        currentStock.value.low   = parseFloat(lastCandle.low   || lastCandle.l || 0)
        if (replayChartData.value.length > 1) {
          const prev = replayChartData.value[replayChartData.value.length - 2]
          const prevClose = parseFloat(prev.close || prev.c || currentStock.value.price)
          currentStock.value.change = parseFloat((currentStock.value.price - prevClose).toFixed(2))
          currentStock.value.changePercent = prevClose > 0
            ? parseFloat(((currentStock.value.price - prevClose) / prevClose * 100).toFixed(2))
            : 0
        }
      }

      replayCash.value = res.account?.cash || replayCash.value



      if (res.signals) {

        replaySignals.value.push(...res.signals)

        for (const signal of res.signals) {

          if (signal.type === 'buy') replayBuyCount.value++

          if (signal.type === 'sell') replaySellCount.value++

        }

      }



      if (res.isFinished) {

        pauseReplay()

        ElMessage.success(`回放完成，收益率：${replayReturn.value.toFixed(2)}%`)

      }

    }

  } catch (e) {

    console.error('Replay step failed:', e)

  }

}



const playReplay = () => {

  replayPlaying.value = true

  replayTimer = setInterval(() => {

    replayStep(1)

  }, replaySpeed.value)

}



const pauseReplay = () => {

  replayPlaying.value = false

  if (replayTimer) { clearInterval(replayTimer); replayTimer = null }

}



const stopReplay = () => {

  pauseReplay()

  replaySessionId.value = null

}



watch(replaySpeed, () => {

  if (replayPlaying.value) {

    pauseReplay()

    playReplay()

  }

})



watch(

  () => replayStrategy.value,

  async (newStrategyId, oldStrategyId) => {

    if (syncingStrategySelection) return



    const normalizedNewId = normalizeStrategySelectionId(newStrategyId)

    const normalizedOldId = normalizeStrategySelectionId(oldStrategyId)

    if (normalizedNewId === normalizedOldId) return



    const strategy = findStrategyBySelectionId(newStrategyId)



    syncingStrategySelection = true

    try {

      strategyStore.selectStrategy(strategy || null)



      if (!strategy) {

        loadedStrategy.value = null

        strategySignals.value = []

        strategyAuxiliaryData.value = {}

        return

      }



      const loadedId = normalizeStrategySelectionId(getStrategySelectionValue(loadedStrategy.value))

      if (loadedId !== normalizeStrategySelectionId(getStrategySelectionValue(strategy))) {

        await loadStrategyToTrading(strategy)

      }

    } catch (error) {

      console.error('同步回放策略选择失败:', error)

      ElMessage.error('同步策略选择失败：' + (error?.message || '未知错误'))

    } finally {

      syncingStrategySelection = false

    }

  }

)



watch(

  () => strategyStore.selectedStrategy,

  (strategy) => {

    if (syncingStrategySelection) return

    syncingStrategySelection = true

    try {

      replayStrategy.value = strategy ? getStrategySelectionValue(strategy) : null

    } finally {

      syncingStrategySelection = false

    }

  },

  { deep: true }

)



onUnmounted(() => {

  if (updateTimer) {

    clearInterval(updateTimer)

  }



  if (strategyStatusTimer) {

    clearInterval(strategyStatusTimer)

  }



  stopReplay()

})

</script>



<style scoped src="./Trading.css"></style>
