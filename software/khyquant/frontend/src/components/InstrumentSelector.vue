<template>
  <div class="instrument-selector">
    <el-select
      v-model="selectedSymbol"
      filterable
      remote
      reserve-keyword
      placeholder="搜索股票代码或名称"
      :remote-method="searchInstruments"
      :loading="loading"
      @change="handleSelect"
      size="large"
      style="width: 100%"
    >
      <el-option-group
        v-for="group in groupedInstruments"
        :key="group.label"
        :label="group.label"
      >
        <el-option
          v-for="item in group.options"
          :key="item.code"
          :label="`${item.name} (${item.code})`"
          :value="item.code"
        >
          <span style="float: left">{{ item.name }}</span>
          <span style="float: right; color: #8492a6; font-size: 13px">
            {{ item.code }}
          </span>
        </el-option>
      </el-option-group>
    </el-select>
    
    <div class="data-source-info" v-if="dataSource">
      <el-tag :type="dataSource === 'AData' ? 'success' : 'warning'" size="small">
        {{ dataSource }}
      </el-tag>
      <span class="instrument-count">共 {{ totalCount }} 个标的</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['update:modelValue', 'select'])

const selectedSymbol = ref(props.modelValue)
const allInstruments = ref([])
const filteredInstruments = ref([])
const loading = ref(false)
const dataSource = ref('')
const totalCount = ref(0)

// 按类型分组
const groupedInstruments = computed(() => {
  const groups = {
    index: { label: '指数', options: [] },
    stock: { label: 'A股', options: [] },
    etf: { label: 'ETF', options: [] },
    bond: { label: '可转债', options: [] }
  }
  
  filteredInstruments.value.forEach(item => {
    if (groups[item.type]) {
      groups[item.type].options.push(item)
    }
  })
  
  return Object.values(groups).filter(g => g.options.length > 0)
})

// 加载所有标的
const loadAllInstruments = async () => {
  try {
    loading.value = true
    
    console.log('🔍 加载标的列表...')
    
    const response = await request.get('/market/symbols', {
      params: {
        limit: 0, // 获取所有标的
        useCache: 'true'
      }
    })
    
    if (response.success && response.data) {
      allInstruments.value = response.data.instruments || []
      filteredInstruments.value = allInstruments.value // 显示所有标的
      totalCount.value = allInstruments.value.length
      dataSource.value = allInstruments.value[0]?.source || 'AData'
      
      console.log(`✅ 加载 ${totalCount.value} 个标的`)
      
      // 保存到本地存储
      localStorage.setItem('instruments_cache', JSON.stringify({
        data: allInstruments.value,
        timestamp: Date.now()
      }))
    }
  } catch (error) {
    console.error('❌ 加载标的列表失败:', error)
    
    // 降级: 尝试从本地缓存加载
    const cached = localStorage.getItem('instruments_cache')
    if (cached) {
      try {
        const { data, timestamp } = JSON.parse(cached)
        const age = Date.now() - timestamp
        
        if (age < 24 * 3600 * 1000) { // 24小时内的缓存
          allInstruments.value = data
          filteredInstruments.value = data // 显示所有标的
          totalCount.value = data.length
          dataSource.value = '本地缓存'
          
          console.log(`✅ 从本地缓存加载 ${totalCount.value} 个标的`)
          ElMessage.warning('使用本地缓存数据')
          return
        }
      } catch (e) {
        console.error('解析缓存失败:', e)
      }
    }
    
    // 最终降级: 使用模拟数据
    useMockData()
  } finally {
    loading.value = false
  }
}

// 使用模拟数据
const useMockData = () => {
  const mockData = [
    { code: 'sh000001', name: '上证指数', type: 'index', category: '指数' },
    { code: 'sh000300', name: '沪深300', type: 'index', category: '指数' },
    { code: 'sz399001', name: '深证成指', type: 'index', category: '指数' },
    { code: 'sz399006', name: '创业板指', type: 'index', category: '指数' },
    { code: 'sh600519', name: '贵州茅台', type: 'stock', category: 'A股' },
    { code: 'sz000858', name: '五粮液', type: 'stock', category: 'A股' },
    { code: 'sh600036', name: '招商银行', type: 'stock', category: 'A股' },
    { code: 'sz000001', name: '平安银行', type: 'stock', category: 'A股' },
    { code: 'sh510050', name: '50ETF', type: 'etf', category: 'ETF' },
    { code: 'sh510300', name: '300ETF', type: 'etf', category: 'ETF' }
  ]
  
  allInstruments.value = mockData
  filteredInstruments.value = mockData
  totalCount.value = mockData.length
  dataSource.value = '模拟数据'
  
  console.log('⚠️ 使用模拟数据')
  ElMessage.warning('API不可用,使用模拟数据')
}

// 搜索标的
const searchInstruments = (query) => {
  if (!query) {
    filteredInstruments.value = allInstruments.value // 显示所有标的
    return
  }
  
  const keyword = query.toLowerCase()
  filteredInstruments.value = allInstruments.value.filter(item => {
    // 🔧 修复：检查 name 和 code 是否存在，避免 null 错误
    const name = item.name || ''
    const code = item.code || ''
    return name.toLowerCase().includes(keyword) ||
           code.toLowerCase().includes(keyword)
  }) // 显示所有搜索结果
}

// 选择标的
const handleSelect = (code) => {
  const instrument = allInstruments.value.find(i => i.code === code)
  if (instrument) {
    emit('update:modelValue', code)
    emit('select', instrument)
    console.log('✅ 选择标的:', instrument)
  }
}

onMounted(() => {
  loadAllInstruments()
})
</script>

<style scoped>
.instrument-selector {
  width: 100%;
}

.data-source-info {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #606266;
}

.instrument-count {
  color: #909399;
}
</style>
