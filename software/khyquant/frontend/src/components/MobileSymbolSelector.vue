<template>
  <div class="mobile-symbol-selector">
    <!-- 触发按钮 - 右上角 -->
    <button class="symbol-trigger-btn" @click="showSelector = true">
      <span class="symbol-code">{{ currentSymbol || '选择' }}</span>
      <el-icon class="arrow-icon"><ArrowDown /></el-icon>
    </button>

    <!-- 底部弹出选择器 -->
    <transition name="slide-up">
      <div v-if="showSelector" class="selector-overlay" @click="showSelector = false">
        <div class="selector-panel" @click.stop>
          <!-- 头部 -->
          <div class="selector-header">
            <span class="title">选择标的</span>
            <button class="close-btn" @click="showSelector = false">
              <el-icon><Close /></el-icon>
            </button>
          </div>

          <!-- 搜索框 -->
          <div class="search-box">
            <el-icon class="search-icon"><Search /></el-icon>
            <input
              v-model="searchKeyword"
              type="text"
              placeholder="搜索代码或名称"
              class="search-input"
              @input="handleSearch"
            />
            <button v-if="searchKeyword" class="clear-btn" @click="clearSearch">
              <el-icon><CircleClose /></el-icon>
            </button>
          </div>

          <!-- 标的列表 -->
          <div class="symbol-list">
            <div
              v-for="symbol in filteredSymbols"
              :key="symbol.code"
              class="symbol-item"
              :class="{ 'active': symbol.code === currentSymbol }"
              @click="selectSymbol(symbol)"
            >
              <div class="symbol-info">
                <span class="code">{{ symbol.code }}</span>
                <span class="name">{{ symbol.name }}</span>
              </div>
              <el-icon v-if="symbol.code === currentSymbol" class="check-icon" color="#409eff">
                <Check />
              </el-icon>
            </div>

            <!-- 无结果提示 -->
            <div v-if="filteredSymbols.length === 0" class="empty-result">
              <el-icon class="empty-icon"><Search /></el-icon>
              <p>未找到匹配的标的</p>
            </div>

            <!-- 加载中 -->
            <div v-if="loading" class="loading-state">
              <el-icon class="is-loading"><Loading /></el-icon>
              <p>加载中...</p>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ArrowDown, Close, Search, CircleClose, Check, Loading } from '@element-plus/icons-vue'

// Props
const props = defineProps({
  currentSymbol: {
    type: String,
    default: ''
  },
  symbols: {
    type: Array,
    default: () => []
  },
  loading: {
    type: Boolean,
    default: false
  }
})

// Emits
const emit = defineEmits(['select'])

// 响应式数据
const showSelector = ref(false)
const searchKeyword = ref('')

// 过滤后的标的列表
const filteredSymbols = computed(() => {
  if (!searchKeyword.value) {
    return props.symbols
  }

  const keyword = searchKeyword.value.toLowerCase()
  return props.symbols.filter(symbol => {
    return (
      symbol.code.toLowerCase().includes(keyword) ||
      symbol.name.toLowerCase().includes(keyword)
    )
  })
})

// 选择标的
const selectSymbol = (symbol) => {
  emit('select', symbol.code)
  showSelector.value = false
  searchKeyword.value = ''
}

// 清除搜索
const clearSearch = () => {
  searchKeyword.value = ''
}

// 搜索处理
const handleSearch = () => {
  // 搜索逻辑已在computed中处理
}

// 监听选择器关闭，清除搜索
watch(showSelector, (newVal) => {
  if (!newVal) {
    searchKeyword.value = ''
  }
})
</script>

<style scoped>
.mobile-symbol-selector {
  position: relative;
}

/* 触发按钮 */
.symbol-trigger-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: white;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  font-size: 14px;
  color: #303133;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.symbol-trigger-btn:active {
  transform: scale(0.98);
  background: #f5f7fa;
}

.symbol-code {
  font-weight: 600;
  font-family: 'Consolas', monospace;
}

.arrow-icon {
  font-size: 12px;
  transition: transform 0.3s;
}

/* 遮罩层 */
.selector-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 9999;
  display: flex;
  align-items: flex-end;
}

/* 选择器面板 */
.selector-panel {
  width: 100%;
  max-height: 70vh;
  background: white;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  display: flex;
  flex-direction: column;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
}

/* 头部 */
.selector-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #f0f0f0;
}

.title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.close-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.2s;
}

.close-btn:active {
  transform: scale(0.95);
  background: #e4e7ed;
}

/* 搜索框 */
.search-box {
  position: relative;
  margin: 12px 20px;
  display: flex;
  align-items: center;
  background: #f5f7fa;
  border-radius: 8px;
  padding: 0 12px;
}

.search-icon {
  font-size: 18px;
  color: #909399;
  margin-right: 8px;
}

.search-input {
  flex: 1;
  height: 40px;
  border: none;
  background: transparent;
  font-size: 14px;
  color: #303133;
  outline: none;
}

.search-input::placeholder {
  color: #c0c4cc;
}

.clear-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
  color: #909399;
}

/* 标的列表 */
.symbol-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.symbol-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  cursor: pointer;
  transition: background 0.2s;
}

.symbol-item:active {
  background: #f5f7fa;
}

.symbol-item.active {
  background: rgba(64, 158, 255, 0.1);
}

.symbol-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.code {
  font-size: 15px;
  font-weight: 600;
  font-family: 'Consolas', monospace;
  color: #303133;
  min-width: 80px;
}

.name {
  font-size: 14px;
  color: #606266;
}

.check-icon {
  font-size: 20px;
}

/* 空结果 */
.empty-result {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: #909399;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
  opacity: 0.5;
}

.empty-result p {
  font-size: 14px;
  margin: 0;
}

/* 加载状态 */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: #909399;
}

.loading-state .el-icon {
  font-size: 32px;
  margin-bottom: 12px;
}

.loading-state p {
  font-size: 14px;
  margin: 0;
}

/* 滑动动画 */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}

.slide-up-enter-from .selector-panel,
.slide-up-leave-to .selector-panel {
  transform: translateY(100%);
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
}
</style>
