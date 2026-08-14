<template>
  <div>
    <!-- 遮罩层 -->
    <Transition name="overlay-fade">
      <div
        v-if="showOverlay && state === 'expanded'"
        class="drawer-overlay"
        @click="collapse"
      ></div>
    </Transition>
    
    <!-- 抽屉容器 -->
    <div
      ref="drawerRef"
      class="bottom-drawer"
      :class="drawerClass"
      :style="drawerStyle"
    >
      <!-- 拖动手柄 -->
      <div
        class="drawer-handle"
        @touchstart="handleTouchStart"
        @touchmove="handleTouchMove"
        @touchend="handleTouchEnd"
        @click="toggleState"
      >
        <div class="handle-bar"></div>
      </div>
      
      <!-- 滚动边界指示器 -->
      <div class="scroll-boundary-top" :class="{ visible: showTopBoundary }"></div>
      
      <!-- 抽屉内容 -->
      <div 
        ref="contentRef"
        class="drawer-content scroll-container"
        :class="{ scrolling: isScrolling }"
        @scroll="handleScroll"
        @touchstart="handleContentTouchStart"
        @touchmove="handleContentTouchMove"
      >
        <slot></slot>
      </div>
      
      <!-- 滚动边界指示器 -->
      <div class="scroll-boundary-bottom" :class="{ visible: showBottomBoundary }"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

/**
 * 抽屉配置接口
 */
interface DrawerConfig {
  peekHeight: number          // 预览高度（px）
  expandedHeight: number      // 展开高度（视口百分比）
  swipeThreshold: number      // 滑动阈值（px）
  animationDuration: number   // 动画时长（ms）
  showOverlay: boolean        // 是否显示遮罩
  overlayOpacity: number      // 遮罩透明度
}

// Props
interface Props {
  modelValue?: 'collapsed' | 'peek' | 'expanded'
  config?: Partial<DrawerConfig>
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: 'collapsed',
  config: () => ({})
})

// Emits
const emit = defineEmits<{
  'update:modelValue': [value: 'collapsed' | 'peek' | 'expanded']
  'state-change': [value: 'collapsed' | 'peek' | 'expanded']
}>()

// 默认配置
const defaultConfig: DrawerConfig = {
  peekHeight: 80,
  expandedHeight: 60,
  swipeThreshold: 50,
  animationDuration: 300,
  showOverlay: true,
  overlayOpacity: 0.5
}

const drawerConfig = computed(() => ({
  ...defaultConfig,
  ...props.config
}))

// 抽屉状态
const state = ref<'collapsed' | 'peek' | 'expanded'>(props.modelValue)

// 触摸状态
const touchStartY = ref(0)
const currentY = ref(0)
const isDragging = ref(false)
const dragOffset = ref(0)

// 抽屉元素引用
const drawerRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)

// 滚动状态
const isScrolling = ref(false)
const showTopBoundary = ref(false)
const showBottomBoundary = ref(false)
let scrollTimer: number | null = null

// 是否显示遮罩
const showOverlay = computed(() => drawerConfig.value.showOverlay)

// 抽屉样式类
const drawerClass = computed(() => ({
  'drawer-collapsed': state.value === 'collapsed' && !isDragging.value,
  'drawer-peek': state.value === 'peek' && !isDragging.value,
  'drawer-expanded': state.value === 'expanded' && !isDragging.value,
  'drawer-dragging': isDragging.value
}))

// 抽屉动态样式
const drawerStyle = computed(() => {
  if (isDragging.value) {
    return {
      transform: `translateY(${dragOffset.value}px)`,
      transition: 'none'
    }
  }
  return {}
})

// 监听外部状态变化
watch(() => props.modelValue, (newValue) => {
  state.value = newValue
})

// 监听内部状态变化
watch(state, (newValue) => {
  emit('update:modelValue', newValue)
  emit('state-change', newValue)
})

/**
 * 展开抽屉
 */
const expand = () => {
  state.value = 'expanded'
}

/**
 * 收起抽屉
 */
const collapse = () => {
  state.value = 'collapsed'
}

/**
 * 预览状态
 */
const peek = () => {
  state.value = 'peek'
}

/**
 * 切换状态
 */
const toggleState = () => {
  if (state.value === 'collapsed') {
    peek()
  } else if (state.value === 'peek') {
    expand()
  } else {
    collapse()
  }
}

/**
 * 获取当前抽屉的 translateY 值
 */
const getCurrentTranslateY = (): number => {
  if (!drawerRef.value) return 0
  
  const height = drawerRef.value.offsetHeight
  const viewportHeight = window.innerHeight
  
  if (state.value === 'collapsed') {
    return height - drawerConfig.value.peekHeight
  } else if (state.value === 'peek') {
    return height - 200
  } else {
    return 0
  }
}

/**
 * 处理触摸开始
 */
const handleTouchStart = (event: TouchEvent) => {
  touchStartY.value = event.touches[0].clientY
  currentY.value = touchStartY.value
  isDragging.value = true
  dragOffset.value = getCurrentTranslateY()
}

/**
 * 处理触摸移动
 */
const handleTouchMove = (event: TouchEvent) => {
  if (!isDragging.value) return
  
  currentY.value = event.touches[0].clientY
  const deltaY = currentY.value - touchStartY.value
  
  // 计算新的偏移量
  const baseOffset = getCurrentTranslateY()
  let newOffset = baseOffset + deltaY
  
  // 限制拖动范围
  const maxOffset = drawerRef.value ? drawerRef.value.offsetHeight - drawerConfig.value.peekHeight : 0
  newOffset = Math.max(0, Math.min(maxOffset, newOffset))
  
  dragOffset.value = newOffset
  
  // 阻止页面滚动
  event.preventDefault()
}

/**
 * 处理内容区触摸开始
 */
const handleContentTouchStart = (event: TouchEvent) => {
  if (!contentRef.value) return
  
  const scrollTop = contentRef.value.scrollTop
  const scrollHeight = contentRef.value.scrollHeight
  const clientHeight = contentRef.value.clientHeight
  
  // 记录初始滚动位置
  const startY = event.touches[0].clientY
  
  // 检查是否在顶部或底部
  const isAtTop = scrollTop === 0
  const isAtBottom = scrollTop + clientHeight >= scrollHeight - 1
  
  // 如果在边界,允许拖动抽屉
  if (isAtTop || isAtBottom) {
    // 不阻止默认行为,允许抽屉拖动
  }
}

/**
 * 处理内容区触摸移动
 */
const handleContentTouchMove = (event: TouchEvent) => {
  if (!contentRef.value) return
  
  const scrollTop = contentRef.value.scrollTop
  const scrollHeight = contentRef.value.scrollHeight
  const clientHeight = contentRef.value.clientHeight
  
  const isAtTop = scrollTop === 0
  const isAtBottom = scrollTop + clientHeight >= scrollHeight - 1
  
  // 如果在边界且向外滑动,阻止滚动穿透
  const deltaY = event.touches[0].clientY - touchStartY.value
  
  if ((isAtTop && deltaY > 0) || (isAtBottom && deltaY < 0)) {
    // 在边界且向外滑动,不阻止(允许抽屉拖动)
  } else if (isAtTop && deltaY < 0) {
    // 在顶部向下滑动,允许内容滚动
    event.stopPropagation()
  } else if (isAtBottom && deltaY > 0) {
    // 在底部向上滑动,允许内容滚动
    event.stopPropagation()
  } else {
    // 正常滚动
    event.stopPropagation()
  }
}

/**
 * 处理滚动事件
 */
const handleScroll = () => {
  if (!contentRef.value) return
  
  const scrollTop = contentRef.value.scrollTop
  const scrollHeight = contentRef.value.scrollHeight
  const clientHeight = contentRef.value.clientHeight
  
  // 设置滚动状态
  isScrolling.value = true
  
  // 清除之前的定时器
  if (scrollTimer) {
    clearTimeout(scrollTimer)
  }
  
  // 300ms 后重置滚动状态
  scrollTimer = window.setTimeout(() => {
    isScrolling.value = false
  }, 300)
  
  // 显示边界指示器
  showTopBoundary.value = scrollTop > 20
  showBottomBoundary.value = scrollTop + clientHeight < scrollHeight - 20
}

/**
 * 处理触摸结束
 */
const handleTouchEnd = () => {
  if (!isDragging.value) return
  
  const deltaY = currentY.value - touchStartY.value
  const threshold = drawerConfig.value.swipeThreshold
  
  // 根据滑动距离和方向决定最终状态
  if (Math.abs(deltaY) < threshold) {
    // 滑动距离不足，保持原状态
    isDragging.value = false
    dragOffset.value = 0
    return
  }
  
  if (deltaY > 0) {
    // 向下滑动
    if (state.value === 'expanded') {
      peek()
    } else if (state.value === 'peek') {
      collapse()
    }
  } else {
    // 向上滑动
    if (state.value === 'collapsed') {
      peek()
    } else if (state.value === 'peek') {
      expand()
    }
  }
  
  isDragging.value = false
  dragOffset.value = 0
}

// 暴露方法给父组件
defineExpose({
  expand,
  collapse,
  peek,
  state
})
</script>

<style scoped>
.drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 999;
}

.overlay-fade-enter-active,
.overlay-fade-leave-active {
  transition: opacity 0.3s ease;
}

.overlay-fade-enter-from,
.overlay-fade-leave-to {
  opacity: 0;
}

.bottom-drawer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(180deg, #1a1a1a 0%, #0f0f0f 100%);
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.5);
  z-index: 1000;
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.drawer-collapsed {
  transform: translateY(calc(100% - 60px));
}

.drawer-peek {
  transform: translateY(calc(100% - 200px));
}

.drawer-expanded {
  transform: translateY(0);
  height: 60vh;
}

.drawer-dragging {
  transition: none !important;
}

.drawer-handle {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  flex-shrink: 0;
  touch-action: none;
  user-select: none;
}

.drawer-handle:active {
  cursor: grabbing;
}

.handle-bar {
  width: 48px;
  height: 5px;
  background: #666;
  border-radius: 3px;
  transition: background 0.2s ease;
}

.drawer-handle:hover .handle-bar {
  background: #888;
}

.drawer-content {
  flex: 1;
  padding: 0 20px 20px;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  position: relative;
}

/* 滚动边界效果 */
.scroll-boundary-top,
.scroll-boundary-bottom {
  position: absolute;
  left: 0;
  right: 0;
  height: 40px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s ease;
  z-index: 10;
}

.scroll-boundary-top {
  top: 48px; /* 手柄高度 */
  background: linear-gradient(to bottom, rgba(26, 26, 26, 0.95), transparent);
}

.scroll-boundary-bottom {
  bottom: 0;
  background: linear-gradient(to top, rgba(26, 26, 26, 0.95), transparent);
}

.scroll-boundary-top.visible,
.scroll-boundary-bottom.visible {
  opacity: 1;
}

/* 防止滚动穿透 */
.drawer-content.scrolling {
  touch-action: pan-y;
}

/* 隐藏滚动条但保持滚动功能 */
.drawer-content::-webkit-scrollbar {
  display: none;
}

.drawer-content {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* 移动端优化 */
@media (max-width: 768px) {
  .bottom-drawer {
    border-top-left-radius: 16px;
    border-top-right-radius: 16px;
  }
  
  .drawer-content {
    padding: 0 16px 16px;
  }
}

/* 横屏模式优化 */
@media (max-width: 768px) and (orientation: landscape) {
  .drawer-expanded {
    height: 70vh;
  }
}
</style>
