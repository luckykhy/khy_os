/**
 * @pattern Observer
 */
import { ref, onMounted, onUnmounted, computed } from 'vue'

/**
 * 响应式布局管理器
 * 检测视口尺寸并提供响应式状态
 */

// 响应式断点定义
const BREAKPOINTS = {
  mobile: 1024,   // < 1024px (调整为更大的断点,包含平板)
  tablet: 1280    // 1024px - 1280px
}

export function useResponsive() {
  // 视口尺寸
  const viewportWidth = ref(window.innerWidth)
  const viewportHeight = ref(window.innerHeight)
  
  // 设备类型状态
  const isMobile = computed(() => viewportWidth.value < BREAKPOINTS.mobile)
  const isTablet = computed(() => 
    viewportWidth.value >= BREAKPOINTS.mobile && 
    viewportWidth.value < BREAKPOINTS.tablet
  )
  const isDesktop = computed(() => viewportWidth.value >= BREAKPOINTS.tablet)
  
  // 屏幕方向
  const isPortrait = computed(() => viewportHeight.value > viewportWidth.value)
  const isLandscape = computed(() => viewportWidth.value >= viewportHeight.value)
  
  // 视口模式
  const viewportMode = computed(() => {
    if (isMobile.value) return 'mobile'
    if (isTablet.value) return 'tablet'
    return 'desktop'
  })
  
  // 更新视口尺寸
  const updateViewport = () => {
    viewportWidth.value = window.innerWidth
    viewportHeight.value = window.innerHeight
  }
  
  // 媒体查询监听器
  let mobileMediaQuery: MediaQueryList | null = null
  let tabletMediaQuery: MediaQueryList | null = null
  
  // 媒体查询变化处理
  const handleMediaQueryChange = () => {
    updateViewport()
  }
  
  // ResizeObserver 实例
  let resizeObserver: ResizeObserver | null = null
  
  // 初始化监听
  const initListeners = () => {
    // 监听窗口 resize 事件
    window.addEventListener('resize', updateViewport)
    
    // 监听屏幕方向变化
    window.addEventListener('orientationchange', updateViewport)
    
    // 使用 matchMedia 监听媒体查询变化
    mobileMediaQuery = window.matchMedia(`(max-width: ${BREAKPOINTS.mobile - 1}px)`)
    tabletMediaQuery = window.matchMedia(
      `(min-width: ${BREAKPOINTS.mobile}px) and (max-width: ${BREAKPOINTS.tablet - 1}px)`
    )
    
    // 添加媒体查询监听器
    if (mobileMediaQuery.addEventListener) {
      mobileMediaQuery.addEventListener('change', handleMediaQueryChange)
      tabletMediaQuery?.addEventListener('change', handleMediaQueryChange)
    } else {
      // 兼容旧版浏览器
      mobileMediaQuery.addListener(handleMediaQueryChange)
      tabletMediaQuery?.addListener(handleMediaQueryChange)
    }
    
    // 使用 ResizeObserver 监听 body 尺寸变化
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        updateViewport()
      })
      resizeObserver.observe(document.body)
    }
  }
  
  // 清理监听
  const cleanupListeners = () => {
    window.removeEventListener('resize', updateViewport)
    window.removeEventListener('orientationchange', updateViewport)
    
    if (mobileMediaQuery) {
      if (mobileMediaQuery.removeEventListener) {
        mobileMediaQuery.removeEventListener('change', handleMediaQueryChange)
      } else {
        mobileMediaQuery.removeListener(handleMediaQueryChange)
      }
    }
    
    if (tabletMediaQuery) {
      if (tabletMediaQuery.removeEventListener) {
        tabletMediaQuery.removeEventListener('change', handleMediaQueryChange)
      } else {
        tabletMediaQuery.removeListener(handleMediaQueryChange)
      }
    }
    
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
  }
  
  // 获取移动端配置
  const getMobileConfig = () => {
    return {
      chartHeight: isMobile.value 
        ? (isLandscape.value ? '70vh' : '60vh')
        : '500px',
      toolbarLayout: isMobile.value ? 'compact' : 'full',
      panelPosition: isMobile.value ? 'bottom' : 'right',
      maxKlineCount: isMobile.value ? 60 : 120,
      enableAnimations: !isMobile.value
    }
  }
  
  // 生命周期钩子
  onMounted(() => {
    initListeners()
  })
  
  onUnmounted(() => {
    cleanupListeners()
  })
  
  return {
    // 视口尺寸
    viewportWidth,
    viewportHeight,
    
    // 设备类型
    isMobile,
    isTablet,
    isDesktop,
    
    // 屏幕方向
    isPortrait,
    isLandscape,
    
    // 视口模式
    viewportMode,
    
    // 配置获取
    getMobileConfig
  }
}
