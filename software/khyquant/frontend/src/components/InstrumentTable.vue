<template>
  <div class="instrument-table">
    <el-table :data="instruments" style="width: 100%" @row-click="handleRowClick">
      <el-table-column prop="symbol" label="代码" width="120">
        <template #default="{ row }">
          <el-tag type="primary">{{ row.symbol }}</el-tag>
        </template>
      </el-table-column>
      
      <el-table-column prop="name" label="名称" width="150" />
      
      <el-table-column prop="market" label="市场" width="100">
        <template #default="{ row }">
          <el-tag :type="getMarketTagType(row.market)" size="small">
            {{ row.market }}
          </el-tag>
        </template>
      </el-table-column>
      
      <el-table-column prop="established" label="上市时间" width="120" />
      
      <el-table-column v-if="type === 'stock'" prop="industry" label="行业" width="120" />
      
      <el-table-column v-if="type === 'index'" prop="baseValue" label="基点" width="80" />
      
      <el-table-column v-if="type === 'futures'" prop="underlying" label="标的物" width="100" />
      
      <el-table-column v-if="type === 'futures'" prop="contractSize" label="合约规模" width="120" />
      
      <el-table-column prop="description" label="描述" min-width="200" />
      
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <el-button size="small" @click.stop="viewData(row)">
            查看数据
          </el-button>
          <el-button size="small" type="primary" @click.stop="addToWatchlist(row)">
            加入自选
          </el-button>
          <el-button size="small" type="success" @click.stop="createStrategy(row)">
            创建策略
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    
    <!-- 数据查看对话框 -->
    <el-dialog
      v-model="dataDialogVisible"
      :title="`${selectedInstrument?.name} - 数据预览`"
      width="80%"
      destroy-on-close
    >
      <div v-if="instrumentData" class="data-preview">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-card>
              <template #header>
                <h4>基本信息</h4>
              </template>
              <el-descriptions :column="1" border>
                <el-descriptions-item label="标的代码">{{ instrumentData.symbol }}</el-descriptions-item>
                <el-descriptions-item label="标的名称">{{ instrumentData.name }}</el-descriptions-item>
                <el-descriptions-item label="数据源">{{ instrumentData.source }}</el-descriptions-item>
                <el-descriptions-item label="数据质量">
                  <el-tag :type="getQualityTagType(instrumentData.dataQuality)">
                    {{ getQualityText(instrumentData.dataQuality) }}
                  </el-tag>
                </el-descriptions-item>
                <el-descriptions-item label="数据点数">{{ instrumentData.kline?.length || 0 }}</el-descriptions-item>
                <el-descriptions-item label="当前价格">{{ instrumentData.currentPrice }}</el-descriptions-item>
              </el-descriptions>
            </el-card>
          </el-col>
          
          <el-col :span="12">
            <el-card>
              <template #header>
                <h4>数据获取阶段</h4>
              </template>
              <div v-if="instrumentData.currentStage">
                <p><strong>当前阶段:</strong> {{ instrumentData.currentStage.name }}</p>
                <p><strong>数据源:</strong> {{ instrumentData.currentStage.source }}</p>
                <p><strong>覆盖范围:</strong> {{ instrumentData.currentStage.coverage }}</p>
                <p><strong>描述:</strong> {{ instrumentData.currentStage.description }}</p>
                <el-progress
                  :percentage="((instrumentData.totalStages - instrumentData.currentStage.priority + 1) / instrumentData.totalStages) * 100"
                  :format="() => `阶段 ${instrumentData.currentStage.priority}/${instrumentData.totalStages}`"
                />
              </div>
            </el-card>
          </el-col>
        </el-row>
        
        <el-card style="margin-top: 20px;">
          <template #header>
            <h4>最近数据</h4>
          </template>
          <el-table :data="recentData" style="width: 100%" max-height="300">
            <el-table-column prop="time" label="日期" width="120" />
            <el-table-column prop="open" label="开盘" width="100" />
            <el-table-column prop="high" label="最高" width="100" />
            <el-table-column prop="low" label="最低" width="100" />
            <el-table-column prop="close" label="收盘" width="100" />
            <el-table-column prop="volume" label="成交量" />
          </el-table>
        </el-card>
        
        <div v-if="instrumentData.indicators" style="margin-top: 20px;">
          <el-card>
            <template #header>
              <h4>技术指标</h4>
            </template>
            <el-row :gutter="20">
              <el-col :span="6" v-for="(indicator, name) in displayIndicators" :key="name">
                <el-statistic
                  :title="getIndicatorName(name)"
                  :value="indicator"
                  :precision="2"
                />
              </el-col>
            </el-row>
          </el-card>
        </div>
      </div>
      
      <div v-else-if="dataLoading" class="loading-container">
        <el-loading-spinner />
        <p>正在获取数据...</p>
      </div>
      
      <template #footer>
        <el-button @click="dataDialogVisible = false">关闭</el-button>
        <el-button type="primary" @click="downloadData">下载数据</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import axios from 'axios'

// Props
const props = defineProps({
  instruments: {
    type: Array,
    default: () => []
  },
  type: {
    type: String,
    default: 'stock'
  }
})

// 响应式数据
const dataDialogVisible = ref(false)
const selectedInstrument = ref(null)
const instrumentData = ref(null)
const dataLoading = ref(false)

// 计算属性
const recentData = computed(() => {
  if (!instrumentData.value?.kline) return []
  return instrumentData.value.kline.slice(-10).reverse()
})

const displayIndicators = computed(() => {
  if (!instrumentData.value?.indicators) return {}
  
  const indicators = instrumentData.value.indicators
  const latest = instrumentData.value.kline?.length - 1
  
  if (latest < 0) return {}
  
  return {
    ma5: indicators.ma5?.[latest],
    ma20: indicators.ma20?.[latest],
    ma60: indicators.ma60?.[latest],
    rsi: indicators.rsi?.[latest]
  }
})

// 方法
const handleRowClick = (row) => {
  console.log('点击行:', row)
}

const viewData = async (instrument) => {
  selectedInstrument.value = instrument
  dataDialogVisible.value = true
  dataLoading.value = true
  instrumentData.value = null
  
  try {
    const response = await axios.get(`/comprehensive/data/${instrument.symbol}`, {
      params: {
        includeIndicators: true
      }
    })
    
    instrumentData.value = response.data.data
    ElMessage.success('数据获取成功')
  } catch (error) {
    console.error('获取数据失败:', error)
    ElMessage.error('数据获取失败')
  } finally {
    dataLoading.value = false
  }
}

const addToWatchlist = async (instrument) => {
  try {
    await ElMessageBox.confirm(
      `确定要将 ${instrument.name}(${instrument.symbol}) 加入自选标的吗？`,
      '确认操作',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'info'
      }
    )
    
    // 这里调用添加自选标的的API
    // await axios.post('/api/watchlist', { symbol: instrument.symbol })
    
    ElMessage.success('已加入自选标的')
  } catch (error) {
    if (error !== 'cancel') {
      console.error('添加自选标的失败:', error)
      ElMessage.error('添加失败')
    }
  }
}

const createStrategy = async (instrument) => {
  try {
    await ElMessageBox.confirm(
      `确定要为 ${instrument.name}(${instrument.symbol}) 创建交易策略吗？`,
      '确认操作',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'info'
      }
    )
    
    // 这里可以跳转到策略创建页面或打开策略创建对话框
    ElMessage.success('即将跳转到策略创建页面')
  } catch (error) {
    if (error !== 'cancel') {
      console.error('创建策略失败:', error)
      ElMessage.error('操作失败')
    }
  }
}

const downloadData = () => {
  if (!instrumentData.value) return
  
  const data = {
    instrument: selectedInstrument.value,
    data: instrumentData.value,
    exportTime: new Date().toISOString()
  }
  
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${selectedInstrument.value.symbol}_data.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  
  ElMessage.success('数据下载成功')
}

const getMarketTagType = (market) => {
  const typeMap = {
    'SSE': 'primary',
    'SZSE': 'success',
    'SHFE': 'warning',
    'DCE': 'info',
    'CZCE': 'danger',
    'CFFEX': 'warning'
  }
  return typeMap[market] || 'info'
}

const getQualityTagType = (quality) => {
  const typeMap = {
    'high': 'success',
    'medium': 'warning',
    'simulated': 'info'
  }
  return typeMap[quality] || 'info'
}

const getQualityText = (quality) => {
  const textMap = {
    'high': '高质量',
    'medium': '中等质量',
    'simulated': '模拟数据'
  }
  return textMap[quality] || quality
}

const getIndicatorName = (name) => {
  const nameMap = {
    'ma5': 'MA5',
    'ma20': 'MA20',
    'ma60': 'MA60',
    'rsi': 'RSI'
  }
  return nameMap[name] || name
}
</script>

<style scoped>
.instrument-table {
  width: 100%;
}

.data-preview {
  min-height: 400px;
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
}

.loading-container p {
  margin-top: 16px;
  color: #606266;
}

.el-table .el-table__row {
  cursor: pointer;
}

.el-table .el-table__row:hover {
  background-color: #f5f7fa;
}
</style>