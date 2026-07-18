/**
 * 策略状态管理 - 实现交易界面与策略管理页面的联动
 */
import { ref, reactive } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { getFriendlyErrorMessage } from '@/utils/errorMessage'
import { 
  getStrategies, 
  createStrategy as createStrategyApi,
  updateStrategy as updateStrategyApi,
  deleteStrategy as deleteStrategyApi,
  backtestStrategy as backtestStrategyApi
} from '@/api/strategy'

export const useStrategyStore = defineStore('strategy', () => {
  const strategyError = (error, fallback = '操作失败') => getFriendlyErrorMessage(error, fallback)

  // 状态
  const strategies = ref([])
  const activeStrategies = ref([]) // 正在运行的策略
  const selectedStrategy = ref(null) // 当前选择的策略
  const loading = ref(false)
  
  // 回测相关状态
  const backtestResults = reactive(new Map()) // 策略ID -> 回测结果
  const backtestHistory = reactive(new Map()) // 策略ID -> 历史回测记录
  
  // 实时状态
  const strategyPerformance = reactive(new Map()) // 策略ID -> 实时表现数据
  
  // 事件监听器
  const eventListeners = reactive({
    strategyCreated: [],
    strategyUpdated: [],
    strategyDeleted: [],
    strategySelected: [],
    strategyUnloaded: [],
    strategyStarted: [],
    strategyStopped: [],
    strategiesLoaded: [],
    backtestCompleted: [],
    backtestDeleted: [],
    backtestBatchDeleted: [],
    backtestCleared: [],
    performanceUpdated: [],
    strategiesSynced: []
  })

  // 加载策略列表
  async function loadStrategies(params = {}) {
    loading.value = true
    try {
      const response = await getStrategies({
        page: 1,
        pageSize: 100,
        ...params
      })
      
      if (response.success) {
        strategies.value = response.data.list
        
        // 更新活跃策略列表
        activeStrategies.value = strategies.value.filter(s => s.status === 'active')
        
        // 触发更新事件
        emit('strategiesLoaded', strategies.value)
        
        console.log('✅ 策略列表加载成功:', strategies.value.length, '个策略')
        return response.data
      } else {
        throw new Error(response.message)
      }
    } catch (error) {
      console.error('❌ 加载策略列表失败:', error)
      ElMessage.error('加载策略列表失败: ' + strategyError(error, '加载策略列表失败'))
      throw error
    } finally {
      loading.value = false
    }
  }

  // 创建策略
  async function createStrategy(strategyData) {
    try {
      const response = await createStrategyApi(strategyData)
      
      if (response.success) {
        const newStrategy = response.data
        strategies.value.push(newStrategy)
        
        // 触发创建事件
        emit('strategyCreated', newStrategy)
        
        ElMessage.success('策略创建成功')
        console.log('✅ 策略创建成功:', newStrategy.name)
        return newStrategy
      } else {
        throw new Error(response.message)
      }
    } catch (error) {
      console.error('❌ 创建策略失败:', error)
      ElMessage.error('创建策略失败: ' + strategyError(error, '创建策略失败'))
      throw error
    }
  }

  // 更新策略
  async function updateStrategy(strategyId, strategyData) {
    try {
      const response = await updateStrategyApi(strategyId, strategyData)
      
      if (response.success) {
        const updatedStrategy = response.data
        const index = strategies.value.findIndex(s => s.id === strategyId)
        
        if (index !== -1) {
          strategies.value[index] = updatedStrategy
        }
        
        // 更新选中的策略
        if (selectedStrategy.value?.id === strategyId) {
          selectedStrategy.value = updatedStrategy
        }
        
        // 触发更新事件
        emit('strategyUpdated', updatedStrategy)
        
        ElMessage.success('策略更新成功')
        console.log('✅ 策略更新成功:', updatedStrategy.name)
        return updatedStrategy
      } else {
        throw new Error(response.message)
      }
    } catch (error) {
      console.error('❌ 更新策略失败:', error)
      ElMessage.error('更新策略失败: ' + strategyError(error, '更新策略失败'))
      throw error
    }
  }

  // 删除策略
  async function deleteStrategy(strategyId) {
    try {
      const response = await deleteStrategyApi(strategyId)
      
      if (response.success) {
        const deletedStrategy = strategies.value.find(s => s.id === strategyId)
        strategies.value = strategies.value.filter(s => s.id !== strategyId)
        activeStrategies.value = activeStrategies.value.filter(s => s.id !== strategyId)
        
        // 清理相关数据
        backtestResults.delete(strategyId)
        backtestHistory.delete(strategyId)
        strategyPerformance.delete(strategyId)
        
        // 如果删除的是当前选中的策略，清空选择
        if (selectedStrategy.value?.id === strategyId) {
          selectedStrategy.value = null
        }
        
        // 触发删除事件
        emit('strategyDeleted', deletedStrategy)
        
        ElMessage.success('策略删除成功')
        console.log('✅ 策略删除成功:', deletedStrategy?.name)
        return true
      } else {
        throw new Error(response.message)
      }
    } catch (error) {
      console.error('❌ 删除策略失败:', error)
      ElMessage.error('删除策略失败: ' + strategyError(error, '删除策略失败'))
      throw error
    }
  }

  // 启动策略
  async function startStrategy(strategyId) {
    try {
      const strategy = strategies.value.find(s => s.id === strategyId)
      if (!strategy) {
        throw new Error('策略不存在')
      }

      // 更新策略状态
      strategy.status = 'active'
      
      // 添加到活跃策略列表
      if (!activeStrategies.value.find(s => s.id === strategyId)) {
        activeStrategies.value.push(strategy)
      }
      
      // 触发启动事件
      emit('strategyStarted', strategy)
      
      ElMessage.success(`策略 "${strategy.name}" 已启动`)
      console.log('✅ 策略启动成功:', strategy.name)
      return strategy
    } catch (error) {
      console.error('❌ 启动策略失败:', error)
      ElMessage.error('启动策略失败: ' + strategyError(error, '启动策略失败'))
      throw error
    }
  }

  // 停止策略
  async function stopStrategy(strategyId) {
    try {
      const strategy = strategies.value.find(s => s.id === strategyId)
      if (!strategy) {
        throw new Error('策略不存在')
      }

      // 更新策略状态
      strategy.status = 'paused'
      
      // 从活跃策略列表移除
      activeStrategies.value = activeStrategies.value.filter(s => s.id !== strategyId)
      
      // 触发停止事件
      emit('strategyStopped', strategy)
      
      ElMessage.success(`策略 "${strategy.name}" 已停止`)
      console.log('✅ 策略停止成功:', strategy.name)
      return strategy
    } catch (error) {
      console.error('❌ 停止策略失败:', error)
      ElMessage.error('停止策略失败: ' + strategyError(error, '停止策略失败'))
      throw error
    }
  }

  // 执行回测
  async function runBacktest(strategyId, backtestParams) {
    try {
      const strategy = strategies.value.find(s => s.id === strategyId)
      if (!strategy) {
        throw new Error('策略不存在')
      }

      console.log('🔄 开始回测策略:', strategy.name, backtestParams)
      
      const response = await backtestStrategyApi(strategyId, backtestParams)
      
      if (response.success) {
        const result = response.data
        
        // 🔥 增强回测结果，添加策略完整信息
        const enhancedResult = {
          ...result,
          id: `backtest_${strategyId}_${Date.now()}`, // 生成唯一ID
          strategyId: strategyId,
          strategyName: strategy.name,
          strategyType: strategy.type || 'trend',
          originalStrategy: {
            id: strategy.id,
            name: strategy.name,
            type: strategy.type,
            description: strategy.description,
            code: strategy.code,
            parameters: strategy.parameters
          },
          createdAt: new Date().toISOString(),
          backtestParams: backtestParams
        }
        
        // 保存回测结果到 store
        backtestResults.set(strategyId, enhancedResult)
        
        // 添加到历史记录
        if (!backtestHistory.has(strategyId)) {
          backtestHistory.set(strategyId, [])
        }
        backtestHistory.get(strategyId).unshift({
          ...enhancedResult,
          timestamp: new Date(),
          params: backtestParams
        })
        
        // 🔥 保存到 localStorage（用于持久化和跨页面共享）
        saveBacktestToLocalStorage(enhancedResult)
        
        // 触发回测完成事件
        emit('backtestCompleted', { strategy, result: enhancedResult, params: backtestParams })
        
        ElMessage.success(`策略 "${strategy.name}" 回测完成`)
        console.log('✅ 回测完成:', strategy.name, enhancedResult)
        return enhancedResult
      } else {
        throw new Error(response.message)
      }
    } catch (error) {
      console.error('❌ 回测失败:', error)
      ElMessage.error('回测失败: ' + strategyError(error, '回测失败'))
      throw error
    }
  }

  // 🔥 新增：保存回测结果到 localStorage
  function saveBacktestToLocalStorage(result) {
    try {
      const stored = JSON.parse(localStorage.getItem('backtestResults') || '[]')
      
      // 添加新结果到开头
      stored.unshift(result)
      
      // 限制最多保存100条记录
      if (stored.length > 100) {
        stored.splice(100)
      }
      
      localStorage.setItem('backtestResults', JSON.stringify(stored))
      invalidateBacktestCache()
      console.log('Backtest result saved to localStorage:', result.id)
    } catch (error) {
      console.error('❌ 保存回测结果到 localStorage 失败:', error)
    }
  }

  // 🔥 新增：从 localStorage 加载回测结果
  function loadBacktestFromLocalStorage() {
    try {
      const stored = JSON.parse(localStorage.getItem('backtestResults') || '[]')
      console.log('📂 从 localStorage 加载回测结果:', stored.length, '条')
      
      stored.forEach(result => {
        if (result.strategyId) {
          backtestResults.set(result.strategyId, result)
          
          // 添加到历史记录
          if (!backtestHistory.has(result.strategyId)) {
            backtestHistory.set(result.strategyId, [])
          }
          backtestHistory.get(result.strategyId).push(result)
        }
      })
      
      return stored
    } catch (error) {
      console.error('❌ 从 localStorage 加载回测结果失败:', error)
      return []
    }
  }

  // In-memory cache for backtest results to avoid repeated localStorage parsing
  let _backtestCache = null
  let _backtestCacheVersion = 0

  function invalidateBacktestCache() {
    _backtestCache = null
    _backtestCacheVersion++
  }

  // 🔥 新增：获取所有回测结果（合并 store 和 localStorage）
  function getAllBacktestResults() {
    if (_backtestCache) return _backtestCache
    try {
      const stored = JSON.parse(localStorage.getItem('backtestResults') || '[]')
      stored.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      _backtestCache = stored
      return stored
    } catch (error) {
      console.error('Failed to load backtest results:', error)
      return []
    }
  }

  // 🔥 新增：删除回测结果
  function deleteBacktestResult(resultId) {
    try {
      const stored = JSON.parse(localStorage.getItem('backtestResults') || '[]')
      const filtered = stored.filter(item => item.id !== resultId)
      localStorage.setItem('backtestResults', JSON.stringify(filtered))
      invalidateBacktestCache()

      console.log('Backtest result deleted:', resultId)
      emit('backtestDeleted', resultId)
      return true
    } catch (error) {
      console.error('Failed to delete backtest result:', error)
      return false
    }
  }

  // 🔥 新增：批量删除回测结果
  function batchDeleteBacktestResults(resultIds) {
    try {
      const stored = JSON.parse(localStorage.getItem('backtestResults') || '[]')
      const filtered = stored.filter(item => !resultIds.includes(item.id))
      localStorage.setItem('backtestResults', JSON.stringify(filtered))
      invalidateBacktestCache()
      
      console.log('🗑️ 批量删除回测结果:', resultIds.length, '条')
      emit('backtestBatchDeleted', resultIds)
      return true
    } catch (error) {
      console.error('❌ 批量删除回测结果失败:', error)
      return false
    }
  }

  // 🔥 新增：清空所有回测结果
  function clearAllBacktestResults() {
    try {
      localStorage.removeItem('backtestResults')
      backtestResults.clear()
      backtestHistory.clear()
      
      console.log('🗑️ 所有回测结果已清空')
      emit('backtestCleared')
      return true
    } catch (error) {
      console.error('❌ 清空回测结果失败:', error)
      return false
    }
  }

  // 选择策略
  function selectStrategy(strategy) {
    selectedStrategy.value = strategy
    console.log('📌 选择策略:', strategy?.name)
    emit('strategySelected', strategy)
  }

  // 更新策略性能数据
  function updateStrategyPerformance(strategyId, performanceData) {
    strategyPerformance.set(strategyId, {
      ...strategyPerformance.get(strategyId),
      ...performanceData,
      lastUpdate: new Date()
    })
    
    // 触发性能更新事件
    emit('performanceUpdated', { strategyId, data: performanceData })
  }

  // 获取策略
  function getStrategy(strategyId) {
    return strategies.value.find(s => s.id === strategyId)
  }

  // 获取策略回测结果
  function getBacktestResult(strategyId) {
    return backtestResults.get(strategyId)
  }

  // 获取策略回测历史
  function getBacktestHistory(strategyId) {
    return backtestHistory.get(strategyId) || []
  }

  // 获取策略性能数据
  function getStrategyPerformance(strategyId) {
    return strategyPerformance.get(strategyId)
  }

  // 事件监听
  function on(event, callback) {
    if (eventListeners[event]) {
      eventListeners[event].push(callback)
    }
  }

  // 移除事件监听
  function off(event, callback) {
    if (eventListeners[event]) {
      const index = eventListeners[event].indexOf(callback)
      if (index > -1) {
        eventListeners[event].splice(index, 1)
      }
    }
  }

  // 触发事件
  function emit(event, data) {
    if (eventListeners[event]) {
      eventListeners[event].forEach(callback => {
        try {
          callback(data)
        } catch (error) {
          console.error('事件回调执行失败:', error)
        }
      })
    }
  }

  // 清理资源
  function cleanup() {
    strategies.value = []
    activeStrategies.value = []
    selectedStrategy.value = null
    backtestResults.clear()
    backtestHistory.clear()
    strategyPerformance.clear()
    
    // 清理事件监听器
    Object.keys(eventListeners).forEach(event => {
      eventListeners[event] = []
    })
  }

  return {
    // 状态
    strategies,
    activeStrategies,
    selectedStrategy,
    loading,
    
    // 方法
    loadStrategies,
    fetchStrategies: loadStrategies, // 添加别名以兼容现有代码
    createStrategy,
    updateStrategy,
    deleteStrategy,
    startStrategy,
    stopStrategy,
    runBacktest,
    selectStrategy,
    updateStrategyPerformance,
    
    // 🔥 新增：回测结果管理
    saveBacktestToLocalStorage,
    loadBacktestFromLocalStorage,
    getAllBacktestResults,
    deleteBacktestResult,
    batchDeleteBacktestResults,
    clearAllBacktestResults,
    
    // 获取器
    getStrategy,
    getBacktestResult,
    getBacktestHistory,
    getStrategyPerformance,
    
    // 事件系统
    on,
    off,
    emit,
    cleanup
  }
})
