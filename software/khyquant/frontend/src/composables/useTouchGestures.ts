/**
 * @pattern Observer
 */
import { ref, onUnmounted } from 'vue'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'

/**
 * 触摸手势配置接口
 */
export interface GestureConfig {
  enablePinchZoom: boolean      // 启用双指缩放
  enablePan: boolean             // 启用单指拖动
  enableLongPress: boolean       // 启用长按
  longPressDelay: number         // 长按延迟（毫秒）
  minZoomLevel: number           // 最少显示K线数
  maxZoomLevel: number           // 最多显示K线数
  panThreshold: number           // 拖动阈值（像素）
  preventPageScroll: boolean     // 防止页面滚动
}

/**
 * 触摸状态接口
 */
interface TouchState {
  touches: Touch[]
  initialDistance: number
  initialVisibleRange: number
  isPanning: boolean
  isZooming: boolean
  longPressTimer: number | null
  panStartX: number
  panStartY: number
  lastTouchTime: number
}

/**
 * 触摸手势处理器
 * 处理K线图上的触摸手势交互
 */
export function useTouchGestures(config: Partial<GestureConfig> = {}) {
  // 默认配置
  const defaultConfig: GestureConfig = {
    enablePinchZoom: true,
    enablePan: true,
    enableLongPress: true,
    longPressDelay: 500,
    minZoomLevel: 10,
    maxZoomLevel: 100,
    panThreshold: 5,
    preventPageScroll: true
  }
  
  const gestureConfig = { ...defaultConfig, ...config }
  
  // 触摸状态
  const touchState = ref<TouchState>({
    touches: [],
    initialDistance: 0,
    initialVisibleRange: 0,
    isPanning: false,
    isZooming: false,
    longPressTimer: null,
    panStartX: 0,
    panStartY: 0,
    lastTouchTime: 0
  })
  
  // 图表实例引用
  let chartInstance: IChartApi | null = null
  let chartElement: HTMLElement | null = null
  let candlestickSeries: ISeriesApi<'Candlestick'> | null = null
  
  /**
   * 计算两个触摸点之间的距离
   */
  const getTouchDistance = (touch1: Touch, touch2: Touch): number => {
    const dx = touch2.clientX - touch1.clientX
    const dy = touch2.clientY - touch1.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }
  
  /**
   * 获取当前可见范围
   */
  const getVisibleRange = (): number => {
    if (!chartInstance) return 60
    
    const timeScale = chartInstance.timeScale()
    const visibleRange = timeScale.getVisibleRange()
    
    if (!visibleRange) return 60
    
    // 计算可见的K线数量
    const from = visibleRange.from as number
    const to = visibleRange.to as number
    
    // 假设每根K线代表一天
    const daysDiff = Math.floor((to - from) / 86400)
    return Math.max(daysDiff, 10)
  }
  
  /**
   * 设置可见范围
   */
  const setVisibleRange = (barsCount: number) => {
    if (!chartInstance || !candlestickSeries) return
    
    try {
      const timeScale = chartInstance.timeScale()
      
      // 限制范围
      const clampedCount = Math.max(
        gestureConfig.minZoomLevel,
        Math.min(gestureConfig.maxZoomLevel, barsCount)
      )
      
      // 设置可见范围
      timeScale.setVisibleLogicalRange({
        from: -clampedCount,
        to: 0
      })
    } catch (error) {
      console.error('设置可见范围失败:', error)
    }
  }
  
  /**
   * 滚动图表
   */
  const scrollChart = (barsDelta: number) => {
    if (!chartInstance) return
    
    try {
      const timeScale = chartInstance.timeScale()
      timeScale.scrollToPosition(-barsDelta, false)
    } catch (error) {
      console.error('滚动图表失败:', error)
    }
  }
  
  /**
   * 获取K线宽度
   */
  const getBarWidth = (): number => {
    if (!chartInstance) return 8
    
    const timeScale = chartInstance.timeScale()
    const options = timeScale.options()
    return options.barSpacing || 8
  }
  
  /**
   * 显示十字光标
   */
  const showCrosshair = (clientX: number, clientY: number) => {
    if (!chartInstance || !chartElement) return
    
    try {
      const rect = chartElement.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top
      
      // 触发十字光标移动
      chartInstance.setCrosshairPosition(x, y, candlestickSeries!)
    } catch (error) {
      console.error('显示十字光标失败:', error)
    }
  }
  
  /**
   * 处理触摸开始
   */
  const handleTouchStart = (event: TouchEvent) => {
    const state = touchState.value
    state.touches = Array.from(event.touches)
    state.lastTouchTime = Date.now()
    
    if (event.touches.length === 2 && gestureConfig.enablePinchZoom) {
      // 双指缩放开始
      state.isZooming = true
      state.isPanning = false
      state.initialDistance = getTouchDistance(event.touches[0], event.touches[1])
      state.initialVisibleRange = getVisibleRange()
      
      // 清除长按定时器
      if (state.longPressTimer) {
        clearTimeout(state.longPressTimer)
        state.longPressTimer = null
      }
      
      if (gestureConfig.preventPageScroll) {
        event.preventDefault()
      }
    } else if (event.touches.length === 1) {
      // 单指操作
      const touch = event.touches[0]
      state.panStartX = touch.clientX
      state.panStartY = touch.clientY
      state.isPanning = false
      state.isZooming = false
      
      // 启动长按定时器
      if (gestureConfig.enableLongPress) {
        state.longPressTimer = window.setTimeout(() => {
          showCrosshair(touch.clientX, touch.clientY)
          
          // 触觉反馈
          if (navigator.vibrate) {
            navigator.vibrate(50)
          }
        }, gestureConfig.longPressDelay)
      }
    }
  }
  
  /**
   * 处理触摸移动
   */
  const handleTouchMove = (event: TouchEvent) => {
    const state = touchState.value
    
    if (event.touches.length === 2 && gestureConfig.enablePinchZoom && state.isZooming) {
      // 双指缩放
      const currentDistance = getTouchDistance(event.touches[0], event.touches[1])
      
      if (state.initialDistance > 0) {
        // 计算缩放比例
        const scale = currentDistance / state.initialDistance
        
        // 计算新的可见范围
        const newVisibleRange = Math.floor(state.initialVisibleRange / scale)
        
        // 应用到图表
        setVisibleRange(newVisibleRange)
      }
      
      if (gestureConfig.preventPageScroll) {
        event.preventDefault()
      }
    } else if (event.touches.length === 1 && gestureConfig.enablePan) {
      // 单指拖动
      const touch = event.touches[0]
      const deltaX = touch.clientX - state.panStartX
      const deltaY = Math.abs(touch.clientY - state.panStartY)
      
      // 清除长按定时器
      if (state.longPressTimer && Math.abs(deltaX) > gestureConfig.panThreshold) {
        clearTimeout(state.longPressTimer)
        state.longPressTimer = null
      }
      
      if (!state.isPanning && Math.abs(deltaX) > gestureConfig.panThreshold) {
        state.isPanning = true
      }
      
      if (state.isPanning) {
        // 转换为K线数量
        const barWidth = getBarWidth()
        const barsDelta = Math.floor(deltaX / barWidth)
        
        if (Math.abs(barsDelta) > 0) {
          scrollChart(barsDelta)
          state.panStartX = touch.clientX
        }
        
        // 防止页面滚动（仅在水平滑动时）
        if (gestureConfig.preventPageScroll && Math.abs(deltaX) > deltaY) {
          event.preventDefault()
        }
      }
    }
  }
  
  /**
   * 处理触摸结束
   */
  const handleTouchEnd = (event: TouchEvent) => {
    const state = touchState.value
    
    // 清除长按定时器
    if (state.longPressTimer) {
      clearTimeout(state.longPressTimer)
      state.longPressTimer = null
    }
    
    // 重置状态
    if (event.touches.length === 0) {
      state.isPanning = false
      state.isZooming = false
      state.initialDistance = 0
      state.initialVisibleRange = 0
    } else if (event.touches.length === 1) {
      // 从双指变为单指，重置缩放状态
      state.isZooming = false
      state.initialDistance = 0
      
      const touch = event.touches[0]
      state.panStartX = touch.clientX
      state.panStartY = touch.clientY
    }
    
    state.touches = Array.from(event.touches)
  }
  
  /**
   * 处理触摸取消
   */
  const handleTouchCancel = (event: TouchEvent) => {
    const state = touchState.value
    
    // 清除长按定时器
    if (state.longPressTimer) {
      clearTimeout(state.longPressTimer)
      state.longPressTimer = null
    }
    
    // 重置所有状态
    state.isPanning = false
    state.isZooming = false
    state.initialDistance = 0
    state.initialVisibleRange = 0
    state.touches = []
  }
  
  /**
   * 初始化手势监听
   */
  const init = (
    element: HTMLElement,
    chart: IChartApi,
    series?: ISeriesApi<'Candlestick'>
  ) => {
    chartElement = element
    chartInstance = chart
    candlestickSeries = series || null
    
    // 添加触摸事件监听
    element.addEventListener('touchstart', handleTouchStart, { passive: false })
    element.addEventListener('touchmove', handleTouchMove, { passive: false })
    element.addEventListener('touchend', handleTouchEnd, { passive: false })
    element.addEventListener('touchcancel', handleTouchCancel, { passive: false })
  }
  
  /**
   * 清理事件监听
   */
  const destroy = () => {
    if (chartElement) {
      chartElement.removeEventListener('touchstart', handleTouchStart)
      chartElement.removeEventListener('touchmove', handleTouchMove)
      chartElement.removeEventListener('touchend', handleTouchEnd)
      chartElement.removeEventListener('touchcancel', handleTouchCancel)
    }
    
    // 清除定时器
    if (touchState.value.longPressTimer) {
      clearTimeout(touchState.value.longPressTimer)
      touchState.value.longPressTimer = null
    }
    
    chartElement = null
    chartInstance = null
    candlestickSeries = null
  }
  
  // 组件卸载时清理
  onUnmounted(() => {
    destroy()
  })
  
  return {
    init,
    destroy,
    touchState,
    config: gestureConfig
  }
}
