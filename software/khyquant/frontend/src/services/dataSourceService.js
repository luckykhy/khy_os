/**
 * 数据源状态管理服务
 * 用于在不同组件间共享和同步数据源状态
 */
import { ref, reactive, computed } from 'vue'
import request from '@/utils/request'

// 全局数据源状态
const dataSourceState = reactive({
  // 当前数据源
  currentSource: {
    key: 'akshare',
    name: 'AKShare',
    status: 'connected',
    successRate: 95,
    responseTime: 50,
    language: 'Python',
    lastUpdate: new Date()
  },
  
  // 数据质量
  dataQuality: 'high',  // high=真实数据, cached=缓存数据, simulated=模拟数据
  
  // 连接状态
  connectionStatus: 'connected',
  
  // 可用数据源列表
  availableSources: [
    {
      key: 'adata',
      name: 'AData',
      status: 'connected',
      successRate: 90,
      statusClass: 'source-connected',
      description: 'AData Python finance library — comprehensive A-share data',
      enabled: true
    },
    {
      key: 'akshare',
      name: 'AKShare',
      status: 'connected',
      successRate: 95,
      statusClass: 'source-connected',
      description: 'AKShare Python金融数据库 - 提供完整的中国股票、指数、期货真实数据',
      enabled: true
    },
    {
      key: 'efinance',
      name: 'EFinance',
      status: 'connected',
      successRate: 90,
      statusClass: 'source-connected',
      description: 'EFinance - Eastmoney data interface',
      enabled: true
    },
    {
      key: 'mock',
      name: '增强模拟数据',
      status: 'connected',
      successRate: 100,
      statusClass: 'source-connected',
      description: '基于真实市场规律的高质量模拟数据',
      enabled: true
    }
  ],
  
  // 最后更新时间
  lastUpdate: new Date(),
  
  // 是否正在加载
  loading: false,
  
  // 错误信息
  error: null
})

// 事件监听器
const eventListeners = new Map()

/**
 * 数据源服务类
 */
class DataSourceService {
  constructor() {
    this.state = dataSourceState
    this.refreshInterval = null
    this.startAutoRefresh()
  }

  /**
   * 获取当前数据源状态
   */
  getCurrentSource() {
    return this.state.currentSource
  }

  /**
   * 获取所有可用数据源
   */
  getAvailableSources() {
    return this.state.availableSources
  }

  /**
   * 获取数据质量
   */
  getDataQuality() {
    return this.state.dataQuality
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus() {
    return this.state.connectionStatus
  }

  /**
   * 切换数据源
   */
  async switchDataSource(sourceKey) {
    const source = this.state.availableSources.find(s => s.key === sourceKey)
    
    if (!source) {
      throw new Error(`数据源 ${sourceKey} 不存在`)
    }

    if (!source.enabled || source.status === 'disconnected') {
      throw new Error(`数据源 ${source.name} 当前不可用`)
    }

    this.state.loading = true
    this.state.error = null

    try {
      // 更新当前数据源
      this.state.currentSource = {
        key: sourceKey,
        name: source.name,
        status: source.status,
        successRate: source.successRate,
        responseTime: Math.floor(Math.random() * 200) + 50,
        language: 'JavaScript',
        lastUpdate: new Date()
      }

      this.state.connectionStatus = source.status
      this.state.lastUpdate = new Date()

      // 触发数据源变更事件
      this.emit('source-changed', {
        source: sourceKey,
        name: source.name,
        previousSource: this.state.currentSource.key
      })

      return this.state.currentSource

    } catch (error) {
      this.state.error = error.message
      throw error
    } finally {
      this.state.loading = false
    }
  }

  /**
   * 更新数据源信息
   */
  updateSourceInfo(sourceData) {
    if (sourceData.source) {
      const sourceMap = {
        'AKShare': 'akshare',
        'AData': 'adata',
        '增强模拟数据': 'mock',
        '模拟数据': 'mock',
        'enhanced_mock': 'mock',
        'mock': 'mock',
        'akshare': 'akshare',
        'adata': 'adata',
        'efinance': 'efinance',
        'EFinance': 'efinance'
      }

      // 精确匹配优先，否则用前缀匹配（兼容 'AKShare每日数据'、'AKShare缓存数据' 等变体）
      let sourceKey = sourceMap[sourceData.source]
      if (!sourceKey) {
        const src = sourceData.source.toLowerCase()
        if (src.startsWith('akshare')) sourceKey = 'akshare'
        else if (src.startsWith('adata')) sourceKey = 'adata'
        else if (src.startsWith('efinance')) sourceKey = 'efinance'
        else sourceKey = 'mock'
      }
      const sourceInfo = this.state.availableSources.find(s => s.key === sourceKey)

      // 将后端原始 key 映射为友好显示名称
      const displayNameMap = {
        'enhanced_mock': '增强模拟数据',
        'mock': '模拟数据',
        'adata': 'AData',
        'akshare': 'AKShare',
        'efinance': 'EFinance',
        'futures-tick': '期货Tick数据'
      }
      const displayName = displayNameMap[sourceData.source] || sourceData.source

      if (sourceInfo) {
        this.state.currentSource = {
          key: sourceKey,
          name: displayName,
          status: 'connected',
          successRate: sourceInfo.successRate,
          responseTime: Math.floor(Math.random() * 200) + 50,
          language: sourceData.currentStage?.language || 'Python',
          lastUpdate: new Date()
        }
      }
    }

    // 🔥 修复：映射后端返回的dataQuality到前端支持的值
    const qualityMap = {
      'high': 'high',                           // 真实API数据
      'medium': 'high',                         // 中等质量真实数据
      'low': 'high',                            // 低质量真实数据
      'cached': 'cached',                       // 数据库缓存
      'cached_incremental': 'cached',           // 增量缓存
      'cached_stale': 'cached',                 // 过期缓存
      'simulated': 'simulated',                 // 基础模拟
      'enhanced_simulation': 'simulated',       // 增强模拟
      'basic_simulation': 'simulated',          // 基础模拟
      'enhanced_hybrid_complete': 'simulated',  // 混合数据(含模拟)
      'mixed': 'simulated'                      // 混合数据
    }
    
    this.state.dataQuality = qualityMap[sourceData.dataQuality] || 'simulated'
    
    // 🔥 修复：所有启用的数据源都显示为connected，数据质量通过标签区分
    this.state.connectionStatus = 'connected'
    this.state.lastUpdate = new Date()

    // 触发数据更新事件
    this.emit('data-updated', sourceData)
  }

  /**
   * 刷新数据源状态
   */
  async refreshSourceStatus() {
    try {
      this.state.loading = true
      this.state.error = null

      const response = await request.get('/comprehensive/sources/status')
      
      if (response.data.success) {
        const statusData = response.data.data

        // 更新数据源状态
        this.state.availableSources.forEach(source => {
          const serverStatus = statusData.sources[source.key]
          if (serverStatus) {
            source.successRate = serverStatus.successRate || 0
            source.enabled = serverStatus.enabled || false
            source.status = serverStatus.enabled ? 'connected' : 'disconnected'
            source.statusClass = source.status === 'connected' ? 'source-connected' : 'source-disconnected'
          }
        })

        this.state.lastUpdate = new Date()

        // 触发状态刷新事件
        this.emit('status-refreshed', statusData)
      }

    } catch (error) {
      this.state.error = error.message
      console.error('刷新数据源状态失败:', error)
    } finally {
      this.state.loading = false
    }
  }

  /**
   * 开始自动刷新
   */
  startAutoRefresh(interval = 30000) {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
    }

    this.refreshInterval = setInterval(() => {
      this.refreshSourceStatus()
    }, interval)
  }

  /**
   * 停止自动刷新
   */
  stopAutoRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = null
    }
  }

  /**
   * 添加事件监听器
   */
  on(event, callback) {
    if (!eventListeners.has(event)) {
      eventListeners.set(event, new Set())
    }
    eventListeners.get(event).add(callback)
  }

  /**
   * 移除事件监听器
   */
  off(event, callback) {
    if (eventListeners.has(event)) {
      eventListeners.get(event).delete(callback)
    }
  }

  /**
   * 触发事件
   */
  emit(event, data) {
    if (eventListeners.has(event)) {
      eventListeners.get(event).forEach(callback => {
        try {
          callback(data)
        } catch (error) {
          console.error(`事件监听器执行失败 (${event}):`, error)
        }
      })
    }
  }

  /**
   * 获取状态的响应式引用
   */
  useDataSourceState() {
    return {
      currentSource: computed(() => this.state.currentSource),
      availableSources: computed(() => this.state.availableSources),
      dataQuality: computed(() => this.state.dataQuality),
      connectionStatus: computed(() => this.state.connectionStatus),
      lastUpdate: computed(() => this.state.lastUpdate),
      loading: computed(() => this.state.loading),
      error: computed(() => this.state.error)
    }
  }

  /**
   * 销毁服务
   */
  destroy() {
    this.stopAutoRefresh()
    eventListeners.clear()
  }
}

// 创建单例实例
const dataSourceService = new DataSourceService()

// 导出服务实例和状态
export default dataSourceService
export { dataSourceState }

// 导出便捷的组合式API
export function useDataSource() {
  return {
    ...dataSourceService.useDataSourceState(),
    switchDataSource: dataSourceService.switchDataSource.bind(dataSourceService),
    refreshSourceStatus: dataSourceService.refreshSourceStatus.bind(dataSourceService),
    updateSourceInfo: dataSourceService.updateSourceInfo.bind(dataSourceService),
    on: dataSourceService.on.bind(dataSourceService),
    off: dataSourceService.off.bind(dataSourceService)
  }
}
