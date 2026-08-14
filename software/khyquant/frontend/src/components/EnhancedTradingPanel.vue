<template>
  <div class="enhanced-trading-panel">
    <!-- 价格输入区 -->
    <div class="price-section">
      <div class="section-label">价格</div>
      <div class="price-input-group">
        <el-button size="small" @click="adjustPrice(-1)" :disabled="orderForm.orderType === 'market'">-</el-button>
        <el-input-number
          v-model="orderForm.price"
          :precision="getPricePrecision()"
          :step="getMinPriceTick()"
          :disabled="orderForm.orderType === 'market'"
          size="small"
          style="width: 150px;"
        />
        <el-button size="small" @click="adjustPrice(1)" :disabled="orderForm.orderType === 'market'">+</el-button>
      </div>
      <div class="order-type-switch">
        <el-radio-group v-model="orderForm.orderType" size="small">
          <el-radio-button label="limit">限价</el-radio-button>
          <el-radio-button label="market">市价</el-radio-button>
        </el-radio-group>
      </div>
      <div class="quick-price-buttons">
        <el-button size="small" @click="setPrice('bid1')">买一: {{ formatPrice(marketData.bid1) }}</el-button>
        <el-button size="small" @click="setPrice('ask1')">卖一: {{ formatPrice(marketData.ask1) }}</el-button>
        <el-button size="small" @click="setPrice('last')">最新: {{ formatPrice(marketData.last) }}</el-button>
      </div>
    </div>

    <!-- 交易方向与操作区 -->
    <div class="direction-section">
      <!-- 期货模式：显示开平选择 -->
      <div v-if="isFutures" class="offset-selector">
        <div class="section-label">操作</div>
        <el-radio-group v-model="orderForm.offset" size="small" style="margin-bottom: 12px;">
          <el-radio-button label="open">开仓</el-radio-button>
          <el-radio-button label="close">平仓</el-radio-button>
        </el-radio-group>
      </div>
      
      <!-- 统一的买入/卖出按钮 -->
      <div class="section-label">方向</div>
      <div class="direction-buttons">
        <el-button 
          type="danger" 
          size="large"
          @click="submitOrder('buy', orderForm.offset)"
          :loading="submitting"
          class="direction-btn buy-btn"
        >
          {{ getBuyButtonText }}
        </el-button>
        <el-button 
          type="success" 
          size="large"
          @click="submitOrder('sell', orderForm.offset)"
          :loading="submitting"
          class="direction-btn sell-btn"
        >
          {{ getSellButtonText }}
        </el-button>
      </div>
    </div>

    <!-- 数量输入区 -->
    <div class="quantity-section">
      <div class="section-label">
        数量 <span class="unit">({{ quantityUnit }})</span>
      </div>
      <el-input-number
        v-model="orderForm.quantity"
        :min="getMinQuantity()"
        :step="getQuantityStep()"
        size="small"
        style="width: 100%;"
      />
      <div class="quick-quantity-buttons">
        <el-button size="small" @click="setQuantity(0.25)">1/4仓</el-button>
        <el-button size="small" @click="setQuantity(0.33)">1/3仓</el-button>
        <el-button size="small" @click="setQuantity(0.5)">1/2仓</el-button>
        <el-button size="small" @click="setQuantity(1)">全仓</el-button>
      </div>
    </div>

    <!-- 预算计算显示 -->
    <div class="budget-section">
      <div class="budget-item">
        <span class="label">{{ isFutures ? '合约价值:' : '预估金额:' }}</span>
        <span class="value">¥{{ formatMoney(isFutures ? contractValue : estimatedAmount) }}</span>
      </div>
      
      <div v-if="isFutures" class="budget-item highlight">
        <span class="label">所需保证金:</span>
        <span class="value">¥{{ formatMoney(requiredMargin) }}</span>
      </div>
      
      <div class="budget-item">
        <span class="label">{{ isFutures ? '可用资金:' : '账户余额:' }}</span>
        <span class="value" :class="{ 'insufficient': availableFunds < (isFutures ? requiredMargin : estimatedTotal) }">
          ¥{{ formatMoney(availableFunds) }}
        </span>
      </div>
      
      <div class="budget-item">
        <span class="label">手续费:</span>
        <span class="value">¥{{ formatMoney(estimatedCommission) }}</span>
      </div>
      
      <div v-if="!isFutures" class="budget-item total">
        <span class="label">合计:</span>
        <span class="value">¥{{ formatMoney(estimatedTotal) }}</span>
      </div>
    </div>

    <!-- 高级设置（可折叠） -->
    <el-collapse v-model="advancedSettingsOpen" class="advanced-settings">
      <el-collapse-item title="高级设置" name="1">
        <!-- 有效期限 -->
        <div class="setting-item">
          <div class="setting-label">有效期限</div>
          <el-select v-model="orderForm.timeInForce" size="small">
            <el-option label="当日有效 (GFD)" value="GFD" />
            <el-option label="立即成交剩余撤销 (FOK)" value="FOK" />
            <el-option label="立即成交剩余转限价 (FAK)" value="FAK" />
            <el-option label="取消前有效 (GTC)" value="GTC" />
          </el-select>
        </div>

        <!-- 止盈止损 -->
        <div class="setting-item">
          <el-checkbox v-model="orderForm.enableStopLoss">启用止损</el-checkbox>
          <el-input-number
            v-if="orderForm.enableStopLoss"
            v-model="orderForm.stopLossPrice"
            :precision="getPricePrecision()"
            placeholder="止损价格"
            size="small"
            style="width: 100%; margin-top: 8px;"
          />
        </div>

        <div class="setting-item">
          <el-checkbox v-model="orderForm.enableTakeProfit">启用止盈</el-checkbox>
          <el-input-number
            v-if="orderForm.enableTakeProfit"
            v-model="orderForm.takeProfitPrice"
            :precision="getPricePrecision()"
            placeholder="止盈价格"
            size="small"
            style="width: 100%; margin-top: 8px;"
          />
        </div>
      </el-collapse-item>
    </el-collapse>

    <!-- 风险提示 -->
    <div v-if="priceLimitWarning" class="risk-warning" style="margin-bottom: 8px;">
      <el-alert :title="priceLimitWarning" type="warning" :closable="false" />
    </div>
    <div v-if="riskWarning" class="risk-warning">
      <el-alert :title="riskWarning" type="warning" :closable="false" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'

const props = defineProps({
  instrumentCode: {
    type: String,
    default: '000001'
  },
  currentPrice: {
    type: Number,
    default: 0
  },
  availableFunds: {
    type: Number,
    default: 100000
  }
})

const emit = defineEmits(['order-submitted', 'mode-changed'])

// 交易模式：自动识别
const tradeMode = ref('stock')

// 判断是否为期货
const isFutures = computed(() => tradeMode.value === 'futures')

// 判断是否为ETF
const isETF = computed(() => {
  const code = props.instrumentCode
  return /^5\d{5}$/.test(code) // 5开头的6位数字
})

// 数量单位
const quantityUnit = computed(() => {
  if (isFutures.value) return '手'
  if (isETF.value) return '份'
  return '股'
})

// 按钮文本
const getBuyButtonText = computed(() => {
  if (!isFutures.value) return '买入'
  return orderForm.value.offset === 'open' ? '买入开仓' : '买入平仓'
})

const getSellButtonText = computed(() => {
  if (!isFutures.value) return '卖出'
  return orderForm.value.offset === 'open' ? '卖出开仓' : '卖出平仓'
})

// 品种信息
const instrumentInfo = ref({
  code: props.instrumentCode,
  name: '上证指数',
  currentPrice: props.currentPrice,
  priceChange: 0,
  priceChangePercent: 0,
  pe: 13.5,
  marketCap: 5000000000000,
  contractMonth: '2401',
  openInterest: 150000
})

// 行情数据
const marketData = ref({
  bid1: props.currentPrice - 0.01,
  ask1: props.currentPrice + 0.01,
  last: props.currentPrice
})

// 订单表单
const orderForm = ref({
  orderType: 'limit', // limit 或 market
  price: props.currentPrice,
  quantity: 100,
  offset: 'open', // open 或 close (期货)
  timeInForce: 'GFD',
  enableStopLoss: false,
  stopLossPrice: 0,
  enableTakeProfit: false,
  takeProfitPrice: 0
})

const submitting = ref(false)
const advancedSettingsOpen = ref([])
const availableFunds = ref(props.availableFunds)

// 自动识别交易模式
watch(() => props.instrumentCode, (newCode) => {
  // 移除前缀（sh/sz）
  const cleanCode = newCode.replace(/^(sh|sz|SH|SZ)/, '')
  
  // 期货：字母开头 + 4位数字 (IF2401, IC2401, IH2401等)
  if (/^[A-Z]{1,2}\d{4}$/.test(cleanCode)) {
    tradeMode.value = 'futures'
  } 
  // 股票/ETF/指数：6位数字
  else if (/^\d{6}$/.test(cleanCode)) {
    tradeMode.value = 'stock'
  }
  // 默认股票模式
  else {
    tradeMode.value = 'stock'
  }
  
  instrumentInfo.value.code = newCode
  console.log('🔍 代码识别:', newCode, '->', cleanCode, '模式:', tradeMode.value)
}, { immediate: true })

// 预算计算
const estimatedAmount = computed(() => {
  return orderForm.value.price * orderForm.value.quantity
})

const estimatedCommission = computed(() => {
  const rate = tradeMode.value === 'stock' ? 0.0003 : 0.0001
  return estimatedAmount.value * rate
})

const estimatedTotal = computed(() => {
  return estimatedAmount.value + estimatedCommission.value
})

// 期货相关计算
const contractMultiplier = computed(() => {
  // 根据合约代码返回合约乘数
  const code = instrumentInfo.value.code
  if (code.startsWith('IF')) return 300 // 沪深300股指期货
  if (code.startsWith('IC')) return 200 // 中证500股指期货
  if (code.startsWith('IH')) return 300 // 上证50股指期货
  return 10 // 默认
})

const marginRate = computed(() => {
  // 保证金比例
  return 0.15 // 15%
})

const contractValue = computed(() => {
  return orderForm.value.price * contractMultiplier.value * orderForm.value.quantity
})

const requiredMargin = computed(() => {
  return contractValue.value * marginRate.value
})

// 风险提示
const riskWarning = computed(() => {
  const requiredFunds = isFutures.value ? requiredMargin.value : estimatedTotal.value
  const fundsType = isFutures.value ? '保证金' : '资金'

  if (availableFunds.value < requiredFunds) {
    return `⚠️ ${fundsType}不足！所需${fundsType}: ¥${formatMoney(requiredFunds)}, 可用资金: ¥${formatMoney(availableFunds.value)}`
  }
  return ''
})

// Price limit warning (±10% for stocks)
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

// 获取价格精度
const getPricePrecision = () => {
  return tradeMode.value === 'stock' ? 2 : 1
}

// 获取最小变动价位
const getMinPriceTick = () => {
  return tradeMode.value === 'stock' ? 0.01 : 0.2
}

// 获取最小数量
const getMinQuantity = () => {
  return isFutures.value ? 1 : 100
}

// 获取数量步进
const getQuantityStep = () => {
  return isFutures.value ? 1 : 100
}

// 调整价格
const adjustPrice = (direction) => {
  const tick = getMinPriceTick()
  orderForm.value.price = parseFloat((orderForm.value.price + direction * tick).toFixed(getPricePrecision()))
}

// 设置价格
const setPrice = (type) => {
  if (type === 'bid1') orderForm.value.price = marketData.value.bid1
  else if (type === 'ask1') orderForm.value.price = marketData.value.ask1
  else if (type === 'last') orderForm.value.price = marketData.value.last
}

// 设置数量（按仓位比例）
const setQuantity = (ratio) => {
  let maxQuantity
  if (isFutures.value) {
    maxQuantity = Math.floor(availableFunds.value / (orderForm.value.price * contractMultiplier.value * marginRate.value))
  } else {
    maxQuantity = Math.floor(availableFunds.value / orderForm.value.price / 100) * 100
  }
  orderForm.value.quantity = Math.floor(maxQuantity * ratio)
  if (!isFutures.value) {
    orderForm.value.quantity = Math.floor(orderForm.value.quantity / 100) * 100
  }
}

// 提交订单
const submitOrder = async (direction, offset) => {
  // 验证
  if (riskWarning.value) {
    ElMessage.error(riskWarning.value)
    return
  }

  if (orderForm.value.quantity <= 0) {
    ElMessage.error('请输入有效的数量')
    return
  }

  if (orderForm.value.orderType === 'limit' && orderForm.value.price <= 0) {
    ElMessage.error('请输入有效的价格')
    return
  }

  // Enforce ±10% price limit for stocks
  if (orderForm.value.orderType === 'limit' && !isFutures.value && props.currentPrice > 0) {
    const upper = props.currentPrice * 1.10
    const lower = props.currentPrice * 0.90
    if (orderForm.value.price > upper || orderForm.value.price < lower) {
      ElMessage.error(`委托价格超出涨跌停限制 (¥${lower.toFixed(2)} - ¥${upper.toFixed(2)})`)
      return
    }
  }

  submitting.value = true
  try {
    const tradeData = {
      symbol: instrumentInfo.value.code,
      side: direction,
      offset: offset,
      quantity: orderForm.value.quantity,
      price: orderForm.value.orderType === 'market' ? marketData.value.last : orderForm.value.price,
      orderType: orderForm.value.orderType,
      tradeMode: tradeMode.value,
      type: 'paper',
      timeInForce: orderForm.value.timeInForce,
      stopLoss: orderForm.value.enableStopLoss ? orderForm.value.stopLossPrice : null,
      takeProfit: orderForm.value.enableTakeProfit ? orderForm.value.takeProfitPrice : null
    }

    console.log('📝 提交订单:', tradeData)

    const response = await request.post('/trades', tradeData)

    if (response.success) {
      const actionText = isFutures.value 
        ? `${offset === 'open' ? '开' : '平'}${direction === 'buy' ? '多' : '空'}`
        : (direction === 'buy' ? '买入' : '卖出')
      
      ElMessage.success(`${actionText}成功`)
      emit('order-submitted', response.data)
      
      // 重置数量
      orderForm.value.quantity = getMinQuantity()
    } else {
      throw new Error(response.message || '下单失败')
    }
  } catch (error) {
    console.error('❌ 下单失败:', error)
    ElMessage.error(`下单失败: ${error.message}`)
  } finally {
    submitting.value = false
  }
}

// 格式化函数
const formatPrice = (price) => {
  if (!price) return '-'
  return price.toFixed(getPricePrecision())
}

const formatMoney = (amount) => {
  if (!amount) return '0.00'
  return amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const formatNumber = (num) => {
  if (!num) return '-'
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// 监听模式变化
watch(tradeMode, (newMode) => {
  emit('mode-changed', newMode)
  // 重置表单
  orderForm.value.quantity = getMinQuantity()
  orderForm.value.offset = 'open'
})

// 监听价格变化
watch(() => props.currentPrice, (newPrice) => {
  instrumentInfo.value.currentPrice = newPrice
  marketData.value.last = newPrice
  marketData.value.bid1 = newPrice - getMinPriceTick()
  marketData.value.ask1 = newPrice + getMinPriceTick()
  if (orderForm.value.orderType === 'market') {
    orderForm.value.price = newPrice
  }
})
</script>

<style scoped>
.enhanced-trading-panel {
  background: #1a1a1a;
  border-radius: 8px;
  padding: 16px;
  color: #e0e0e0;
}

.section-label {
  font-size: 14px;
  font-weight: 600;
  color: #ccc;
  margin-bottom: 8px;
}

.unit {
  font-size: 12px;
  color: #888;
  font-weight: normal;
}

.price-section,
.direction-section,
.quantity-section {
  margin-bottom: 20px;
}

.offset-selector {
  margin-bottom: 16px;
}

.price-input-group {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}

.order-type-switch {
  margin-bottom: 8px;
}

.quick-price-buttons {
  display: flex;
  gap: 8px;
}

.quick-price-buttons .el-button {
  flex: 1;
  font-size: 12px;
}

.direction-buttons {
  display: flex;
  gap: 12px;
}

.direction-btn {
  flex: 1;
  height: 50px;
  font-size: 16px;
  font-weight: 600;
}

.buy-btn {
  background: #ff4444 !important;
  border-color: #ff4444 !important;
}

.sell-btn {
  background: #00aa00 !important;
  border-color: #00aa00 !important;
}

.quick-quantity-buttons {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.quick-quantity-buttons .el-button {
  flex: 1;
  font-size: 12px;
}

.budget-section {
  background: #2a2a2a;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 16px;
}

.budget-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  font-size: 14px;
}

.budget-item .label {
  color: #888;
}

.budget-item .value {
  color: #fff;
  font-weight: 600;
}

.budget-item.highlight .label {
  color: #ffa500;
  font-weight: 600;
}

.budget-item.highlight .value {
  color: #ffa500;
  font-size: 16px;
}

.budget-item.total {
  border-top: 1px solid #444;
  margin-top: 6px;
  padding-top: 12px;
  font-size: 15px;
}

.budget-item .insufficient {
  color: #ff4444;
}

.advanced-settings {
  margin-bottom: 16px;
}

.setting-item {
  margin-bottom: 12px;
}

.setting-label {
  font-size: 13px;
  color: #ccc;
  margin-bottom: 6px;
}

.risk-warning {
  margin-top: 16px;
}

:deep(.el-radio-button__inner) {
  background: #2a2a2a;
  border-color: #444;
  color: #ccc;
}

:deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: #409eff;
  border-color: #409eff;
  color: #fff;
}

:deep(.el-input-number) {
  width: 100%;
}

:deep(.el-input-number .el-input__inner) {
  background: #2a2a2a;
  border-color: #444;
  color: #fff;
}

:deep(.el-select .el-input__inner) {
  background: #2a2a2a;
  border-color: #444;
  color: #fff;
}

:deep(.el-collapse) {
  border-color: #444;
  background: transparent;
}

:deep(.el-collapse-item__header) {
  background: #2a2a2a;
  border-color: #444;
  color: #ccc;
}

:deep(.el-collapse-item__content) {
  background: #1f1f1f;
  color: #ccc;
}
</style>
