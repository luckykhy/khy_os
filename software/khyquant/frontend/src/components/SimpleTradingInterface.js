

import { ref, reactive, onMounted, onUnmounted, computed, nextTick, watch } from 'vue'

import { ElMessage, ElMessageBox } from 'element-plus'

import { TrendCharts, Calendar, Setting, Check, FolderOpened, Plus, CaretRight, Search, DArrowLeft, DArrowRight, Refresh, Tickets, List, Document } from '@element-plus/icons-vue'

import { createChart } from 'lightweight-charts'

import request from '@/utils/request'

import { useRouter } from 'vue-router'

import DataSourceIndicator from '@/components/DataSourceIndicator.vue'

import ModernTradingPanel from '@/components/ModernTradingPanel.vue'

import LiveTradingCenter from '@/components/LiveTradingCenter.vue'

import ProfessionalTradeHistory from '@/components/ProfessionalTradeHistory.vue'

import CollapsiblePositionBar from '@/components/CollapsiblePositionBar.vue'

// import EnhancedPositionsPanel from '@/components/EnhancedPositionsPanel.vue'

// import RecentTradesPanel from '@/components/RecentTradesPanel.vue'

import { useDataSource } from '@/services/dataSourceService.js'

import { useStrategyStore } from '@/stores/strategyStore'

import { getApiBaseUrl } from '@/config/api'

import { ensureArray, addArrayWatchGuard, validateApiArrayField } from '@/utils/arrayGuards'

import { normalizeKlineForTV, parseCrosshairTime } from '@/utils/tvTime'

// 移动端适配导入

import { useResponsive } from '@/composables/useResponsive'

import { getChartOptions, getMobileCandlestickOptions } from '@/utils/mobileChartConfig'
import { executeSandbox } from '@/utils/sandboxExecute'

import { useTouchGestures } from '@/composables/useTouchGestures'

import { throttleData, debounce, enableHardwareAcceleration } from '@/utils/performanceOptimizer'

import {
  getStrategyTypeColor as getStrategyTypeColorHelper,
  getStrategyTypeLabel as getStrategyTypeLabelHelper,
  getLanguageColor as getLanguageColorHelper,
  getLanguageName as getLanguageNameHelper,
  disabledStartDate as disabledStartDateHelper,
  disabledEndDate as disabledEndDateHelper,
  parseTradingError,
  formatTime as formatTimeHelper,
  formatDateTime as formatDateTimeHelper
} from '@/utils/simpleTradingHelpers'
import {
  generateMockKlineData as generateMockKlineDataHelper,
  getInstrumentInfo as getInstrumentInfoHelper,
  getPeriodInfo as getPeriodInfoHelper,
  getBaseVolume as getBaseVolumeHelper,
  getSymbolSeed as getSymbolSeedHelper
} from '@/utils/simpleTradingMarketData'
import {
  generateMockSignals as generateMockSignalsHelper,
  generateStrategySignals as generateStrategySignalsHelper
} from '@/utils/simpleTradingSignalGenerator'



export default {

  name: 'SimpleTradingInterface',

  components: {

    TrendCharts,

    DataSourceIndicator,

    ModernTradingPanel,

    LiveTradingCenter,

    ProfessionalTradeHistory,

    CollapsiblePositionBar

    // EnhancedPositionsPanel,

    // RecentTradesPanel

  },

  props: {

    contract: {

      type: String,

      default: '000001'

    },

    contractName: {

      type: String,

      default: ''

    },

    period: {

      type: String,

      default: '1d'

    },

    signals: {

      type: Array,

      default: () => [],

      validator: (value) => {

        if (!Array.isArray(value)) {

          console.error('❌ [Props Validator] signals prop is not an array:', {

            type: typeof value,

            value: value

          })

          return false

        }

        return true

      }

    },

    auxiliaryData: {

      type: Object,

      default: () => ({}),

      validator: (value) => {

        if (typeof value !== 'object' || value === null || Array.isArray(value)) {

          console.error('❌ [Props Validator] auxiliaryData prop is not an object:', {

            type: typeof value,

            value: value

          })

          return false

        }

        return true

      }

    },

    loadedStrategy: {

      type: Object,

      default: null

    },

    currentPrice: {

      type: Number,

      default: 0

    },

    availableFunds: {

      type: Number,

      default: 100000

    },

    replayData: {

      type: Array,

      default: null

    },

    replaySignals: {

      type: Array,

      default: () => []

    },

    enabledPeriods: {

      type: Array,

      default: () => ['daily']

    }

  },

  emits: ['contract-change', 'period-change', 'signal-loaded', 'order-placed', 'navigate-to-backtest-analysis', 'price-update'],

  setup(props, { emit }) {

    const router = useRouter()

    

    // 🔥 策略状态管理

    const strategyStore = useStrategyStore()

    

    // 数据源服务

    const {

      currentSource,

      availableSources,

      dataQuality,

      connectionStatus,

      lastUpdate,

      loading: dataSourceLoading,

      error: dataSourceError,

      switchDataSource,

      refreshSourceStatus,

      updateSourceInfo,

      on: onDataSourceEvent,

      off: offDataSourceEvent

    } = useDataSource()

    

    // 🔥 修复：数据源状态（直接使用 ref 对象，不要再包装）

    const dataSourceState = {

      currentSource,

      availableSources,

      dataQuality,

      connectionStatus,

      lastUpdate

    }

    

    // 响应式布局管理

    const { isMobile, getMobileConfig } = useResponsive()

    const mobileConfig = computed(() => getMobileConfig())

    

    // 触摸手势处理

    const touchGestures = useTouchGestures({

      enablePinchZoom: true,

      enablePan: true,

      enableLongPress: true,

      minZoomLevel: 10,

      maxZoomLevel: 100

    })

    

    // 响应式数据

    const chartContainer = ref(null)

    const chart = ref(null)

    const candlestickSeries = ref(null)

    const ma5Series = ref(null)

    const ma10Series = ref(null)

    const ma20Series = ref(null)

    const signalSeries = ref(null)

    const strategyIndicatorSeries = ref(null)

    const auxiliarySeries = ref({}) // 🔥 新增：辅助线系列

    

    // 基础数据

    const selectedSymbol = ref(props.contract)

    // Futures default to 1m, stocks keep prop default (usually 1d)

    const initIsFutures = (() => {

      const c = (props.contract || '').toUpperCase()

      return /^[A-Z]{1,3}[\d_]/i.test(c) || /^[A-Z]{1,3}[-_]?MAIN$/i.test(c)

    })()

    const selectedPeriod = ref(props.period || '1d')

    const currentPrice = ref(0)

    const priceChange = ref(0)

    const pricePercent = ref(0)

    

    // 悬停信息数据

    let lastPriceEmitTime = 0

    const crosshairData = reactive({

      visible: false,

      time: '',

      open: '',

      high: '',

      low: '',

      close: '',

      volume: '',

      changeClass: ''

    })

    

    // 当前合约信息 (从props获取)

    const currentContract = computed(() => {

      const code = props.contract || selectedSymbol.value

      // 优先使用父组件传递的名称，否则使用映射表

      const name = props.contractName || getInstrumentName(code)

      console.log('🏷️ 当前合约信息更新:', { 

        code, 

        name, 

        propsContract: props.contract, 

        propsContractName: props.contractName,

        selectedSymbol: selectedSymbol.value 

      })

      return { 

        name: name,

        symbol: code

      }

    })

    

    // 获取合约名称

    const getInstrumentName = (code) => {

      // 移除前缀（sh/sz）

      const cleanCode = code.replace(/^(sh|sz|SH|SZ)/, '')

      

      // 常见股票/指数代码映射

      const nameMap = {

        '000001': '上证指数',

        '000014': '上证50B',

        '000016': '上证50',

        '000300': '沪深300',

        '000688': '科创50',

        '000852': '中证1000',

        '000905': '中证500',

        '399001': '深证成指',

        '399006': '创业板指',

        '510300': '沪深300ETF',

        '510500': '中证500ETF',

        '512100': '中证1000ETF',

        '159915': '创业板ETF',

        '159919': '沪深300ETF',

        '588000': '科创50ETF'

      }

      

      // 期货代码映射

      if (/^IF\d{4}$/.test(cleanCode)) return '沪深300股指期货'

      if (/^IC\d{4}$/.test(cleanCode)) return '中证500股指期货'

      if (/^IH\d{4}$/.test(cleanCode)) return '上证50股指期货'

      if (/^IM\d{4}$/.test(cleanCode)) return '中证1000股指期货'

      

      // 返回映射的名称或默认显示代码

      const result = nameMap[cleanCode] || `合约 ${cleanCode}`

      console.log('📛 获取合约名称:', code, '->', cleanCode, '->', result)

      return result

    }

    

    // 价格变化样式

    const priceChangeClass = computed(() => {

      if (priceChange.value > 0) return 'price-up'

      if (priceChange.value < 0) return 'price-down'

      return 'price-neutral'

    })



    // Detect if the current symbol is a futures contract

    const isFuturesSymbol = computed(() => {

      const code = (selectedSymbol.value || props.contract || '').toUpperCase()

      // Futures patterns: rb_main, RB2605, RB8888, IF2601, A2605, etc.

      return /^[A-Z]{1,3}[\d_]/i.test(code) || /^[A-Z]{1,3}[-_]?MAIN$/i.test(code)

    })

    // Dynamic period options based on admin settings
    const allPeriodDefs = [
      { setting: '1m', value: '1m', label: '1分' },
      { setting: '5m', value: '5m', label: '5分' },
      { setting: '15m', value: '15m', label: '15分' },
      { setting: '30m', value: '30m', label: '30分' },
      { setting: '1h', value: '1h', label: '1时' },
      { setting: 'daily', value: '1d', label: '日线' },
      { setting: 'weekly', value: '1w', label: '周线' },
      { setting: 'monthly', value: '1M', label: '月线' }
    ]

    const availablePeriods = computed(() => {
      const enabled = props.enabledPeriods || ['daily']
      return allPeriodDefs.filter(p => enabled.includes(p.setting) || enabled.includes(p.value))
    })



    const priceChangeText = computed(() => {

      const change = priceChange.value

      return change >= 0 ? `+${change.toFixed(2)}` : change.toFixed(2)

    })

    

    const pricePercentText = computed(() => {

      const percent = pricePercent.value

      return percent >= 0 ? `+${percent.toFixed(2)}%` : `${percent.toFixed(2)}%`

    })

    

    // 策略相关

    const loadingStrategy = ref(false)

    const loadedStrategy = ref(null)

    const signals = ref([])

    

    // 刷新数据状态

    const refreshing = ref(false)

    const auxiliaryData = ref({}) // 🔥 新增：辅助线数据

    const showSignals = ref(true)

    const showStrategyIndicator = ref(false)

    const showAuxiliaryLines = ref(true) // 🔥 新增：是否显示辅助线

    const showMA = ref(true) // 🔥 新增：是否显示均线

    const showBoll = ref(true) // 🔥 新增：是否显示布林带

    

    // 🔥 新增：持仓面板相关

    const mockPositions = ref([])  // 改为空数组，从API加载

    

    // 🔥 加载真实持仓

    const loadPositions = async () => {

      try {

        const response = await request.get('/trading/positions')

        if (response.success) {

          // 转换API返回的持仓格式为CollapsiblePositionBar需要的格式

          mockPositions.value = response.data.map((pos, index) => ({

            id: index + 1,

            symbol: pos.symbol,

            name: pos.symbolName,

            direction: 'long',  // 默认多头

            isFutures: false,   // 默认非期货

            avgPrice: pos.avgCost,

            quantity: pos.totalQuantity,

            currentPrice: pos.currentPrice,

            profit: pos.unrealizedProfit,

            profitPercent: pos.unrealizedProfitPercent,

            isUpdating: false,

            isDemo: pos.isDemo  // 保留演示标记

          }))

          console.log('✅ 持仓加载成功:', mockPositions.value.length, '个')

        }

      } catch (error) {

        console.error('❌ 加载持仓失败:', error)

        // 失败时使用硬编码的演示数据

        mockPositions.value = [

          {

            id: 1,

            symbol: 'rb2601',

            name: '螺纹钢',

            direction: 'long',

            isFutures: true,

            avgPrice: 3280.00,

            quantity: 1,

            currentPrice: 3450.00,

            profit: 17000.00,

            profitPercent: 5.18,

            isUpdating: false,

            isDemo: true

          },

          {

            id: 2,

            symbol: '600519',

            name: '贵州茅台',

            direction: 'long',

            isFutures: false,

            avgPrice: 1650.00,

            quantity: 100,

            currentPrice: 1720.00,

            profit: 7000.00,

            profitPercent: 4.24,

            isUpdating: false,

            isDemo: true

          },

          {

            id: 3,

            symbol: 'IF2601',

            name: '沪深300',

            direction: 'short',

            isFutures: true,

            avgPrice: 4250.00,

            quantity: 1,

            currentPrice: 4320.00,

            profit: -7000.00,

            profitPercent: -1.65,

            isUpdating: false,

            isDemo: true

          }

        ]

      }

    }

    

    // 当前价格映射（用于持仓面板）

    const currentPrices = ref({

      'rb2601': 3450.00,

      '600519': 1720.00,

      'IF2601': 4320.00

    })

    

    // 🔥 新增：策略选择对话框

    const showStrategySelectDialog = ref(false)

    

    // 🔥 新增：快速策略选择对话框

    const showQuickStrategyDialog = ref(false)

    const selectedQuickStrategyId = ref('')

    const strategySearchKeyword = ref('')

    const executingStrategy = ref(false)

    

    // 可用策略列表

    const availableStrategies = ref([])

    const loadingStrategies = ref(false)

    const selectedStrategyId = ref('')

    

    // 🔥 添加watch守卫，确保数组变量始终是数组

    addArrayWatchGuard(availableStrategies, 'availableStrategies', watch)

    addArrayWatchGuard(signals, 'signals', watch)

    

    // 🔥 新增：过滤后的策略列表（用于快速选择）

    const filteredStrategies = computed(() => {

      if (!strategySearchKeyword.value) {

        return ensureArray(availableStrategies.value, [], 'availableStrategies')

      }

      const keyword = strategySearchKeyword.value.toLowerCase()

      const strategies = ensureArray(availableStrategies.value, [], 'availableStrategies')

      return strategies.filter(strategy => {

        return strategy.name.toLowerCase().includes(keyword) ||

               (strategy.description && strategy.description.toLowerCase().includes(keyword))

      })

    })

    

    // 当前选中的策略

    const selectedStrategy = computed(() => {

      const strategies = ensureArray(availableStrategies.value, [], 'availableStrategies')

      return strategies.find(s => s.id === selectedStrategyId.value) || null

    })

    

    // 交易表单

    const orderForm = reactive({

      direction: 'buy',

      type: 'market',

      price: 0,

      quantity: 100

    })

    

    const submittingOrder = ref(false)

    

    // 🔥 组件引用（已废弃，保留用于未来可能的集成）

    // const enhancedPositionsPanelRef = ref(null)

    // const recentTradesPanelRef = ref(null)

    

    // 最新信号

    const recentSignals = computed(() => {

      const signalsArray = ensureArray(signals.value, [], 'signals')

      return signalsArray.slice(-5).reverse()

    })

    

    // 🔥 安全的 signals 计算属性，确保始终返回数组

    const safeSignals = computed(() => {

      return ensureArray(props.signals, [], 'props.signals')

    })

    

    // 回测相关

    // Upload dialog

    const showUploadDialog = ref(false)

    const uploadPeriod = ref('Tick')

    const uploadHeaders = computed(() => {

      const token = localStorage.getItem('token')

      return token ? { Authorization: `Bearer ${token}` } : {}

    })

    const onUploadSuccess = (response) => {

      if (response.success) {

        ElMessage.success(`上传成功: ${response.message}`)

        showUploadDialog.value = false

        loadChartData()

      } else {

        ElMessage.error(response.message || '上传失败')

      }

    }

    const onUploadError = (error) => {

      ElMessage.error(`上传失败: ${error.message || '未知错误'}`)

    }

    const folderInputRef = ref(null)

    const folderUploadProgress = ref('')

    const triggerFolderUpload = () => {

      folderInputRef.value?.click()

    }

    const handleFolderUpload = async (event) => {

      const files = Array.from(event.target.files || [])

      const csvFiles = files.filter(f => f.name.endsWith('.csv'))

      if (csvFiles.length === 0) {

        ElMessage.warning('文件夹中没有 CSV 文件')

        return

      }

      // Try to detect date from folder path (webkitRelativePath: "20260421/tick/RB2605.csv")

      const dateMatch = (csvFiles[0].webkitRelativePath || '').match(/(\d{8})/)

      const date = dateMatch?.[1] || ''



      folderUploadProgress.value = `正在上传 ${csvFiles.length} 个文件...`

      let successCount = 0

      const token = localStorage.getItem('token')

      for (const file of csvFiles) {

        try {

          const form = new FormData()

          form.append('file', file, file.name)

          form.append('period', uploadPeriod.value)

          if (date) form.append('date', date)

          const resp = await fetch(`${getApiBaseUrl()}/futures-tick/upload`, {

            method: 'POST',

            headers: { Authorization: `Bearer ${token}` },

            body: form

          })

          const result = await resp.json()

          if (result.success) successCount++

          folderUploadProgress.value = `已上传 ${successCount}/${csvFiles.length}`

        } catch (err) {

          console.error(`Upload failed for ${file.name}:`, err)

        }

      }

      folderUploadProgress.value = ''

      ElMessage.success(`文件夹上传完成: ${successCount}/${csvFiles.length} 成功`)

      event.target.value = '' // Reset input

      if (successCount > 0) loadChartData()

    }



    const showBacktestDialog = ref(false)

    const backtesting = ref(false)

    const backtestFormRef = ref(null)

    const backtestParams = reactive({

      strategyId: '', // 添加策略ID字段

      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),

      endDate: new Date(),

      initialCapital: 100000,

      commission: 0.0003,

      slippage: 0.0001,

      benchmark: '000300'

    })

    

    const backtestRules = {

      strategyId: [

        { required: true, message: '请选择策略', trigger: 'change' }

      ],

      startDate: [

        { required: true, message: '请选择开始日期', trigger: 'change' }

      ],

      endDate: [

        { required: true, message: '请选择结束日期', trigger: 'change' }

      ],

      initialCapital: [

        { required: true, message: '请输入初始资金', trigger: 'blur' }

      ]

    }

    

    // 安全地移除图表系列（避免事件监听器错误）

    const safeRemoveSeries = (series) => {

      if (!chart.value || !series) return

      

      try {

        chart.value.removeSeries(series)

      } catch (error) {

        console.log('移除系列时出错:', error.message)

      }

    }

    

    // 计算移动平均线

    const calculateMA = (data, period) => {

      const result = []

      for (let i = 0; i < data.length; i++) {

        if (i < period - 1) {

          // 数据不足period个，跳过

          continue

        }

        

        let sum = 0

        for (let j = 0; j < period; j++) {

          sum += data[i - j].close

        }

        

        result.push({

          time: data[i].time,

          value: sum / period

        })

      }

      return result

    }

    

    // Bollinger Bands series refs

    const bollUpperSeries = ref(null)

    const bollMiddleSeries = ref(null)

    const bollLowerSeries = ref(null)

    const klineDataCache = ref([]) // Cache of normalized kline data for Boll recalc



    // Calculate Bollinger Bands (period=20, stddev=2)

    const calculateBollingerBands = (data, period = 20, stddev = 2) => {

      const upper = []

      const middle = []

      const lower = []



      for (let i = period - 1; i < data.length; i++) {

        let sum = 0

        for (let j = 0; j < period; j++) {

          sum += data[i - j].close

        }

        const ma = sum / period



        let sqSum = 0

        for (let j = 0; j < period; j++) {

          sqSum += Math.pow(data[i - j].close - ma, 2)

        }

        const std = Math.sqrt(sqSum / period)



        middle.push({ time: data[i].time, value: ma })

        upper.push({ time: data[i].time, value: ma + stddev * std })

        lower.push({ time: data[i].time, value: ma - stddev * std })

      }



      return { upper, middle, lower }

    }



    // Chart container height helper — fill available space, never use fixed 500px

    const getChartHeight = () => {

      if (isMobile.value) return Math.floor(window.innerHeight * 0.6)

      if (chartContainer.value) {

        const h = chartContainer.value.clientHeight

        if (h > 100) return h

      }

      // Fallback: calculate from parent

      return Math.max(window.innerHeight - 200, 400)

    }



    // 图表初始化

    const initChart = () => {

      if (!chartContainer.value) return



      try {

        const width = chartContainer.value.clientWidth

        const height = getChartHeight()

        

        // 使用移动端优化的配置

        const chartOptions = getChartOptions(isMobile.value, width, height)

        

        chart.value = createChart(chartContainer.value, chartOptions)

        

        // 创建K线系列 - 使用移动端优化配置

        const candlestickOptions = isMobile.value 

          ? getMobileCandlestickOptions() 

          : {

              upColor: '#ff6b6b',

              downColor: '#51cf66',

              borderVisible: false,

              wickUpColor: '#ff6b6b',

              wickDownColor: '#51cf66'

            }

        

        candlestickSeries.value = chart.value.addCandlestickSeries(candlestickOptions)

        

        // 移动端启用硬件加速

        if (isMobile.value) {

          enableHardwareAcceleration(chartContainer.value)

        }

        

        // 创建均线系列

        ma5Series.value = chart.value.addLineSeries({

          color: '#FFD700',

          lineWidth: 1,

          title: 'MA5',

          priceLineVisible: false,

          lastValueVisible: false,

          priceScaleId: 'right'  // 🔥 使用和K线相同的价格刻度

        })

        

        ma10Series.value = chart.value.addLineSeries({

          color: '#00CED1',

          lineWidth: 1,

          title: 'MA10',

          priceLineVisible: false,

          lastValueVisible: false,

          priceScaleId: 'right'  // 🔥 使用和K线相同的价格刻度

        })

        

        ma20Series.value = chart.value.addLineSeries({

          color: '#FF69B4',

          lineWidth: 1,

          title: 'MA20',

          priceLineVisible: false,

          lastValueVisible: false,

          priceScaleId: 'right'  // 🔥 使用和K线相同的价格刻度

        })



        // Bollinger Bands (BOLL 20,2) overlay

        bollUpperSeries.value = chart.value.addLineSeries({

          color: '#ff6b6b',

          lineWidth: 1,

          lineStyle: 2, // dashed

          title: 'BOLL Upper',

          priceLineVisible: false,

          lastValueVisible: false,

          priceScaleId: 'right',

          crosshairMarkerVisible: false,

        })

        bollMiddleSeries.value = chart.value.addLineSeries({

          color: '#ffd93d',

          lineWidth: 1,

          lineStyle: 2,

          title: 'BOLL Mid',

          priceLineVisible: false,

          lastValueVisible: false,

          priceScaleId: 'right',

          crosshairMarkerVisible: false,

        })

        bollLowerSeries.value = chart.value.addLineSeries({

          color: '#6bcb77',

          lineWidth: 1,

          lineStyle: 2,

          title: 'BOLL Lower',

          priceLineVisible: false,

          lastValueVisible: false,

          priceScaleId: 'right',

          crosshairMarkerVisible: false,

        })



        // 订阅 crosshair 移动事件 - 保存引用以便后续取消订阅

        const crosshairMoveHandler = (param) => {

          // 添加安全检查，防止访问已移除的系列

          if (!chart.value || !candlestickSeries.value) {

            return

          }

          updateCrosshairInfo(param)

        }

        chart.value.subscribeCrosshairMove(crosshairMoveHandler)

        

        // 保存处理器引用以便清理

        if (!chart.value._crosshairHandlers) {

          chart.value._crosshairHandlers = []

        }

        chart.value._crosshairHandlers.push(crosshairMoveHandler)

        

        console.log('✅ 图表初始化成功')

        loadChartData()

      } catch (error) {

        console.error('❌ 图表初始化失败:', error)

        ElMessage.error('图表初始化失败')

      }

    }

    

    // 刷新数据（强制重新加载，绕过缓存）

    const refreshData = async () => {

      try {

        refreshing.value = true

        console.log('🔄 手动刷新数据...')

        

        // 添加时间戳参数绕过缓存

        const timestamp = Date.now()

        const symbol = selectedSymbol.value || props.contract || '000001.SH'

        

        // 获取标的信息

        const instrumentInfo = getInstrumentInfo(symbol)

        const endDate = new Date()

        

        // 🔥 始终传 startDate，有多少真实数据显示多少，不依赖 currentSource 状态
        let startDateParam = ''
        if (instrumentInfo && instrumentInfo.listingDate) {
          const listingDate = new Date(instrumentInfo.listingDate)
          startDateParam = `&startDate=${listingDate.toISOString().split('T')[0]}`
          console.log(`📅 从上市日期开始: ${listingDate.toLocaleDateString()}`)
        } else {
          const defaultStart = new Date('1990-01-01')
          startDateParam = `&startDate=${defaultStart.toISOString().split('T')[0]}`
          console.log(`📅 使用默认起始日期: ${defaultStart.toLocaleDateString()}`)
        }

        

        // 转换周期格式

        const periodMap = {

          '1d': 'daily',

          '1w': 'weekly',

          '1M': 'monthly'

        }

        const period = periodMap[selectedPeriod.value] || 'daily'

        

        // 🔥 添加nocache参数强制刷新，增加超时时间支持大数据量

        const controller = new AbortController()

        const timeoutId = setTimeout(() => controller.abort(), 120000) // 120秒超时（2分钟）

        

        try {

          const response = await fetch(

            `${getApiBaseUrl()}/comprehensive-data/kline?symbol=${symbol}${startDateParam}&endDate=${endDate.toISOString().split('T')[0]}&period=${period}&nocache=${timestamp}`,

            {

              signal: controller.signal,

              cache: 'no-store', // 禁用浏览器缓存

              headers: {

                'Cache-Control': 'no-cache',

                'Pragma': 'no-cache',

                'Content-Type': 'application/json'

              }

            }

          )

          clearTimeout(timeoutId)

          clearTimeout(timeoutId)

        

          if (response.ok) {

          const data = await response.json()

          console.log('✅ 刷新成功:', data.source, '数据条数:', data.kline?.length || 0)

          

          if (data.kline && data.kline.length > 0) {

            // Normalize to "YYYY-MM-DD" strings for Lightweight Charts

            const klineData = normalizeKlineForTV(data.kline)

            

            // 更新图表

            if (candlestickSeries.value) {

              candlestickSeries.value.setData(klineData)

              klineDataCache.value = klineData



              // 计算并更新均线

              ma5Data.value = calculateMA(klineData, 5)

              ma10Data.value = calculateMA(klineData, 10)

              ma20Data.value = calculateMA(klineData, 20)

              

              if (ma5Series.value) ma5Series.value.setData(ma5Data.value)

              if (ma10Series.value) ma10Series.value.setData(ma10Data.value)

              if (ma20Series.value) ma20Series.value.setData(ma20Data.value)



              // Update Bollinger Bands on refresh

              const bollRefresh = calculateBollingerBands(klineData, 20, 2)

              if (bollUpperSeries.value) bollUpperSeries.value.setData(bollRefresh.upper)

              if (bollMiddleSeries.value) bollMiddleSeries.value.setData(bollRefresh.middle)

              if (bollLowerSeries.value) bollLowerSeries.value.setData(bollRefresh.lower)



              // 自动缩放 - 强制显示所有数据

              nextTick(() => {

                if (chart.value && klineData.length > 0) {

                  // 方法1：fitContent（自动适应）

                  chart.value.timeScale().fitContent()

                  

                  // 方法2：强制设置可见范围（确保显示所有数据）

                  setTimeout(() => {

                    const firstTime = klineData[0].time

                    const lastTime = klineData[klineData.length - 1].time

                    chart.value.timeScale().setVisibleRange({

                      from: firstTime,

                      to: lastTime

                    })

                    console.log(`Visible range set: ${new Date(firstTime * 1000).toISOString().slice(0, 10)} to ${new Date(lastTime * 1000).toISOString().slice(0, 10)}`)

                  }, 100)

                }

              })

              

              // 更新当前价格

              const lastCandle = klineData[klineData.length - 1]

              currentPrice.value = lastCandle.close

              

              // 计算价格变化

              if (klineData.length > 1) {

                const prevCandle = klineData[klineData.length - 2]

                priceChange.value = lastCandle.close - prevCandle.close

                pricePercent.value = (priceChange.value / prevCandle.close) * 100

              }

              

              // 🔥 使用后端返回的dataQuality更新数据源状态

              updateSourceInfo({

                source: data.source,

                dataQuality: data.dataQuality || 'medium'

              })

              

              // 🔥 通知父组件更新左上角价格
              emit('price-update', {
                price: lastCandle.close,
                open: lastCandle.open,
                high: lastCandle.high,
                low: lastCandle.low,
                change: priceChange.value,
                changePercent: pricePercent.value,
                dataSource: currentSource.value?.name || '真实数据'
              })

              ElMessage.success({
                message: `数据已刷新！最新价格: ${lastCandle.close}`,
                duration: 2000
              })

            }

          }

          } else {

            clearTimeout(timeoutId)

            throw new Error('刷新失败')

          }

        } catch (fetchError) {

          clearTimeout(timeoutId)

          if (fetchError.name === 'AbortError') {

            throw new Error('请求超时（30秒），数据量较大，请稍后重试')

          }

          throw fetchError

        }

      } catch (error) {

        console.error('❌ 刷新数据失败:', error)

        ElMessage.error('刷新数据失败，请稍后重试')

      } finally {

        refreshing.value = false

      }

    }

    

    // 🔥 新增: 标准化标的代码格式

    /**

     * 标准化标的代码格式

     * 000116 -> sz000116

     * 600519 -> sh600519

     * 000116.SZ -> sz000116

     * 600519.SH -> sh600519

     */

    const normalizeSymbolCode = (symbol) => {

      if (!symbol) return 'sh000001'

      symbol = symbol.trim()

      

      // 已经是标准格式 (sh000001, sz000116)

      if (/^(sh|sz)\d{6}$/i.test(symbol)) {

        return symbol.toLowerCase()

      }

      

      // 带.SH/.SZ后缀 (000116.SZ -> sz000116)

      if (/^\d{6}\.(SH|SZ)$/i.test(symbol)) {

        const [code, market] = symbol.split('.')

        return `${market.toLowerCase()}${code}`

      }

      

      // 只有6位数字 (000116 -> sz000116, 600519 -> sh600519)

      if (/^\d{6}$/.test(symbol)) {

        return symbol.startsWith('6') ? `sh${symbol}` : `sz${symbol}`

      }

      

      console.warn(`⚠️ 无法标准化标的代码: ${symbol}, 返回原值`)

      return symbol

    }

    

    // 加载图表数据

    const loadChartData = async () => {

      try {

        console.log('📊 开始加载图表数据...')

        

        // 🔥 优先尝试从后端API获取真实数据

        let klineData = []

        const symbol = selectedSymbol.value || props.contract || '000001.SH'

        

        // 🔥 标准化标的代码格式

        const normalizedSymbol = normalizeSymbolCode(symbol)

        console.log(`🔍 标的代码转换: ${symbol} -> ${normalizedSymbol}`)

        

        // 🔥 添加重试机制

        let retryCount = 0

        const maxRetries = 3

        let apiSuccess = false

        

        while (retryCount < maxRetries && !apiSuccess) {

          try {

            if (retryCount > 0) {

              console.log(`🔄 第 ${retryCount + 1} 次尝试获取数据...`)

              // 🔥 增加重试延迟: 3秒, 5秒, 8秒（支持大数据量加载）

              const delays = [3000, 5000, 8000]

              await new Promise(resolve => setTimeout(resolve, delays[retryCount - 1] || 3000))

            }

            

            console.log('🌐 尝试从后端API获取真实数据:', normalizedSymbol)

            

            // 🔥 获取标的上市时间

            const instrumentInfo = getInstrumentInfo(normalizedSymbol)

            

            // 计算日期范围

            const endDate = new Date()

            

            // 🔥 始终传递startDate参数，获取完整历史数据

            let startDateParam = ''

            

            // 获取标的上市日期

            if (instrumentInfo && instrumentInfo.listingDate) {

              const listingDate = new Date(instrumentInfo.listingDate)

              startDateParam = `&startDate=${listingDate.toISOString().split('T')[0]}`

              console.log(`📅 从上市日期开始: ${listingDate.toLocaleDateString()}`)

            } else {

              // 如果没有上市日期信息，默认使用1990年（中国股市开始时间）

              const defaultStartDate = new Date('1990-01-01')

              startDateParam = `&startDate=${defaultStartDate.toISOString().split('T')[0]}`

              console.log(`📅 使用默认起始日期: ${defaultStartDate.toLocaleDateString()}`)

            }

            

            // 转换周期格式

            const periodMap = {

              '1m': '1m',

              '5m': '5m',

              '15m': '15m',

              '30m': '30m',

              '1h': '1h',

              '1d': 'daily',

              '1w': 'weekly',

              '1M': 'monthly'

            }

            const period = periodMap[selectedPeriod.value] || (isFuturesSymbol.value ? '1m' : 'daily')

            

            // 🧪 添加测试模式参数

            const testMode = localStorage.getItem('AKSHARE_TEST_MODE') || ''

            const testParam = testMode ? `&testMode=${testMode}` : ''

            

            // For futures, pass instrumentType so backend uses tick data priority

            const futuresParam = isFuturesSymbol.value ? '&instrumentType=futures' : ''



            // 🔥 使用标准化的标的代码，根据是否模拟数据决定是否传startDate

            const apiUrl = `${getApiBaseUrl()}/comprehensive-data/kline?symbol=${normalizedSymbol}${startDateParam}&endDate=${endDate.toISOString().split('T')[0]}&period=${period}${testParam}${futuresParam}`

            console.log(`📡 API URL: ${apiUrl}`)

            

            // 🔥 增加超时时间，支持大量历史数据加载

            const controller = new AbortController()

            const timeoutId = setTimeout(() => controller.abort(), 120000) // 120秒超时（2分钟）

            

            try {

              const response = await fetch(apiUrl, {

                signal: controller.signal,

                headers: {

                  'Content-Type': 'application/json'

                }

              })

              clearTimeout(timeoutId)

            

              if (response.ok) {

                const data = await response.json()

                

                // 🔥 添加详细日志

                console.log('📥 前端收到响应:');

                console.log('   success:', data.success);

                console.log('   source:', data.source);

                console.log('   kline条数:', data.kline?.length || 0);

                

                console.log('✅ 后端API响应:', data.source, '数据条数:', data.kline?.length || 0)

                

                if (data.kline && data.kline.length > 0) {

                  // Normalize to "YYYY-MM-DD" strings for Lightweight Charts

                  klineData = normalizeKlineForTV(data.kline)

                  console.log(`Chart data sample:`, klineData.slice(0, 2), 'total:', klineData.length)

                  

                  // 🔥 根据后端返回的source和dataQuality更新数据源状态

                  console.log('🔍 更新数据源状态, source =', data.source, ', dataQuality =', data.dataQuality);

                  

                  // 🔥 直接使用后端返回的dataQuality，不要硬编码

                  updateSourceInfo({

                    source: data.source,

                    dataQuality: data.dataQuality || 'medium'

                  })

                  console.log(`✅ 数据源状态已更新为: ${data.source} (${data.dataQuality?.toUpperCase() || 'MEDIUM'})`)

                  

                  // 🔥 API调用成功，退出重试循环

                  apiSuccess = true

                  console.log(`✅ API调用成功! 获取 ${klineData.length} 条K线数据`)

                } else {

                  throw new Error('API返回数据为空')

                }

              } else {

                throw new Error(`HTTP ${response.status}: ${response.statusText}`)

              }

            } catch (fetchError) {

              clearTimeout(timeoutId)

              if (fetchError.name === 'AbortError') {

                throw new Error('请求超时（30秒），数据量较大，请稍后重试')

              }

              throw fetchError

            }

          } catch (apiError) {

            retryCount++

            console.warn(`⚠️ 第 ${retryCount} 次API调用失败:`, apiError.message)

            

            if (retryCount >= maxRetries) {

              console.error(`❌ API调用失败，已重试 ${maxRetries} 次，将使用模拟数据`)

            }

          }

        }

        

        // 如果所有重试都失败，使用增强模拟数据作为后备

        if (klineData.length === 0) {

          console.log('📊 使用增强模拟数据作为后备')

          klineData = generateMockKlineData()

          

          // 🔥 使用 updateSourceInfo 更新数据源状态为增强模拟数据

          updateSourceInfo({

            source: '增强模拟数据',

            dataQuality: 'simulated'

          })

        }

        

        if (candlestickSeries.value && klineData.length > 0) {

          // normalizeKlineForTV already sorts and deduplicates when from API.

          // For mock data (already unix seconds), run through normalizer too.

          const uniqueData = Array.isArray(klineData) && klineData.length > 0 && typeof klineData[0]?.time === 'number' && klineData[0].time > 0

            ? klineData  // Mock data already has valid unix seconds

            : normalizeKlineForTV(klineData)



          console.log(`Chart data: ${uniqueData.length} candles`)

          

          // 移动端限制数据量

          const maxCount = mobileConfig.value.maxKlineCount

          const limitedData = isMobile.value ? throttleData(uniqueData, maxCount) : uniqueData

          

          candlestickSeries.value.setData(limitedData)

          klineDataCache.value = limitedData

          ma5Data.value = calculateMA(limitedData, 5)

          ma10Data.value = calculateMA(limitedData, 10)

          ma20Data.value = calculateMA(limitedData, 20)

          

          if (ma5Series.value) ma5Series.value.setData(ma5Data.value)

          if (ma10Series.value) ma10Series.value.setData(ma10Data.value)

          if (ma20Series.value) ma20Series.value.setData(ma20Data.value)



          // Calculate and set Bollinger Bands data

          const boll = calculateBollingerBands(limitedData, 20, 2)

          if (bollUpperSeries.value) bollUpperSeries.value.setData(boll.upper)

          if (bollMiddleSeries.value) bollMiddleSeries.value.setData(boll.middle)

          if (bollLowerSeries.value) bollLowerSeries.value.setData(boll.lower)



          // 🔥 强制自动缩放图表以显示所有数据

          if (chart.value) {

            // 使用 nextTick 确保数据已经渲染

            nextTick(() => {

              if (chart.value && limitedData.length > 0) {

                // 方法1：fitContent（自动适应）

                chart.value.timeScale().fitContent()

                

                // 方法2：强制设置可见范围（确保显示所有数据）

                setTimeout(() => {

                  const firstTime = limitedData[0].time

                  const lastTime = limitedData[limitedData.length - 1].time

                  chart.value.timeScale().setVisibleRange({

                    from: firstTime,

                    to: lastTime

                  })

                  console.log(`Visible range set: ${new Date(firstTime * 1000).toISOString().slice(0, 10)} to ${new Date(lastTime * 1000).toISOString().slice(0, 10)}`)

                  console.log('✅ 图表已自动缩放以显示所有数据')

                }, 100)

              }

            })

          }

          

          // 更新当前价格

          const lastCandle = klineData[klineData.length - 1]

          currentPrice.value = lastCandle.close

          

          // 计算价格变化

          if (klineData.length > 1) {

            const prevCandle = klineData[klineData.length - 2]

            priceChange.value = lastCandle.close - prevCandle.close

            pricePercent.value = (priceChange.value / prevCandle.close) * 100

          }

          

          // 🔥 发送价格更新事件给父组件

          emit('price-update', {

            price: lastCandle.close,

            open: lastCandle.open,

            high: lastCandle.high,

            low: lastCandle.low,

            change: priceChange.value,

            changePercent: pricePercent.value,

            dataSource: currentSource.value?.name || '真实数据'

          })

          

          console.log('✅ K线数据加载成功，共', klineData.length, '条数据，当前价格:', lastCandle.close)

        }

      } catch (error) {

        console.error('❌ 加载图表数据失败:', error)

        ElMessage.error('加载图表数据失败')

      }

    }

    


    // 生成模拟K线数据（根据周期和标的生成从上市开始的历史数据）
    const generateMockKlineData = () => generateMockKlineDataHelper({
      symbol: selectedSymbol.value || props.contract || '000001.SH',
      selectedPeriod: selectedPeriod.value,
      selectedSymbol: selectedSymbol.value,
      contract: props.contract,
      getInstrumentInfoFn: (symbol) => getInstrumentInfo(symbol),
      getSymbolSeedFn: (symbol) => getSymbolSeed(symbol)
    })

    // 获取标的信息（上市时间、基础价格等）
    const getInstrumentInfo = (symbol) => getInstrumentInfoHelper(symbol, normalizeSymbolCode)

    // 获取周期信息（时间间隔、最大数据点数、波动率等）
    const getPeriodInfo = getPeriodInfoHelper

    // 根据周期获取基础成交量
    const getBaseVolume = getBaseVolumeHelper

    // 根据标的代码生成种子
    const getSymbolSeed = getSymbolSeedHelper

    // 更新悬停信息

    const updateCrosshairInfo = (param) => {

      // 增强安全检查：确保图表和系列都存在

      if (!param || !param.time || !chart.value || !candlestickSeries.value) {

        crosshairData.visible = false

        return

      }

      

      // 安全获取系列数据

      let data

      try {

        data = param.seriesData.get(candlestickSeries.value)

      } catch (error) {

        console.log('获取系列数据时出错:', error)

        crosshairData.visible = false

        return

      }

      

      if (!data) {

        crosshairData.visible = false

        return

      }

      

      // Format time for display — handles string, number, and BusinessDay

      const { year, month, day, hour, minute } = parseCrosshairTime(param.time)

      const period = selectedPeriod.value



      let timeString = ''

      switch (period) {

        case '1m':

        case '5m':

        case '15m':

          timeString = `${year}年${month}月${day}日 ${hour}:${minute}`

          break

        case '1h':

          timeString = `${year}年${month}月${day}日 ${hour}:00`

          break

        case '1d':

          timeString = `${year}年${month}月${day}日`

          break

        case '1w':

          const weekStart = new Date(date)

          weekStart.setDate(date.getDate() - date.getDay())

          const weekEnd = new Date(weekStart)

          weekEnd.setDate(weekStart.getDate() + 6)

          const wsYear = weekStart.getFullYear()

          const wsMonth = String(weekStart.getMonth() + 1).padStart(2, '0')

          const wsDay = String(weekStart.getDate()).padStart(2, '0')

          const weYear = weekEnd.getFullYear()

          const weMonth = String(weekEnd.getMonth() + 1).padStart(2, '0')

          const weDay = String(weekEnd.getDate()).padStart(2, '0')

          timeString = `${wsYear}年${wsMonth}月${wsDay}日 - ${weYear}年${weMonth}月${weDay}日`

          break

        case '1M':

          timeString = `${year}年${month}月`

          break

        case '1Y':

          timeString = `${year}年`

          break

        default:

          timeString = `${year}年${month}月${day}日`

      }

      

      // 计算涨跌颜色

      const changeClass = data.close >= data.open ? 'price-up' : 'price-down'

      

      // 格式化成交量（如果有的话）

      const volume = data.volume ? formatVolume(data.volume) : ''

      

      // 更新悬停数据

      crosshairData.visible = true

      crosshairData.time = timeString

      crosshairData.open = data.open.toFixed(2)

      crosshairData.high = data.high.toFixed(2)

      crosshairData.low = data.low.toFixed(2)

      crosshairData.close = data.close.toFixed(2)

      crosshairData.volume = volume

      crosshairData.changeClass = changeClass

      // Throttled emit: update parent header at most every 100ms
      const now = Date.now()
      if (now - lastPriceEmitTime >= 100) {
        lastPriceEmitTime = now
        emit('price-update', {
          price: data.close,
          open: data.open,
          high: data.high,
          low: data.low,
          change: data.close - data.open,
          changePercent: ((data.close - data.open) / data.open) * 100,
          dataSource: currentSource.value?.name || '真实数据'
        })
      }

    }

    

    // 格式化成交量

    const formatVolume = (volume) => {

      if (volume >= 100000000) {

        return (volume / 100000000).toFixed(2) + '亿'

      } else if (volume >= 10000) {

        return (volume / 10000).toFixed(2) + '万'

      }

      return volume.toString()

    }

    

    // 事件处理函数

    const onSymbolChange = (symbol) => {

      console.log('📈 切换合约:', symbol)

      emit('contract-change', symbol)

      loadChartData()

    }

    

    const onPeriodChange = (period) => {

      console.log('⏰ 切换周期:', period)

      emit('period-change', period)

      loadChartData()

    }

    

    const loadStrategy = async () => {

      // 🔥 打开策略选择对话框

      console.log('📋 打开策略选择对话框...')

      

      // 加载可用策略列表

      await loadAvailableStrategies()

      

      // 显示对话框

      showStrategySelectDialog.value = true

    }

    

    // 🔥 新增：确认选择策略并执行

    const confirmSelectStrategy = async (strategy) => {

      if (!strategy) {

        ElMessage.warning('请选择一个策略')

        return

      }

      

      loadingStrategy.value = true

      try {

        console.log('📋 选择策略:', strategy.name)

        loadedStrategy.value = strategy

        

        // 关闭对话框

        showStrategySelectDialog.value = false

        

        // 🔥 执行策略代码，获取信号和辅助线数据

        console.log('📊 开始执行策略代码...')

        await executeStrategyCode()

        

        // 确保信号生成完成后再显示

        await nextTick()

        

        // 自动显示信号和辅助线到图表上

        if (signals.value.length > 0) {

          console.log('🎯 自动显示信号到图表，信号数量:', signals.value.length)

          displaySignalsOnChart()

          showSignals.value = true // 确保显示状态为true

        }

        

        // 🔥 显示辅助线

        if (auxiliaryData.value && Object.keys(auxiliaryData.value).length > 0) {

          console.log('🎨 检测到辅助线数据，自动显示:', Object.keys(auxiliaryData.value))

          displayAuxiliaryLines()

          showAuxiliaryLines.value = true

        }

        

        // 显示成功消息

        const auxCount = Object.keys(auxiliaryData.value || {}).length

        const message = auxCount > 0 

          ? `策略"${loadedStrategy.value.name}"加载成功！生成 ${signals.value.length} 个交易信号和 ${auxCount} 条辅助线`

          : `策略"${loadedStrategy.value.name}"加载成功！生成 ${signals.value.length} 个交易信号`

        

        ElMessage.success(message)

        

      } catch (error) {

        console.error('❌ 加载策略失败:', error)

        ElMessage.error('加载策略失败: ' + error.message)

      } finally {

        loadingStrategy.value = false

      }

    }

    

    // 🔥 新增：快速加载策略（从左侧面板）

    const quickLoadStrategy = async (strategy) => {

      if (!strategy) {

        ElMessage.warning('请选择一个策略')

        return

      }

      

      loadingStrategy.value = true

      selectedQuickStrategyId.value = strategy.id

      

      try {

        console.log('⚡ 快速加载策略:', strategy.name)

        loadedStrategy.value = strategy

        

        // 关闭对话框

        showQuickStrategyDialog.value = false

        

        // 执行策略代码，获取信号和辅助线数据

        console.log('📊 开始执行策略代码...')

        await executeStrategyCode()

        

        // 确保信号生成完成后再显示

        await nextTick()

        

        // 自动显示信号和辅助线到图表上

        if (signals.value.length > 0) {

          console.log('🎯 自动显示信号到图表，信号数量:', signals.value.length)

          displaySignalsOnChart()

          showSignals.value = true

        }

        

        // 显示辅助线

        if (auxiliaryData.value && Object.keys(auxiliaryData.value).length > 0) {

          console.log('🎨 检测到辅助线数据，自动显示:', Object.keys(auxiliaryData.value))

          displayAuxiliaryLines()

          showAuxiliaryLines.value = true

        }

        

        // 显示成功消息

        const auxCount = Object.keys(auxiliaryData.value || {}).length

        const message = auxCount > 0 

          ? `策略"${loadedStrategy.value.name}"加载成功！生成 ${signals.value.length} 个交易信号和 ${auxCount} 条辅助线`

          : `策略"${loadedStrategy.value.name}"加载成功！生成 ${signals.value.length} 个交易信号`

        

        ElMessage.success(message)

        

      } catch (error) {

        console.error('❌ 快速加载策略失败:', error)

        ElMessage.error('加载策略失败: ' + error.message)

      } finally {

        loadingStrategy.value = false

        selectedQuickStrategyId.value = ''

      }

    }

    

    // 🔥 新增：清除当前策略

    const clearStrategy = () => {

      loadedStrategy.value = null

      signals.value = []

      auxiliaryData.value = {}

      showSignals.value = false

      showAuxiliaryLines.value = false

      

      // 清除图表上的信号和辅助线

      clearSignalsFromChart()

      clearAuxiliaryLines()

      

      ElMessage.info('已清除当前策略')

    }

    

    // 🔥 新增：执行当前策略

    const executeCurrentStrategy = async () => {

      if (!loadedStrategy.value) {

        ElMessage.warning('请先加载策略')

        return

      }

      

      executingStrategy.value = true

      try {

        console.log('🚀 重新执行当前策略:', loadedStrategy.value.name)

        

        // 清除旧的信号和辅助线

        signals.value = []

        auxiliaryData.value = {}

        clearSignalsFromChart()

        clearAuxiliaryLines()

        

        // 执行策略代码

        await executeStrategyCode()

        

        // 确保信号生成完成后再显示

        await nextTick()

        

        // 自动显示信号和辅助线

        if (signals.value.length > 0) {

          displaySignalsOnChart()

          showSignals.value = true

        }

        

        if (auxiliaryData.value && Object.keys(auxiliaryData.value).length > 0) {

          displayAuxiliaryLines()

          showAuxiliaryLines.value = true

        }

        

        ElMessage.success(`策略执行完成！生成 ${signals.value.length} 个交易信号`)

        

      } catch (error) {

        console.error('❌ 执行策略失败:', error)

        ElMessage.error('执行策略失败: ' + error.message)

      } finally {

        executingStrategy.value = false

      }

    }

    

    // 🔥 新增：执行策略代码，获取信号和辅助线数据

    const executeStrategyCode = async () => {

      if (!loadedStrategy.value) {

        console.warn('⚠️ 没有加载的策略')

        return

      }

      

      try {

        // 获取K线数据

        const klineData = generateMockKlineData()

        if (!klineData || klineData.length === 0) {

          console.warn('⚠️ 没有K线数据')

          return

        }

        

        console.log('📊 准备执行策略代码:', {

          策略名称: loadedStrategy.value.name,

          策略类型: loadedStrategy.value.type,

          K线数据长度: klineData.length,

          有策略代码: !!loadedStrategy.value.code

        })

        

        // 如果策略有代码，执行真实的策略代码

        if (loadedStrategy.value.code) {

          console.log('🚀 执行真实策略代码...')

          const result = await executeRealStrategyCode(loadedStrategy.value, klineData)

          

          if (result) {

            // 处理策略返回结果

            if (Array.isArray(result)) {

              // 旧格式：只返回信号数组

              signals.value = result

              auxiliaryData.value = {}

              console.log('✅ 策略返回信号数组（旧格式）:', signals.value.length, '个信号')

            } else if (result.signals) {

              // 新格式：返回 { signals, auxiliaryData }

              signals.value = result.signals || []

              auxiliaryData.value = result.auxiliaryData || {}

              console.log('✅ 策略返回完整数据（新格式）:', {

                信号数量: signals.value.length,

                辅助线: Object.keys(auxiliaryData.value)

              })

            }

          } else {

            console.warn('⚠️ 策略执行无返回结果，使用模拟数据')

            generateStrategySignals()

          }

        } else {

          // 没有策略代码，使用模拟信号生成

          console.log('📊 策略无代码，使用模拟信号生成')

          generateStrategySignals()

        }

        

      } catch (error) {

        console.error('❌ 执行策略代码失败:', error)

        // 失败时使用模拟信号

        console.log('📊 执行失败，回退到模拟信号生成')

        generateStrategySignals()

      }

    }

    

    // 🔥 新增：执行真实的策略代码

    const executeRealStrategyCode = async (strategy, klineData) => {

      try {

        console.log('🔧 开始执行策略代码...')

        

        // 准备策略参数

        const params = strategy.parameters || {}

        

        // All languages execute via backend vm sandbox
        console.log('📦 策略沙箱执行, 语言:', strategy.language || 'javascript')

        const result = await executeSandbox({
          code: strategy.code,
          klineData,
          parameters: params,
          language: strategy.language || 'javascript'
        })

        console.log('✅ 策略沙箱执行完成, signals:', result.signals?.length || 0)

        return result

      } catch (error) {

        console.error('❌ 执行策略代码异常:', error)

        throw error

      }

    }

    


    const generateMockSignals = () => {
      const mockSignals = generateMockSignalsHelper()
      signals.value = mockSignals

      console.log('📊 SimpleTradingInterface: 生成模拟信号', {
        信号数量: mockSignals.length,
        时间范围: `${new Date(mockSignals[0].time * 1000).toLocaleDateString()} - ${new Date(mockSignals[mockSignals.length - 1].time * 1000).toLocaleDateString()}`,
        前3个信号: mockSignals.slice(0, 3),
        recentSignals数量: recentSignals.value.length
      })
    }

    // 生成基于策略的信号
    const generateStrategySignals = () => {
      if (!loadedStrategy.value) {
        console.log('⚠️ 没有加载的策略，无法生成信号')
        return
      }

      const klineData = generateMockKlineData()
      if (!klineData || klineData.length === 0) {
        console.log('⚠️ 没有K线数据，无法生成信号')
        return
      }

      const { signals: strategySignals, signalPositions } = generateStrategySignalsHelper({
        strategy: loadedStrategy.value,
        klineData
      })

      signals.value = strategySignals
      console.log('📊 SimpleTradingInterface: 生成策略信号', {
        策略名称: loadedStrategy.value.name,
        策略类型: loadedStrategy.value.type,
        信号数量: strategySignals.length,
        K线数据长度: klineData.length,
        信号位置: signalPositions,
        前3个信号: strategySignals.slice(0, 3)
      })
    }

    const toggleSignals = () => {

      console.log('🔄 toggleSignals 被调用，当前状态:', {

        showSignals: showSignals.value,

        loadedStrategy存在: !!loadedStrategy.value,

        signals数量: signals.value.length

      })

      

      showSignals.value = !showSignals.value

      

      if (showSignals.value) {

        // 显示信号

        if (!loadedStrategy.value) {

          ElMessage.warning('请先加载策略再显示信号')

          showSignals.value = false

          return

        }

        

        // 如果没有信号或需要重新生成，则生成策略信号

        if (signals.value.length === 0) {

          console.log('📊 没有信号数据，重新生成策略信号')

          generateStrategySignals()

        }

        

        // 显示信号到图表

        if (signals.value.length > 0) {

          console.log('🎯 显示信号到图表，信号数量:', signals.value.length)

          displaySignalsOnChart()

          ElMessage.success(`已显示 ${signals.value.length} 个交易信号`)

        } else {

          console.log('⚠️ 没有可显示的信号')

          ElMessage.warning('没有可显示的交易信号')

        }

        

      } else {

        // 隐藏信号

        console.log('🧹 隐藏信号标记')

        clearSignalsFromChart()

        ElMessage.info('信号已隐藏')

      }

      

      console.log('✅ toggleSignals 完成，最终状态:', {

        showSignals: showSignals.value,

        signals数量: signals.value.length

      })

    }

    

    // 🔥 新增：切换右侧面板显示/隐藏

    const togglePanel = () => {

      const oldState = panelCollapsed.value

      panelCollapsed.value = !panelCollapsed.value

      

      console.log('� 切换右侧面板:', {

        旧状态: oldState ? '折叠' : '展开',

        新状态: panelCollapsed.value ? '折叠' : '展开',

        当前值: panelCollapsed.value

      })

      

      // 🔥 强制 Vue 更新 DOM

      nextTick(() => {

        console.log('📊 DOM 更新后的状态:', panelCollapsed.value)

        

        // 🔥 延长等待时间，确保 CSS 动画和 DOM 更新完成

        setTimeout(() => {

          if (chart.value && chartContainer.value) {

            // 🔥 强制重新计算容器尺寸

            const container = chartContainer.value

            const rect = container.getBoundingClientRect()

            const newWidth = Math.floor(rect.width)

            const newHeight = Math.floor(rect.height)

            

            console.log('📊 调整图表大小:', { 

              width: newWidth, 

              height: newHeight,

              collapsed: panelCollapsed.value,

              containerWidth: container.clientWidth,

              rectWidth: rect.width

            })

            

            // 🔥 只有当尺寸有效时才调整

            if (newWidth > 100 && newHeight > 100) {

              // 🔥 使用 applyOptions 明确设置新尺寸

              chart.value.applyOptions({

                width: newWidth,

                height: newHeight

              })

              

              // 🔥 调用 resize 方法

              chart.value.resize(newWidth, newHeight)

              

              // 🔥 调整时间轴以适应新宽度

              chart.value.timeScale().fitContent()

            } else {

              console.warn('⚠️ 容器尺寸无效，跳过图表调整')

            }

          }

        }, 400) // 🔥 延长到 400ms，确保动画完成

      })

    }

    

    // 在图表上显示信号标记

    const displaySignalsOnChart = () => {

      if (!candlestickSeries.value || !signals.value || signals.value.length === 0) {

        console.log('⚠️ 无法显示信号：图表或信号数据不存在', {

          candlestickSeries存在: !!candlestickSeries.value,

          signals数量: signals.value?.length || 0

        })

        return

      }

      

      try {

        // 获取当前K线数据的时间范围，用于过滤有效信号

        const klineData = generateMockKlineData()

        if (!klineData || klineData.length === 0) {

          console.log('⚠️ 无K线数据，无法显示信号')

          return

        }

        

        const minTime = klineData[0].time

        const maxTime = klineData[klineData.length - 1].time

        

        console.log('📊 K线时间范围:', {

          最小时间: new Date(minTime * 1000).toLocaleString(),

          最大时间: new Date(maxTime * 1000).toLocaleString(),

          K线数据点数: klineData.length

        })

        

        // 🔥 调试：查看原始信号数据

        console.log('🔍 原始信号数据（前3个）:', signals.value.slice(0, 3).map(s => ({

          type: s.type,

          time: s.time,

          timeType: typeof s.time,

          timeDate: new Date(s.time * 1000).toLocaleString(),

          price: s.price

        })))

        

        // 创建信号标记并按时间排序，只显示在K线时间范围内的信号

        const markers = signals.value

          .map(signal => {

            // 🔥 修复：确保时间戳是秒级的

            let timeValue = signal.time

            if (typeof timeValue === 'string') {

              timeValue = parseInt(timeValue)

            }

            // 如果是毫秒级时间戳，转换为秒级

            if (timeValue > 10000000000) {

              timeValue = Math.floor(timeValue / 1000)

            }

            

            return {

              originalSignal: signal,

              timeValue: timeValue,

              inRange: timeValue >= minTime && timeValue <= maxTime

            }

          })

          .filter(item => {

            if (!item.inRange) {

              console.log('⚠️ 信号时间超出范围:', {

                time: item.timeValue,

                date: new Date(item.timeValue * 1000).toLocaleString(),

                minTime: minTime,

                maxTime: maxTime,

                signal: item.originalSignal

              })

            }

            return item.inRange

          })

          .map(item => {

            const signal = item.originalSignal

            return {

              time: item.timeValue,

              position: signal.type === 'buy' ? 'belowBar' : 'aboveBar',

              color: signal.type === 'buy' ? '#4CAF50' : '#F44336',

              shape: signal.type === 'buy' ? 'arrowUp' : 'arrowDown',

              text: signal.type === 'buy' ? '买' : '卖',

              size: 1.5 // 🔥 增大标记尺寸，更容易看到

            }

          })

          .sort((a, b) => a.time - b.time) // 按时间升序排序

        

        console.log('🎯 准备显示信号标记:', {

          原始信号数量: signals.value.length,

          过滤后标记数量: markers.length,

          时间戳范围: markers.length > 0 ? `${markers[0].time} - ${markers[markers.length-1].time}` : '无',

          前3个标记: markers.slice(0, 3).map(m => ({

            time: new Date(m.time * 1000).toLocaleString(),

            type: m.shape,

            color: m.color

          }))

        })

        

        if (markers.length === 0) {

          console.warn('⚠️ 警告：所有信号都被过滤掉了！')

          console.warn('   可能原因：信号时间戳与K线时间戳不匹配')

          console.warn('   K线时间范围:', minTime, '-', maxTime)

          console.warn('   信号时间范围:', signals.value.map(s => s.time))

          ElMessage.warning('信号时间与K线时间不匹配，无法显示')

          return

        }

        

        // 直接在K线系列上设置标记

        candlestickSeries.value.setMarkers(markers)

        

        console.log('✅ 信号标记已设置到K线系列上:', markers.length, '个标记')

        

        // 强制图表重绘

        if (chart.value) {

          chart.value.timeScale().fitContent()

        }

        

      } catch (error) {

        console.error('❌ 显示信号标记失败:', error)

        console.error('错误堆栈:', error.stack)

        ElMessage.error('显示信号标记失败: ' + error.message)

      }

    }

    

    // 清除图表上的信号标记

    const clearSignalsFromChart = () => {

      if (candlestickSeries.value) {

        candlestickSeries.value.setMarkers([])

        console.log('🧹 图表信号标记已清除')

        

        // 强制图表重绘

        if (chart.value) {

          chart.value.timeScale().fitContent()

        }

      } else {

        console.log('⚠️ candlestickSeries 不存在，无法清除标记')

      }

    }

    

    const toggleStrategyIndicator = () => {

      showStrategyIndicator.value = !showStrategyIndicator.value

      // 这里可以添加显示/隐藏指标的逻辑

    }

    

    // 存储均线数据

    const ma5Data = ref([])

    const ma10Data = ref([])

    const ma20Data = ref([])

    

    // 🔥 新增：切换均线显示

    const toggleMA = () => {

      console.log('🔘 toggleMA 被调用, 当前状态:', showMA.value)

      console.log('📊 均线系列状态:', {

        ma5: !!ma5Series.value,

        ma10: !!ma10Series.value,

        ma20: !!ma20Series.value

      })

      console.log('📈 均线数据长度:', {

        ma5: ma5Data.value.length,

        ma10: ma10Data.value.length,

        ma20: ma20Data.value.length

      })

      

      showMA.value = !showMA.value

      

      if (showMA.value) {

        // 显示均线 - 恢复数据

        console.log('✅ 显示均线')

        if (ma5Series.value && ma5Data.value.length > 0) {

          ma5Series.value.setData(ma5Data.value)

          console.log('  MA5 数据已设置')

        }

        if (ma10Series.value && ma10Data.value.length > 0) {

          ma10Series.value.setData(ma10Data.value)

          console.log('  MA10 数据已设置')

        }

        if (ma20Series.value && ma20Data.value.length > 0) {

          ma20Series.value.setData(ma20Data.value)

          console.log('  MA20 数据已设置')

        }

        ElMessage.success('均线已显示')

      } else {

        // 隐藏均线 - 清空数据

        console.log('❌ 隐藏均线')

        if (ma5Series.value) {

          ma5Series.value.setData([])

          console.log('  MA5 数据已清空')

        }

        if (ma10Series.value) {

          ma10Series.value.setData([])

          console.log('  MA10 数据已清空')

        }

        if (ma20Series.value) {

          ma20Series.value.setData([])

          console.log('  MA20 数据已清空')

        }

        ElMessage.info('均线已隐藏')

      }

    }



    // 🔥 新增：切换布林带显示

    const toggleBoll = () => {

      showBoll.value = !showBoll.value

      if (showBoll.value) {

        // Restore Bollinger data from current chart data

        if (candlestickSeries.value && chart.value) {

          // Re-calculate from stored kline data

          const kline = klineDataCache.value

          if (kline && kline.length > 0) {

            const boll = calculateBollingerBands(kline, 20, 2)

            if (bollUpperSeries.value) bollUpperSeries.value.setData(boll.upper)

            if (bollMiddleSeries.value) bollMiddleSeries.value.setData(boll.middle)

            if (bollLowerSeries.value) bollLowerSeries.value.setData(boll.lower)

          }

        }

        ElMessage.success('布林带已显示')

      } else {

        if (bollUpperSeries.value) bollUpperSeries.value.setData([])

        if (bollMiddleSeries.value) bollMiddleSeries.value.setData([])

        if (bollLowerSeries.value) bollLowerSeries.value.setData([])

        ElMessage.info('布林带已隐藏')

      }

    }

    

    // 🔥 新增：显示辅助线到图表

    const displayAuxiliaryLines = () => {

      if (!chart.value || !auxiliaryData.value) {

        console.warn('⚠️ 图表或辅助线数据不存在')

        return

      }

      

      // 🔥 关键修复：确保K线数据存在

      if (!candlestickSeries.value) {

        console.warn('⚠️ K线系列不存在，先初始化图表')

        initChart()

        return

      }

      

      try {

        // 先清除现有的辅助线（但不要动K线系列！）

        clearAuxiliaryLines()

        

        console.log('🎨 开始显示辅助线:', Object.keys(auxiliaryData.value))

        console.log('🎨 辅助线数据详情:', auxiliaryData.value)

        console.log('📊 当前K线系列状态:', candlestickSeries.value ? '存在' : '不存在')

        

        // 🔥 关键修复：生成K线数据（只生成一次，避免重复）

        const klineData = generateMockKlineData()

        console.log(`� 生成K线数据: ${klineData.length} 条`)

        

        // 🔥 关键修复：完全重建图表以确保K线可见

        try {

          console.log('� 开始重建图表以确保K线可见...')

          

          // 1. 移除旧的K线系列

          if (candlestickSeries.value) {

            try {

              safeRemoveSeries(candlestickSeries.value)

              console.log('🗑️ 已移除旧的K线系列')

            } catch (e) {

              console.warn('⚠️ 移除K线系列失败:', e.message)

            }

          }

          

          // 2. 重新创建K线系列（确保它在最底层）

          candlestickSeries.value = chart.value.addCandlestickSeries({

            upColor: '#ff6b6b',

            downColor: '#51cf66',

            borderVisible: false,

            wickUpColor: '#ff6b6b',

            wickDownColor: '#51cf66',

            priceLineVisible: true,

            lastValueVisible: true

          })

          

          // 3. 设置K线数据（使用同一份数据）

          candlestickSeries.value.setData(klineData)

          console.log('✅ K线系列重新创建成功，数据点数:', klineData.length)

          

          // 🔥 强制自动缩放图表以显示所有数据

          nextTick(() => {

            if (chart.value) {

              chart.value.timeScale().fitContent()

              console.log('✅ 图表已自动缩放以显示所有数据')

            }

          })

          

          // 更新当前价格

          const lastCandle = klineData[klineData.length - 1]

          currentPrice.value = lastCandle.close

          

          // 计算价格变化

          if (klineData.length > 1) {

            const prevCandle = klineData[klineData.length - 2]

            priceChange.value = lastCandle.close - prevCandle.close

            pricePercent.value = (priceChange.value / prevCandle.close) * 100

          }

        } catch (rebuildError) {

          console.error('❌ 重建图表失败:', rebuildError)

        }

        

        let successCount = 0

        let failCount = 0

        

        // 遍历所有辅助线数据

        Object.keys(auxiliaryData.value).forEach(lineName => {

          const lineConfig = auxiliaryData.value[lineName]

          

          if (!lineConfig || !lineConfig.data || !Array.isArray(lineConfig.data)) {

            console.warn(`⚠️ 辅助线 "${lineName}" 数据格式不正确:`, lineConfig)

            failCount++

            return

          }

          

          console.log(`📊 处理辅助线 "${lineName}"，原始数据点数:`, lineConfig.data.length)

          

          // 🔥 新方案：完全参考测试页面，直接基于当前K线数据重新计算辅助线

          // 这样可以确保辅助线和K线的价格范围完全匹配

          console.log(`🔄 基于当前K线数据重新计算辅助线 "${lineName}"`)

          

          const expandedLineData = []

          const period = 20  // 箱体周期

          

          // 根据辅助线类型重新计算（完全参考测试页面的逻辑）

          if (lineName === '多线' || lineName.includes('上轨')) {

            // 多线（箱体上轨）：使用滚动窗口的最高价

            klineData.forEach((candle, index) => {

              const start = Math.max(0, index - period + 1)

              const slice = klineData.slice(start, index + 1)

              const high = Math.max(...slice.map(c => c.high))

              expandedLineData.push({

                time: candle.time,

                value: parseFloat(high.toFixed(2))

              })

            })

            console.log(`✅ 多线重新计算完成: ${expandedLineData.length} 个数据点`)

          } else if (lineName === '空线' || lineName.includes('下轨')) {

            // 空线（箱体下轨）：使用滚动窗口的最低价

            klineData.forEach((candle, index) => {

              const start = Math.max(0, index - period + 1)

              const slice = klineData.slice(start, index + 1)

              const low = Math.min(...slice.map(c => c.low))

              expandedLineData.push({

                time: candle.time,

                value: parseFloat(low.toFixed(2))

              })

            })

            console.log(`✅ 空线重新计算完成: ${expandedLineData.length} 个数据点`)

          } else if (lineName === '箱体中线' || lineName.includes('中线')) {

            // 箱体中线：上轨和下轨的平均值

            klineData.forEach((candle, index) => {

              const start = Math.max(0, index - period + 1)

              const slice = klineData.slice(start, index + 1)

              const high = Math.max(...slice.map(c => c.high))

              const low = Math.min(...slice.map(c => c.low))

              const mid = (high + low) / 2

              expandedLineData.push({

                time: candle.time,

                value: parseFloat(mid.toFixed(2))

              })

            })

            console.log(`✅ 箱体中线重新计算完成: ${expandedLineData.length} 个数据点`)

          } else {

            // 未知类型的辅助线，跳过

            console.warn(`⚠️ 未知辅助线类型 "${lineName}"，跳过`)

            failCount++

            return

          }

          

          // 创建线条系列 - 使用最简配置

          const lineStyle = lineConfig.lineStyle !== undefined ? lineConfig.lineStyle : 0

          const lineWidth = lineConfig.lineWidth || 2

          const color = lineConfig.color || '#ffa726'

          const title = lineConfig.name || lineName

          

          try {

            // 🔥 使用最简配置，只设置必要的属性

            const lineSeries = chart.value.addLineSeries({

              color: color,

              lineWidth: lineWidth,

              lineStyle: lineStyle,

              // 🔥 关键：完全禁用所有交互功能

              priceLineVisible: false,

              lastValueVisible: false,

              crosshairMarkerVisible: false,

              // 不设置 title，避免图例问题

            })

            

            // 设置数据（使用扩展后的数据）

            lineSeries.setData(expandedLineData)

            

            // 保存引用

            auxiliarySeries.value[lineName] = lineSeries

            

            successCount++

            console.log(`✅ 辅助线 "${title}" 已添加到图表`)

          } catch (seriesError) {

            console.error(`❌ 添加辅助线 "${title}" 失败:`, seriesError)

            failCount++

          }

        })

        

        console.log(`✅ 辅助线显示完成: 成功 ${successCount} 条, 失败 ${failCount} 条`)

        

        // 🔥 关键修复：重新显示均线（如果之前是显示状态）

        if (showMA.value) {

          console.log('🔄 重新显示均线...')

          nextTick(() => {

            // 重新设置均线数据

            if (ma5Series.value && ma5Data.value.length > 0) {

              ma5Series.value.setData(ma5Data.value)

            }

            if (ma10Series.value && ma10Data.value.length > 0) {

              ma10Series.value.setData(ma10Data.value)

            }

            if (ma20Series.value && ma20Data.value.length > 0) {

              ma20Series.value.setData(ma20Data.value)

            }

          })

        }

        

        // 🔥 关键修复：重新显示信号（如果有信号数据）

        if (signals.value && signals.value.length > 0) {

          console.log('🔄 重新显示交易信号...')

          nextTick(() => {

            displaySignalsOnChart()

          })

        }

        

        // 🔥 关键修复：完全不调整视图范围

        // 让图表保持当前状态，K线和辅助线都可见

        // 用户可以手动缩放查看不同范围

        console.log('✅ 辅助线已添加，保持当前视图（K线应该仍然可见）')

        console.log('💡 提示: 如果看不到K线，请双击图表或使用鼠标滚轮调整视图')

        

      } catch (error) {

        console.error('❌ 显示辅助线失败:', error)

        ElMessage.error('显示辅助线失败: ' + error.message)

      }

    }

    

    // 🔥 新增：清除辅助线

    const clearAuxiliaryLines = () => {

      if (!chart.value) return

      

      try {

        console.log('🧹 开始清除辅助线，当前数量:', Object.keys(auxiliarySeries.value).length)

        

        // 移除所有辅助线系列

        Object.entries(auxiliarySeries.value).forEach(([name, series]) => {

          try {

            if (series && chart.value) {

              safeRemoveSeries(series)

              console.log(`🧹 已移除辅助线: ${name}`)

            }

          } catch (removeError) {

            console.warn(`⚠️ 移除辅助线 "${name}" 时出错:`, removeError.message)

          }

        })

        

        // 清空辅助线系列对象

        auxiliarySeries.value = {}

        

        console.log('✅ 辅助线已全部清除')

        

      } catch (error) {

        console.error('❌ 清除辅助线失败:', error)

        // 即使出错也要清空对象，避免残留引用

        auxiliarySeries.value = {}

      }

    }

    

    // 🔥 新增：切换辅助线显示

    const toggleAuxiliaryLines = () => {

      showAuxiliaryLines.value = !showAuxiliaryLines.value

      

      if (showAuxiliaryLines.value) {

        // 显示辅助线

        if (Object.keys(auxiliaryData.value || {}).length > 0) {

          displayAuxiliaryLines()

          ElMessage.success(`已显示 ${Object.keys(auxiliaryData.value).length} 条辅助线`)

        } else {

          ElMessage.warning('当前策略没有辅助线数据')

          showAuxiliaryLines.value = false

        }

      } else {

        // 隐藏辅助线

        clearAuxiliaryLines()

        ElMessage.info('辅助线已隐藏')

      }

    }

    

    // 加载可用策略列表

    const loadAvailableStrategies = async () => {

      loadingStrategies.value = true

      try {

        // 🔥 从 strategyStore 加载真实的策略列表

        console.log('📋 开始加载策略列表...')

        

        // 确保 strategyStore 已加载策略

        if (strategyStore.strategies.length === 0) {

          console.log('📥 策略列表为空，从后端加载...')

          await strategyStore.loadStrategies()

        }

        

        // 🔥 使用 ensureArray 确保 strategies 是数组

        const strategies = ensureArray(strategyStore.strategies, [], 'strategyStore.strategies')

        

        // 使用 strategyStore 中的策略

        availableStrategies.value = strategies.map(strategy => ({

          id: strategy.id,

          name: strategy.name,

          type: strategy.type || 'trend',

          description: strategy.description || '',

          createdAt: strategy.createdAt,

          code: strategy.code,

          parameters: strategy.parameters,

          language: strategy.language || 'javascript'

        }))

        

        console.log('✅ 策略列表加载成功:', availableStrategies.value.length, '个策略')

        console.log('📊 策略详情:', availableStrategies.value.map(s => ({ id: s.id, name: s.name, type: s.type })))

        

        // 如果没有策略，显示提示

        if (availableStrategies.value.length === 0) {

          console.warn('⚠️ 没有可用的策略，请先在策略管理页面创建策略')

          ElMessage.warning('没有可用的策略，请先在策略管理页面创建策略')

        }

      } catch (error) {

        console.error('❌ 加载策略列表失败:', error)

        ElMessage.error('加载策略列表失败: ' + error.message)

        

        // 🔥 失败时确保使用空数组

        availableStrategies.value = []

      } finally {

        loadingStrategies.value = false

      }

    }

    

    // 策略选择事件

    const onStrategySelect = (strategyId) => {

      // 🔥 使用 ensureArray 确保 availableStrategies.value 是数组

      const strategies = ensureArray(availableStrategies.value, [], 'availableStrategies')

      const strategy = strategies.find(s => s.id === strategyId)

      if (strategy) {

        console.log('📋 选择策略:', strategy.name)

        // 同步更新selectedStrategyId

        selectedStrategyId.value = strategyId

      }

    }

    

    // 获取策略类型颜色
    const getStrategyTypeColor = getStrategyTypeColorHelper

    

    // 获取策略类型标签
    const getStrategyTypeLabel = getStrategyTypeLabelHelper

    

    // 🔥 新增：获取语言颜色
    const getLanguageColor = getLanguageColorHelper

    

    // 🔥 新增：获取语言名称
    const getLanguageName = getLanguageNameHelper

    

    // 🔥 新增：前往策略管理页面

    const goToStrategyManagement = () => {

      showStrategySelectDialog.value = false

      router.push('/strategies')

    }

    

    const openBacktestDialog = () => {

      // 加载可用策略列表

      loadAvailableStrategies()

      showBacktestDialog.value = true

    }

    

    const handleCloseBacktest = () => {

      showBacktestDialog.value = false

      selectedStrategyId.value = ''

      backtestParams.strategyId = '' // 重置表单中的策略ID

    }

    

    const disabledStartDate = disabledStartDateHelper

    

    const disabledEndDate = (time) => disabledEndDateHelper(time, backtestParams.startDate)

    

    // 错误解析函数
    const parseError = parseTradingError

    

    // 防重复执行标志

    const isBacktesting = ref(false)

    

    const runBacktest = async () => {

      // 防重复执行

      if (isBacktesting.value) {

        console.warn('⚠️ 回测正在进行中，忽略重复调用')

        ElMessage.warning('当前回测任务尚未完成，请等待结果返回后再发起新的回测')

        return

      }

      

      console.log('🚀 runBacktest 函数开始执行')

      

      if (!backtestFormRef.value) {

        console.error('❌ backtestFormRef 不存在')

        ElMessage.error('表单引用错误')

        return

      }

      

      isBacktesting.value = true

      

      try {

        console.log('📋 开始表单验证')

        await backtestFormRef.value.validate()

        console.log('✅ 表单验证通过')

        

        if (!backtestParams.strategyId) {

          console.warn('⚠️ 未选择策略')

          ElMessage.warning('请先选择策略')

          return

        }

        

        console.log('📊 选中的策略ID:', backtestParams.strategyId)

        

        backtesting.value = true

        

        // 获取选中的策略 - 使用本地数据，避免API调用

        const strategy = availableStrategies.value.find(s => s.id === backtestParams.strategyId)

        if (!strategy) {

          console.error('❌ 未找到选中的策略')

          throw new Error('未找到选中的策略')

        }

        

        console.log('✅ 策略信息:', {

          id: strategy.id,

          name: strategy.name,

          type: strategy.type

        })

        

        console.log('🚀 开始回测计算:', {

          strategyName: strategy.name,

          symbol: selectedSymbol.value,

          period: selectedPeriod.value,

          startDate: backtestParams.startDate,

          endDate: backtestParams.endDate

        })

        

        // 验证日期

        if (!backtestParams.startDate || !backtestParams.endDate) {

          throw new Error('请选择有效的开始和结束日期')

        }

        

        if (backtestParams.startDate >= backtestParams.endDate) {

          throw new Error('开始日期必须早于结束日期')

        }

        

        console.log('📅 日期验证通过')

        

        // 🔥 真实执行策略回测

        console.log('⏳ 开始真实策略回测...')

        

        // 1. 生成回测期间的K线数据

        const klineData = generateMockKlineData()

        console.log('📊 生成K线数据:', klineData.length, '条')

        console.log('📊 K线数据时间范围:', {

          开始: new Date(klineData[0].time * 1000).toLocaleString(),

          结束: new Date(klineData[klineData.length - 1].time * 1000).toLocaleString(),

          前3条数据: klineData.slice(0, 3).map(k => ({

            time: new Date(k.time * 1000).toLocaleString(),

            open: k.open,

            high: k.high,

            low: k.low,

            close: k.close

          }))

        })

        

        // 2. 执行策略代码

        let strategyResult

        try {

          if (strategy.code) {

            console.log('🚀 执行策略代码...')

            console.log('📋 策略信息:', {

              name: strategy.name,

              type: strategy.type,

              language: strategy.language,

              parameters: strategy.parameters,

              codeLength: strategy.code?.length || 0

            })

            

            const result = await executeRealStrategyCode(strategy, klineData)

            strategyResult = result

            

            console.log('✅ 策略执行完成')

            console.log('📊 策略返回结果:', {

              类型: typeof result,

              是否有signals: !!result?.signals,

              signals长度: result?.signals?.length || 0,

              是否有auxiliaryData: !!result?.auxiliaryData,

              完整结果: result

            })

          } else {

            throw new Error('策略代码不存在')

          }

        } catch (strategyError) {

          console.error('❌ 策略执行失败:', strategyError)

          console.error('❌ 错误堆栈:', strategyError.stack)

          throw new Error('策略执行失败: ' + strategyError.message)

        }

        

        // 3. 提取信号

        const strategySignals = strategyResult?.signals || []

        console.log('📊 策略信号数量:', strategySignals.length)

        

        if (strategySignals.length === 0) {

          console.warn('⚠️ 策略没有生成任何信号！')

          console.warn('⚠️ 可能原因:')

          console.warn('   1. 数据量不足（当前:', klineData.length, '条）')

          console.warn('   2. 策略参数不适合当前数据')

          console.warn('   3. 策略代码逻辑问题')

          console.warn('⚠️ 建议: 检查策略代码中的数据量要求和参数设置')

          

          // 🔥 不再抛出错误，而是继续执行，显示0交易的回测结果

          console.log('⚠️ 继续执行回测，将生成0交易的回测结果')

        } else {

          console.log('📊 前3个信号:', strategySignals.slice(0, 3).map(s => ({

            type: s.type,

            index: s.index,

            time: s.time,

            timeDate: new Date(s.time * 1000).toLocaleString(),

            price: s.price

          })))

        }

        

        // 4. 执行回测计算

        console.log('💰 开始回测计算...')

        let capital = backtestParams.initialCapital

        let position = 0

        const trades = []

        let buyPrice = 0

        let buyIndex = -1

        

        console.log('💰 初始资金:', capital)

        console.log('📊 策略信号总数:', strategySignals.length)

        

        if (strategySignals.length === 0) {

          console.warn('⚠️ 没有交易信号，回测结果将显示0交易')

        } else {

          // 遍历所有信号进行回测

          for (let i = 0; i < strategySignals.length; i++) {

            const signal = strategySignals[i]

            const dataPoint = klineData[signal.index]

            

            if (!dataPoint) {

              console.warn(`⚠️ 信号 #${i+1} 的K线数据不存在，索引:`, signal.index)

              continue

            }

            

            const isBuySignal = signal.type === 'buy' || signal.type === 'open_long'

            const isSellSignal = signal.type === 'sell' || signal.type === 'close_long' || signal.type === 'close_short'

            

            if (isBuySignal && capital > 0 && position === 0) {

              // 买入

              const quantity = Math.floor(capital / signal.price)

              if (quantity > 0) {

                position = quantity

                capital -= quantity * signal.price

                buyPrice = signal.price

                buyIndex = signal.index

                

                const tradeRecord = {

                  id: trades.length + 1,

                  date: new Date(signal.time * 1000).toISOString().split('T')[0],

                  type: 'buy',

                  price: signal.price,

                  quantity: quantity,

                  reason: signal.reason || '买入信号'

                }

                

                trades.push(tradeRecord)

                

                console.log(`✅ 买入交易 #${trades.length}:`, {

                  日期: tradeRecord.date,

                  价格: tradeRecord.price,

                  数量: tradeRecord.quantity,

                  剩余资金: capital.toFixed(2)

                })

              } else {

                console.warn('⚠️ 资金不足，无法买入')

              }

            } else if (isSellSignal && position > 0) {

              // 卖出

              const quantity = position

              const sellAmount = quantity * signal.price

              capital += sellAmount

              const profit = (signal.price - buyPrice) * quantity

              const returnRate = (signal.price - buyPrice) / buyPrice

              

              const tradeRecord = {

                id: trades.length + 1,

                date: new Date(signal.time * 1000).toISOString().split('T')[0],

                type: 'sell',

                price: signal.price,

                quantity: quantity,

                return: returnRate,

                profit: profit,

                reason: signal.reason || '卖出信号'

              }

              

              trades.push(tradeRecord)

              

              console.log(`✅ 卖出交易 #${trades.length}:`, {

                日期: tradeRecord.date,

                价格: tradeRecord.price,

                数量: tradeRecord.quantity,

                盈亏: profit.toFixed(2),

                收益率: (returnRate * 100).toFixed(2) + '%',

                当前资金: capital.toFixed(2)

              })

              

              position = 0

            } else {

              // 跳过的信号

              if (isBuySignal && position > 0) {

                console.log(`⏭️ 跳过买入信号 #${i+1}: 已有持仓`)

              } else if (isSellSignal && position === 0) {

                console.log(`⏭️ 跳过卖出信号 #${i+1}: 无持仓`)

              }

            }

          }

        }

        

        console.log('💰 回测计算完成，生成交易记录:', trades.length, '条')

        if (trades.length > 0) {

          console.log('📊 交易记录详情:', trades)

        } else {

          console.warn('⚠️ 没有生成任何交易记录')

        }

        

        // 5. 计算回测指标

        console.log('📊 开始计算回测指标...')

        

        // 计算期末资金（包括持仓市值）

        const finalCapital = capital + position * klineData[klineData.length - 1].close

        

        // 🔥 基于实际交易计算总收益率

        let totalProfit = 0

        const sellTrades = trades.filter(t => t.type === 'sell')

        

        // 累计所有卖出交易的盈亏

        for (const trade of sellTrades) {

          if (trade.profit) {

            totalProfit += trade.profit

          }

        }

        

        // 如果还有持仓，计算浮动盈亏

        if (position > 0 && buyPrice > 0) {

          const currentPrice = klineData[klineData.length - 1].close

          const floatingProfit = (currentPrice - buyPrice) * position

          totalProfit += floatingProfit

          console.log('💰 当前持仓浮动盈亏:', floatingProfit.toFixed(2))

        }

        

        // 总收益率 = 总盈亏 / 初始资金

        const totalReturn = totalProfit / backtestParams.initialCapital

        

        console.log('💰 收益计算:', {

          初始资金: backtestParams.initialCapital,

          期末资金: finalCapital.toFixed(2),

          总盈亏: totalProfit.toFixed(2),

          总收益率: (totalReturn * 100).toFixed(2) + '%'

        })

        

        // 🔥 基于实际交易天数计算年化收益率

        let actualTradingDays = 0

        if (sellTrades.length > 0) {

          // 计算第一笔买入到最后一笔卖出的天数

          const buyTrades = trades.filter(t => t.type === 'buy')

          if (buyTrades.length > 0) {

            const firstBuyDate = new Date(buyTrades[0].date)

            const lastSellDate = new Date(sellTrades[sellTrades.length - 1].date)

            actualTradingDays = Math.max(1, (lastSellDate - firstBuyDate) / (1000 * 60 * 60 * 24))

          }

        }

        

        // 如果没有交易，使用回测周期

        if (actualTradingDays === 0) {

          actualTradingDays = (backtestParams.endDate - backtestParams.startDate) / (1000 * 60 * 60 * 24)

        }

        

        // 年化收益率 = 总收益率 * (365 / 实际交易天数)

        const annualizedReturn = totalReturn * (365 / actualTradingDays)

        

        console.log('📅 交易周期:', {

          回测天数: ((backtestParams.endDate - backtestParams.startDate) / (1000 * 60 * 60 * 24)).toFixed(0),

          实际交易天数: actualTradingDays.toFixed(0),

          年化收益率: (annualizedReturn * 100).toFixed(2) + '%'

        })

        

        // 计算胜率

        const winTrades = sellTrades.filter(t => t.profit > 0).length

        const lossTrades = sellTrades.filter(t => t.profit <= 0).length

        const winRate = sellTrades.length > 0 ? winTrades / sellTrades.length : 0

        

        console.log('🎯 交易统计:', {

          总交易次数: trades.length,

          买入次数: trades.filter(t => t.type === 'buy').length,

          卖出次数: sellTrades.length,

          盈利次数: winTrades,

          亏损次数: lossTrades,

          胜率: (winRate * 100).toFixed(2) + '%'

        })

        

        // 🔥 改进最大回撤计算 - 基于权益曲线

        let maxDrawdown = 0

        let peak = backtestParams.initialCapital

        let currentEquity = backtestParams.initialCapital

        const equityCurve = [{ date: backtestParams.startDate, equity: currentEquity }]

        

        // 构建权益曲线

        for (const trade of trades) {

          if (trade.type === 'sell' && trade.profit) {

            currentEquity += trade.profit

            equityCurve.push({

              date: new Date(trade.date),

              equity: currentEquity

            })

            

            // 更新峰值和回撤

            if (currentEquity > peak) {

              peak = currentEquity

            }

            const drawdown = (peak - currentEquity) / peak

            if (drawdown > maxDrawdown) {

              maxDrawdown = drawdown

            }

          }

        }

        

        console.log('📉 回撤分析:', {

          最高权益: peak.toFixed(2),

          当前权益: currentEquity.toFixed(2),

          最大回撤: (maxDrawdown * 100).toFixed(2) + '%'

        })

        

        // 计算夏普比率

        const returns = sellTrades.map(t => t.return || 0)

        const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0

        const variance = returns.length > 0 ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length : 0

        const stdDev = Math.sqrt(variance) || 0.0001 // 避免除以0

        const sharpeRatio = returns.length > 0 ? (avgReturn / stdDev * Math.sqrt(252)) : 0 // 年化

        

        // 计算盈亏比

        const avgWin = winTrades > 0 ? sellTrades.filter(t => t.profit > 0).reduce((sum, t) => sum + t.profit, 0) / winTrades : 0

        const avgLoss = lossTrades > 0 ? Math.abs(sellTrades.filter(t => t.profit <= 0).reduce((sum, t) => sum + t.profit, 0) / lossTrades) : 0

        const profitLossRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 999 : 0)

        

        // 计算平均持仓天数

        let totalHoldingDays = 0

        const buyTradesMap = {}

        

        for (const trade of trades) {

          if (trade.type === 'buy') {

            buyTradesMap[trade.id] = new Date(trade.date)

          } else if (trade.type === 'sell') {

            // 找到对应的买入交易

            const buyTrade = trades.find(t => t.type === 'buy' && t.id < trade.id && !t.matched)

            if (buyTrade) {

              buyTrade.matched = true

              const holdingDays = (new Date(trade.date) - new Date(buyTrade.date)) / (1000 * 60 * 60 * 24)

              totalHoldingDays += holdingDays

            }

          }

        }

        

        const avgHoldingDays = sellTrades.length > 0 ? totalHoldingDays / sellTrades.length : 0

        

        console.log('✅ 回测指标计算完成:', {

          总收益率: (totalReturn * 100).toFixed(2) + '%',

          年化收益率: (annualizedReturn * 100).toFixed(2) + '%',

          交易次数: trades.length,

          胜率: (winRate * 100).toFixed(2) + '%',

          盈亏比: profitLossRatio.toFixed(2),

          最大回撤: (maxDrawdown * 100).toFixed(2) + '%',

          夏普比率: sharpeRatio.toFixed(2),

          平均持仓天数: avgHoldingDays.toFixed(1)

        })

        

        // 🔥 改进月度收益计算 - 基于实际交易盈亏

        const monthlyReturns = []

        const monthlyProfits = {}

        

        // 按月份统计交易盈亏

        for (const trade of sellTrades) {

          const tradeDate = new Date(trade.date)

          const monthKey = `${tradeDate.getFullYear()}-${String(tradeDate.getMonth() + 1).padStart(2, '0')}`

          

          if (!monthlyProfits[monthKey]) {

            monthlyProfits[monthKey] = {

              profit: 0,

              trades: 0

            }

          }

          

          monthlyProfits[monthKey].profit += trade.profit || 0

          monthlyProfits[monthKey].trades += 1

        }

        

        // 生成月度收益数组

        const startMonth = new Date(backtestParams.startDate)

        const endMonth = new Date(backtestParams.endDate)

        let currentMonth = new Date(startMonth.getFullYear(), startMonth.getMonth(), 1)

        

        while (currentMonth <= endMonth && monthlyReturns.length < 12) {

          const monthKey = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}`

          const monthData = monthlyProfits[monthKey] || { profit: 0, trades: 0 }

          

          // 月度收益率 = 月度盈亏 / 初始资金

          const monthReturn = monthData.profit / backtestParams.initialCapital

          

          monthlyReturns.push({

            month: monthKey,

            return: monthReturn,

            profit: monthData.profit,

            trades: monthData.trades

          })

          

          // 移动到下一个月

          currentMonth.setMonth(currentMonth.getMonth() + 1)

        }

        

        console.log('📊 月度收益:', monthlyReturns.map(m => ({

          月份: m.month,

          收益率: (m.return * 100).toFixed(2) + '%',

          盈亏: m.profit.toFixed(2),

          交易次数: m.trades

        })))

        

        console.log('✅ 回测计算完成')

        

        // 创建回测结果对象

        console.log('🏗️ 创建回测结果对象...')

        const backtestResult = {

          id: Date.now(),

          strategyName: strategy.name,

          strategyType: strategy.type,

          symbol: selectedSymbol.value,

          period: selectedPeriod.value,

          startDate: backtestParams.startDate.toISOString().split('T')[0],

          endDate: backtestParams.endDate.toISOString().split('T')[0],

          

          // 🔥 资金指标 - 基于实际交易计算

          initialCapital: backtestParams.initialCapital,

          finalCapital: finalCapital,

          totalProfit: totalProfit,  // 总盈亏

          totalReturn: totalReturn,  // 总收益率

          annualizedReturn: annualizedReturn,  // 年化收益率

          

          // 🔥 风险指标

          maxDrawdown: maxDrawdown,  // 最大回撤

          sharpeRatio: sharpeRatio,  // 夏普比率

          

          // 🔥 交易指标

          winRate: winRate,  // 胜率

          totalTrades: trades.length,  // 总交易次数

          winTrades: winTrades,  // 盈利次数

          lossTrades: lossTrades,  // 亏损次数

          profitLossRatio: profitLossRatio,  // 盈亏比

          avgHoldingDays: avgHoldingDays,  // 平均持仓天数

          actualTradingDays: actualTradingDays,  // 实际交易天数

          

          // 🔥 详细数据

          benchmarkReturn: 0,  // 基准收益率（暂未实现）

          trades: trades.slice(0, 50),  // 只保存前50条交易记录

          monthlyReturns: monthlyReturns,  // 月度收益

          equityCurve: equityCurve,  // 权益曲线

          signals: strategySignals,  // 策略信号

          klineData: klineData,  // K线数据

          

          // 回测参数

          backtestParams: {

            initialCapital: backtestParams.initialCapital,

            slippage: backtestParams.slippage || 0.0001,

            fees: {

              buyFeeRate: backtestParams.commission || 0.0003,

              sellFeeRate: backtestParams.commission || 0.0003,

              stampTaxRate: 0.001

            }

          },

          

          originalStrategy: strategy,

          createdAt: new Date().toISOString()

        }

        

        console.log('✅ 回测结果对象创建完成:', {

          id: backtestResult.id,

          strategyName: backtestResult.strategyName,

          初始资金: backtestResult.initialCapital,

          期末资金: backtestResult.finalCapital.toFixed(2),

          总盈亏: backtestResult.totalProfit.toFixed(2),

          总收益率: (backtestResult.totalReturn * 100).toFixed(2) + '%',

          年化收益率: (backtestResult.annualizedReturn * 100).toFixed(2) + '%',

          交易次数: backtestResult.totalTrades,

          胜率: (backtestResult.winRate * 100).toFixed(2) + '%'

        })

        

        // 保存到本地存储

        console.log('💾 保存到本地存储...')

        try {

          const existingResults = JSON.parse(localStorage.getItem('backtestResults') || '[]')

          existingResults.unshift(backtestResult)

          localStorage.setItem('backtestResults', JSON.stringify(existingResults))

          console.log('✅ 本地存储保存成功，当前总数:', existingResults.length)

        } catch (storageError) {

          console.error('❌ 本地存储失败:', storageError)

        }



        // Save to backend database for BacktestAnalysis page

        try {

          await request.post('/backtest/save', {

            strategyId: strategy.id,

            strategyName: strategy.name,

            symbol: selectedSymbol.value,

            startDate: backtestResult.startDate,

            endDate: backtestResult.endDate,

            initialCapital: backtestResult.initialCapital,

            finalCapital: backtestResult.finalCapital,

            totalReturn: parseFloat((backtestResult.totalReturn * 100).toFixed(2)),

            annualizedReturn: parseFloat((backtestResult.annualizedReturn * 100).toFixed(2)),

            maxDrawdown: parseFloat((backtestResult.maxDrawdown * 100).toFixed(2)),

            totalTrades: backtestResult.totalTrades,

            winningTrades: backtestResult.winTrades,

            losingTrades: backtestResult.lossTrades,

            winRate: parseFloat((backtestResult.winRate * 100).toFixed(2)),

            trades: backtestResult.trades,

            signals: backtestResult.signals,

            parameters: strategy.parameters

          })

          console.log('✅ 回测结果已保存到数据库')

        } catch (dbError) {

          console.error('❌ 保存到数据库失败:', dbError)

        }

        

        // 关闭对话框

        showBacktestDialog.value = false

        console.log('✅ 回测对话框已关闭')

        

        // 显示完成提示

        console.log('🎉 准备显示完成提示对话框')

        

        try {

          // 🔥 修复：使用正确的变量名

          const totalTradesCount = trades.length

          const totalReturnPercent = (totalReturn * 100).toFixed(2)

          

          let confirmMessage

          if (totalTradesCount === 0) {

            // 没有交易的情况

            confirmMessage = `回测已完成！



策略"${strategy.name}"在${selectedSymbol.value}上的回测结果已生成。



⚠️ 注意：策略在回测期间没有生成任何交易信号。



可能原因：

• 数据量不足（当前：${klineData.length}条K线）

• 策略参数不适合当前市场环境

• 策略条件过于严格



建议：

• 调整策略参数

• 选择更长的回测周期

• 检查策略代码逻辑



是否查看详细的回测结果？`

          } else {

            // 有交易的情况

            confirmMessage = `回测已完成！



策略"${strategy.name}"在${selectedSymbol.value}上的回测结果已生成。



总收益率: ${totalReturnPercent}%

交易次数: ${totalTradesCount}次

胜率: ${(winRate * 100).toFixed(2)}%



是否立即查看回测结果？`

          }

          

          console.log('📊 回测结果摘要:', {

            策略名称: strategy.name,

            总收益率: totalReturnPercent + '%',

            交易次数: totalTradesCount,

            胜率: (winRate * 100).toFixed(2) + '%',

            K线数据量: klineData.length

          })

          

          await ElMessageBox.confirm(

            confirmMessage,

            totalTradesCount === 0 ? '回测完成（无交易）' : '回测完成',

            {

              confirmButtonText: '查看结果',

              cancelButtonText: '稍后查看',

              type: totalTradesCount === 0 ? 'warning' : 'success',

              confirmButtonClass: 'el-button--primary',

              cancelButtonClass: 'el-button--info',

              dangerouslyUseHTMLString: false

            }

          )

          

          console.log('✅ 用户选择查看结果，准备跳转')

          

          // 跳转到回测分析页面，自动显示最新结果

          await router.push({

            path: '/backtest',

            query: { 

              autoShow: 'latest',

              new: 'true',

              timestamp: Date.now() // 确保URL变化触发页面更新

            }

          })

          

          console.log('✅ 页面跳转成功，将自动显示最新回测结果')

          

        } catch (dialogError) {

          if (dialogError === 'cancel') {

            console.log('📝 用户选择稍后查看')

            ElMessage({

              message: `回测结果已保存！策略"${strategy.name}"的回测已完成，您可以在"回测分析"页面查看详细结果`,

              type: 'info',

              duration: 5000

            })

          } else {

            console.error('❌ 对话框错误:', dialogError)

            console.error('错误详情:', dialogError)

            ElMessage.error('显示结果对话框时出错: ' + (dialogError.message || '未知错误'))

          }

        }

        

      } catch (error) {

        console.error('❌ 回测执行过程中发生错误:', error)

        console.error('错误类型:', typeof error)

        console.error('错误构造函数:', error?.constructor?.name)

        

        const errorMessage = '回测失败: ' + parseError(error)

        console.error('解析后的错误信息:', errorMessage)

        

        ElMessage.error(errorMessage)

      } finally {

        backtesting.value = false

        isBacktesting.value = false

        console.log('🏁 回测流程结束，loading状态已重置')

      }

    }

    

    // 🔥 处理订单提交事件（已废弃 - 现在使用 ModernTradingPanel + LiveTradingCenter）

    // const handleOrderSubmitted = (tradeData) => {

    //   console.log('✅ 订单已提交:', tradeData)

    //   // 刷新持仓和交易记录

    //   if (enhancedPositionsPanelRef.value) {

    //     enhancedPositionsPanelRef.value.loadPositions()

    //     enhancedPositionsPanelRef.value.loadAccountInfo()

    //   }

    //   if (recentTradesPanelRef.value) {

    //     recentTradesPanelRef.value.loadTrades()

    //   }

    // }



    // 🔥 处理交易模式变化事件（已废弃）

    // const handleTradeModeChanged = (mode) => {

    //   console.log('🔄 交易模式已切换:', mode)

    // }

    

    // 🔥 处理平仓事件（已废弃）

    // const handlePositionClosed = (position) => {

    //   console.log('持仓已平仓:', position)

    //   // 刷新交易记录

    //   if (recentTradesPanelRef.value) {

    //     recentTradesPanelRef.value.loadTrades()

    //   }

    // }

    

    const formatTime = formatTimeHelper

    

    const formatDateTime = formatDateTimeHelper

    

    // 数据源事件处理

    const handleSourceChange = async (sourceKey) => {

      try {

        console.log('🔄 切换数据源:', sourceKey)

        await switchDataSource(sourceKey)

        ElMessage.success(`已切换到数据源: ${dataSourceState.currentSource.value?.name || '未知'}`)

        

        // 重新加载图表数据

        loadChartData()

      } catch (error) {

        console.error('❌ 切换数据源失败:', error)

        ElMessage.error(`切换数据源失败: ${error.message}`)

      }

    }

    

    const handleManageDataSource = () => {

      console.log('🔧 打开数据源管理')

      // 跳转到顶部导航栏的数据源页面

      router.push('/data-sources')

    }

    

    // 🔥 持仓面板事件处理

    const handleSelectPosition = (position) => {

      console.log('📊 选中持仓:', position)

      // 可以在这里联动下单面板，自动填充标的和数量

      selectedSymbol.value = position.symbol

      ElMessage.success(`已选中持仓: ${position.symbol} ${position.name}`)

    }

    

    const handleClosePosition = async (position) => {

      console.log('💰 平仓操作:', position)

      

      try {

        // 这里应该调用后端API进行平仓

        // const response = await tradeAPI.closePosition(position.id)

        

        // 模拟平仓成功

        ElMessage.success(`${position.symbol} ${position.name} 平仓成功`)

        

        // 从持仓列表中移除

        const index = mockPositions.value.findIndex(p => p.id === position.id)

        if (index !== -1) {

          mockPositions.value.splice(index, 1)

        }

      } catch (error) {

        console.error('平仓失败:', error)

        ElMessage.error('平仓失败: ' + error.message)

      }

    }

    

    // 监听数据源事件

    onMounted(() => {

      // 🔥 加载真实持仓

      loadPositions()

      

      // 监听数据源变更事件

      onDataSourceEvent('source-changed', (data) => {

        console.log('📡 数据源已变更:', data)

        ElMessage.info(`数据源已切换: ${data.name}`)

        

        // 重新加载图表数据

        loadChartData()

      })

      

      // 🔥 移除 data-updated 监听器，避免无限递归

      // updateSourceInfo 会触发 data-updated 事件

      // 如果在这里监听并再次调用 updateSourceInfo，会导致无限循环

      

      // 监听状态刷新事件

      onDataSourceEvent('status-refreshed', (data) => {

        console.log('🔄 数据源状态已刷新:', data)

      })

    })

    

    onUnmounted(() => {

      // 清理事件监听器

      offDataSourceEvent('source-changed')

      // data-updated 监听器已移除，无需清理

      offDataSourceEvent('status-refreshed')

    })

    

    // 生命周期

    // 防抖处理窗口resize

    const handleResize = debounce(() => {

      if (chart.value && chartContainer.value) {

        const width = chartContainer.value.clientWidth

        const height = getChartHeight()



        chart.value.applyOptions({ width, height })

      }

    }, 200)

    

    // ResizeObserver for dynamic chart container sizing

    let resizeObserver = null



    onMounted(() => {

      nextTick(() => {

        initChart()



        // 移动端启用触摸手势

        if (isMobile.value && chartContainer.value && chart.value) {

          touchGestures.init(

            chartContainer.value,

            chart.value,

            candlestickSeries.value

          )

        }



        // Observe container size changes so chart fills available space

        if (chartContainer.value && typeof ResizeObserver !== 'undefined') {

          resizeObserver = new ResizeObserver(debounce((entries) => {

            if (!chart.value || !chartContainer.value) return

            const entry = entries[0]

            if (!entry) return

            const { width, height } = entry.contentRect

            if (width > 100 && height > 100) {

              chart.value.applyOptions({ width: Math.floor(width), height: Math.floor(height) })

            }

          }, 150))

          resizeObserver.observe(chartContainer.value)

        }

      })



      // 添加resize监听

      window.addEventListener('resize', handleResize)

    })

    

    onUnmounted(() => {

      // 清理图表

      if (chart.value) {

        try {

          // 先取消订阅所有 crosshair 事件

          if (chart.value._crosshairHandlers) {

            chart.value._crosshairHandlers.forEach(handler => {

              try {

                chart.value.unsubscribeCrosshairMove(handler)

              } catch (e) {

                console.log('取消订阅 crosshair 事件时出错:', e)

              }

            })

            chart.value._crosshairHandlers = []

          }

          

          // 然后移除所有系列

          if (candlestickSeries.value) {

            safeRemoveSeries(candlestickSeries.value)

            candlestickSeries.value = null

          }

          if (ma5Series.value) {

            safeRemoveSeries(ma5Series.value)

            ma5Series.value = null

          }

          if (ma10Series.value) {

            safeRemoveSeries(ma10Series.value)

            ma10Series.value = null

          }

          if (ma20Series.value) {

            safeRemoveSeries(ma20Series.value)

            ma20Series.value = null

          }

          if (bollUpperSeries.value) {

            safeRemoveSeries(bollUpperSeries.value)

            bollUpperSeries.value = null

          }

          if (bollMiddleSeries.value) {

            safeRemoveSeries(bollMiddleSeries.value)

            bollMiddleSeries.value = null

          }

          if (bollLowerSeries.value) {

            safeRemoveSeries(bollLowerSeries.value)

            bollLowerSeries.value = null

          }



          // 最后移除图表

          chart.value.remove()

          chart.value = null

        } catch (error) {

          console.log('清理图表时出错:', error)

        }

      }

      

      // 清理触摸手势

      if (touchGestures && touchGestures.destroy) {

        touchGestures.destroy()

      }

      

      // 清理resize监听

      window.removeEventListener('resize', handleResize)



      // 清理ResizeObserver

      if (resizeObserver) {

        resizeObserver.disconnect()

        resizeObserver = null

      }

    })

    

    // 监听合约代码变化

    watch(() => props.contract, (newContract) => {

      if (newContract && newContract !== selectedSymbol.value) {

        console.log('📊 合约代码已变化:', newContract)

        selectedSymbol.value = newContract

        // 统一使用日线，不自动切换周期
        const upper = (newContract || '').toUpperCase()
        const nowFutures = /^[A-Z]{1,3}[\d_]/i.test(upper) || /^[A-Z]{1,3}[-_]?MAIN$/i.test(upper)

        // 保持日线不变（非日线周期暂时隐藏）
        if (!nowFutures && ['1m','5m','15m','30m','1h'].includes(selectedPeriod.value)) {
          selectedPeriod.value = '1d'
        }

        loadChartData()

      }

    })

    

    // 监听父组件传递的策略变化

    watch(() => props.loadedStrategy, (newStrategy) => {

      if (newStrategy) {

        console.log('👀 检测到父组件策略变化:', newStrategy)

        loadedStrategy.value = newStrategy

        

        // 生成新策略的信号

        generateStrategySignals()

        

        // 自动显示信号到图表上

        setTimeout(() => {

          displaySignalsOnChart()

          showSignals.value = true // 确保显示状态为true

        }, 100)

        

        ElMessage.success(`策略"${newStrategy.name}"已应用，生成了新的交易信号`)

      } else {

        // 策略被卸载的情况

        console.log('👀 检测到策略被卸载')

        loadedStrategy.value = null

        

        // 清空信号数据

        signals.value = []

        

        // 清除图表上的信号标记

        clearSignalsFromChart()

        

        // 设置信号显示状态为false

        showSignals.value = false

        

        console.log('✅ 策略已卸载，信号已清除')

      }

    }, { immediate: true })

    

    // 🔥 新增：监听父组件传递的signals变化

    watch(() => props.signals, (newSignals) => {

      console.log('👀 检测到父组件signals变化:', newSignals?.length || 0, '个信号')

      

      if (newSignals && Array.isArray(newSignals) && newSignals.length > 0) {

        // 更新本地signals

        signals.value = [...newSignals]

        

        console.log('✅ signals已更新，准备显示到图表')

        console.log('📊 信号详情:', signals.value.map(s => ({

          type: s.type,

          time: s.time,

          price: s.price,

          timestamp: s.timestamp

        })))

        

        // 等待图表准备好后显示信号

        nextTick(() => {

          if (candlestickSeries.value) {

            displaySignalsOnChart()

            showSignals.value = true

            console.log('✅ 信号已自动显示到图表')

          } else {

            console.warn('⚠️ K线系列尚未初始化，延迟显示信号')

            setTimeout(() => {

              if (candlestickSeries.value) {

                displaySignalsOnChart()

                showSignals.value = true

              }

            }, 500)

          }

        })

      } else if (!newSignals || newSignals.length === 0) {

        console.log('👀 signals被清空')

        signals.value = []

        clearSignalsFromChart()

        showSignals.value = false

      }

    }, { immediate: true, deep: true })

    

    // 🔥 新增：监听父组件传递的auxiliaryData变化

    watch(() => props.auxiliaryData, (newAuxiliaryData) => {

      console.log('👀 检测到父组件auxiliaryData变化:', Object.keys(newAuxiliaryData || {}).length, '条辅助线')

      

      if (newAuxiliaryData && Object.keys(newAuxiliaryData).length > 0) {

        // 更新本地auxiliaryData

        auxiliaryData.value = { ...newAuxiliaryData }

        

        console.log('✅ auxiliaryData已更新，准备显示到图表')

        console.log('📊 辅助线详情:', Object.keys(auxiliaryData.value))

        

        // 等待图表准备好后显示辅助线

        nextTick(() => {

          if (chart.value && candlestickSeries.value) {

            displayAuxiliaryLines()

            showAuxiliaryLines.value = true

            console.log('✅ 辅助线已自动显示到图表')

          } else {

            console.warn('⚠️ 图表尚未初始化，延迟显示辅助线')

            setTimeout(() => {

              if (chart.value && candlestickSeries.value) {

                displayAuxiliaryLines()

                showAuxiliaryLines.value = true

              }

            }, 500)

          }

        })

      } else {

        console.log('👀 auxiliaryData被清空')

        auxiliaryData.value = {}

        clearAuxiliaryLines()

        showAuxiliaryLines.value = false

      }

    }, { immediate: true, deep: true })

    

    // 🔥 新增：监听合约变化，重新加载K线数据

    watch(() => props.contract, (newContract, oldContract) => {

      console.log('=' .repeat(80))

      console.log('👀👀👀 watch检测到合约变化！')

      console.log('👀 旧合约:', oldContract)

      console.log('👀 新合约:', newContract)

      console.log('👀 当前时间:', new Date().toLocaleString())

      console.log('=' .repeat(80))

      

      if (newContract && newContract !== oldContract) {

        console.log('✅ 合约确实发生了变化，开始更新...')

        selectedSymbol.value = newContract

        console.log('✅ selectedSymbol.value 已更新为:', selectedSymbol.value)

        

        // 重新加载K线数据

        if (chart.value && candlestickSeries.value) {

          console.log('✅ 图表和K线系列存在，调用 loadChartData()')

          loadChartData()

          console.log('✅ loadChartData() 调用完成')

        } else {

          console.warn('⚠️ 图表或K线系列不存在')

          console.warn('   - chart.value:', !!chart.value)

          console.warn('   - candlestickSeries.value:', !!candlestickSeries.value)

        }

      } else {

        console.log('⚠️ 合约未变化或为空，跳过更新')

      }

    })

    

    // 🔥 新增：监听辅助线数据变化

    watch(() => props.auxiliaryData, (newAuxiliaryData) => {

      console.log('👀 检测到辅助线数据变化:', newAuxiliaryData)

      

      if (newAuxiliaryData && Object.keys(newAuxiliaryData).length > 0) {

        auxiliaryData.value = newAuxiliaryData

        

        console.log('🎨 准备显示辅助线，数量:', Object.keys(newAuxiliaryData).length)

        console.log('🎨 辅助线详情:', Object.keys(newAuxiliaryData).map(key => ({

          name: key,

          dataPoints: newAuxiliaryData[key]?.data?.length || 0

        })))

        

        // 🔥 修改：自动显示辅助线，但不调整视图范围

        nextTick(() => {

          if (chart.value) {

            displayAuxiliaryLines()

            showAuxiliaryLines.value = true

            ElMessage.success(`已显示 ${Object.keys(newAuxiliaryData).length} 条辅助线`)

          } else {

            console.warn('⚠️ 图表尚未初始化，延迟显示辅助线')

            setTimeout(() => {

              if (chart.value) {

                displayAuxiliaryLines()

                showAuxiliaryLines.value = true

              }

            }, 500)

          }

        })

      } else {

        // 清除辅助线

        console.log('🧹 辅助线数据为空，清除现有辅助线')

        auxiliaryData.value = {}

        clearAuxiliaryLines()

        showAuxiliaryLines.value = false

      }

    }, { immediate: true, deep: true })



    // ===== Replay Data Watcher =====

    // When replayData prop is set, inject it directly into the chart

    // bypassing the normal API data loading pipeline

    watch(() => props.replayData, (newData) => {

      if (!newData || newData.length === 0) return

      if (!candlestickSeries.value) return



      try {

        // Normalize replay candles (they come with time as unix seconds or date string)

        const normalized = normalizeKlineForTV(newData)

        candlestickSeries.value.setData(normalized)

        klineDataCache.value = normalized



        // Update MA lines

        ma5Data.value = calculateMA(normalized, 5)

        ma10Data.value = calculateMA(normalized, 10)

        ma20Data.value = calculateMA(normalized, 20)

        if (ma5Series.value) ma5Series.value.setData(ma5Data.value)

        if (ma10Series.value) ma10Series.value.setData(ma10Data.value)

        if (ma20Series.value) ma20Series.value.setData(ma20Data.value)



        // Update Bollinger Bands from replay data

        if (showBoll.value) {

          const boll = calculateBollingerBands(normalized, 20, 2)

          if (bollUpperSeries.value) bollUpperSeries.value.setData(boll.upper)

          if (bollMiddleSeries.value) bollMiddleSeries.value.setData(boll.middle)

          if (bollLowerSeries.value) bollLowerSeries.value.setData(boll.lower)

        }



        // Render replay signal markers

        if (props.replaySignals && props.replaySignals.length > 0) {

          const markers = props.replaySignals

            .map(s => {

              let t = s.time

              if (typeof t === 'string') {

                t = Math.floor(new Date(t).getTime() / 1000)

              }

              return {

                time: t,

                position: s.type === 'buy' ? 'belowBar' : 'aboveBar',

                color: s.type === 'buy' ? '#26a69a' : '#ef5350',

                shape: s.type === 'buy' ? 'arrowUp' : 'arrowDown',

                text: s.type === 'buy' ? 'B' : 'S',

                size: 1.5

              }

            })

            .sort((a, b) => a.time - b.time)

          candlestickSeries.value.setMarkers(markers)

        } else {

          candlestickSeries.value.setMarkers([])

        }



        // Auto-scroll to latest candle

        if (chart.value) {

          chart.value.timeScale().scrollToRealTime()

        }



        // Update price from last candle

        const last = normalized[normalized.length - 1]

        if (last) {

          currentPrice.value = last.close

        }

      } catch (err) {

        console.error('Replay data update failed:', err)

      }

    }, { deep: true })



    return {

      // refs

      chartContainer,

      backtestFormRef,

      // enhancedPositionsPanelRef, // 已废弃

      // recentTradesPanelRef, // 已废弃

      

      // 基础数据

      selectedSymbol,

      selectedPeriod,

      currentPrice,

      currentContract,

      priceChangeClass,

      isFuturesSymbol,

      availablePeriods,

      priceChangeText,

      pricePercentText,

      availableFunds: computed(() => props.availableFunds), // 从 props 导出

      

      // 悬停信息数据

      crosshairData,

      

      // 数据源状态

      dataSourceState,

      dataSourceLoading,

      dataSourceError,

      

      // 策略相关

      loadingStrategy,

      loadedStrategy,

      signals,

      safeSignals, // 🔥 新增：安全的 signals 计算属性

      auxiliaryData, // 🔥 新增

      showSignals,

      showAuxiliaryLines, // 🔥 新增

      showStrategyIndicator,

      showMA, // 🔥 新增：均线显示状态

      showBoll, // 🔥 新增：布林带显示状态

      showStrategySelectDialog, // 🔥 新增

      showQuickStrategyDialog, // 🔥 新增

      selectedQuickStrategyId, // 🔥 新增

      strategySearchKeyword, // 🔥 新增

      filteredStrategies, // 🔥 新增

      executingStrategy, // 🔥 新增

      availableStrategies,

      loadingStrategies,

      selectedStrategyId,

      selectedStrategy,

      

      // 刷新数据

      refreshing,

      refreshData,

      

      // 交易表单

      orderForm,

      submittingOrder,

      recentSignals,

      

      // Upload dialog

      showUploadDialog,

      uploadPeriod,

      uploadHeaders,

      onUploadSuccess,

      onUploadError,

      getApiBaseUrl,

      folderInputRef,

      folderUploadProgress,

      triggerFolderUpload,

      handleFolderUpload,



      // 回测相关

      showBacktestDialog,

      backtesting,

      isBacktesting,

      backtestParams,

      backtestRules,

      

      // 方法

      onSymbolChange,

      onPeriodChange,

      loadStrategy,

      confirmSelectStrategy, // 🔥 新增

      quickLoadStrategy, // 🔥 新增

      clearStrategy, // 🔥 新增

      executeCurrentStrategy, // 🔥 新增

      toggleSignals,

      toggleAuxiliaryLines, // 🔥 新增

      toggleMA, // 🔥 新增：切换均线显示

      toggleBoll, // 🔥 新增：切换布林带显示

      generateStrategySignals,

      displaySignalsOnChart,

      clearSignalsFromChart,

      displayAuxiliaryLines, // 🔥 新增

      clearAuxiliaryLines, // 🔥 新增

      toggleStrategyIndicator,

      openBacktestDialog,

      handleCloseBacktest,

      disabledStartDate,

      disabledEndDate,

      runBacktest,

      parseError,

      // handleOrderSubmitted, // 已废弃

      // handleTradeModeChanged, // 已废弃

      // handlePositionClosed, // 已废弃

      formatTime,

      formatDateTime,

      loadAvailableStrategies,

      onStrategySelect,

      getStrategyTypeColor,

      getStrategyTypeLabel,

      getLanguageColor, // 🔥 新增

      getLanguageName, // 🔥 新增

      goToStrategyManagement, // 🔥 新增

      

      // 持仓面板相关

      mockPositions,

      currentPrices,

      loadPositions,  // 🔥 新增：加载持仓函数

      handleSelectPosition,

      handleClosePosition,

      

      // 数据源方法

      handleSourceChange,

      handleManageDataSource

    }

  }

}

