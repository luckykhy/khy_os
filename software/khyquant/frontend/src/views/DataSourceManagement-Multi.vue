<template>
  <div class="data-source-management-multi">
    <div class="page-header">
      <h1>
        <img src="/icons/database.svg" class="header-icon" alt="数据源" />
        数据源管理中心
      </h1>
      <p class="subtitle">Manage data sources — AKShare, AData, EFinance, Enhanced Mock</p>
    </div>

    <!-- 调试日志面板 -->
    <div class="debug-log-panel">
      <div class="debug-header">
        <h3>
          <img src="/icons/debug.svg" class="debug-icon" alt="调试" />
          调试日志
        </h3>
        <button class="btn-clear-log" @click="clearLogs">清空日志</button>
      </div>
      <div class="debug-logs" ref="debugLogsRef">
        <div v-for="(log, idx) in debugLogs" :key="idx" class="log-entry" :class="log.type">
          <span class="log-time">{{ log.time }}</span>
          <span class="log-type">
            <img v-if="log.type === 'info'" src="/icons/info.svg" class="log-icon" alt="信息" />
            <img v-else-if="log.type === 'success'" src="/icons/success.svg" class="log-icon" alt="成功" />
            <img v-else-if="log.type === 'error'" src="/icons/error.svg" class="log-icon" alt="错误" />
            <img v-else-if="log.type === 'warning'" src="/icons/warning.svg" class="log-icon" alt="警告" />
            <img v-else-if="log.type === 'debug'" src="/icons/debug.svg" class="log-icon" alt="调试" />
            {{ log.typeLabel }}
          </span>
          <span class="log-message">{{ log.message }}</span>
        </div>
        <div v-if="debugLogs.length === 0" class="log-empty">
          暂无日志记录
        </div>
      </div>
    </div>

    <!-- 当前激活的数据源 -->
    <div class="active-source-banner">
      <div class="banner-content">
        <span class="banner-label">当前激活:</span>
        <div class="banner-sources">
          <template v-for="(source, index) in activeSources" :key="source.key">
            <span class="banner-source">{{ source.name }}</span>
            <span class="banner-badge" :class="source.key">{{ source.badge }}</span>
            <span v-if="index < activeSources.length - 1" class="banner-separator">→</span>
          </template>
        </div>
      </div>
    </div>

    <!-- 数据源卡片列表 -->
    <div class="sources-grid">
      <!-- AData 数据源 -->
      <div class="source-card" :class="{ active: activeSource.key === 'adata' }">
        <div class="card-header">
          <div class="source-info">
            <h3>AData</h3>
            <span class="source-desc">本地Python数据源</span>
          </div>
          <div class="source-status" :class="sources.adata.status">
            <span class="status-dot"></span>
            <span>{{ sources.adata.statusText }}</span>
          </div>
        </div>

        <div class="card-body">
          <div class="info-grid">
            <div class="info-item">
              <span class="label">市场</span>
              <span class="value">沪深A股</span>
            </div>
            <div class="info-item">
              <span class="label">类型</span>
              <span class="value">实时+K线</span>
            </div>
            <div class="info-item">
              <span class="label">费用</span>
              <span class="value">免费</span>
            </div>
            <div class="info-item">
              <span class="label">稳定性</span>
              <span class="value">⭐⭐⭐</span>
            </div>
          </div>

          <div class="card-actions">
            <button 
              class="btn-test" 
              @click="testSource('adata')"
              :disabled="sources.adata.testing"
            >
              {{ sources.adata.testing ? '测试中...' : '测试连接' }}
            </button>
            <button 
              class="btn-activate" 
              :class="{ enabled: sources.adata.enabled }"
              @click="activateSource('adata')"
            >
              <img v-if="sources.adata.enabled" src="/icons/check.svg" class="btn-icon" alt="已启用" />
              {{ sources.adata.enabled ? '已启用' : '启用' }}
            </button>
          </div>

          <!-- 测试结果 -->
          <div v-if="sources.adata.testResult" class="test-result" :class="sources.adata.testResult.success ? 'success' : 'error'">
            <div class="result-header">
              <span class="result-status">
                <img v-if="sources.adata.testResult.success" src="/icons/success.svg" class="status-icon" alt="成功" />
                <img v-else src="/icons/error.svg" class="status-icon" alt="失败" />
                {{ sources.adata.testResult.success ? '测试成功' : '测试失败' }}
              </span>
              <span v-if="sources.adata.testResult.success" class="result-time">
                {{ sources.adata.testResult.responseTime }}ms
              </span>
            </div>
            <!-- 预定义数据警告 -->
            <div v-if="sources.adata.testResult.success && sources.adata.testResult.isPredefined" class="predefined-warning">
              <img src="/icons/warning.svg" class="warning-icon" alt="警告" />
              使用预定义数据（API暂时不可用）
            </div>
            <div v-if="sources.adata.testResult.success && sources.adata.testResult.samples" class="result-samples">
              <div v-for="(sample, idx) in sources.adata.testResult.samples.slice(0, 2)" :key="idx" class="sample">
                <div class="sample-info">
                  <span class="sample-name">{{ sample.name }}</span>
                  <span class="sample-price">¥{{ sample.price }}</span>
                  <span class="sample-change" :class="parseFloat(sample.change) >= 0 ? 'up' : 'down'">
                    {{ parseFloat(sample.change) >= 0 ? '+' : '' }}{{ sample.change }}%
                  </span>
                  <!-- 预定义数据标记 -->
                  <span v-if="sample.isPredefined" class="predefined-badge">模拟</span>
                </div>
                <!-- 每个样本的跳转按钮 - 使用symbol字段 -->
                <button class="btn-goto-trading-mini" @click="gotoTrading(sample.symbol)" title="前往交易">
                  <img src="/icons/chart-up.svg" class="chart-icon" alt="交易" />
                </button>
              </div>
            </div>
            <div v-else-if="!sources.adata.testResult.success" class="result-error">
              {{ sources.adata.testResult.error }}
            </div>
          </div>
        </div>
      </div>

      <!-- AKShare 数据源 -->
      <div class="source-card" :class="{ active: activeSource.key === 'akshare' }">
        <div class="card-header">
          <div class="source-info">
            <h3>AKShare</h3>
            <span class="source-desc">开源金融数据接口</span>
          </div>
          <div class="source-status" :class="sources.akshare.status">
            <span class="status-dot"></span>
            <span>{{ sources.akshare.statusText }}</span>
          </div>
        </div>

        <div class="card-body">
          <div class="info-grid">
            <div class="info-item">
              <span class="label">市场</span>
              <span class="value">全市场</span>
            </div>
            <div class="info-item">
              <span class="label">类型</span>
              <span class="value">实时+历史</span>
            </div>
            <div class="info-item">
              <span class="label">费用</span>
              <span class="value">完全免费</span>
            </div>
            <div class="info-item">
              <span class="label">稳定性</span>
              <span class="value">⭐⭐⭐⭐</span>
            </div>
          </div>

          <div class="card-actions">
            <button 
              class="btn-test" 
              @click="testSource('akshare')"
              :disabled="sources.akshare.testing"
            >
              {{ sources.akshare.testing ? '测试中...' : '测试连接' }}
            </button>
            <button 
              class="btn-activate" 
              :class="{ enabled: sources.akshare.enabled }"
              @click="activateSource('akshare')"
            >
              <img v-if="sources.akshare.enabled" src="/icons/check.svg" class="btn-icon" alt="已启用" />
              {{ sources.akshare.enabled ? '已启用' : '启用' }}
            </button>
          </div>

          <!-- 测试结果 -->
          <div v-if="sources.akshare.testResult" class="test-result" :class="sources.akshare.testResult.success ? 'success' : 'error'">
            <div class="result-header">
              <span class="result-status">
                <img v-if="sources.akshare.testResult.success" src="/icons/success.svg" class="status-icon" alt="成功" />
                <img v-else src="/icons/error.svg" class="status-icon" alt="失败" />
                {{ sources.akshare.testResult.success ? '测试成功' : '测试失败' }}
              </span>
              <span v-if="sources.akshare.testResult.success" class="result-time">
                {{ sources.akshare.testResult.responseTime }}ms
              </span>
            </div>
            <!-- 预定义数据警告 -->
            <div v-if="sources.akshare.testResult.success && sources.akshare.testResult.isPredefined" class="predefined-warning">
              <img src="/icons/warning.svg" class="warning-icon" alt="警告" />
              使用预定义数据（API暂时不可用）
            </div>
            <div v-if="sources.akshare.testResult.success && sources.akshare.testResult.samples" class="result-samples">
              <div v-for="(sample, idx) in sources.akshare.testResult.samples.slice(0, 2)" :key="idx" class="sample">
                <div class="sample-info">
                  <span class="sample-name">{{ sample.name }}</span>
                  <span class="sample-price">¥{{ sample.price }}</span>
                  <span class="sample-change" :class="parseFloat(sample.change) >= 0 ? 'up' : 'down'">
                    {{ parseFloat(sample.change) >= 0 ? '+' : '' }}{{ sample.change }}%
                  </span>
                  <!-- 预定义数据标记 -->
                  <span v-if="sample.isPredefined" class="predefined-badge">模拟</span>
                </div>
                <!-- 每个样本的跳转按钮 - 使用symbol字段 -->
                <button class="btn-goto-trading-mini" @click="gotoTrading(sample.symbol)" title="前往交易">
                  <img src="/icons/chart-up.svg" class="chart-icon" alt="交易" />
                </button>
              </div>
            </div>
            <div v-else-if="!sources.akshare.testResult.success" class="result-error">
              {{ sources.akshare.testResult.error }}
            </div>
          </div>
        </div>
      </div>

      <!-- EFinance 数据源 -->
      <div class="source-card" :class="{ active: activeSource.key === 'efinance' }">
        <div class="card-header">
          <div class="source-info">
            <h3>EFinance</h3>
            <span class="source-desc">东方财富数据接口</span>
          </div>
          <div class="source-status" :class="sources.efinance.status">
            <span class="status-dot"></span>
            <span>{{ sources.efinance.statusText }}</span>
          </div>
        </div>

        <div class="card-body">
          <div class="info-grid">
            <div class="info-item">
              <span class="label">市场</span>
              <span class="value">沪深A股</span>
            </div>
            <div class="info-item">
              <span class="label">类型</span>
              <span class="value">实时+K线</span>
            </div>
            <div class="info-item">
              <span class="label">费用</span>
              <span class="value">免费</span>
            </div>
            <div class="info-item">
              <span class="label">稳定性</span>
              <span class="value">⭐⭐⭐⭐⭐</span>
            </div>
          </div>

          <div class="card-actions">
            <button 
              class="btn-test" 
              @click="testSource('efinance')"
              :disabled="sources.efinance.testing"
            >
              {{ sources.efinance.testing ? '测试中...' : '测试连接' }}
            </button>
            <button 
              class="btn-activate" 
              :class="{ enabled: sources.efinance.enabled }"
              @click="activateSource('efinance')"
            >
              <img v-if="sources.efinance.enabled" src="/icons/check.svg" class="btn-icon" alt="已启用" />
              {{ sources.efinance.enabled ? '已启用' : '启用' }}
            </button>
          </div>

          <!-- 测试结果 -->
          <div v-if="sources.efinance.testResult" class="test-result" :class="sources.efinance.testResult.success ? 'success' : 'error'">
            <div class="result-header">
              <span class="result-status">
                <img v-if="sources.efinance.testResult.success" src="/icons/success.svg" class="status-icon" alt="成功" />
                <img v-else src="/icons/error.svg" class="status-icon" alt="失败" />
                {{ sources.efinance.testResult.success ? '测试成功' : '测试失败' }}
              </span>
              <span v-if="sources.efinance.testResult.success" class="result-time">
                {{ sources.efinance.testResult.responseTime }}ms
              </span>
            </div>
            <!-- 预定义数据警告 -->
            <div v-if="sources.efinance.testResult.success && sources.efinance.testResult.isPredefined" class="predefined-warning">
              <img src="/icons/warning.svg" class="warning-icon" alt="警告" />
              使用预定义数据（API暂时不可用）
            </div>
            <div v-if="sources.efinance.testResult.success && sources.efinance.testResult.samples" class="result-samples">
              <div v-for="(sample, idx) in sources.efinance.testResult.samples.slice(0, 2)" :key="idx" class="sample">
                <div class="sample-info">
                  <span class="sample-name">{{ sample.name }}</span>
                  <span class="sample-price">¥{{ sample.price }}</span>
                  <span class="sample-change" :class="parseFloat(sample.change) >= 0 ? 'up' : 'down'">
                    {{ parseFloat(sample.change) >= 0 ? '+' : '' }}{{ sample.change }}%
                  </span>
                  <!-- 预定义数据标记 -->
                  <span v-if="sample.isPredefined" class="predefined-badge">模拟</span>
                </div>
                <!-- 每个样本的跳转按钮 - 使用symbol字段 -->
                <button class="btn-goto-trading-mini" @click="gotoTrading(sample.symbol)" title="前往交易">
                  <img src="/icons/chart-up.svg" class="chart-icon" alt="交易" />
                </button>
              </div>
            </div>
            <div v-else-if="!sources.efinance.testResult.success" class="result-error">
              {{ sources.efinance.testResult.error }}
            </div>
          </div>
        </div>
      </div>

      <!-- 增强模拟数据源 -->
      <div class="source-card" :class="{ active: activeSource.key === 'mock' }">
        <div class="card-header">
          <div class="source-info">
            <h3>增强模拟数据</h3>
            <span class="source-desc">智能混合策略：历史真实数据 + 模拟补充</span>
          </div>
          <div class="source-status" :class="sources.mock.status">
            <span class="status-dot"></span>
            <span>{{ sources.mock.statusText }}</span>
          </div>
        </div>

        <div class="card-body">
          <div class="info-grid">
            <div class="info-item">
              <span class="label">市场</span>
              <span class="value">全市场</span>
            </div>
            <div class="info-item">
              <span class="label">类型</span>
              <span class="value">混合数据</span>
            </div>
            <div class="info-item">
              <span class="label">费用</span>
              <span class="value">免费</span>
            </div>
            <div class="info-item">
              <span class="label">稳定性</span>
              <span class="value">⭐⭐⭐⭐⭐</span>
            </div>
          </div>

          <div class="card-actions">
            <button 
              class="btn-test" 
              @click="testSource('mock')"
              :disabled="sources.mock.testing"
            >
              {{ sources.mock.testing ? '测试中...' : '测试连接' }}
            </button>
            <button 
              class="btn-activate fallback"
              :class="{ enabled: sources.mock.enabled }"
              @click="activateSource('mock')"
            >
              <img v-if="sources.mock.enabled" src="/icons/check.svg" class="btn-icon" alt="已启用" />
              {{ sources.mock.enabled ? '兜底启用' : '启用兜底' }}
            </button>
          </div>

          <!-- 测试结果 -->
          <div v-if="sources.mock.testResult" class="test-result" :class="sources.mock.testResult.success ? 'success' : 'error'">
            <div class="result-header">
              <span class="result-status">
                <img v-if="sources.mock.testResult.success" src="/icons/success.svg" class="status-icon" alt="成功" />
                <img v-else src="/icons/error.svg" class="status-icon" alt="失败" />
                {{ sources.mock.testResult.success ? '测试成功' : '测试失败' }}
              </span>
              <span v-if="sources.mock.testResult.success" class="result-time">
                {{ sources.mock.testResult.responseTime }}ms
              </span>
            </div>
            <div v-if="sources.mock.testResult.success && sources.mock.testResult.samples" class="result-samples">
              <div v-for="(sample, idx) in sources.mock.testResult.samples.slice(0, 2)" :key="idx" class="sample">
                <div class="sample-info">
                  <span class="sample-name">{{ sample.name }}</span>
                  <span class="sample-price">¥{{ sample.price }}</span>
                  <span class="sample-change" :class="parseFloat(sample.change) >= 0 ? 'up' : 'down'">
                    {{ parseFloat(sample.change) >= 0 ? '+' : '' }}{{ sample.change }}%
                  </span>
                  <span class="predefined-badge">模拟</span>
                </div>
                <!-- 每个样本的跳转按钮 - 使用symbol字段 -->
                <button class="btn-goto-trading-mini" @click="gotoTrading(sample.symbol)" title="前往交易">
                  <img src="/icons/chart-up.svg" class="chart-icon" alt="交易" />
                </button>
              </div>
            </div>
            <div v-else-if="!sources.mock.testResult.success" class="result-error">
              {{ sources.mock.testResult.error }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 使用说明 -->
    <div class="usage-guide">
      <h3>
        <img src="/icons/book.svg" class="guide-icon" alt="使用说明" />
        使用说明
      </h3>
      <div class="guide-content">
        <div class="guide-section">
          <h4>数据源对比</h4>
          <ul>
            <li><strong>AKShare</strong>: Free, most comprehensive, recommended primary source</li>
            <li><strong>AData</strong>: Local Python library, good for offline use</li>
            <li><strong>EFinance</strong>: Eastmoney data interface, stable and reliable</li>
            <li><strong>Enhanced Mock</strong>: High-quality simulated data, 100% available, ideal for testing</li>
          </ul>
        </div>
        <div class="guide-section">
          <h4>如何切换</h4>
          <ol>
            <li>点击"测试连接"按钮验证数据源是否可用</li>
            <li>测试成功后，点击"激活"按钮切换到该数据源</li>
            <li>系统会自动使用激活的数据源获取行情数据</li>
          </ol>
        </div>
        <div class="guide-section">
          <h4>源码集成优势</h4>
          <ul>
            <li class="advantage-item">
              <img src="/icons/success.svg" class="advantage-icon" alt="优势" />
              开箱即用，无需安装Python包
            </li>
            <li class="advantage-item">
              <img src="/icons/success.svg" class="advantage-icon" alt="优势" />
              跨电脑部署，复制即可使用
            </li>
            <li class="advantage-item">
              <img src="/icons/success.svg" class="advantage-icon" alt="优势" />
              版本锁定，避免兼容性问题
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>

</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import request from '@/utils/request'
import { ElMessage } from 'element-plus'

const ACTIVE_SOURCE_KEYS = ['akshare', 'adata', 'efinance', 'mock']

// 🔥 调试日志
const debugLogs = ref([])
const debugLogsRef = ref(null)

// 添加日志函数
const addLog = (type, message) => {
  const now = new Date()
  const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`
  
  const typeLabels = {
    info: '信息',
    success: '成功',
    error: '错误',
    warning: '警告',
    debug: '调试'
  }
  
  debugLogs.value.push({
    time,
    type,
    typeLabel: typeLabels[type] || type,
    message
  })
  
  // 限制日志数量
  if (debugLogs.value.length > 100) {
    debugLogs.value.shift()
  }
  
  // 自动滚动到底部
  nextTick(() => {
    if (debugLogsRef.value) {
      debugLogsRef.value.scrollTop = debugLogsRef.value.scrollHeight
    }
  })
  
  // 同时输出到控制台
  console.log(`[${time}] [${typeLabels[type]}] ${message}`)
}

// 清空日志
const clearLogs = () => {
  debugLogs.value = []
  addLog('info', '日志已清空')
}

// 数据源配置
const sources = ref({
  akshare: {
    key: 'akshare',
    name: 'AKShare',
    status: 'success',
    statusText: '正常',
    testing: false,
    testResult: null,
    enabled: true
  },
  adata: {
    key: 'adata',
    name: 'AData',
    status: 'success',
    statusText: '正常',
    testing: false,
    testResult: null,
    enabled: true
  },
  efinance: {
    key: 'efinance',
    name: 'EFinance',
    status: 'success',
    statusText: '正常',
    testing: false,
    testResult: null,
    enabled: true
  },
  mock: {
    key: 'mock',
    name: '增强模拟数据',
    status: 'success',
    statusText: '正常',
    testing: false,
    testResult: null,
    enabled: true
  }
})

// 当前激活的数据源
const activeSource = ref({
  key: 'akshare',
  name: 'AKShare',
  badge: '主'
})

const enforceSourcePolicy = () => {
  ACTIVE_SOURCE_KEYS.forEach((key) => {
    if (sources.value[key]) {
      sources.value[key].enabled = true
      if (sources.value[key].status === 'disabled') {
        sources.value[key].status = 'success'
        sources.value[key].statusText = '正常'
      }
    }
  })

  if (!ACTIVE_SOURCE_KEYS.includes(activeSource.value.key)) {
    activeSource.value = {
      key: 'akshare',
      name: 'AKShare',
      badge: '主'
    }
  }
}

// 计算所有激活的数据源(按优先级排序)
const activeSources = computed(() => {
  const enabled = []
  
  // 按优先级顺序检查
  const priority = ['akshare', 'adata', 'efinance', 'mock']
  
  priority.forEach(key => {
    if (sources.value[key] && sources.value[key].enabled) {
      enabled.push({
        key,
        name: sources.value[key].name || key.toUpperCase(),
        badge: key === activeSource.value.key ? '主' : '备用'
      })
    }
  })
  
  // 如果没有启用的,返回当前激活的
  if (enabled.length === 0) {
    return [activeSource.value]
  }
  
  return enabled
})

// 从后端加载数据源状态
onMounted(async () => {
  enforceSourcePolicy()
  addLog('info', '🚀 页面加载,开始初始化数据源状态')
  
  // 1. 从localStorage加载激活的数据源
  const saved = localStorage.getItem('activeDataSource')
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      activeSource.value = parsed
      addLog('info', `📦 从localStorage加载激活数据源: ${parsed.name}`)
    } catch (e) {
      addLog('error', `localStorage解析失败: ${e.message}`)
    }
  } else {
    addLog('warning', 'localStorage中没有保存的数据源配置')
  }
  
  // 2. 从后端加载真实的启用状态
  try {
    addLog('info', '🌐 开始从后端加载数据源状态...')
    const response = await request.get('/comprehensive-data/sources/enabled')
    
    addLog('debug', `后端响应: ${JSON.stringify(response, null, 2)}`)
    
    if (response.success && response.data.sources) {
      addLog('success', `✅ 成功获取 ${response.data.sources.length} 个数据源配置`)
      
      // 更新所有数据源的启用状态
      response.data.sources.forEach(source => {
        if (sources.value[source.key] && ACTIVE_SOURCE_KEYS.includes(source.key)) {
          sources.value[source.key].enabled = source.enabled
          addLog('info', `  - ${source.name}: ${source.enabled ? '✅ 已启用' : '❌ 已禁用'}`)
        }
      })
      
      // 更新当前激活的数据源
      if (response.data.currentLocked && ACTIVE_SOURCE_KEYS.includes(response.data.currentLocked.key)) {
        activeSource.value = {
          key: response.data.currentLocked.key,
          name: response.data.currentLocked.name,
          badge: '当前'
        }
        addLog('success', `🔒 当前锁定数据源: ${response.data.currentLocked.name}`)
      } else {
        // 使用第一个启用的数据源
        const firstEnabled = response.data.sources.find(s => s.enabled && ACTIVE_SOURCE_KEYS.includes(s.key))
        if (firstEnabled) {
          activeSource.value = {
            key: firstEnabled.key,
            name: firstEnabled.name,
            badge: '默认'
          }
          addLog('success', `📌 设置默认数据源: ${firstEnabled.name}`)
        } else {
          addLog('warning', '⚠️ 没有找到已启用的数据源')
        }
      }
    } else {
      addLog('error', '❌ 后端响应格式错误或没有数据源')
    }
  } catch (error) {
    addLog('error', `❌ 加载数据源状态失败: ${error.message}`)
    addLog('debug', `错误详情: ${JSON.stringify(error.response?.data || error)}`)
  }

  enforceSourcePolicy()
  
  addLog('info', '✨ 数据源初始化完成')
})

// 测试数据源
const testSource = async (sourceKey) => {
  if (!ACTIVE_SOURCE_KEYS.includes(sourceKey)) {
    ElMessage.warning('该数据源已停用')
    return
  }

  const source = sources.value[sourceKey]
  
  addLog('info', `🧪 开始测试数据源: ${source.name}`)
  
  source.testing = true
  source.testResult = null
  source.status = 'testing'
  source.statusText = '测试中...'
  
  try {
    const startTime = Date.now()
    addLog('debug', `发送测试请求: GET /comprehensive-data/test-source/${sourceKey}`)
    
    const response = await request.get(`/comprehensive-data/test-source/${sourceKey}`)
    const responseTime = Date.now() - startTime
    
    addLog('debug', `收到响应 (${responseTime}ms): ${JSON.stringify(response, null, 2)}`)
    
    if (response.success) {
      source.status = 'success'
      source.statusText = '正常'
      source.testResult = {
        success: true,
        responseTime: response.responseTime || responseTime,
        dataCount: response.dataCount || response.samples?.length || 0,
        samples: response.samples || [],
        isPredefined: response.isPredefined || false
      }
      
      addLog('success', `✅ ${source.name} 测试成功`)
      addLog('info', `  - 响应时间: ${source.testResult.responseTime}ms`)
      addLog('info', `  - 数据条数: ${source.testResult.dataCount}`)
      addLog('info', `  - 是否预定义: ${source.testResult.isPredefined ? '是' : '否'}`)
      
      if (source.testResult.samples.length > 0) {
        addLog('info', `  - 样本数据:`)
        source.testResult.samples.slice(0, 3).forEach(s => {
          addLog('info', `    * ${s.name} (${s.symbol}): ¥${s.price} ${s.change}%`)
        })
      }
      
      ElMessage.success(`${source.name} 测试成功`)
    } else {
      source.status = 'error'
      source.statusText = '失败'
      source.testResult = {
        success: false,
        error: response.error || response.message || '测试失败'
      }
      
      addLog('error', `❌ ${source.name} 测试失败: ${source.testResult.error}`)
      ElMessage.error(`${source.name} 测试失败`)
    }
  } catch (error) {
    source.status = 'error'
    source.statusText = '错误'
    source.testResult = {
      success: false,
      error: error.response?.data?.error || error.message || '网络请求失败'
    }
    
    addLog('error', `❌ ${source.name} 测试异常: ${source.testResult.error}`)
    addLog('debug', `异常详情: ${JSON.stringify(error.response?.data || error)}`)
    
    ElMessage.error(`${source.name} 测试失败`)
  } finally {
    source.testing = false
    addLog('info', `🏁 ${source.name} 测试结束`)
  }
}

// 激活数据源（多选模式）
const activateSource = async (sourceKey) => {
  if (!ACTIVE_SOURCE_KEYS.includes(sourceKey)) {
    ElMessage.warning('该数据源已停用')
    return
  }

  const source = sources.value[sourceKey]
  const currentEnabled = source.enabled || false
  const newEnabled = !currentEnabled
  
  const action = newEnabled ? '启用' : '禁用'
  addLog('info', `⚙️ ${action}数据源: ${source.name}`)
  addLog('debug', `当前状态: ${currentEnabled ? '已启用' : '已禁用'} -> 目标状态: ${newEnabled ? '启用' : '禁用'}`)
  
  try {
    addLog('debug', `发送配置请求: POST /comprehensive-data/sources/config`)
    addLog('debug', `请求参数: { sourceKey: "${sourceKey}", enabled: ${newEnabled} }`)
    
    const response = await request.post('/comprehensive-data/sources/config', {
      sourceKey,
      enabled: newEnabled
    })
    
    addLog('debug', `收到响应: ${JSON.stringify(response, null, 2)}`)
    
    if (response.success) {
      addLog('success', `✅ 后端配置更新成功`)
      
      // 🔥 更新所有数据源的启用状态
      if (response.data && response.data.allSources) {
        addLog('info', '📊 更新所有数据源状态:')
        response.data.allSources.forEach(s => {
          if (sources.value[s.key]) {
            sources.value[s.key].enabled = s.enabled
            addLog('info', `  - ${s.name}: ${s.enabled ? '✅ 已启用' : '❌ 已禁用'}`)
          }
        })
      }
      
      // 🔥 更新当前激活的主数据源（优先级最高的启用数据源）
      const enabledSources = response.data.allSources
        .filter(s => s.enabled && ACTIVE_SOURCE_KEYS.includes(s.key) && s.key !== 'mock')
        .sort((a, b) => a.priority - b.priority)
      
      if (enabledSources.length > 0) {
        const primary = enabledSources[0]
        const badgeMap = {
          akshare: '推荐',
          adata: '默认',
          efinance: '备用',
          mock: '增强'
        }
        
        activeSource.value = {
          key: primary.key,
          name: primary.name,
          badge: badgeMap[primary.key] || '主要'
        }
        
        localStorage.setItem('activeDataSource', JSON.stringify(activeSource.value))
        addLog('success', `🎯 主数据源更新为: ${primary.name}`)
      } else {
        addLog('warning', '⚠️ 没有真实数据源启用,将使用增强模拟数据')
      }
      
      addLog('success', `✅ 已${action} ${source.name} 数据源`)
      ElMessage.success(`已${action} ${source.name} 数据源`)
    } else {
      addLog('error', `❌ 更新数据源配置失败: ${response.message || '未知错误'}`)
      ElMessage.error('更新数据源配置失败')
    }
  } catch (error) {
    addLog('error', `❌ 更新数据源配置异常: ${error.message}`)
    addLog('debug', `异常详情: ${JSON.stringify(error.response?.data || error)}`)
    ElMessage.error('更新数据源配置失败')
  }

  enforceSourcePolicy()
}

// 🔥 前往交易页面
const gotoTrading = (symbol) => {
  console.log('🔍 跳转到交易页面')
  console.log('   symbol参数:', symbol)
  console.log('   symbol类型:', typeof symbol)
  console.log('   symbol长度:', symbol?.length)
  
  if (!symbol) {
    ElMessage.error('标的代码为空,无法跳转')
    return
  }
  
  const url = `/trading?symbol=${encodeURIComponent(symbol)}`
  console.log('   跳转URL:', url)
  
  // 使用Vue Router跳转到交易页面,并传递标的代码
  window.location.href = url
  ElMessage.success(`正在跳转到 ${symbol} 交易页面...`)
}


</script>

<style scoped>
.data-source-management-multi {
  padding: var(--content-padding);
  width: 100%;
}

/* 🔥 调试日志面板样式 */
.debug-log-panel {
  background: #1e1e1e;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 24px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.debug-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.debug-header h3 {
  color: #ffffff;
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.debug-icon {
  width: 16px;
  height: 16px;
  color: #4fc3f7;
}

.btn-clear-log {
  padding: 6px 12px;
  background: #3a3a3a;
  color: #ffffff;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-clear-log:hover {
  background: #4a4a4a;
}

.debug-logs {
  background: #0d0d0d;
  border-radius: 4px;
  padding: 12px;
  max-height: 300px;
  overflow-y: auto;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.debug-logs::-webkit-scrollbar {
  width: 8px;
}

.debug-logs::-webkit-scrollbar-track {
  background: #1e1e1e;
  border-radius: 4px;
}

.debug-logs::-webkit-scrollbar-thumb {
  background: #4a4a4a;
  border-radius: 4px;
}

.debug-logs::-webkit-scrollbar-thumb:hover {
  background: #5a5a5a;
}

.log-entry {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px solid #2a2a2a;
}

.log-entry:last-child {
  border-bottom: none;
}

.log-time {
  color: #888888;
  flex-shrink: 0;
  width: 90px;
}

.log-type {
  flex-shrink: 0;
  width: 80px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
}

.log-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.log-message {
  color: #d4d4d4;
  flex: 1;
  word-break: break-word;
}

.log-entry.info .log-type {
  color: #4fc3f7;
}

.log-entry.success .log-type {
  color: #66bb6a;
}

.log-entry.error .log-type {
  color: #ef5350;
}

.log-entry.warning .log-type {
  color: #ffa726;
}

.log-entry.debug .log-type {
  color: #ab47bc;
}

.log-empty {
  color: #666666;
  text-align: center;
  padding: 20px;
  font-style: italic;
}

.page-header {
  margin-bottom: 24px;
}

.page-header h1 {
  font-size: 24px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 8px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-icon {
  width: 24px;
  height: 24px;
  color: #667eea;
}

.subtitle {
  color: #6b7280;
  font-size: 14px;
  margin: 0;
}

.active-source-banner {
  background: linear-gradient(135deg, #8B4513 0%, #A0522D 50%, #CD853F 100%);
  border-radius: var(--radius-md);
  padding: 20px 24px;
  margin-bottom: 24px;
  box-shadow: 0 4px 6px rgba(139, 69, 19, 0.2);
}

.banner-content {
  display: flex;
  align-items: center;
  gap: 12px;
  color: white;
}

.banner-sources {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.banner-separator {
  font-size: 16px;
  opacity: 0.7;
  margin: 0 4px;
}

.banner-label {
  font-size: 14px;
  opacity: 0.9;
}

.banner-source {
  font-size: 20px;
  font-weight: 600;
}

.banner-badge {
  padding: 4px 12px;
  border-radius: var(--radius-md);
  font-size: 12px;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.2);
}

.sources-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
  gap: 24px;
  margin-bottom: 32px;
}

.source-card {
  background: white;
  border-radius: var(--radius-md);
  border: 2px solid #e5e7eb;
  overflow: hidden;
  transition: all 0.3s ease;
}

.source-card:hover {
  border-color: #9ca3af;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
}

.source-card.active {
  border-color: #e5e7eb;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.05);
}

/* 🪵 增强模拟数据源 - 木纹色样式 (已移除,使用统一样式) */
/*
.source-card-mock {
  background: linear-gradient(135deg, 
    #D2691E 0%,
    #CD853F 20%,
    #8B4513 40%,
    #A0522D 60%,
    #CD853F 80%,
    #D2691E 100%
  );
  border-color: #8B4513;
}

.source-card-mock:hover {
  border-color: #654321;
  box-shadow: 0 8px 16px rgba(139, 69, 19, 0.25);
}

.source-card-mock.active {
  border-color: #654321;
  box-shadow: 0 8px 16px rgba(139, 69, 19, 0.35);
}

.source-card-mock .card-header {
  background: linear-gradient(to right, 
    rgba(210, 105, 30, 0.2),
    rgba(205, 133, 63, 0.15),
    rgba(210, 105, 30, 0.2)
  );
  border-bottom-color: rgba(139, 69, 19, 0.3);
}

.source-card-mock .card-body {
  background: linear-gradient(to bottom,
    rgba(245, 222, 179, 0.15),
    rgba(222, 184, 135, 0.1)
  );
}

.source-card-mock .source-info h3 {
  color: #3E2723;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.3);
}

.source-card-mock .source-desc {
  color: #5D4037;
}

.source-card-mock .info-item .label {
  color: #6D4C41;
}

.source-card-mock .info-item .value {
  color: #3E2723;
  font-weight: 600;
}
*/

.card-header {
  padding: 20px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.source-info h3 {
  font-size: 20px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 4px 0;
}

.source-desc {
  font-size: 13px;
  color: #6b7280;
}

.source-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9ca3af;
}

.source-status.success .status-dot {
  background: #10b981;
}

.source-status.error .status-dot {
  background: #ef4444;
}

.source-status.testing .status-dot {
  background: #f59e0b;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.card-body {
  padding: 20px;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-item .label {
  font-size: 12px;
  color: #6b7280;
}

.info-item .value {
  font-size: 14px;
  font-weight: 500;
  color: #1f2937;
}

.card-actions {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.btn-test, .btn-activate {
  flex: 1;
  padding: 10px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
}

.btn-test {
  background: #f3f4f6;
  color: #374151;
}

.btn-test:hover:not(:disabled) {
  background: #e5e7eb;
}

.btn-activate {
  background: #667eea;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.btn-activate:hover:not(:disabled) {
  background: #5568d3;
}

.btn-icon {
  width: 16px;
  height: 16px;
  filter: brightness(0) invert(1);
}

.btn-test:disabled, .btn-activate:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.test-result {
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
}

.test-result.success {
  background: #f0fdf4;
  border: 1px solid #86efac;
}

.test-result.error {
  background: #fef2f2;
  border: 1px solid #fca5a5;
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-weight: 500;
}

.result-status {
  display: flex;
  align-items: center;
  gap: 6px;
}

.status-icon {
  width: 16px;
  height: 16px;
}

.result-time {
  color: #6b7280;
  font-size: 12px;
}

.result-samples {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sample {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  background: white;
  border-radius: 4px;
  gap: 8px;
}

.sample-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.sample-name {
  font-weight: 500;
  color: #374151;
}

.sample-price {
  color: #6b7280;
}

.sample-change {
  font-weight: 500;
}

.sample-change.up {
  color: #ef4444;
}

.sample-change.down {
  color: #10b981;
}

/* 迷你跳转按钮样式 */
.btn-goto-trading-mini {
  padding: 4px 8px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 28px;
  flex-shrink: 0;
}

.btn-goto-trading-mini:hover {
  transform: scale(1.1);
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.4);
}

.btn-goto-trading-mini:active {
  transform: scale(0.95);
}

.chart-icon {
  width: 16px;
  height: 16px;
  filter: brightness(0) invert(1);
}

/* 预定义数据警告样式 */
.predefined-warning {
  background: #fef3c7;
  color: #92400e;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  margin: 8px 0;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #fbbf24;
}

.warning-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* 预定义数据标记样式 */
.predefined-badge {
  background: #fbbf24;
  color: #78350f;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  margin-left: 8px;
}

.result-error {
  color: #dc2626;
}

.usage-guide {
  background: white;
  border-radius: var(--radius-md);
  padding: 24px;
  border: 1px solid #e5e7eb;
}

.usage-guide h3 {
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 16px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.guide-icon {
  width: 20px;
  height: 20px;
  color: #667eea;
}

.guide-content {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 24px;
}

.guide-section h4 {
  font-size: 14px;
  font-weight: 600;
  color: #374151;
  margin: 0 0 12px 0;
}

.guide-section ul, .guide-section ol {
  margin: 0;
  padding-left: 20px;
  color: #6b7280;
  font-size: 13px;
  line-height: 1.8;
}

.advantage-item {
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  margin-left: -20px;
}

.advantage-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.guide-section pre {
  background: #f3f4f6;
  padding: 12px;
  border-radius: 6px;
  font-size: 13px;
  color: #374151;
  margin: 0;
  overflow-x: auto;
}

</style>
