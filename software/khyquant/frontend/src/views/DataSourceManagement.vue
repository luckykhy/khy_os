<template>
  <div class="data-source-management">
    <div class="page-header">
      <h1>数据源管理</h1>
      <p class="subtitle">AData 数据源 - 专业的A股市场数据服务</p>
    </div>

    <!-- AData 数据源卡片 - 古风精简版 -->
    <div class="adata-source-card-classic">
      <div class="card-ornament top-left"></div>
      <div class="card-ornament top-right"></div>
      <div class="card-ornament bottom-left"></div>
      <div class="card-ornament bottom-right"></div>
      
      <div class="card-header-classic">
        <div class="source-title">
          <span class="title-text">AData 数据源</span>
        </div>
        <div class="status-indicator" :class="{ active: !testing }">
          <span class="status-dot"></span>
          <span class="status-text">{{ testing ? '测试中' : '运行中' }}</span>
        </div>
      </div>

      <div class="card-content-classic">
        <div class="info-row">
          <div class="info-item">
            <span class="info-label">状态</span>
            <span class="info-value success">正常</span>
          </div>
          <div class="info-item">
            <span class="info-label">市场</span>
            <span class="info-value">沪深A股</span>
          </div>
          <div class="info-item">
            <span class="info-label">类型</span>
            <span class="info-value">实时 + K线</span>
          </div>
          <div class="info-item">
            <span class="info-label">频率</span>
            <span class="info-value">实时</span>
          </div>
        </div>

        <div class="action-row">
          <button 
            class="btn-test-classic" 
            @click="testAData"
            :disabled="testing"
          >
            <span v-if="!testing">测试数据源</span>
            <span v-else>测试中...</span>
          </button>
        </div>

        <!-- 测试结果 - 精简版 -->
        <div v-if="testResult" class="test-result-classic">
          <div class="result-header-classic">
            <span class="result-title">测试结果</span>
            <span 
              class="result-badge" 
              :class="testResult.success ? 'success' : 'error'"
            >
              {{ testResult.success ? '✓ 成功' : '✗ 失败' }}
            </span>
          </div>
          
          <div v-if="testResult.success" class="result-content-classic">
            <div class="result-stats">
              <span class="stat">响应: {{ testResult.responseTime }}ms</span>
              <span class="stat-divider">|</span>
              <span class="stat">数据: {{ testResult.dataCount }}条</span>
            </div>
            
            <div v-if="testResult.samples && testResult.samples.length > 0" class="samples-classic">
              <div class="sample-header">数据样本</div>
              <div class="sample-list">
                <div v-for="(sample, idx) in testResult.samples.slice(0, 3)" :key="idx" class="sample-item">
                  <span class="sample-code">{{ sample.symbol }}</span>
                  <span class="sample-name">{{ sample.name }}</span>
                  <span class="sample-price">¥{{ sample.price }}</span>
                  <span class="sample-change" :class="parseFloat(sample.change) >= 0 ? 'up' : 'down'">
                    {{ parseFloat(sample.change) >= 0 ? '+' : '' }}{{ sample.change }}%
                  </span>
                </div>
              </div>
            </div>
          </div>
          
          <div v-else class="error-content-classic">
            <p class="error-text">{{ testResult.error }}</p>
            <p class="error-hint">请检查后端服务状态</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 使用说明 -->
    <div class="usage-info">
      <h3>📖 使用说明</h3>
      <ul>
        <li>AData 是系统默认的数据源，提供稳定的A股市场数据</li>
        <li>支持实时行情查询、历史K线数据获取</li>
        <li>数据更新频率：实时（交易时间内）</li>
        <li>如遇到数据获取问题，请点击"测试数据源"按钮进行诊断</li>
      </ul>
    </div>

    <!-- 测试日志 -->
    <div v-if="testLogs.length > 0" class="logs-section">
      <div class="logs-header">
        <h3>📝 测试日志</h3>
        <button class="btn-clear" @click="clearLogs">清除日志</button>
      </div>
      <div class="logs-container">
        <div 
          v-for="(log, index) in testLogs" 
          :key="index"
          class="log-item"
          :class="log.type"
        >
          <span class="log-time">{{ log.time }}</span>
          <span class="log-type">{{ log.typeLabel }}</span>
          <span class="log-message">{{ log.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import request from '@/utils/request'
import { ElMessage } from 'element-plus'

const testing = ref(false)
const testResult = ref(null)
const testLogs = ref([])

// 添加日志
const addLog = (message, type = 'info') => {
  const now = new Date()
  const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
  
  const typeLabels = {
    info: 'INFO',
    success: 'SUCCESS',
    error: 'ERROR',
    warning: 'WARNING'
  }
  
  testLogs.value.unshift({
    time,
    type,
    typeLabel: typeLabels[type] || 'INFO',
    message
  })
  
  // 只保留最近50条日志
  if (testLogs.value.length > 50) {
    testLogs.value = testLogs.value.slice(0, 50)
  }
}

// 清除日志
const clearLogs = () => {
  testLogs.value = []
  addLog('日志已清除', 'info')
}

// 测试 AData 数据源
const testAData = async () => {
  testing.value = true
  testResult.value = null
  
  addLog('开始测试 AData 数据源...', 'info')
  
  try {
    const startTime = Date.now()
    addLog('发送测试请求到 /api/comprehensive-data/test-source/adata', 'info')
    
    // 使用配置好的request实例，会自动添加/api前缀
    const response = await request.get('/comprehensive-data/test-source/adata')
    const responseTime = Date.now() - startTime
    
    addLog(`收到响应，耗时 ${responseTime}ms`, 'info')
    console.log('AData测试响应:', response)
    
    if (response.success) {
      // 使用返回的samples数组
      const samples = response.samples || []
      addLog(`测试成功！获取到 ${samples.length} 条数据`, 'success')
      
      testResult.value = {
        success: true,
        responseTime: response.responseTime || responseTime,
        dataCount: response.dataCount || samples.length,
        samples: samples.map(item => ({
          symbol: item.symbol || item.code || '',
          name: item.name || '未知',
          type: item.type || '未知',
          price: parseFloat(item.price || item.current || item.close || 0).toFixed(2),
          change: parseFloat(item.change || item.change_percent || 0).toFixed(2)
        }))
      }
      
      // 记录每个样本
      samples.forEach((item, idx) => {
        addLog(`样本${idx + 1}: ${item.name}(${item.symbol}) - ¥${parseFloat(item.price || 0).toFixed(2)}`, 'info')
      })
      
      ElMessage.success(`AData 数据源测试成功 - 获取${samples.length}条数据`)
    } else {
      const errorMsg = response.error || response.message || '测试失败'
      addLog(`测试失败: ${errorMsg}`, 'error')
      
      testResult.value = {
        success: false,
        error: errorMsg
      }
      ElMessage.error('AData 数据源测试失败')
    }
  } catch (error) {
    console.error('测试 AData 失败:', error)
    const errorMsg = error.response?.data?.error || error.response?.data?.message || error.message || '网络请求失败'
    
    addLog(`测试异常: ${errorMsg}`, 'error')
    
    testResult.value = {
      success: false,
      error: errorMsg
    }
    ElMessage.error('测试请求失败')
  } finally {
    testing.value = false
    addLog('测试完成', 'info')
  }
}
</script>

<style scoped>
.data-source-management {
  padding: var(--content-padding);
  width: 100%;
}

.page-header {
  margin-bottom: 32px;
}

.page-header h1 {
  font-size: 28px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 8px 0;
}

.subtitle {
  font-size: 14px;
  color: #6b7280;
  margin: 0;
}

/* AData 卡片样式 - 古风精简版 */
.adata-source-card-classic {
  position: relative;
  background: linear-gradient(135deg, 
    rgba(139, 116, 96, 0.08) 0%, 
    rgba(205, 179, 139, 0.05) 100%);
  border: 2px solid rgba(139, 116, 96, 0.3);
  border-radius: var(--radius-md);
  padding: 24px;
  margin-bottom: 24px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  backdrop-filter: blur(10px);
  max-width: 800px;
}

/* 古风装饰角 */
.card-ornament {
  position: absolute;
  width: 20px;
  height: 20px;
  border-style: solid;
  border-color: rgba(139, 116, 96, 0.4);
}

.card-ornament.top-left {
  top: -2px;
  left: -2px;
  border-width: 2px 0 0 2px;
  border-top-left-radius: 12px;
}

.card-ornament.top-right {
  top: -2px;
  right: -2px;
  border-width: 2px 2px 0 0;
  border-top-right-radius: 12px;
}

.card-ornament.bottom-left {
  bottom: -2px;
  left: -2px;
  border-width: 0 0 2px 2px;
  border-bottom-left-radius: 12px;
}

.card-ornament.bottom-right {
  bottom: -2px;
  right: -2px;
  border-width: 0 2px 2px 0;
  border-bottom-right-radius: 12px;
}

.card-header-classic {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(139, 116, 96, 0.2);
}

.source-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title-icon {
  font-size: 24px;
}

.title-text {
  font-size: 20px;
  font-weight: 600;
  color: #5a4a3a;
  font-family: 'Microsoft YaHei', 'SimSun', serif;
  letter-spacing: 2px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: rgba(139, 116, 96, 0.1);
  border: 1px solid rgba(139, 116, 96, 0.3);
  border-radius: 20px;
  font-size: 13px;
  color: #8b7460;
  font-family: 'KaiTi', 'SimSun', serif;
}

.status-indicator.active .status-dot {
  background: #7ec699;
  box-shadow: 0 0 8px rgba(126, 198, 153, 0.6);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #999;
  animation: breathe-classic 2s ease-in-out infinite;
}

@keyframes breathe-classic {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.5;
    transform: scale(0.85);
  }
}

.status-text {
  font-weight: 500;
}

.card-content-classic {
  background: rgba(255, 255, 255, 0.6);
  border-radius: 8px;
  padding: 20px;
  border: 1px solid rgba(139, 116, 96, 0.15);
}

.info-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}

.info-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid rgba(139, 116, 96, 0.15);
  border-radius: var(--radius-sm);
  transition: all 0.3s ease;
}

.info-item:hover {
  background: rgba(255, 255, 255, 0.8);
  transform: translateY(-2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.info-label {
  font-size: 12px;
  color: #8b7460;
  font-family: 'KaiTi', 'SimSun', serif;
}

.info-value {
  font-size: 15px;
  font-weight: 600;
  color: #5a4a3a;
  font-family: 'Microsoft YaHei', serif;
}

.info-value.success {
  color: #7ec699;
}

.action-row {
  display: flex;
  justify-content: center;
  margin-bottom: 20px;
}

.btn-test-classic {
  padding: 10px 32px;
  background: linear-gradient(135deg, 
    rgba(139, 116, 96, 0.9) 0%, 
    rgba(115, 95, 75, 0.9) 100%);
  color: #f5f0e8;
  border: 1px solid rgba(139, 116, 96, 0.5);
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.3s ease;
  font-family: 'Microsoft YaHei', serif;
  letter-spacing: 1px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.btn-test-classic:hover:not(:disabled) {
  background: linear-gradient(135deg, 
    rgba(139, 116, 96, 1) 0%, 
    rgba(115, 95, 75, 1) 100%);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.btn-test-classic:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 测试结果 - 古风精简版 */
.test-result-classic {
  margin-top: 20px;
  border: 1px solid rgba(139, 116, 96, 0.25);
  border-radius: 8px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.4);
}

.result-header-classic {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: rgba(139, 116, 96, 0.08);
  border-bottom: 1px solid rgba(139, 116, 96, 0.15);
}

.result-title {
  font-size: 14px;
  font-weight: 500;
  color: #5a4a3a;
  font-family: 'KaiTi', 'SimSun', serif;
}

.result-badge {
  padding: 4px 12px;
  border-radius: var(--radius-md);
  font-size: 12px;
  font-weight: 600;
  font-family: 'Microsoft YaHei', serif;
}

.result-badge.success {
  background: rgba(126, 198, 153, 0.15);
  color: #7ec699;
  border: 1px solid rgba(126, 198, 153, 0.3);
}

.result-badge.error {
  background: rgba(212, 87, 78, 0.15);
  color: #d4574e;
  border: 1px solid rgba(212, 87, 78, 0.3);
}

.result-content-classic {
  padding: 16px;
}

.result-stats {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-sm);
  margin-bottom: 16px;
}

.stat {
  font-size: 13px;
  color: #5a4a3a;
  font-family: 'Consolas', 'Monaco', monospace;
  font-weight: 500;
}

.stat-divider {
  color: rgba(139, 116, 96, 0.3);
}

.samples-classic {
  margin-top: 12px;
}

.sample-header {
  font-size: 13px;
  font-weight: 500;
  color: #8b7460;
  margin-bottom: 10px;
  font-family: 'KaiTi', 'SimSun', serif;
}

.sample-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sample-item {
  display: grid;
  grid-template-columns: 100px 1fr 80px 80px;
  gap: 12px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(139, 116, 96, 0.15);
  border-radius: var(--radius-sm);
  font-size: 13px;
  align-items: center;
  transition: all 0.2s ease;
}

.sample-item:hover {
  background: rgba(255, 255, 255, 0.9);
  transform: translateX(4px);
}

.sample-code {
  font-family: 'Consolas', 'Monaco', monospace;
  color: #8b7460;
  font-weight: 600;
}

.sample-name {
  color: #5a4a3a;
  font-weight: 500;
}

.sample-price {
  font-family: 'Consolas', 'Monaco', monospace;
  color: #5a4a3a;
  font-weight: 600;
  text-align: right;
}

.sample-change {
  font-family: 'Consolas', 'Monaco', monospace;
  font-weight: 600;
  text-align: right;
}

.sample-change.up {
  color: #d4574e;
}

.sample-change.down {
  color: #7ec699;
}

.error-content-classic {
  padding: 16px;
  text-align: center;
}

.error-text {
  color: #d4574e;
  font-size: 14px;
  margin: 0 0 8px 0;
  font-weight: 500;
}

.error-hint {
  color: #8b7460;
  font-size: 12px;
  margin: 0;
}

/* 响应式 - 古风版 */
@media (max-width: 768px) {
  .info-row {
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }

  .sample-item {
    grid-template-columns: 80px 1fr 70px 70px;
    gap: 8px;
    font-size: 12px;
  }
}

/* 使用说明 */
.usage-info {
  background: white;
  border-radius: var(--radius-md);
  padding: 24px;
  border: 1px solid #e5e7eb;
  margin-bottom: 24px;
}

.usage-info h3 {
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 16px 0;
}

.usage-info ul {
  margin: 0;
  padding-left: 20px;
}

.usage-info li {
  color: #4b5563;
  font-size: 14px;
  line-height: 1.8;
  margin-bottom: 8px;
}

/* 测试日志 */
.logs-section {
  background: white;
  border-radius: var(--radius-md);
  padding: 24px;
  border: 1px solid #e5e7eb;
}

.logs-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.logs-header h3 {
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
  margin: 0;
}

.btn-clear {
  padding: 6px 12px;
  border: 1px solid #e5e7eb;
  border-radius: var(--radius-sm);
  background: white;
  color: #6b7280;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-clear:hover {
  background: #f9fafb;
  border-color: #d1d5db;
}

.logs-container {
  background: #1f2937;
  border-radius: 8px;
  padding: 16px;
  max-height: 400px;
  overflow-y: auto;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
}

.log-item {
  padding: 8px;
  margin-bottom: 4px;
  border-radius: 4px;
  display: flex;
  gap: 12px;
  line-height: 1.5;
}

.log-item.info {
  color: #94a3b8;
}

.log-item.success {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.1);
}

.log-item.error {
  color: #f87171;
  background: rgba(248, 113, 113, 0.1);
}

.log-item.warning {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.1);
}

.log-time {
  color: #64748b;
  min-width: 70px;
  flex-shrink: 0;
}

.log-type {
  color: #a78bfa;
  min-width: 80px;
  flex-shrink: 0;
  font-weight: 600;
}

.log-message {
  flex: 1;
  word-break: break-word;
}

/* 响应式 */
@media (max-width: 768px) {
  .data-source-management {
    padding: 16px;
  }

  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }

  .card-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }

  .sample-table {
    font-size: 12px;
  }
  
  .log-item {
    flex-direction: column;
    gap: 4px;
  }
  
  .log-time,
  .log-type {
    min-width: auto;
  }
}
</style>
