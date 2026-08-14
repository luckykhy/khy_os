<template>
  <Transition name="slide-up">
    <div v-if="visible" class="mobile-strategy-selector">
      <!-- 顶部导航栏 -->
      <div class="selector-header">
        <button class="back-button" @click="close">
          <el-icon><ArrowLeft /></el-icon>
          <span>返回</span>
        </button>
        <h2 class="header-title">选择策略</h2>
        <div class="header-spacer"></div>
      </div>

      <!-- 下拉刷新区域 -->
      <div 
        class="selector-content"
        @touchstart="handleTouchStart"
        @touchmove="handleTouchMove"
        @touchend="handleTouchEnd"
        :style="contentStyle"
      >
        <!-- 刷新指示器 -->
        <div class="refresh-indicator" :class="{ 'active': isRefreshing }">
          <el-icon class="refresh-icon" :class="{ 'spinning': isRefreshing }">
            <Refresh />
          </el-icon>
          <span>{{ refreshText }}</span>
        </div>

        <!-- 策略列表 -->
        <div v-loading="loading" class="strategy-list">
          <div
            v-for="strategy in strategies"
            :key="strategy.id"
            class="strategy-card"
            @click="selectStrategy(strategy)"
          >
            <div class="card-header">
              <h3 class="strategy-name">{{ strategy.name }}</h3>
              <div class="strategy-tags">
                <el-tag :type="getLanguageColor(strategy.language)" size="small">
                  {{ getLanguageName(strategy.language) }}
                </el-tag>
                <el-tag :type="getStrategyTypeColor(strategy.type)" size="small">
                  {{ getStrategyTypeLabel(strategy.type) }}
                </el-tag>
              </div>
            </div>
            
            <p class="strategy-description" v-if="strategy.description">
              {{ strategy.description }}
            </p>
            <p class="strategy-description empty" v-else>
              暂无描述
            </p>
            
            <div class="card-footer">
              <span class="create-time">
                <el-icon><Calendar /></el-icon>
                {{ formatDate(strategy.createdAt) }}
              </span>
              <span v-if="strategy.parameters && Object.keys(strategy.parameters).length > 0" class="param-count">
                <el-icon><Setting /></el-icon>
                {{ Object.keys(strategy.parameters).length }} 个参数
              </span>
            </div>
          </div>

          <!-- 空状态 -->
          <div v-if="!loading && strategies.length === 0" class="empty-state">
            <el-icon class="empty-icon"><FolderOpened /></el-icon>
            <p class="empty-text">暂无可用策略</p>
            <el-button type="primary" @click="goToStrategyManagement">
              创建策略
            </el-button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ArrowLeft, Refresh, Calendar, Setting, FolderOpened } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'

interface Strategy {
  id: string
  name: string
  description?: string
  language: string
  type: string
  parameters?: Record<string, any>
  createdAt: string
}

interface Props {
  visible: boolean
  strategies: Strategy[]
  loading?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  loading: false
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'select': [strategy: Strategy]
  'refresh': []
}>()

const router = useRouter()

// 下拉刷新状态
const isRefreshing = ref(false)
const pullDistance = ref(0)
const touchStartY = ref(0)
const isPulling = ref(false)

const PULL_THRESHOLD = 80 // 触发刷新的阈值

const contentStyle = computed(() => {
  if (isPulling.value && pullDistance.value > 0) {
    return {
      transform: `translateY(${Math.min(pullDistance.value, PULL_THRESHOLD * 1.5)}px)`,
      transition: 'none'
    }
  }
  return {
    transform: 'translateY(0)',
    transition: 'transform 0.3s ease'
  }
})

const refreshText = computed(() => {
  if (isRefreshing.value) return '刷新中...'
  if (pullDistance.value >= PULL_THRESHOLD) return '释放刷新'
  return '下拉刷新'
})

// 下拉刷新处理
const handleTouchStart = (event: TouchEvent) => {
  const content = event.currentTarget as HTMLElement
  if (content.scrollTop === 0) {
    touchStartY.value = event.touches[0].clientY
    isPulling.value = true
  }
}

const handleTouchMove = (event: TouchEvent) => {
  if (!isPulling.value || isRefreshing.value) return
  
  const content = event.currentTarget as HTMLElement
  if (content.scrollTop > 0) {
    isPulling.value = false
    return
  }
  
  const currentY = event.touches[0].clientY
  const distance = currentY - touchStartY.value
  
  if (distance > 0) {
    pullDistance.value = distance
    // 阻止默认滚动
    if (distance > 10) {
      event.preventDefault()
    }
  }
}

const handleTouchEnd = () => {
  if (!isPulling.value) return
  
  isPulling.value = false
  
  if (pullDistance.value >= PULL_THRESHOLD && !isRefreshing.value) {
    // 触发刷新
    refresh()
  }
  
  pullDistance.value = 0
}

// 刷新策略列表
const refresh = async () => {
  isRefreshing.value = true
  emit('refresh')
  
  // 模拟刷新延迟
  setTimeout(() => {
    isRefreshing.value = false
    ElMessage.success('刷新成功')
  }, 1000)
}

// 选择策略
const selectStrategy = (strategy: Strategy) => {
  emit('select', strategy)
  close()
}

// 关闭选择器
const close = () => {
  emit('update:visible', false)
}

// 前往策略管理
const goToStrategyManagement = () => {
  router.push('/strategy-management')
  close()
}

// 格式化日期
const formatDate = (dateString: string) => {
  const date = new Date(dateString)
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

// 获取语言颜色
const getLanguageColor = (language: string) => {
  const colorMap: Record<string, string> = {
    javascript: 'warning',
    python: 'success',
    typescript: 'primary'
  }
  return colorMap[language?.toLowerCase()] || 'info'
}

// 获取语言名称
const getLanguageName = (language: string) => {
  const nameMap: Record<string, string> = {
    javascript: 'JavaScript',
    python: 'Python',
    typescript: 'TypeScript'
  }
  return nameMap[language?.toLowerCase()] || language
}

// 获取策略类型颜色
const getStrategyTypeColor = (type: string) => {
  const colorMap: Record<string, string> = {
    trend: 'success',
    reversal: 'warning',
    breakout: 'danger',
    arbitrage: 'info'
  }
  return colorMap[type?.toLowerCase()] || 'info'
}

// 获取策略类型标签
const getStrategyTypeLabel = (type: string) => {
  const labelMap: Record<string, string> = {
    trend: '趋势',
    reversal: '反转',
    breakout: '突破',
    arbitrage: '套利'
  }
  return labelMap[type?.toLowerCase()] || type
}
</script>

<style scoped>
.mobile-strategy-selector {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: #0a0a0a;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 顶部导航栏 */
.selector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: linear-gradient(180deg, #1a1a1a 0%, #0f0f0f 100%);
  border-bottom: 1px solid #2a2a2a;
  flex-shrink: 0;
  min-height: 56px;
}

.back-button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  background: transparent;
  border: none;
  color: #409eff;
  font-size: 16px;
  cursor: pointer;
  border-radius: 8px;
  transition: background 0.2s;
  min-height: 44px;
}

.back-button:active {
  background: rgba(64, 158, 255, 0.1);
  transform: scale(0.96);
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: #fff;
  margin: 0;
}

.header-spacer {
  width: 80px; /* 与返回按钮宽度相同，保持标题居中 */
}

/* 内容区域 */
.selector-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  position: relative;
}

/* 刷新指示器 */
.refresh-indicator {
  position: absolute;
  top: -60px;
  left: 0;
  right: 0;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #999;
  font-size: 14px;
  transition: opacity 0.3s;
}

.refresh-indicator.active {
  opacity: 1;
}

.refresh-icon {
  font-size: 20px;
}

.refresh-icon.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 策略列表 */
.strategy-list {
  padding: 16px;
  min-height: 100%;
}

/* 策略卡片 */
.strategy-card {
  background: linear-gradient(135deg, #1a1a1a 0%, #0f0f0f 100%);
  border: 1px solid #2a2a2a;
  border-radius: var(--radius-md);
  padding: 16px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: all 0.2s;
  min-height: 120px;
}

.strategy-card:active {
  transform: scale(0.98);
  background: linear-gradient(135deg, #252525 0%, #1a1a1a 100%);
  border-color: #409eff;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 12px;
  gap: 12px;
}

.strategy-name {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  margin: 0;
  flex: 1;
}

.strategy-tags {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.strategy-description {
  font-size: 14px;
  color: #999;
  line-height: 1.5;
  margin: 0 0 12px 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.strategy-description.empty {
  color: #666;
  font-style: italic;
}

.card-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  color: #666;
}

.create-time,
.param-count {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
  min-height: 400px;
}

.empty-icon {
  font-size: 64px;
  color: #666;
  margin-bottom: 16px;
}

.empty-text {
  font-size: 16px;
  color: #999;
  margin: 0 0 24px 0;
}

/* 过渡动画 */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.3s ease-out;
}

.slide-up-enter-from {
  transform: translateY(100%);
}

.slide-up-leave-to {
  transform: translateY(100%);
}

/* 隐藏滚动条 */
.selector-content::-webkit-scrollbar {
  display: none;
}

.selector-content {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
