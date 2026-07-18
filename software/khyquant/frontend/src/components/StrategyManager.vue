<template>
  <div class="strategy-manager">
    <div class="manager-header">
      <h3>策略管理</h3>
      <div class="header-actions">
        <el-button type="primary" size="small" @click="showCreateDialog = true">
          <el-icon><Plus /></el-icon>
          创建策略
        </el-button>
        <el-button size="small" @click="navigateToStrategies">
          <el-icon><Setting /></el-icon>
          高级管理
        </el-button>
      </div>
    </div>

    <!-- 策略列表 -->
    <div class="strategy-list" v-loading="strategyStore.loading">
      <div v-if="strategyStore.strategies.length === 0" class="empty-state">
        <el-empty description="暂无策略" />
      </div>
      <div v-else>
        <div 
          v-for="strategy in strategyStore.strategies" 
          :key="strategy.id"
          class="strategy-item"
          :class="{ 
            active: strategy.status === 'active',
            selected: strategyStore.selectedStrategy?.id === strategy.id
          }"
          @click="selectStrategy(strategy)"
        >
          <div class="strategy-info">
            <div class="strategy-name">
              {{ strategy.name }}
              <el-tag v-if="strategy.status === 'active'" type="success" size="small">运行中</el-tag>
            </div>
            <div class="strategy-details">
              <span class="detail-item">{{ getInstrumentTypeLabel(strategy.type) }}</span>
              <span class="detail-item">{{ strategy.language || 'JavaScript' }}</span>
              <span class="detail-item">{{ formatDate(strategy.createdAt) }}</span>
            </div>
            <div class="strategy-stats" v-if="getStrategyStats(strategy.id)">
              <span class="stat-item">
                收益: 
                <span :class="getProfitClass(getStrategyStats(strategy.id).totalReturn)">
                  {{ getStrategyStats(strategy.id).totalReturn }}%
                </span>
              </span>
              <span class="stat-item">胜率: {{ getStrategyStats(strategy.id).winRate }}%</span>
              <span class="stat-item">交易: {{ getStrategyStats(strategy.id).totalTrades }}次</span>
            </div>
          </div>
          <div class="strategy-actions" @click.stop>
            <el-button 
              :type="strategy.status === 'active' ? 'danger' : 'success'"
              size="small"
              @click="toggleStrategy(strategy)"
            >
              {{ strategy.status === 'active' ? '停止' : '启动' }}
            </el-button>
            <el-button 
              size="small" 
              type="primary"
              @click="loadToTrading(strategy)"
              :disabled="loadedStrategyId === strategy.id"
              :loading="loadingStrategyId === strategy.id"
            >
              {{ loadedStrategyId === strategy.id ? '已加载到图表' : '加载到图表' }}
            </el-button>
            <el-button size="small" @click="quickBacktest(strategy)">回测</el-button>
            <el-dropdown @command="handleCommand">
              <el-button size="small">
                更多<el-icon class="el-icon--right"><arrow-down /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item :command="{action: 'edit', strategy}">编辑</el-dropdown-item>
                  <el-dropdown-item :command="{action: 'clone', strategy}">克隆</el-dropdown-item>
                  <el-dropdown-item :command="{action: 'export', strategy}">导出</el-dropdown-item>
                  <el-dropdown-item :command="{action: 'delete', strategy}" divided>删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </div>
    </div>

    <!-- 快速回测面板 -->
    <div v-if="strategyStore.selectedStrategy" class="quick-backtest-panel">
      <div class="panel-header">
        <span class="panel-title">快速回测 - {{ strategyStore.selectedStrategy.name }}</span>
        <el-button size="small" text @click="strategyStore.selectStrategy(null)">
          <el-icon><Close /></el-icon>
        </el-button>
      </div>
      <div class="backtest-form">
        <el-form :model="quickBacktestForm" size="small" label-width="80px">
          <el-form-item label="交易标的">
            <el-select 
              v-model="quickBacktestForm.symbol" 
              placeholder="选择标的"
              filterable
              style="width: 100%"
            >
              <el-option-group 
                v-for="group in groupedInstruments" 
                :key="group.label" 
                :label="group.label"
              >
                <el-option
                  v-for="instrument in group.options"
                  :key="instrument.code"
                  :label="`${instrument.name} (${instrument.code})`"
                  :value="instrument.code"
                />
              </el-option-group>
            </el-select>
          </el-form-item>
          <el-form-item label="初始资金">
            <el-input-number 
              v-model="quickBacktestForm.initialCapital" 
              :min="10000" 
              :step="10000"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item>
            <el-button 
              type="primary" 
              @click="runQuickBacktest" 
              :loading="backtesting"
              style="width: 100%"
            >
              开始回测
            </el-button>
          </el-form-item>
        </el-form>
      </div>
      
      <!-- 回测结果 -->
      <div v-if="quickBacktestResult" class="quick-result">
        <div class="result-stats">
          <div class="stat-card">
            <div class="stat-label">收益率</div>
            <div class="stat-value" :class="getProfitClass(quickBacktestResult.totalReturn)">
              {{ quickBacktestResult.totalReturn }}%
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">交易次数</div>
            <div class="stat-value">{{ quickBacktestResult.totalTrades }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">胜率</div>
            <div class="stat-value">{{ quickBacktestResult.winRate }}%</div>
          </div>
        </div>
        <el-button size="small" @click="viewDetailedBacktest" style="width: 100%; margin-top: 10px;">
          查看详细结果
        </el-button>
      </div>
    </div>

    <!-- 创建策略对话框 -->
    <el-dialog
      v-model="showCreateDialog"
      title="创建策略"
      width="600px"
      :before-close="handleCreateDialogClose"
    >
      <el-form :model="newStrategy" :rules="strategyRules" ref="strategyFormRef" label-width="100px">
        <el-form-item label="策略名称" prop="name">
          <el-input v-model="newStrategy.name" placeholder="请输入策略名称" />
        </el-form-item>
        
        <el-form-item label="策略描述">
          <el-input 
            v-model="newStrategy.description" 
            type="textarea" 
            :rows="3"
            placeholder="请输入策略描述"
          />
        </el-form-item>
        
        <!-- 智能检测结果显示 -->
        <div v-if="intelligentAnalysis" class="intelligent-analysis">
          <div class="analysis-header">
            <el-icon><MagicStick /></el-icon>
            <span>智能分析结果</span>
            <el-tag :type="getConfidenceType(intelligentAnalysis.confidence)" size="small">
              置信度: {{ (intelligentAnalysis.confidence * 100).toFixed(0) }}%
            </el-tag>
          </div>
          
          <div class="analysis-content">
            <div class="detection-item">
              <span class="label">检测语言:</span>
              <el-tag type="primary" size="small">{{ getLanguageLabel(intelligentAnalysis.detectedLanguage.language) }}</el-tag>
              <span class="confidence">({{ (intelligentAnalysis.detectedLanguage.confidence * 100).toFixed(0) }}%)</span>
            </div>
            
            <div class="detection-item">
              <span class="label">策略类型:</span>
              <el-tag type="success" size="small">{{ getStrategyTypeLabel(intelligentAnalysis.detectedType.type) }}</el-tag>
              <span class="confidence">({{ (intelligentAnalysis.detectedType.confidence * 100).toFixed(0) }}%)</span>
            </div>
            
            <div class="detection-item">
              <span class="label">复杂度:</span>
              <el-tag :type="getComplexityType(intelligentAnalysis.complexity)" size="small">
                {{ getComplexityLabel(intelligentAnalysis.complexity) }}
              </el-tag>
            </div>
            
            <div v-if="intelligentAnalysis.autoConfig.tags.length > 0" class="detection-item">
              <span class="label">特征标签:</span>
              <el-tag 
                v-for="tag in intelligentAnalysis.autoConfig.tags" 
                :key="tag" 
                size="small" 
                class="tag-item"
              >
                {{ tag }}
              </el-tag>
            </div>
          </div>
          
          <!-- 智能建议 -->
          <div v-if="intelligentAnalysis.recommendations.length > 0" class="recommendations">
            <div class="recommendations-title">智能建议:</div>
            <div 
              v-for="(rec, index) in intelligentAnalysis.recommendations" 
              :key="index"
              class="recommendation-item"
              :class="rec.type"
            >
              <el-icon v-if="rec.type === 'warning'"><Warning /></el-icon>
              <el-icon v-else-if="rec.type === 'success'"><SuccessFilled /></el-icon>
              <el-icon v-else><InfoFilled /></el-icon>
              <span>{{ rec.message }}</span>
            </div>
          </div>
          
          <!-- 应用智能配置按钮 -->
          <div class="apply-config">
            <el-button 
              type="primary" 
              size="small" 
              @click="applyIntelligentConfig"
              :disabled="!intelligentAnalysis"
            >
              <el-icon><MagicStick /></el-icon>
              应用智能配置
            </el-button>
          </div>
        </div>



        <el-form-item label="策略代码" prop="code">
          <div class="code-editor-container">
            <div class="code-editor-toolbar">
              <el-button 
                size="small" 
                type="primary" 
                @click="analyzeStrategyCode"
                :loading="analyzing"
                :disabled="!newStrategy.code.trim()"
              >
                <el-icon><MagicStick /></el-icon>
                智能分析
              </el-button>
              <el-button 
                size="small" 
                @click="clearCodeAnalysis"
                v-if="intelligentAnalysis"
              >
                清除分析
              </el-button>
            </div>
            <el-input
              v-model="newStrategy.code"
              type="textarea"
              :rows="10"
              :placeholder="getCodePlaceholder()"
              class="code-editor"
              @input="onCodeChange"
            />
          </div>
        </el-form-item>

        <el-form-item label="策略参数">
          <el-input
            v-model="parametersJson"
            type="textarea"
            :rows="3"
            placeholder='{"fastPeriod": 12, "slowPeriod": 26, "signalPeriod": 9}'
          />
        </el-form-item>

        <el-form-item label="公开策略">
          <el-switch v-model="newStrategy.isPublic" />
          <span style="margin-left: 10px; color: #999; font-size: 12px;">
            公开后其他用户可以查看和使用
          </span>
        </el-form-item>
      </el-form>

      <template #footer>
        <span class="dialog-footer">
          <el-button @click="showCreateDialog = false">取消</el-button>
          <el-button type="primary" @click="createStrategy" :loading="creating">创建</el-button>
        </span>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Setting, Close, ArrowDown, MagicStick, Warning, SuccessFilled, InfoFilled } from '@element-plus/icons-vue'
import { useStrategyStore } from '@/stores/strategyStore'
import axios from 'axios'

// 路由
const router = useRouter()

// 策略状态管理
const strategyStore = useStrategyStore()

// 响应式数据
const availableInstruments = ref([])
const showCreateDialog = ref(false)
const strategyFormRef = ref()
const creating = ref(false)
const backtesting = ref(false)
const quickBacktestResult = ref(null)
const loadedStrategyId = ref(null) // 当前加载到交易界面的策略ID
const loadingStrategyId = ref(null) // 正在加载的策略ID

// 新策略表单数据
const newStrategy = ref({
  name: '',
  description: '',
  code: '',
  type: '',
  language: '',
  parameters: {},
  isPublic: false
})

const parametersJson = ref('{}')

// 智能分析相关
const intelligentAnalysis = ref(null)
const analyzing = ref(false)
const showManualConfig = ref(false)

// 快速回测表单
const quickBacktestForm = ref({
  symbol: '',
  initialCapital: 100000
})

// 表单验证规则
const strategyRules = {
  name: [
    { required: true, message: '请输入策略名称', trigger: 'blur' }
  ],
  code: [
    { required: true, message: '请输入策略代码', trigger: 'blur' }
  ]
}

// 计算属性
const groupedInstruments = computed(() => {
  // 按类型分组
  const groups = {}
  availableInstruments.value.forEach(item => {
    const type = getInstrumentTypeLabel(item.type)
    if (!groups[type]) {
      groups[type] = []
    }
    groups[type].push(item)
  })
  
  return Object.keys(groups).map(type => ({
    label: type,
    options: groups[type]
  }))
})

// 智能分析相关方法
async function analyzeStrategyCode() {
  if (!newStrategy.value.code.trim()) {
    ElMessage.warning('请先输入策略代码')
    return
  }

  analyzing.value = true
  try {
    const response = await axios.post('/api/strategy/analyze', {
      code: newStrategy.value.code,
      name: newStrategy.value.name,
      description: newStrategy.value.description
    }, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
    })

    if (response.data.success) {
      intelligentAnalysis.value = response.data.data.analysis
      
      // 自动应用智能配置
      applyIntelligentConfig()
      
      if (intelligentAnalysis.value.confidence > 0.7) {
        ElMessage.success(`智能分析完成，检测为${getStrategyTypeLabel(intelligentAnalysis.value.detectedType.type)}`)
      } else if (intelligentAnalysis.value.confidence > 0.4) {
        ElMessage.info('智能分析完成，置信度较低，请检查代码')
      } else {
        ElMessage.warning('无法准确识别策略类型，将使用默认配置')
      }
    } else {
      throw new Error(response.data.message)
    }
  } catch (error) {
    console.error('智能分析失败:', error)
    // 分析失败时使用默认配置
    newStrategy.value.type = 'other'
    newStrategy.value.language = 'javascript'
    ElMessage.error('智能分析失败，已使用默认配置')
  } finally {
    analyzing.value = false
  }
}

function applyIntelligentConfig() {
  if (!intelligentAnalysis.value) return
  
  const config = intelligentAnalysis.value.autoConfig
  
  // 应用智能配置
  if (!newStrategy.value.name.trim()) {
    newStrategy.value.name = config.name
  }
  if (!newStrategy.value.description.trim()) {
    newStrategy.value.description = config.description
  }
  newStrategy.value.type = config.type
  newStrategy.value.language = config.language
  
  // 应用参数
  if (Object.keys(config.parameters).length > 0) {
    parametersJson.value = JSON.stringify(config.parameters, null, 2)
  }
  
  showManualConfig.value = false
  ElMessage.success('智能配置已应用')
}

function clearIntelligentAnalysis() {
  intelligentAnalysis.value = null
  showManualConfig.value = true
}

function clearCodeAnalysis() {
  intelligentAnalysis.value = null
  showManualConfig.value = false
}

function onCodeChange() {
  // 代码变化时自动进行智能分析
  if (newStrategy.value.code.trim().length > 50) {
    // 防抖处理，避免频繁分析
    clearTimeout(window.codeAnalysisTimer)
    window.codeAnalysisTimer = setTimeout(() => {
      analyzeStrategyCode()
    }, 1000)
  } else if (intelligentAnalysis.value) {
    // 代码太短时清除分析结果
    intelligentAnalysis.value = null
  }
}

// 智能分析辅助方法
function getConfidenceType(confidence) {
  if (confidence >= 0.8) return 'success'
  if (confidence >= 0.6) return 'warning'
  return 'danger'
}

function getLanguageLabel(language) {
  const labels = {
    javascript: 'JavaScript',
    python: 'Python'
  }
  return labels[language] || language
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

function getComplexityType(complexity) {
  const types = {
    simple: 'success',
    intermediate: 'warning',
    advanced: 'danger'
  }
  return types[complexity] || 'info'
}

function getComplexityLabel(complexity) {
  const labels = {
    simple: '简单',
    intermediate: '中等',
    advanced: '高级'
  }
  return labels[complexity] || complexity
}

// 方法
function getInstrumentTypeLabel(type) {
  const labels = {
    stock: '股票',
    index: '指数',
    futures: '期货',
    trend: '趋势',
    mean_reversion: '均值回归',
    momentum: '动量',
    arbitrage: '套利',
    market_making: '做市',
    other: '其他'
  }
  return labels[type] || type
}

function getProfitClass(profit) {
  if (profit > 0) return 'profit-positive'
  if (profit < 0) return 'profit-negative'
  return 'profit-neutral'
}

function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function getStrategyStats(strategyId) {
  return strategyStore.getBacktestResult(strategyId)
}

function selectStrategy(strategy) {
  strategyStore.selectStrategy(strategy)
  quickBacktestResult.value = strategyStore.getBacktestResult(strategy.id)
  
  // 设置默认回测参数
  if (!quickBacktestForm.value.symbol && availableInstruments.value.length > 0) {
    quickBacktestForm.value.symbol = availableInstruments.value[0].code
  }
}

// 加载策略到交易界面
async function loadToTrading(strategy) {
  try {
    console.log('🔄 开始加载策略到交易界面:', strategy.name)
    
    // 设置加载状态
    loadingStrategyId.value = strategy.id
    
    // 触发策略选择事件，Trading.vue会监听这个事件
    strategyStore.selectStrategy(strategy)
    strategyStore.emit('strategySelected', strategy)
    
    // 等待一小段时间确保事件处理完成
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // 更新加载状态
    loadedStrategyId.value = strategy.id
    
    ElMessage.success({
      message: `策略 "${strategy.name}" 已加载到右侧K线图`,
      duration: 3000,
      showClose: true
    })
    
    console.log('✅ 策略加载完成:', strategy.name)
    
  } catch (error) {
    console.error('❌ 加载策略到交易界面失败:', error)
    ElMessage.error('加载策略失败: ' + error.message)
  } finally {
    loadingStrategyId.value = null
  }
}

async function toggleStrategy(strategy) {
  try {
    if (strategy.status === 'active') {
      await strategyStore.stopStrategy(strategy.id)
    } else {
      await strategyStore.startStrategy(strategy.id)
    }
  } catch (error) {
    console.error('切换策略状态失败:', error)
  }
}

function quickBacktest(strategy) {
  strategyStore.selectStrategy(strategy)
  quickBacktestResult.value = strategyStore.getBacktestResult(strategy.id)
}

async function runQuickBacktest() {
  if (!quickBacktestForm.value.symbol) {
    ElMessage.warning('请选择交易标的')
    return
  }

  backtesting.value = true
  try {
    const result = await strategyStore.runBacktest(
      strategyStore.selectedStrategy.id,
      quickBacktestForm.value
    )
    quickBacktestResult.value = result
  } catch (error) {
    console.error('快速回测失败:', error)
  } finally {
    backtesting.value = false
  }
}

function viewDetailedBacktest() {
  // 跳转到策略管理页面的详细回测
  router.push({
    name: 'Strategies',
    query: {
      action: 'backtest',
      strategyId: strategyStore.selectedStrategy.id,
      symbol: quickBacktestForm.value.symbol
    }
  })
}

function navigateToStrategies() {
  router.push({ name: 'Strategies' })
}

function handleCommand({ action, strategy }) {
  switch (action) {
    case 'edit':
      router.push({
        name: 'Strategies',
        query: { action: 'edit', strategyId: strategy.id }
      })
      break
    case 'clone':
      cloneStrategy(strategy)
      break
    case 'export':
      exportStrategy(strategy)
      break
    case 'delete':
      deleteStrategy(strategy)
      break
  }
}

async function cloneStrategy(strategy) {
  try {
    const clonedStrategy = {
      ...strategy,
      name: strategy.name + ' (副本)',
      id: undefined,
      createdAt: undefined,
      updatedAt: undefined
    }
    
    await strategyStore.createStrategy(clonedStrategy)
  } catch (error) {
    console.error('克隆策略失败:', error)
  }
}

function exportStrategy(strategy) {
  const dataStr = JSON.stringify(strategy, null, 2)
  const dataBlob = new Blob([dataStr], { type: 'application/json' })
  const url = URL.createObjectURL(dataBlob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${strategy.name}.json`
  link.click()
  URL.revokeObjectURL(url)
  ElMessage.success('策略导出成功')
}

async function deleteStrategy(strategy) {
  try {
    await ElMessageBox.confirm(
      `确定要删除策略 "${strategy.name}" 吗？`,
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    await strategyStore.deleteStrategy(strategy.id)
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除策略失败:', error)
    }
  }
}

async function createStrategy() {
  try {
    // 如果没有进行智能分析，先自动分析
    if (!intelligentAnalysis.value && newStrategy.value.code.trim()) {
      await analyzeStrategyCode()
    }
    
    // 如果仍然没有类型和语言，使用默认值
    if (!newStrategy.value.type) {
      newStrategy.value.type = 'other'
    }
    if (!newStrategy.value.language) {
      newStrategy.value.language = 'javascript'
    }
    
    await strategyFormRef.value.validate()
    
    // 解析参数
    try {
      newStrategy.value.parameters = JSON.parse(parametersJson.value || '{}')
    } catch (error) {
      ElMessage.error('策略参数格式错误，请输入有效的JSON')
      return
    }
    
    creating.value = true
    await strategyStore.createStrategy(newStrategy.value)
    
    showCreateDialog.value = false
    resetForm()
  } catch (error) {
    console.error('创建策略失败:', error)
  } finally {
    creating.value = false
  }
}

function handleCreateDialogClose() {
  showCreateDialog.value = false
  resetForm()
}

function resetForm() {
  newStrategy.value = {
    name: '',
    description: '',
    code: '',
    type: '',
    language: '',
    parameters: {},
    isPublic: false
  }
  parametersJson.value = '{}'
  intelligentAnalysis.value = null
  showManualConfig.value = false
}

function getCodePlaceholder() {
  return `// 请输入策略代码，系统将自动检测语言和策略类型
// JavaScript策略示例:
function strategy(data, params) {
  const signals = [];
  
  for (let i = 1; i < data.length; i++) {
    // 简单的价格突破策略
    if (data[i].close > data[i-1].close * 1.02) {
      signals.push({
        type: 'buy',
        index: i,
        price: data[i].close,
        reason: '价格突破'
      });
    } else if (data[i].close < data[i-1].close * 0.98) {
      signals.push({
        type: 'sell',
        index: i,
        price: data[i].close,
        reason: '价格下跌'
      });
    } else {
      signals.push({type: 'hold', index: i});
    }
  }
  
  return signals;
}

# Python策略示例:
def strategy(data, params):
    signals = []
    for i in range(1, len(data)):
        if data[i]['close'] > data[i-1]['close'] * 1.02:
            signals.append({
                'type': 'buy',
                'index': i,
                'price': data[i]['close'],
                'reason': '价格突破'
            })
        elif data[i]['close'] < data[i-1]['close'] * 0.98:
            signals.append({
                'type': 'sell',
                'index': i,
                'price': data[i]['close'],
                'reason': '价格下跌'
            })
        else:
            signals.append({'type': 'hold', 'index': i})
    return signals`
}

async function loadAvailableInstruments() {
  try {
    const token = localStorage.getItem('token')
    if (!token) return

    const response = await axios.get('/api/watchlist/available', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 100 }
    })

    if (response.data.success) {
      availableInstruments.value = response.data.data.instruments
      
      // 设置默认选择
      if (availableInstruments.value.length > 0) {
        quickBacktestForm.value.symbol = availableInstruments.value[0].code
      }
    }
  } catch (error) {
    console.error('加载可用工具失败:', error)
  }
}

// 事件监听器
const eventListeners = []

onMounted(async () => {
  // 加载数据
  await Promise.all([
    strategyStore.loadStrategies(),
    loadAvailableInstruments()
  ])
  
  // 监听策略事件
  const onStrategyCreated = (strategy) => {
    console.log('📢 策略创建事件:', strategy.name)
  }
  
  const onStrategyUpdated = (strategy) => {
    console.log('📢 策略更新事件:', strategy.name)
  }
  
  const onStrategyDeleted = (strategy) => {
    console.log('📢 策略删除事件:', strategy.name)
    // 如果删除的是当前加载的策略，清除加载状态
    if (loadedStrategyId.value === strategy.id) {
      loadedStrategyId.value = null
    }
  }
  
  const onBacktestCompleted = ({ strategy, result }) => {
    console.log('📢 回测完成事件:', strategy.name, result)
    if (strategyStore.selectedStrategy?.id === strategy.id) {
      quickBacktestResult.value = result
    }
  }
  
  // 监听策略卸载事件
  const onStrategyUnloaded = () => {
    loadedStrategyId.value = null
  }
  
  // 注册事件监听器
  strategyStore.on('strategyCreated', onStrategyCreated)
  strategyStore.on('strategyUpdated', onStrategyUpdated)
  strategyStore.on('strategyDeleted', onStrategyDeleted)
  strategyStore.on('backtestCompleted', onBacktestCompleted)
  strategyStore.on('strategyUnloaded', onStrategyUnloaded)
  
  // 保存监听器引用以便清理
  eventListeners.push(
    { event: 'strategyCreated', callback: onStrategyCreated },
    { event: 'strategyUpdated', callback: onStrategyUpdated },
    { event: 'strategyDeleted', callback: onStrategyDeleted },
    { event: 'backtestCompleted', callback: onBacktestCompleted },
    { event: 'strategyUnloaded', callback: onStrategyUnloaded }
  )
})

onUnmounted(() => {
  // 清理事件监听器
  eventListeners.forEach(({ event, callback }) => {
    strategyStore.off(event, callback)
  })
})
</script>

<style scoped>
.strategy-manager {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #111;
  color: #fff;
}

.manager-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px;
  border-bottom: 1px solid #333;
}

.manager-header h3 {
  margin: 0;
  color: #fff;
  font-size: 16px;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.strategy-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}

.strategy-item {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 15px;
  margin-bottom: 10px;
  transition: all 0.3s ease;
  cursor: pointer;
}

.strategy-item:hover {
  border-color: #555;
  background: #222;
}

.strategy-item.active {
  border-color: #00aa00;
  background: rgba(0, 170, 0, 0.1);
}

.strategy-item.selected {
  border-color: #00aaff;
  background: rgba(0, 170, 255, 0.1);
}

.strategy-info {
  margin-bottom: 10px;
}

.strategy-name {
  font-size: 14px;
  font-weight: bold;
  color: #fff;
  margin-bottom: 5px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.strategy-details {
  display: flex;
  gap: 15px;
  margin-bottom: 8px;
}

.detail-item {
  font-size: 12px;
  color: #888;
}

.strategy-stats {
  display: flex;
  gap: 20px;
}

.stat-item {
  font-size: 12px;
  color: #ccc;
}

.profit-positive {
  color: #ff4444;
}

.profit-negative {
  color: #00aa00;
}

.profit-neutral {
  color: #ccc;
}

.strategy-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

/* 快速回测面板 */
.quick-backtest-panel {
  border-top: 1px solid #333;
  background: #1a1a1a;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 15px;
  border-bottom: 1px solid #333;
  background: #222;
}

.panel-title {
  font-size: 14px;
  font-weight: bold;
  color: #00aaff;
}

.backtest-form {
  padding: 15px;
}

.quick-result {
  padding: 15px;
  border-top: 1px solid #333;
}

.result-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 10px;
}

.stat-card {
  background: #222;
  padding: 10px;
  border-radius: 4px;
  text-align: center;
}

.stat-label {
  font-size: 12px;
  color: #888;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 16px;
  font-weight: bold;
  color: #fff;
}

.stat-value.profit-positive {
  color: #ff4444;
}

.stat-value.profit-negative {
  color: #00aa00;
}

/* 智能分析样式 */
.intelligent-analysis {
  background: rgba(0, 170, 255, 0.1);
  border: 1px solid #00aaff;
  border-radius: 6px;
  padding: 15px;
  margin-bottom: 15px;
}

.analysis-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-weight: bold;
  color: #00aaff;
}

.analysis-content {
  margin-bottom: 12px;
}

.detection-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
}

.detection-item .label {
  color: #ccc;
  min-width: 80px;
}

.detection-item .confidence {
  color: #888;
  font-size: 12px;
}

.tag-item {
  margin-right: 4px;
}

.recommendations {
  margin-bottom: 12px;
}

.recommendations-title {
  font-size: 13px;
  font-weight: bold;
  color: #00aaff;
  margin-bottom: 8px;
}

.recommendation-item {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
}

.recommendation-item.warning {
  background: rgba(255, 193, 7, 0.1);
  color: #ffc107;
}

.recommendation-item.success {
  background: rgba(40, 167, 69, 0.1);
  color: #28a745;
}

.recommendation-item.info {
  background: rgba(23, 162, 184, 0.1);
  color: #17a2b8;
}

.apply-config {
  display: flex;
  gap: 8px;
}

.code-editor-container {
  width: 100%;
}

.code-editor-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  justify-content: flex-end;
}

.manual-config {
  border-top: 1px solid #333;
  padding-top: 15px;
  margin-top: 10px;
  display: none; /* 隐藏手动配置选项 */
}

/* 创建对话框样式 */
.code-editor :deep(textarea) {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  background: #1a1a1a;
  color: #fff;
  border: 1px solid #444;
}

.instrument-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.instrument-name {
  font-weight: bold;
}

.instrument-code {
  color: #2962FF;
  font-family: 'Consolas', 'Monaco', monospace;
}

.instrument-sector {
  color: #888;
  font-size: 12px;
}

/* Element Plus 样式覆盖 */
:deep(.el-dialog) {
  background: #1a1a1a;
  border: 1px solid #333;
}

:deep(.el-dialog__header) {
  background: #222;
  border-bottom: 1px solid #333;
}

:deep(.el-dialog__title) {
  color: #fff;
}

:deep(.el-dialog__body) {
  background: #1a1a1a;
  color: #fff;
}

:deep(.el-form-item__label) {
  color: #ccc;
}

:deep(.el-input__wrapper) {
  background: #222;
  border-color: #444;
}

:deep(.el-input__inner) {
  color: #fff;
}

:deep(.el-select .el-input__wrapper) {
  background: #222;
  border-color: #444;
}

:deep(.el-input-number .el-input__wrapper) {
  background: #222;
  border-color: #444;
}

:deep(.el-textarea__inner) {
  background: #222;
  border-color: #444;
  color: #fff;
}

:deep(.el-button) {
  background: #333;
  border-color: #555;
  color: #ccc;
}

:deep(.el-button:hover) {
  background: #555;
  border-color: #777;
}

:deep(.el-button--primary) {
  background: #00aaff;
  border-color: #00aaff;
}

:deep(.el-button--success) {
  background: #00aa00;
  border-color: #00aa00;
}

:deep(.el-button--danger) {
  background: #ff4444;
  border-color: #ff4444;
}

:deep(.el-empty) {
  color: #888;
}

:deep(.el-tag) {
  background: rgba(0, 170, 0, 0.2);
  border-color: #00aa00;
  color: #00aa00;
}

:deep(.el-tag--success) {
  background: rgba(0, 170, 0, 0.2);
  border-color: #00aa00;
  color: #00aa00;
}

:deep(.el-switch.is-checked .el-switch__core) {
  background-color: #00aaff;
  border-color: #00aaff;
}

/* 滚动条样式 */
::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-track {
  background: #1a1a1a;
}

::-webkit-scrollbar-thumb {
  background: #555;
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: #777;
}
</style>