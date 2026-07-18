<template>
  <div class="data-source-indicator-classic">
    <el-dropdown @command="handleSourceChange" trigger="click">
      <el-tooltip :content="tooltipContent" placement="bottom">
        <div class="source-badge" :class="statusClass">
          <span class="source-dot"></span>
          <span class="source-text">{{ sourceName }}</span>
          <span class="quality-tag">{{ qualityText }}</span>
          <el-icon class="dropdown-icon"><ArrowDown /></el-icon>
        </div>
      </el-tooltip>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item 
            v-for="source in availableSources" 
            :key="source.key"
            :command="source.key"
            :disabled="source.key === currentSource"
          >
            <div class="source-menu-item">
              <span class="source-menu-name">{{ source.name }}</span>
              <el-tag v-if="source.key === currentSource" type="success" size="small">当前</el-tag>
            </div>
          </el-dropdown-item>
          <el-dropdown-item divided @click="handleManage">
            <div class="source-menu-item">
              <el-icon><Setting /></el-icon>
              <span>管理数据源</span>
            </div>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<script setup>
import { computed, watch } from 'vue'
import { ArrowDown, Setting } from '@element-plus/icons-vue'

const props = defineProps({
  sourceName: {
    type: String,
    default: '数据源'
  },
  status: {
    type: String,
    default: 'connected',
    validator: (value) => ['connected', 'warning', 'disconnected'].includes(value)
  },
  quality: {
    type: String,
    default: 'high',
    validator: (value) => ['high', 'medium', 'low', 'simulated', 'cached'].includes(value)
  },
  successRate: {
    type: Number,
    default: 0
  },
  responseTime: {
    type: Number,
    default: 0
  },
  lastUpdate: {
    type: [Date, Object],
    default: () => new Date()
  },
  currentSource: {
    type: String,
    default: ''
  },
  availableSources: {
    type: Array,
    default: () => []
  }
})

const emit = defineEmits(['source-change', 'manage'])

// 🔥 添加调试日志
watch(() => props.availableSources, (newVal) => {
  console.log('📊 DataSourceIndicator - availableSources 更新:', newVal)
  console.log('   数量:', newVal?.length || 0)
  console.log('   内容:', JSON.stringify(newVal))
}, { immediate: true, deep: true })

watch(() => props.currentSource, (newVal) => {
  console.log('📊 DataSourceIndicator - currentSource 更新:', newVal)
}, { immediate: true })

const statusClass = computed(() => {
  return `status-${props.status}`
})

const qualityText = computed(() => {
  const qualityMap = {
    high: '真',
    medium: '中',
    low: '低',
    simulated: '模',
    cached: '缓'
  }
  return qualityMap[props.quality] || '?'
})

const tooltipContent = computed(() => {
  const lastUpdateValue = props.lastUpdate?.value || props.lastUpdate || new Date()
  const updateTime = lastUpdateValue instanceof Date 
    ? lastUpdateValue.toLocaleTimeString() 
    : new Date(lastUpdateValue).toLocaleTimeString()
  
  const lines = [
    `数据源：${props.sourceName}`,
    `状态：${getStatusText()}`,
    `质量：${getQualityText()}`,
    `更新：${updateTime}`,
    '',
    '点击查看数据源列表'
  ]
  
  return lines.join('\n')
})

function getStatusText() {
  const statusMap = {
    connected: '已连接',
    warning: '警告',
    disconnected: '已断开'
  }
  return statusMap[props.status] || '未知'
}

function getQualityText() {
  const qualityMap = {
    high: '真实数据',
    medium: '中等质量',
    low: '低质量',
    simulated: '模拟数据',
    cached: '缓存数据'
  }
  return qualityMap[props.quality] || '未知'
}

function handleSourceChange(sourceKey) {
  console.log('🔄 用户选择切换数据源:', sourceKey)
  emit('source-change', sourceKey)
}

function handleManage() {
  console.log('⚙️ 打开数据源管理')
  emit('manage')
}
</script>

<style scoped>
.data-source-indicator-classic {
  display: inline-flex;
  align-items: center;
}

.source-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid;
  background: linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.1) 100%);
  backdrop-filter: blur(4px);
}

.source-badge:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}

/* 古风配色 - 青色系（连接状态） */
.status-connected {
  color: #7ec699;
  border-color: rgba(126, 198, 153, 0.5);
  background: linear-gradient(135deg, rgba(126, 198, 153, 0.15) 0%, rgba(126, 198, 153, 0.05) 100%);
}

.status-connected .source-dot {
  background: #7ec699;
  box-shadow: 0 0 6px rgba(126, 198, 153, 0.6);
}

/* 古风配色 - 橙黄色系（警告状态） */
.status-warning {
  color: #f0a020;
  border-color: rgba(240, 160, 32, 0.5);
  background: linear-gradient(135deg, rgba(240, 160, 32, 0.15) 0%, rgba(240, 160, 32, 0.05) 100%);
}

.status-warning .source-dot {
  background: #f0a020;
  box-shadow: 0 0 6px rgba(240, 160, 32, 0.6);
}

/* 古风配色 - 朱红色系（断开状态） */
.status-disconnected {
  color: #d4574e;
  border-color: rgba(212, 87, 78, 0.5);
  background: linear-gradient(135deg, rgba(212, 87, 78, 0.15) 0%, rgba(212, 87, 78, 0.05) 100%);
}

.status-disconnected .source-dot {
  background: #d4574e;
  box-shadow: 0 0 6px rgba(212, 87, 78, 0.6);
}

.source-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  animation: breathe 2s ease-in-out infinite;
}

@keyframes breathe {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(0.9);
  }
}

.source-text {
  font-weight: 500;
  font-family: 'Microsoft YaHei', 'SimSun', serif;
  letter-spacing: 1px;
}

.quality-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 2px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  font-family: 'KaiTi', 'SimSun', serif;
}

.dropdown-icon {
  margin-left: 2px;
  font-size: 12px;
  transition: transform 0.3s ease;
}

.source-badge:hover .dropdown-icon {
  transform: translateY(2px);
}

.source-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 150px;
}

.source-menu-name {
  flex: 1;
}
</style>