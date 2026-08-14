<template>
  <div class="modern-trading-panel">
    <!-- 可滚动内容区域 -->
    <div class="panel-scroll-content">
      <!-- 标的信息头部 - 已在页面左上角显示,暂时隐藏避免重复 -->
    <!-- 如需恢复显示,取消下面的注释即可 -->
    <!--
    <div class="symbol-header">
      <div class="symbol-info">
        <span class="symbol-code">{{ currentSymbol || '请选择标的' }}</span>
        <el-tag v-if="instrumentType" :type="instrumentType === 'futures' ? 'warning' : 'info'" size="small">
          {{ instrumentType === 'futures' ? '期货' : '股票' }}
        </el-tag>
      </div>
      <div class="price-display">
        <span class="current-price">{{ formatPrice(currentPrice) }}</span>
        <span class="price-change" :class="priceChangeClass">
          {{ priceChange >= 0 ? '+' : '' }}{{ priceChange.toFixed(2) }}%
        </span>
      </div>
    </div>
    -->

    <!-- 订单类型选择 -->
    <div class="order-type-section">
      <div class="section-label">
        <el-icon><Document /></el-icon>
        <span>订单类型</span>
      </div>
      <el-select v-model="orderForm.orderType" placeholder="选择订单类型" size="large" style="width: 100%;">
        <el-option label="限价单" value="limit">
          <span>限价单</span>
          <span style="float: right; color: #8492a6; font-size: 12px;">指定价格</span>
        </el-option>
        <el-option label="市价单" value="market">
          <span>市价单</span>
          <span style="float: right; color: #8492a6; font-size: 12px;">最优价格</span>
        </el-option>
        <el-option label="对手价" value="counterparty">
          <span>对手价</span>
          <span style="float: right; color: #8492a6; font-size: 12px;">买一/卖一</span>
        </el-option>
        <el-option label="排队价" value="queue">
          <span>排队价</span>
          <span style="float: right; color: #8492a6; font-size: 12px;">卖一/买一</span>
        </el-option>
        <el-option label="最优五档" value="best5">
          <span>最优五档</span>
          <span style="float: right; color: #8492a6; font-size: 12px;">五档成交</span>
        </el-option>
        <el-option label="最优本方" value="bestOwn">
          <span>最优本方</span>
          <span style="float: right; color: #8492a6; font-size: 12px;">本方最优</span>
        </el-option>
        <el-option label="TWAP算法" value="twap">
          <span>TWAP算法</span>
          <span style="float: right; color: #8492a6; font-size: 12px;">时间加权</span>
        </el-option>
        <el-option label="VWAP算法" value="vwap">
          <span>VWAP算法</span>
          <span style="float: right; color: #8492a6; font-size: 12px;">成交量加权</span>
        </el-option>
        <el-option label="策略下单" value="strategy">
          <span>策略下单</span>
          <span style="float: right; color: #8492a6; font-size: 12px;">智能策略</span>
        </el-option>
      </el-select>
      
      <!-- 订单类型说明 -->
      <div class="order-type-hint">
        <el-icon><InfoFilled /></el-icon>
        <span>{{ getOrderTypeHint() }}</span>
      </div>
    </div>

    <!-- 策略选择（仅策略下单显示） -->
    <div v-if="orderForm.orderType === 'strategy'" class="strategy-section">
      <div class="section-label">
        <el-icon><TrendCharts /></el-icon>
        <span>选择策略</span>
      </div>
      
      <el-select 
        v-model="orderForm.strategyId" 
        placeholder="选择交易策略" 
        size="large" 
        style="width: 100%;"
        filterable
        @change="onStrategyChange"
      >
        <el-option
          v-for="strategy in availableStrategies"
          :key="strategy.id"
          :label="strategy.name"
          :value="strategy.id"
        >
          <div class="strategy-option">
            <span class="strategy-name">{{ strategy.name }}</span>
            <el-tag :type="getStrategyTypeColor(strategy.type)" size="small">
              {{ getStrategyTypeLabel(strategy.type) }}
            </el-tag>
          </div>
        </el-option>
      </el-select>
      
      <!-- 策略信息显示 -->
      <div v-if="selectedStrategy" class="strategy-info-display">
        <div class="strategy-info-item">
          <span class="label">策略类型:</span>
          <span class="value">{{ getStrategyTypeLabel(selectedStrategy.type) }}</span>
        </div>
        <div class="strategy-info-item" v-if="selectedStrategy.description">
          <span class="label">策略说明:</span>
          <span class="value desc">{{ selectedStrategy.description }}</span>
        </div>
        <div class="strategy-info-item" v-if="strategyStats">
          <span class="label">历史表现:</span>
          <span class="value">
            收益率 <span :class="getProfitClass(strategyStats.totalReturn)">{{ strategyStats.totalReturn }}%</span>
            | 胜率 {{ strategyStats.winRate }}%
          </span>
        </div>
        <div class="strategy-info-item">
          <span class="label">交易模式:</span>
          <span class="value">
            <el-tag type="warning" size="small">自动交易</el-tag>
            <span style="margin-left: 8px; font-size: 11px; color: #f59e0b;">
              策略将自动监控市场并执行买卖
            </span>
          </span>
        </div>
      </div>
    </div>

    <!-- 期货特有：开平仓选择 -->
    <div v-if="isFutures" class="offset-section">
      <div class="section-label">
        <el-icon><Operation /></el-icon>
        <span>操作类型</span>
      </div>
      <el-segmented v-model="orderForm.offset" :options="offsetOptions" size="default" />
    </div>

    <!-- 价格输入 -->
    <div class="price-section">
      <div class="section-label">
        <el-icon><Money /></el-icon>
        <span>{{ getPriceSectionLabel() }}</span>
      </div>
      
      <!-- 限价单：手动输入价格 -->
      <div v-if="orderForm.orderType === 'limit'" class="price-input-group">
        <el-button 
          class="adjust-btn" 
          @click="adjustPrice(-1)"
          :disabled="!currentPrice"
        >
          <el-icon><Minus /></el-icon>
        </el-button>
        
        <el-input-number
          v-model="orderForm.price"
          :precision="2"
          :step="0.01"
          :min="0.01"
          :controls="false"
          class="price-input"
          size="large"
        />
        
        <el-button 
          class="adjust-btn" 
          @click="adjustPrice(1)"
          :disabled="!currentPrice"
        >
          <el-icon><Plus /></el-icon>
        </el-button>
      </div>
      
      <!-- 市价单：显示参考价格 -->
      <div v-else-if="orderForm.orderType === 'market'" class="market-price-display">
        <span class="market-text">按市场最优价格成交</span>
        <span class="reference-price">参考: ¥{{ formatPrice(currentPrice) }}</span>
      </div>

      <!-- 对手价：显示买一/卖一价格 -->
      <div v-else-if="orderForm.orderType === 'counterparty'" class="reference-price-display">
        <div class="ref-price-item">
          <span class="label">买一价:</span>
          <span class="value">¥{{ formatPrice(marketDepth.bid1) }}</span>
        </div>
        <div class="ref-price-item">
          <span class="label">卖一价:</span>
          <span class="value">¥{{ formatPrice(marketDepth.ask1) }}</span>
        </div>
      </div>

      <!-- 排队价：显示买一/卖一价格 -->
      <div v-else-if="orderForm.orderType === 'queue'" class="reference-price-display">
        <div class="ref-price-item">
          <span class="label">买一价:</span>
          <span class="value">¥{{ formatPrice(marketDepth.bid1) }}</span>
        </div>
        <div class="ref-price-item">
          <span class="label">卖一价:</span>
          <span class="value">¥{{ formatPrice(marketDepth.ask1) }}</span>
        </div>
      </div>

      <!-- 最优五档/最优本方：显示参考价格 -->
      <div v-else-if="orderForm.orderType === 'best5' || orderForm.orderType === 'bestOwn'" class="market-price-display">
        <span class="market-text">{{ orderForm.orderType === 'best5' ? '最优五档价格成交' : '本方最优价格成交' }}</span>
        <span class="reference-price">参考: ¥{{ formatPrice(currentPrice) }}</span>
      </div>

      <!-- TWAP/VWAP算法：显示算法参数 -->
      <div v-else-if="orderForm.orderType === 'twap' || orderForm.orderType === 'vwap'" class="algo-params">
        <div class="algo-param-item">
          <span class="param-label">执行时间段</span>
          <el-time-picker
            v-model="algoParams.timeRange"
            is-range
            range-separator="-"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            format="HH:mm"
            size="default"
            style="width: 100%;"
          />
        </div>
        <div class="algo-param-item">
          <span class="param-label">分批次数</span>
          <el-input-number
            v-model="algoParams.sliceCount"
            :min="2"
            :max="100"
            :step="1"
            size="default"
            style="width: 100%;"
          />
        </div>
        <div class="algo-param-item">
          <span class="param-label">价格限制</span>
          <el-input-number
            v-model="algoParams.priceLimit"
            :precision="2"
            :step="0.01"
            :min="0.01"
            size="default"
            style="width: 100%;"
          >
            <template #prefix>¥</template>
          </el-input-number>
        </div>
      </div>

      <!-- Price range hint (涨跌停范围提示) -->
      <div v-if="orderForm.orderType === 'limit' && !isFutures && currentPrice > 0" class="price-range-hint">
        <span>允许范围: ¥{{ (currentPrice * 0.9).toFixed(2) }} ~ ¥{{ (currentPrice * 1.1).toFixed(2) }}</span>
      </div>

      <!-- 快速价格按钮（仅限价单显示） -->
      <div v-if="orderForm.orderType === 'limit'" class="quick-price-btns">
        <el-button size="small" @click="setQuickPrice('bid')">
          买一 ¥{{ formatPrice(marketDepth.bid1) }}
        </el-button>
        <el-button size="small" @click="setQuickPrice('ask')">
          卖一 ¥{{ formatPrice(marketDepth.ask1) }}
        </el-button>
        <el-button size="small" @click="setQuickPrice('last')">
          最新 ¥{{ formatPrice(currentPrice) }}
        </el-button>
      </div>
    </div>

    <!-- 数量输入 -->
    <div class="quantity-section">
      <div class="section-label">
        <el-icon><Box /></el-icon>
        <span>数量 ({{ isFutures ? '手' : '股' }})</span>
      </div>
      
      <el-input-number
        v-model="orderForm.quantity"
        :min="isFutures ? 1 : 100"
        :step="isFutures ? 1 : 100"
        class="quantity-input"
        size="large"
      />

      <!-- 快速数量按钮 -->
      <div class="quick-quantity-btns">
        <el-button size="small" @click="setQuickQuantity(0.25)">1/4</el-button>
        <el-button size="small" @click="setQuickQuantity(0.5)">1/2</el-button>
        <el-button size="small" @click="setQuickQuantity(0.75)">3/4</el-button>
        <el-button size="small" @click="setQuickQuantity(1)">全仓</el-button>
      </div>
    </div>

    <!-- 资金预算 -->
    <div class="budget-section">
      <div class="budget-item">
        <span class="label">{{ isFutures ? '合约价值' : '预估金额' }}</span>
        <span class="value">¥{{ formatMoney(estimatedAmount) }}</span>
      </div>
      
      <div v-if="isFutures" class="budget-item highlight">
        <span class="label">所需保证金</span>
        <span class="value">¥{{ formatMoney(requiredMargin) }}</span>
      </div>
      
      <div class="budget-item">
        <span class="label">可用资金</span>
        <span class="value" :class="{ insufficient: !hasEnoughFunds }">
          ¥{{ formatMoney(availableFunds) }}
        </span>
      </div>
      
      <div v-if="isFutures" class="budget-item">
        <span class="label">杠杆倍数</span>
        <span class="value leverage">{{ leverageRatio }}x</span>
      </div>
    </div>

    </div>
    <!-- 结束 panel-scroll-content -->

    <!-- 固定在底部的交易按钮区域 -->
    <div class="panel-fixed-footer">
      <!-- 交易按钮 -->
      <div class="action-section">
        <!-- 策略下单：显示启动/停止按钮 -->
        <template v-if="orderForm.orderType === 'strategy'">
          <el-button
            type="success"
            size="large"
            class="trade-btn strategy-btn"
            @click="toggleStrategyMonitoring"
            :loading="submitting"
            :disabled="!canSubmit"
            style="width: 100%;"
          >
            <el-icon v-if="!isStrategyMonitoring"><VideoPlay /></el-icon>
            <el-icon v-else><VideoPause /></el-icon>
            <span>{{ isStrategyMonitoring ? '停止策略' : '启动策略' }}</span>
          </el-button>
        </template>
        
        <!-- 普通下单：显示买入/卖出按钮 -->
        <template v-else>
          <el-button
            type="danger"
            size="large"
            class="trade-btn buy-btn"
            @click="submitOrder('buy')"
            :loading="submitting"
            :disabled="!canSubmit"
          >
            <el-icon><Top /></el-icon>
            <span>{{ getBuyText }}</span>
          </el-button>
          
          <el-button
            type="success"
            size="large"
            class="trade-btn sell-btn"
            @click="submitOrder('sell')"
            :loading="submitting"
            :disabled="!canSubmit"
          >
            <el-icon><Bottom /></el-icon>
            <span>{{ getSellText }}</span>
          </el-button>
        </template>
      </div>

      <!-- Trading hours notice -->
      <div v-if="tradingHoursNotice" class="trading-hours-notice">
        <el-icon><Clock /></el-icon>
        <span>{{ tradingHoursNotice }}</span>
      </div>

      <!-- Price limit warning -->
      <div v-if="priceLimitWarning" class="price-limit-warning">
        <el-icon><Warning /></el-icon>
        <span>{{ priceLimitWarning }}</span>
      </div>

      <!-- 风险提示 -->
      <div v-if="riskWarning" class="risk-warning">
        <el-icon><Warning /></el-icon>
        <span>{{ riskWarning }}</span>
      </div>
    </div>
    <!-- 结束 panel-fixed-footer -->
  </div>
  <!-- 结束 modern-trading-panel -->
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Operation, Money, Box, Plus, Minus, Top, Bottom, Warning, Document, InfoFilled, TrendCharts,
  VideoPlay, VideoPause, Clock
} from '@element-plus/icons-vue'
import axios from 'axios'
import { tradeAPI } from '@/api/trade'

// Props
const props = defineProps({
  currentSymbol: String,
  currentPrice: {
    type: Number,
    default: 0
  },
  availableFunds: {
    type: Number,
    default: 100000
  }
})

// Emits
const emit = defineEmits(['order-submitted'])

// 订单表单
const orderForm = ref({
  orderType: 'limit',
  offset: 'open',
  price: 0,
  quantity: 100,
  strategyId: null
})

// 算法订单参数
const algoParams = ref({
  timeRange: [new Date(2024, 0, 1, 9, 30), new Date(2024, 0, 1, 15, 0)], // 默认交易时段
  sliceCount: 10, // 默认分10批
  priceLimit: 0 // 价格限制
})

// 策略相关
const availableStrategies = ref([])
const selectedStrategy = ref(null)
const strategyStats = ref(null)
const loadingStrategies = ref(false)
const isStrategyMonitoring = ref(false) // 策略是否正在监控
const strategyMonitorKey = ref(null) // 策略监控键

// 提交状态
const submitting = ref(false)

// 订单类型选项
const orderTypeOptions = [
  { label: '限价单', value: 'limit' },
  { label: '市价单', value: 'market' },
  { label: '对手价', value: 'counterparty' },
  { label: '排队价', value: 'queue' },
  { label: '最优五档', value: 'best5' },
  { label: '最优本方', value: 'bestOwn' },
  { label: 'TWAP', value: 'twap' },
  { label: 'VWAP', value: 'vwap' }
]

// 开平仓选项
const offsetOptions = [
  { label: '开仓', value: 'open' },
  { label: '平仓', value: 'close' }
]

// 市场深度数据（模拟）
const marketDepth = ref({
  bid1: 0,
  ask1: 0
})

// 判断是否为期货
const isFutures = computed(() => {
  if (!props.currentSymbol) return false
  return /^(IF|IC|IH|IM|IO|MO|HO|EB|EG|FG|MA|OI|RM|SF|SM|SR|TA|ZC|AP|CJ|CY|PF|PK|UR|SA|LH|RR|JR|WH|PM|RI|RS|WR|LR|NR|SP|SS|SC|BC|LU|FU|BU|RU|NR|HC|RB|WR|AG|AU|CU|AL|ZN|PB|NI|SN|SS|WR|V|PP|L|EB|EG|PG|MA|Y|P|A|B|M|C|CS|JD|FB|BB|JM|I|J|ZC|SF|SM|CF|CY|AP|CJ|UR|SA|FG|TA|OI|RM|SR|WH|PM|RI|RS|LR|JR|WR)/i.test(props.currentSymbol)
})

// 标的类型
const instrumentType = computed(() => {
  return isFutures.value ? 'futures' : 'stock'
})

// 价格变化百分比（模拟）
const priceChange = ref(0)

// 价格变化样式
const priceChangeClass = computed(() => {
  return priceChange.value >= 0 ? 'positive' : 'negative'
})

// 预估金额
const estimatedAmount = computed(() => {
  let price = orderForm.value.price
  
  // 根据订单类型确定价格
  if (orderForm.value.orderType === 'market') {
    price = props.currentPrice
  } else if (orderForm.value.orderType === 'counterparty') {
    // 使用中间价估算
    price = (marketDepth.value.bid1 + marketDepth.value.ask1) / 2
  } else if (orderForm.value.orderType === 'queue') {
    price = (marketDepth.value.bid1 + marketDepth.value.ask1) / 2
  } else if (orderForm.value.orderType === 'best5' || orderForm.value.orderType === 'bestOwn') {
    price = props.currentPrice
  } else if (orderForm.value.orderType === 'twap' || orderForm.value.orderType === 'vwap') {
    price = algoParams.value.priceLimit || props.currentPrice
  }
  
  return price * orderForm.value.quantity
})

// 保证金比例（期货）
const marginRatio = computed(() => {
  return isFutures.value ? 0.15 : 1 // 15%保证金
})

// 所需保证金
const requiredMargin = computed(() => {
  return isFutures.value ? estimatedAmount.value * marginRatio.value : estimatedAmount.value
})

// 杠杆倍数
const leverageRatio = computed(() => {
  return isFutures.value ? Math.floor(1 / marginRatio.value) : 1
})

// 是否有足够资金
const hasEnoughFunds = computed(() => {
  return props.availableFunds >= requiredMargin.value
})

// 是否可以提交
const canSubmit = computed(() => {
  if (!props.currentSymbol) return false
  if (orderForm.value.quantity <= 0) return false

  // 限价单需要检查价格
  if (orderForm.value.orderType === 'limit' && orderForm.value.price <= 0) return false

  // Block submit when price exceeds ±10% limit
  if (priceLimitWarning.value) return false

  // 算法订单需要检查参数
  if (orderForm.value.orderType === 'twap' || orderForm.value.orderType === 'vwap') {
    if (!algoParams.value.timeRange || algoParams.value.sliceCount < 2) return false
    if (algoParams.value.priceLimit <= 0) return false
  }

  // 策略订单需要检查策略选择
  if (orderForm.value.orderType === 'strategy' && !orderForm.value.strategyId) return false

  if (!hasEnoughFunds.value) return false
  return true
})

// Price limit check (±10% for stocks)
const priceLimitWarning = computed(() => {
  if (orderForm.value.orderType !== 'limit' || isFutures.value) return ''
  if (!props.currentPrice || props.currentPrice <= 0) return ''
  const price = orderForm.value.price
  if (!price || price <= 0) return ''
  const upperLimit = props.currentPrice * 1.10
  const lowerLimit = props.currentPrice * 0.90
  if (price > upperLimit) {
    return `委托价 ¥${price.toFixed(2)} 超过涨停价 ¥${upperLimit.toFixed(2)} (当前价+10%)`
  }
  if (price < lowerLimit) {
    return `委托价 ¥${price.toFixed(2)} 低于跌停价 ¥${lowerLimit.toFixed(2)} (当前价-10%)`
  }
  return ''
})

// Trading hours notice
const tradingHoursNotice = computed(() => {
  const now = new Date()
  const h = now.getHours()
  const m = now.getMinutes()
  const day = now.getDay()
  // Weekend
  if (day === 0 || day === 6) {
    return '当前为非交易日（周末），委托将在下一交易日生效'
  }
  const t = h * 60 + m
  // A-share trading hours: 9:30-11:30, 13:00-15:00
  const morning = (t >= 570 && t < 690)   // 9:30 - 11:30
  const afternoon = (t >= 780 && t < 900)  // 13:00 - 15:00
  if (!morning && !afternoon) {
    if (t < 570) return '当前为盘前时段，交易将在 9:30 开盘后执行'
    if (t >= 690 && t < 780) return '当前为午间休市时段 (11:30-13:00)'
    if (t >= 900) return '今日交易已收盘 (15:00)，委托将在下一交易日生效'
  }
  return ''
})

// 风险提示
const riskWarning = computed(() => {
  if (!hasEnoughFunds.value) {
    return '资金不足，无法下单'
  }
  if (isFutures.value && leverageRatio.value > 5) {
    return `高杠杆交易，风险较大 (${leverageRatio.value}倍)`
  }
  return ''
})

// 买入文本
const getBuyText = computed(() => {
  if (isFutures.value) {
    return orderForm.value.offset === 'open' ? '买入开仓' : '买入平仓'
  }
  return '买入'
})

// 卖出文本
const getSellText = computed(() => {
  if (isFutures.value) {
    return orderForm.value.offset === 'open' ? '卖出开仓' : '卖出平仓'
  }
  return '卖出'
})

// 调整价格
const adjustPrice = (direction) => {
  const cp = props.currentPrice
  const step = cp > 0 ? Math.max(0.01, parseFloat((cp * 0.001).toFixed(2))) : 0.01
  orderForm.value.price = Math.max(0.01, parseFloat((orderForm.value.price + direction * step).toFixed(2)))
}

// 设置快速价格
const setQuickPrice = (type) => {
  if (type === 'bid') {
    orderForm.value.price = marketDepth.value.bid1 || props.currentPrice
  } else if (type === 'ask') {
    orderForm.value.price = marketDepth.value.ask1 || props.currentPrice
  } else {
    orderForm.value.price = props.currentPrice
  }
}

// 设置快速数量
const setQuickQuantity = (ratio) => {
  const price = orderForm.value.orderType === 'market' ? props.currentPrice : orderForm.value.price
  if (!price || price <= 0) {
    ElMessage.warning('请先设置价格')
    return
  }
  
  const availableAmount = props.availableFunds * ratio
  const maxQuantity = Math.floor(availableAmount / (price * marginRatio.value))
  
  if (isFutures.value) {
    orderForm.value.quantity = Math.max(1, maxQuantity)
  } else {
    orderForm.value.quantity = Math.floor(maxQuantity / 100) * 100
  }
}

const validateOrderForm = (side) => {
  if (!props.currentSymbol) {
    ElMessage.warning('请选择交易标的')
    return false
  }

  const quantity = Number(orderForm.value.quantity)
  if (!Number.isFinite(quantity) || quantity <= 0) {
    ElMessage.warning('请输入有效的下单数量')
    return false
  }

  if (!isFutures.value && (!Number.isInteger(quantity) || quantity % 100 !== 0)) {
    ElMessage.warning('股票数量必须为100的整数倍')
    return false
  }

  const orderType = orderForm.value.orderType
  if (orderType === 'limit') {
    const limitPrice = Number(orderForm.value.price)
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      ElMessage.warning('请输入有效的委托价格')
      return false
    }
    // Enforce ±10% price limit for stocks
    if (!isFutures.value && props.currentPrice > 0) {
      const upper = props.currentPrice * 1.10
      const lower = props.currentPrice * 0.90
      if (limitPrice > upper || limitPrice < lower) {
        ElMessage.warning(`委托价格超出涨跌停限制 (${lower.toFixed(2)} - ${upper.toFixed(2)})`)
        return false
      }
    }
  }

  if (orderType === 'strategy' && !orderForm.value.strategyId) {
    ElMessage.warning('请选择策略后再提交策略单')
    return false
  }

  if ((orderType === 'twap' || orderType === 'vwap') && (!algoParams.value.timeRange || algoParams.value.sliceCount < 2)) {
    ElMessage.warning('算法单参数不完整，请检查时间范围和分片数量')
    return false
  }

  if (!['buy', 'sell'].includes(side)) {
    ElMessage.warning('无效的买卖方向')
    return false
  }

  if (!hasEnoughFunds.value) {
    ElMessage.warning('可用资金不足，无法下单')
    return false
  }

  return true
}

// 提交订单
const submitOrder = async (side) => {
  if (!canSubmit.value || !validateOrderForm(side)) return
  
  submitting.value = true
  
  try {
    // 根据订单类型确定实际成交价格
    let actualPrice = orderForm.value.price
    
    if (orderForm.value.orderType === 'market') {
      actualPrice = props.currentPrice
    } else if (orderForm.value.orderType === 'counterparty') {
      // 对手价：买入用卖一，卖出用买一
      actualPrice = side === 'buy' ? marketDepth.value.ask1 : marketDepth.value.bid1
    } else if (orderForm.value.orderType === 'queue') {
      // 排队价：买入用买一，卖出用卖一
      actualPrice = side === 'buy' ? marketDepth.value.bid1 : marketDepth.value.ask1
    } else if (orderForm.value.orderType === 'best5' || orderForm.value.orderType === 'bestOwn') {
      actualPrice = props.currentPrice
    } else if (orderForm.value.orderType === 'twap' || orderForm.value.orderType === 'vwap') {
      // 算法订单使用价格限制
      actualPrice = algoParams.value.priceLimit || props.currentPrice
    } else if (orderForm.value.orderType === 'strategy') {
      // 策略下单：使用当前价格，实际交易由策略决定
      actualPrice = props.currentPrice
    }
    
    const orderData = {
      symbol: props.currentSymbol,
      side,
      orderType: orderForm.value.orderType,
      price: actualPrice,
      quantity: orderForm.value.quantity,
      isFutures: isFutures.value,
      offset: isFutures.value ? orderForm.value.offset : null,
      marginRatio: marginRatio.value,
      // 算法订单额外参数
      algoParams: (orderForm.value.orderType === 'twap' || orderForm.value.orderType === 'vwap')
        ? algoParams.value
        : null,
      // 策略订单额外参数
      strategyId: orderForm.value.orderType === 'strategy' ? orderForm.value.strategyId : null,
      strategyName: orderForm.value.orderType === 'strategy' && selectedStrategy.value
        ? selectedStrategy.value.name
        : null
    }
    
    // 🔥 调用后端API保存订单
    const response = await tradeAPI.createTrade(orderData)
    
    if (response.success) {
      // 触发事件到交易记录中心
      window.dispatchEvent(new CustomEvent('new-order', { detail: response.data }))
      
      // 通知父组件
      emit('order-submitted', response.data)
      
      ElMessage.success('订单已提交')
    } else {
      throw new Error(response.message || '订单提交失败')
    }
    
    // 重置表单（可选）
    // resetForm()
    
  } catch (error) {
    console.error('订单提交失败:', error)
    ElMessage.error('订单提交失败: ' + (error.response?.data?.message || error.message))
  } finally {
    submitting.value = false
  }
}

// 重置表单
const resetForm = () => {
  orderForm.value.quantity = isFutures.value ? 1 : 100
}

// 格式化价格
const formatPrice = (price) => {
  return price ? price.toFixed(2) : '0.00'
}

// 格式化金额
const formatMoney = (amount) => {
  return amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// 获取订单类型说明
const getOrderTypeHint = () => {
  const hints = {
    limit: '以指定价格或更优价格成交，未成交部分继续挂单',
    market: '以当前市场最优价格立即成交，不保证成交价格',
    counterparty: '买入时以卖一价成交，卖出时以买一价成交',
    queue: '买入时以买一价挂单，卖出时以卖一价挂单，排队等待成交',
    best5: '在最优五档价格范围内以对手价成交，未成交部分自动撤单',
    bestOwn: '在本方最优价格成交，买入不高于买一价，卖出不低于卖一价',
    twap: '时间加权平均价格算法，在指定时间内均匀分批下单',
    vwap: '成交量加权平均价格算法，根据市场成交量分布智能下单',
    strategy: '根据选定的交易策略自动生成交易信号并执行下单'
  }
  return hints[orderForm.value.orderType] || '请选择订单类型'
}

// 获取价格区块标签
const getPriceSectionLabel = () => {
  const labels = {
    limit: '限价',
    market: '市价',
    counterparty: '对手价参考',
    queue: '排队价参考',
    best5: '最优五档',
    bestOwn: '最优本方',
    twap: 'TWAP参数',
    vwap: 'VWAP参数',
    strategy: '策略价格'
  }
  return labels[orderForm.value.orderType] || '价格'
}

// 策略相关方法
async function loadAvailableStrategies() {
  loadingStrategies.value = true
  try {
    const token = localStorage.getItem('token')
    if (!token) {
      console.warn('未登录，无法加载策略列表')
      ElMessage.warning('请先登录')
      return
    }

    console.log('开始加载策略列表...')
    console.log('Token:', token ? '已设置' : '未设置')

    const response = await axios.get('/api/strategy', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        page: 1,
        pageSize: 100 // 加载更多策略
      }
    })

    console.log('策略API响应:', response.data)

    if (response.data.success) {
      // 修复：后端返回的是 data.list 而不是 data.strategies
      const strategies = response.data.data.list || response.data.data.strategies || []
      availableStrategies.value = strategies
      console.log('已加载策略数量:', strategies.length)
      
      if (strategies.length === 0) {
        console.warn('策略列表为空')
        ElMessage.info('暂无可用策略，请先在策略管理中创建策略')
      } else {
        console.log('策略列表:', strategies.map(s => ({ id: s.id, name: s.name })))
      }
    } else {
      console.error('加载策略失败:', response.data.message)
      ElMessage.error('加载策略失败: ' + response.data.message)
    }
  } catch (error) {
    console.error('加载策略列表失败:', error)
    console.error('错误详情:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      statusText: error.response?.statusText
    })
    
    if (error.response?.status === 401) {
      ElMessage.error('登录已过期，请重新登录')
    } else if (error.response?.status === 404) {
      ElMessage.error('策略API不存在，请检查后端服务')
    } else {
      ElMessage.error('加载策略列表失败: ' + (error.response?.data?.message || error.message))
    }
  } finally {
    loadingStrategies.value = false
  }
}

function onStrategyChange(strategyId) {
  const strategy = availableStrategies.value.find(s => s.id === strategyId)
  if (strategy) {
    selectedStrategy.value = strategy
    // 加载策略统计数据
    loadStrategyStats(strategyId)
  }
}

async function loadStrategyStats(strategyId) {
  try {
    const token = localStorage.getItem('token')
    if (!token) return

    const response = await axios.get(`/api/strategy/${strategyId}/stats`, {
      headers: { Authorization: `Bearer ${token}` }
    })

    if (response.data.success) {
      strategyStats.value = response.data.data
    }
  } catch (error) {
    console.error('加载策略统计失败:', error)
    strategyStats.value = null
  }
}

function getStrategyTypeLabel(type) {
  const labels = {
    trend: '趋势策略',
    mean_reversion: '均值回归',
    momentum: '动量策略',
    arbitrage: '套利策略',
    market_making: '做市策略',
    other: '其他'
  }
  return labels[type] || type
}

function getStrategyTypeColor(type) {
  const colors = {
    trend: 'success',
    mean_reversion: 'warning',
    momentum: 'danger',
    arbitrage: 'info',
    market_making: 'primary',
    other: ''
  }
  return colors[type] || ''
}

function getProfitClass(profit) {
  if (profit > 0) return 'profit-positive'
  if (profit < 0) return 'profit-negative'
  return 'profit-neutral'
}

// 策略监控相关方法
async function toggleStrategyMonitoring() {
  if (isStrategyMonitoring.value) {
    // 停止监控
    await stopStrategyMonitoring()
  } else {
    // 启动监控
    await startStrategyMonitoring()
  }
}

async function startStrategyMonitoring() {
  if (!selectedStrategy.value) {
    ElMessage.warning('请先选择策略')
    return
  }

  submitting.value = true
  try {
    const token = localStorage.getItem('token')
    if (!token) {
      throw new Error('未登录')
    }

    const response = await axios.post('/api/strategy/monitor/start', {
      strategyId: orderForm.value.strategyId,
      symbol: props.currentSymbol,
      quantity: orderForm.value.quantity
    }, {
      headers: { Authorization: `Bearer ${token}` }
    })

    if (response.data.success) {
      isStrategyMonitoring.value = true
      strategyMonitorKey.value = response.data.data.monitorKey
      
      ElMessage.success({
        message: `策略 "${selectedStrategy.value.name}" 已启动，将自动监控市场并执行交易`,
        duration: 5000
      })
      
      // 触发事件通知父组件
      emit('strategy-monitoring-started', {
        strategyId: orderForm.value.strategyId,
        strategyName: selectedStrategy.value.name,
        symbol: props.currentSymbol,
        quantity: orderForm.value.quantity
      })
    } else {
      throw new Error(response.data.message || '启动失败')
    }
  } catch (error) {
    console.error('启动策略监控失败:', error)
    ElMessage.error('启动策略失败: ' + error.message)
  } finally {
    submitting.value = false
  }
}

async function stopStrategyMonitoring() {
  if (!strategyMonitorKey.value) {
    isStrategyMonitoring.value = false
    return
  }

  submitting.value = true
  try {
    const token = localStorage.getItem('token')
    if (!token) {
      throw new Error('未登录')
    }

    const response = await axios.post('/api/strategy/monitor/stop', {
      monitorKey: strategyMonitorKey.value
    }, {
      headers: { Authorization: `Bearer ${token}` }
    })

    if (response.data.success) {
      isStrategyMonitoring.value = false
      strategyMonitorKey.value = null
      
      ElMessage.info('策略监控已停止')
      
      // 触发事件通知父组件
      emit('strategy-monitoring-stopped', {
        strategyId: orderForm.value.strategyId
      })
    } else {
      throw new Error(response.data.message || '停止失败')
    }
  } catch (error) {
    console.error('停止策略监控失败:', error)
    ElMessage.error('停止策略失败: ' + error.message)
  } finally {
    submitting.value = false
  }
}

// 组件卸载时停止监控
onUnmounted(() => {
  if (isStrategyMonitoring.value) {
    stopStrategyMonitoring()
  }
})

// Sync limit price to market price when it arrives or when price was zero
watch(() => props.currentPrice, (newPrice) => {
  if (newPrice && newPrice > 0) {
    // Fill price when it's unset or still at the el-input-number min (0.01)
    if (orderForm.value.orderType === 'limit' && (!orderForm.value.price || orderForm.value.price < newPrice * 0.5)) {
      orderForm.value.price = newPrice
    }

    // Update market depth simulation
    marketDepth.value.bid1 = newPrice * 0.999
    marketDepth.value.ask1 = newPrice * 1.001

    // Price change simulation
    priceChange.value = (Math.random() - 0.5) * 4
  }
}, { immediate: true })


// 监听标的变化
watch(() => props.currentSymbol, () => {
  resetForm()
  orderForm.value.price = props.currentPrice
})

// 监听订单类型变化
watch(() => orderForm.value.orderType, (newType) => {
  // 切换到算法订单时，自动设置价格限制
  if ((newType === 'twap' || newType === 'vwap') && algoParams.value.priceLimit === 0) {
    algoParams.value.priceLimit = props.currentPrice
  }
  
  // 切换到策略订单时，加载策略列表
  if (newType === 'strategy' && availableStrategies.value.length === 0) {
    loadAvailableStrategies()
  }
})

// 组件挂载时加载策略列表 and sync initial price
onMounted(() => {
  loadAvailableStrategies()
  // Pre-fill limit price from current market price
  if (props.currentPrice && props.currentPrice > 0 && (!orderForm.value.price || orderForm.value.price <= 0)) {
    orderForm.value.price = props.currentPrice
  }
})
</script>

<style scoped>
.modern-trading-panel {
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
  padding: 20px;
  border: 1px solid rgba(16, 185, 129, 0.2);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.modern-trading-panel::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: 
    radial-gradient(circle at 20% 30%, rgba(16, 185, 129, 0.05) 1px, transparent 1px),
    radial-gradient(circle at 80% 70%, rgba(59, 130, 246, 0.05) 1px, transparent 1px);
  background-size: 100% 100%;
  opacity: 0.6;
  pointer-events: none;
}

/* 可滚动内容区域 */
.panel-scroll-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 10px;
}

.panel-scroll-content::-webkit-scrollbar {
  width: 6px;
}

.panel-scroll-content::-webkit-scrollbar-track {
  background: rgba(16, 185, 129, 0.1);
  border-radius: 3px;
}

.panel-scroll-content::-webkit-scrollbar-thumb {
  background: rgba(16, 185, 129, 0.3);
  border-radius: 3px;
}

.panel-scroll-content::-webkit-scrollbar-thumb:hover {
  background: rgba(16, 185, 129, 0.5);
}

/* 固定在底部的按钮区域 */
.panel-fixed-footer {
  flex-shrink: 0;
  padding-top: 10px;
  border-top: 1px solid rgba(16, 185, 129, 0.2);
  background: linear-gradient(to bottom, transparent, rgba(10, 14, 19, 0.8));
}

/* 标的信息头部 */
.symbol-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: rgba(16, 185, 129, 0.1);
  border-radius: 6px;
  margin-bottom: 20px;
  position: relative;
  z-index: 1;
}

.symbol-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.symbol-code {
  font-size: 18px;
  font-weight: 700;
  color: #10b981;
  font-family: 'Consolas', monospace;
}

.price-display {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.current-price {
  font-size: 24px;
  font-weight: 700;
  color: #e5e7eb;
  font-family: 'Consolas', monospace;
}

.price-change {
  font-size: 14px;
  font-weight: 600;
  margin-top: 4px;
}

.price-change.positive {
  color: #ef4444;
}

.price-change.negative {
  color: #10b981;
}

/* 各个区块 */
.order-type-section,
.offset-section,
.price-section,
.quantity-section,
.budget-section,
.action-section {
  margin-bottom: 20px;
  position: relative;
  z-index: 1;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: #9ca3af;
  font-size: 14px;
  font-weight: 600;
}

/* 价格输入组 */
.price-input-group {
  display: flex;
  gap: 10px;
  align-items: center;
}

.adjust-btn {
  width: 40px;
  height: 40px;
  padding: 0;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: #10b981;
}

.adjust-btn:hover {
  background: rgba(16, 185, 129, 0.2);
  border-color: rgba(16, 185, 129, 0.5);
}

.price-input,
.quantity-input {
  flex: 1;
}

:deep(.el-input-number) {
  width: 100%;
}

:deep(.el-input-number .el-input__inner) {
  background: rgba(26, 26, 26, 0.8);
  border-color: rgba(16, 185, 129, 0.3);
  color: #e5e7eb;
  font-size: 20px;
  font-weight: 600;
  font-family: 'Consolas', monospace;
  text-align: center;
  padding: 0 8px;
}

/* 市价显示 */
.market-price-display {
  padding: 16px;
  background: rgba(59, 130, 246, 0.1);
  border: 1px dashed rgba(59, 130, 246, 0.3);
  border-radius: 6px;
  text-align: center;
}

.market-text {
  display: block;
  color: #3b82f6;
  font-size: 14px;
  margin-bottom: 8px;
}

.reference-price {
  display: block;
  color: #9ca3af;
  font-size: 12px;
}

/* 参考价格显示 */
.reference-price-display {
  padding: 12px 16px;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 6px;
  display: flex;
  justify-content: space-around;
  gap: 16px;
}

.ref-price-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.ref-price-item .label {
  color: #9ca3af;
  font-size: 12px;
}

.ref-price-item .value {
  color: #10b981;
  font-size: 16px;
  font-weight: 700;
  font-family: 'Consolas', monospace;
}

/* 算法订单参数 */
.algo-params {
  padding: 16px;
  background: rgba(139, 92, 246, 0.08);
  border: 1px solid rgba(139, 92, 246, 0.2);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.algo-param-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.param-label {
  color: #9ca3af;
  font-size: 12px;
  font-weight: 600;
}

.algo-params :deep(.el-input__inner),
.algo-params :deep(.el-input-number__decrease),
.algo-params :deep(.el-input-number__increase) {
  background: rgba(26, 26, 26, 0.8);
  border-color: rgba(139, 92, 246, 0.3);
  color: #e5e7eb;
}

.algo-params :deep(.el-range-separator) {
  color: #9ca3af;
}

/* 快速按钮 */
.price-range-hint {
  margin-top: 8px;
  font-size: 12px;
  color: #f59e0b;
  text-align: center;
}

.quick-price-btns,
.quick-quantity-btns {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.quick-price-btns .el-button,
.quick-quantity-btns .el-button {
  flex: 1;
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.3);
  color: #10b981;
  font-size: 12px;
}

/* 资金预算 */
.budget-section {
  background: rgba(26, 26, 26, 0.6);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 6px;
  padding: 16px;
}

.budget-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid rgba(16, 185, 129, 0.1);
}

.budget-item:last-child {
  border-bottom: none;
}

.budget-item.highlight {
  background: rgba(245, 158, 11, 0.1);
  padding: 8px 12px;
  margin: 8px -12px;
  border-radius: 4px;
}

.budget-item .label {
  color: #9ca3af;
  font-size: 13px;
}

.budget-item .value {
  color: #e5e7eb;
  font-weight: 600;
  font-family: 'Consolas', monospace;
  font-size: 14px;
}

.budget-item .value.insufficient {
  color: #ef4444;
}

.budget-item .value.leverage {
  color: #f59e0b;
}

/* 交易按钮 */
.action-section {
  display: flex;
  gap: 12px;
}

.trade-btn {
  flex: 1;
  height: 56px;
  font-size: 16px;
  font-weight: 700;
  border: none;
  position: relative;
  overflow: hidden;
}

.trade-btn::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
  transition: left 0.5s;
}

.trade-btn:hover::before {
  left: 100%;
}

.buy-btn {
  background: linear-gradient(135deg, #ef4444, #dc2626);
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
}

.buy-btn:hover {
  background: linear-gradient(135deg, #dc2626, #b91c1c);
}

.sell-btn {
  background: linear-gradient(135deg, #10b981, #059669);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
}

.sell-btn:hover {
  background: linear-gradient(135deg, #059669, #047857);
}

.strategy-btn {
  background: linear-gradient(135deg, #f59e0b, #d97706);
  box-shadow: 0 4px 12px rgba(245, 158, 11, 0.4);
}

.strategy-btn:hover {
  background: linear-gradient(135deg, #d97706, #b45309);
}

/* 风险提示 */
.risk-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 6px;
  color: #f59e0b;
  font-size: 13px;
  margin-top: 16px;
}

/* Trading hours notice */
.trading-hours-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.3);
  border-radius: 6px;
  color: #60a5fa;
  font-size: 12px;
  margin-top: 12px;
}

/* Price limit warning */
.price-limit-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 12px;
  margin-top: 8px;
}

/* 订单类型说明 */
.order-type-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(59, 130, 246, 0.08);
  border: 1px solid rgba(59, 130, 246, 0.2);
  border-radius: 6px;
  color: #93c5fd;
  font-size: 12px;
  line-height: 1.5;
  margin-top: 10px;
}

.order-type-hint .el-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: #60a5fa;
}

/* 策略选择区域 */
.strategy-section {
  margin-bottom: 20px;
  position: relative;
  z-index: 1;
}

.strategy-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.strategy-name {
  flex: 1;
  color: #e5e7eb;
  font-weight: 600;
}

.strategy-info-display {
  margin-top: 12px;
  padding: 12px;
  background: rgba(139, 92, 246, 0.08);
  border: 1px solid rgba(139, 92, 246, 0.2);
  border-radius: 6px;
}

.strategy-info-item {
  display: flex;
  margin-bottom: 8px;
  font-size: 12px;
}

.strategy-info-item:last-child {
  margin-bottom: 0;
}

.strategy-info-item .label {
  color: #9ca3af;
  min-width: 80px;
  flex-shrink: 0;
}

.strategy-info-item .value {
  color: #e5e7eb;
  flex: 1;
}

.strategy-info-item .value.desc {
  line-height: 1.5;
}

.strategy-info-item .profit-positive {
  color: #ef4444;
  font-weight: 700;
}

.strategy-info-item .profit-negative {
  color: #10b981;
  font-weight: 700;
}

.strategy-info-item .profit-neutral {
  color: #9ca3af;
}

/* Segmented 样式 */
:deep(.el-segmented) {
  background: rgba(26, 26, 26, 0.8);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

:deep(.el-segmented__item) {
  color: #9ca3af;
}

:deep(.el-segmented__item.is-selected) {
  background: linear-gradient(135deg, #10b981, #059669);
  color: #fff;
}

/* 移动端优化 */
@media (max-width: 768px) {
  .modern-trading-panel {
    padding: 16px;
    height: auto;
    min-height: 100%;
  }

  .panel-scroll-content {
    max-height: calc(100vh - 300px);
    padding-bottom: 20px;
  }

  .panel-fixed-footer {
    position: sticky;
    bottom: 0;
    left: 0;
    right: 0;
    background: linear-gradient(to bottom, rgba(10, 14, 19, 0.95), rgba(10, 14, 19, 1));
    padding: 16px;
    margin: 0 -16px -16px -16px;
    z-index: 100;
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.3);
  }

  .action-section {
    flex-direction: column;
    gap: 12px;
  }

  .trade-btn {
    width: 100%;
    height: 52px;
    font-size: 18px;
    /* 确保触摸目标至少44px */
    min-height: 44px;
  }

  .section-label {
    font-size: 13px;
  }

  .price-input-group {
    gap: 8px;
  }

  .adjust-btn {
    width: 44px;
    height: 44px;
  }

  .quick-price-btns,
  .quick-quantity-btns {
    flex-wrap: wrap;
  }

  .quick-price-btns .el-button,
  .quick-quantity-btns .el-button {
    min-height: 40px;
    font-size: 13px;
  }

  .budget-section {
    padding: 12px;
  }

  .budget-item {
    padding: 6px 0;
  }

  .budget-item .label,
  .budget-item .value {
    font-size: 13px;
  }

  .risk-warning {
    font-size: 12px;
    padding: 10px;
    margin-top: 12px;
  }

  .order-type-hint {
    font-size: 11px;
    padding: 8px 10px;
  }

  .strategy-info-display {
    padding: 10px;
  }

  .strategy-info-item {
    font-size: 11px;
  }

  :deep(.el-input-number .el-input__inner) {
    font-size: 16px;
  }

  :deep(.el-select) {
    font-size: 14px;
  }
}
</style>
