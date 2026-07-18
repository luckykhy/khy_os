<template>
  <div class="comprehensive-data-viewer">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <h2>综合数据源管理</h2>
          <el-button type="primary" @click="refreshStatus">
            <el-icon><Refresh /></el-icon>
            刷新状态
          </el-button>
        </div>
      </template>
      
      <div class="status-overview">
        <el-row :gutter="20">
          <el-col :span="6">
            <el-statistic title="支持的数据源" :value="dataSourceCount" />
          </el-col>
          <el-col :span="6">
            <el-statistic title="支持的标的" :value="instrumentCount" />
          </el-col>
          <el-col :span="6">
            <el-statistic title="覆盖市场" :value="marketCount" />
          </el-col>
          <el-col :span="6">
            <el-statistic title="历史数据范围" value="1990至今" />
          </el-col>
        </el-row>
      </div>
    </el-card>

    <!-- 数据源状态 -->
    <el-card class="sources-card">
      <template #header>
        <h3>数据源状态</h3>
      </template>
      
      <el-table :data="dataSourceList" style="width: 100%">
        <el-table-column prop="name" label="数据源" width="120">
          <template #default="{ row }">
            <div class="source-name">
              <el-tag :type="row.enabled ? 'success' : 'info'">
                {{ row.name }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        
        <el-table-column prop="description" label="描述" />
        
        <el-table-column prop="historicalRange" label="历史数据范围" width="150" />
        
        <el-table-column prop="updateFrequency" label="更新频率" width="100" />
        
        <el-table-column label="支持类型" width="200">
          <template #default="{ row }">
            <div class="coverage-tags">
              <el-tag v-if="row.coverage.stocks" size="small" type="primary">股票</el-tag>
              <el-tag v-if="row.coverage.indices" size="small" type="success">指数</el-tag>
              <el-tag v-if="row.coverage.futures" size="small" type="warning">期货</el-tag>
              <el-tag v-if="row.coverage.funds" size="small" type="info">基金</el-tag>
              <el-tag v-if="row.coverage.bonds" size="small">债券</el-tag>
            </div>
          </template>
        </el-table-column>
        
        <el-table-column prop="priority" label="优先级" width="80" />
        
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-switch
              v-model="row.enabled"
              @change="toggleDataSource(row)"
              :disabled="row.name === 'AKShare'"
            />
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 支持的标的 -->
    <el-card class="instruments-card">
      <template #header>
        <div class="card-header">
          <h3>支持的金融标的</h3>
          <div class="header-controls">
            <el-input
              v-model="searchQuery"
              placeholder="搜索标的..."
              style="width: 200px; margin-right: 10px;"
              @input="searchInstruments"
            >
              <template #prefix>
                <el-icon><Search /></el-icon>
              </template>
            </el-input>
            <el-select v-model="selectedCategory" placeholder="选择类别" @change="filterInstruments">
              <el-option label="全部" value="" />
              <el-option label="指数" value="indices" />
              <el-option label="蓝筹股" value="blueChips" />
              <el-option label="期货" value="futures" />
            </el-select>
          </div>
        </div>
      </template>
      
      <el-tabs v-model="activeTab" @tab-change="handleTabChange">
        <el-tab-pane label="指数" name="indices">
          <InstrumentTable :instruments="filteredInstruments.indices" type="index" />
        </el-tab-pane>
        
        <el-tab-pane label="蓝筹股" name="blueChips">
          <InstrumentTable :instruments="filteredInstruments.blueChips" type="stock" />
        </el-tab-pane>
        
        <el-tab-pane label="期货" name="futures">
          <InstrumentTable :instruments="filteredInstruments.futures" type="futures" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 市场信息 -->
    <el-card class="markets-card">
      <template #header>
        <h3>支持的市场</h3>
      </template>
      
      <el-row :gutter="20">
        <el-col :span="8" v-for="(market, code) in markets" :key="code">
          <el-card class="market-card" shadow="hover">
            <div class="market-info">
              <h4>{{ market.name }}</h4>
              <p class="market-code">{{ code }}</p>
              <div class="market-details">
                <p><strong>成立时间:</strong> {{ market.established }}</p>
                <p><strong>交易时间:</strong> {{ market.tradingHours }}</p>
                <p><strong>支持品种:</strong> 
                  <el-tag v-for="instrument in market.instruments" :key="instrument" size="small">
                    {{ getInstrumentName(instrument) }}
                  </el-tag>
                </p>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </el-card>

    <!-- 数据获取测试 -->
    <el-card class="test-card">
      <template #header>
        <h3>数据获取测试</h3>
      </template>
      
      <div class="test-controls">
        <el-row :gutter="20">
          <el-col :span="6">
            <el-input v-model="testSymbol" placeholder="输入标的代码" />
          </el-col>
          <el-col :span="4">
            <el-date-picker
              v-model="testStartDate"
              type="date"
              placeholder="开始日期"
              format="YYYY-MM-DD"
              value-format="YYYY-MM-DD"
            />
          </el-col>
          <el-col :span="4">
            <el-date-picker
              v-model="testEndDate"
              type="date"
              placeholder="结束日期"
              format="YYYY-MM-DD"
              value-format="YYYY-MM-DD"
            />
          </el-col>
          <el-col :span="4">
            <el-button type="primary" @click="testDataFetch" :loading="testLoading">
              测试获取
            </el-button>
          </el-col>
        </el-row>
      </div>
      
      <div v-if="testResult" class="test-result">
        <el-alert
          :title="testResult.success ? '数据获取成功' : '数据获取失败'"
          :type="testResult.success ? 'success' : 'error'"
          :description="testResult.message"
          show-icon
        />
        
        <div v-if="testResult.success && testResult.data" class="data-info">
          <h4>数据信息</h4>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="标的名称">{{ testResult.data.name }}</el-descriptions-item>
            <el-descriptions-item label="数据源">{{ testResult.data.source }}</el-descriptions-item>
            <el-descriptions-item label="当前阶段">{{ testResult.data.currentStage?.name }}</el-descriptions-item>
            <el-descriptions-item label="数据质量">{{ testResult.data.dataQuality }}</el-descriptions-item>
            <el-descriptions-item label="数据点数">{{ testResult.data.kline?.length || 0 }}</el-descriptions-item>
            <el-descriptions-item label="覆盖范围">{{ testResult.data.currentStage?.coverage }}</el-descriptions-item>
          </el-descriptions>
          
          <div v-if="testResult.data.dataStrategy" class="strategy-info">
            <h5>数据获取策略</h5>
            <el-timeline>
              <el-timeline-item
                v-for="(stage, index) in testResult.data.dataStrategy.stages"
                :key="index"
                :type="index === 0 ? 'primary' : 'info'"
                :icon="index === 0 ? 'SuccessFilled' : 'InfoFilled'"
              >
                <div class="stage-info">
                  <h6>{{ stage.name }}</h6>
                  <p>{{ stage.description }}</p>
                  <p><strong>数据源:</strong> {{ stage.source }}</p>
                  <p><strong>覆盖范围:</strong> {{ stage.coverage }}</p>
                  <p><strong>优先级:</strong> {{ stage.priority }}</p>
                </div>
              </el-timeline-item>
            </el-timeline>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Search, SuccessFilled, InfoFilled } from '@element-plus/icons-vue'
import InstrumentTable from './InstrumentTable.vue'
import axios from 'axios'

// 响应式数据
const dataSourceStatus = ref({})
const instruments = ref({})
const markets = ref({})
const searchQuery = ref('')
const selectedCategory = ref('')
const activeTab = ref('indices')
const testSymbol = ref('000001.SH')
const testStartDate = ref('')
const testEndDate = ref('')
const testLoading = ref(false)
const testResult = ref(null)

// 计算属性
const dataSourceCount = computed(() => {
  return Object.keys(dataSourceStatus.value.sources || {}).length
})

const instrumentCount = computed(() => {
  const instruments = dataSourceStatus.value.supportedInstruments
  return instruments ? instruments.total : 0
})

const marketCount = computed(() => {
  return Object.keys(markets.value).length
})

const dataSourceList = computed(() => {
  const sources = dataSourceStatus.value.sources || {}
  return Object.entries(sources).map(([key, source]) => ({
    key,
    ...source
  }))
})

const filteredInstruments = computed(() => {
  if (!instruments.value) return { indices: [], blueChips: [], futures: [] }
  
  const filtered = { ...instruments.value }
  
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    for (const category in filtered) {
      filtered[category] = filtered[category].filter(item =>
        item.symbol.toLowerCase().includes(query) ||
        item.name.toLowerCase().includes(query) ||
        (item.description && item.description.toLowerCase().includes(query))
      )
    }
  }
  
  if (selectedCategory.value) {
    const result = {}
    result[selectedCategory.value] = filtered[selectedCategory.value] || []
    return result
  }
  
  return filtered
})

// 方法
const refreshStatus = async () => {
  try {
    const [statusRes, instrumentsRes, marketsRes] = await Promise.all([
      axios.get('/comprehensive/sources/status'),
      axios.get('/comprehensive/instruments'),
      axios.get('/comprehensive/markets')
    ])
    
    dataSourceStatus.value = statusRes.data.data
    instruments.value = instrumentsRes.data.data.instruments
    markets.value = marketsRes.data.data
    
    ElMessage.success('状态刷新成功')
  } catch (error) {
    console.error('刷新状态失败:', error)
    ElMessage.error('刷新状态失败')
  }
}

const toggleDataSource = async (source) => {
  try {
    // 这里可以添加启用/禁用数据源的API调用
    ElMessage.success(`${source.name} 已${source.enabled ? '启用' : '禁用'}`)
  } catch (error) {
    console.error('切换数据源状态失败:', error)
    ElMessage.error('操作失败')
  }
}

const searchInstruments = () => {
  // 搜索逻辑已在计算属性中实现
}

const filterInstruments = () => {
  // 过滤逻辑已在计算属性中实现
}

const handleTabChange = (tabName) => {
  activeTab.value = tabName
}

const testDataFetch = async () => {
  if (!testSymbol.value) {
    ElMessage.warning('请输入标的代码')
    return
  }
  
  testLoading.value = true
  testResult.value = null
  
  try {
    const params = {}
    if (testStartDate.value) params.startDate = testStartDate.value
    if (testEndDate.value) params.endDate = testEndDate.value
    
    const response = await axios.get(`/comprehensive/data/${testSymbol.value}`, { params })
    
    testResult.value = {
      success: true,
      data: response.data.data,
      message: '数据获取成功'
    }
    
    ElMessage.success('测试成功')
  } catch (error) {
    console.error('测试数据获取失败:', error)
    testResult.value = {
      success: false,
      message: error.response?.data?.message || error.message
    }
    ElMessage.error('测试失败')
  } finally {
    testLoading.value = false
  }
}

const getInstrumentName = (instrument) => {
  const nameMap = {
    stocks: '股票',
    indices: '指数',
    futures: '期货',
    funds: '基金',
    bonds: '债券'
  }
  return nameMap[instrument] || instrument
}

// 生命周期
onMounted(() => {
  refreshStatus()
})
</script>

<style scoped>
.comprehensive-data-viewer {
  padding: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-card {
  margin-bottom: 20px;
}

.status-overview {
  margin-top: 20px;
}

.sources-card,
.instruments-card,
.markets-card,
.test-card {
  margin-bottom: 20px;
}

.source-name {
  display: flex;
  align-items: center;
}

.coverage-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.coverage-tags .el-tag {
  margin: 0;
}

.header-controls {
  display: flex;
  align-items: center;
}

.market-card {
  height: 100%;
}

.market-info h4 {
  margin: 0 0 8px 0;
  color: #409eff;
}

.market-code {
  font-size: 12px;
  color: #909399;
  margin: 0 0 12px 0;
}

.market-details p {
  margin: 4px 0;
  font-size: 14px;
}

.market-details .el-tag {
  margin-right: 4px;
  margin-bottom: 4px;
}

.test-controls {
  margin-bottom: 20px;
}

.test-result {
  margin-top: 20px;
}

.data-info {
  margin-top: 20px;
}

.data-info h4 {
  margin-bottom: 16px;
}

.strategy-info {
  margin-top: 20px;
}

.strategy-info h5 {
  margin-bottom: 16px;
}

.stage-info h6 {
  margin: 0 0 8px 0;
  color: #409eff;
}

.stage-info p {
  margin: 4px 0;
  font-size: 14px;
  color: #606266;
}
</style>