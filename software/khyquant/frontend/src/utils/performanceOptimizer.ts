/**
 * 性能优化工具
 * 提供数据节流、防抖、节流等性能优化功能
  * @pattern Flyweight
 */

/**
 * K线数据接口
 */
export interface KlineData {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

/**
 * 数据节流 - 限制数据数量
 * @param data K线数据数组
 * @param maxCount 最大数量
 * @returns 节流后的数据
 */
export function throttleData<T>(data: T[], maxCount: number): T[] {
  if (!data || data.length <= maxCount) {
    return data
  }
  
  // 保留最新的 maxCount 条数据
  return data.slice(-maxCount)
}

/**
 * 防抖函数
 * 在事件触发后延迟执行，如果在延迟期间再次触发则重新计时
 * @param func 要执行的函数
 * @param delay 延迟时间（毫秒）
 * @returns 防抖后的函数
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: number | null = null
  
  return function(this: any, ...args: Parameters<T>) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
    }
    
    timeoutId = window.setTimeout(() => {
      func.apply(this, args)
      timeoutId = null
    }, delay)
  }
}

/**
 * 节流函数
 * 限制函数在指定时间内只能执行一次
 * @param func 要执行的函数
 * @param delay 时间间隔（毫秒）
 * @returns 节流后的函数
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let lastCall = 0
  let timeoutId: number | null = null
  
  return function(this: any, ...args: Parameters<T>) {
    const now = Date.now()
    const timeSinceLastCall = now - lastCall
    
    if (timeSinceLastCall >= delay) {
      // 立即执行
      func.apply(this, args)
      lastCall = now
    } else {
      // 延迟执行最后一次调用
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
      }
      
      timeoutId = window.setTimeout(() => {
        func.apply(this, args)
        lastCall = Date.now()
        timeoutId = null
      }, delay - timeSinceLastCall)
    }
  }
}

/**
 * 启用硬件加速
 * 通过 CSS transform 触发 GPU 加速
 * @param element HTML 元素
 */
export function enableHardwareAcceleration(element: HTMLElement): void {
  if (!element) return
  
  element.style.transform = 'translateZ(0)'
  element.style.willChange = 'transform'
  element.style.backfaceVisibility = 'hidden'
  element.style.perspective = '1000px'
}

/**
 * 禁用硬件加速
 * @param element HTML 元素
 */
export function disableHardwareAcceleration(element: HTMLElement): void {
  if (!element) return
  
  element.style.transform = ''
  element.style.willChange = ''
  element.style.backfaceVisibility = ''
  element.style.perspective = ''
}

/**
 * 请求动画帧节流
 * 使用 requestAnimationFrame 限制函数执行频率
 * @param func 要执行的函数
 * @returns 节流后的函数
 */
export function rafThrottle<T extends (...args: any[]) => any>(
  func: T
): (...args: Parameters<T>) => void {
  let rafId: number | null = null
  let lastArgs: Parameters<T> | null = null
  
  return function(this: any, ...args: Parameters<T>) {
    lastArgs = args
    
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        if (lastArgs !== null) {
          func.apply(this, lastArgs)
          lastArgs = null
        }
        rafId = null
      })
    }
  }
}

/**
 * 内存清理工具
 */
export class MemoryManager {
  private caches: Map<string, any> = new Map()
  private maxCacheSize: number
  
  constructor(maxCacheSize: number = 100) {
    this.maxCacheSize = maxCacheSize
  }
  
  /**
   * 设置缓存
   */
  set(key: string, value: any): void {
    // 如果超过最大缓存数量，删除最早的缓存
    if (this.caches.size >= this.maxCacheSize) {
      const firstKey = this.caches.keys().next().value
      this.caches.delete(firstKey)
    }
    
    this.caches.set(key, value)
  }
  
  /**
   * 获取缓存
   */
  get(key: string): any {
    return this.caches.get(key)
  }
  
  /**
   * 删除缓存
   */
  delete(key: string): boolean {
    return this.caches.delete(key)
  }
  
  /**
   * 清空所有缓存
   */
  clear(): void {
    this.caches.clear()
  }
  
  /**
   * 获取缓存大小
   */
  size(): number {
    return this.caches.size
  }
}

/**
 * 图片懒加载
 * @param element 图片元素
 * @param src 图片源
 */
export function lazyLoadImage(element: HTMLImageElement, src: string): void {
  if (!element || !src) return
  
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          element.src = src
          observer.unobserve(element)
        }
      })
    })
    
    observer.observe(element)
  } else {
    // 不支持 IntersectionObserver，直接加载
    element.src = src
  }
}

/**
 * 批量处理
 * 将多个操作合并为一次执行
 * @param operations 操作数组
 * @param batchSize 批次大小
 * @param delay 批次间延迟（毫秒）
 */
export async function batchProcess<T>(
  operations: (() => T)[],
  batchSize: number = 10,
  delay: number = 0
): Promise<T[]> {
  const results: T[] = []
  
  for (let i = 0; i < operations.length; i += batchSize) {
    const batch = operations.slice(i, i + batchSize)
    const batchResults = batch.map(op => op())
    results.push(...batchResults)
    
    // 批次间延迟
    if (delay > 0 && i + batchSize < operations.length) {
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  
  return results
}

/**
 * 检测设备性能
 * @returns 性能等级 (high, medium, low)
 */
export function detectPerformance(): 'high' | 'medium' | 'low' {
  // 检测硬件并发数
  const cores = navigator.hardwareConcurrency || 2
  
  // 检测内存（如果可用）
  const memory = (navigator as any).deviceMemory || 4
  
  // 检测连接速度（如果可用）
  const connection = (navigator as any).connection
  const effectiveType = connection?.effectiveType || '4g'
  
  // 综合评分
  let score = 0
  
  if (cores >= 8) score += 3
  else if (cores >= 4) score += 2
  else score += 1
  
  if (memory >= 8) score += 3
  else if (memory >= 4) score += 2
  else score += 1
  
  if (effectiveType === '4g') score += 2
  else if (effectiveType === '3g') score += 1
  
  if (score >= 7) return 'high'
  if (score >= 4) return 'medium'
  return 'low'
}

/**
 * 获取移动端优化配置
 * @param performanceLevel 性能等级
 * @returns 优化配置
 */
export function getMobileOptimizationConfig(performanceLevel?: 'high' | 'medium' | 'low') {
  const level = performanceLevel || detectPerformance()
  
  return {
    maxKlineCount: level === 'high' ? 100 : level === 'medium' ? 60 : 30,
    enableAnimations: level === 'high',
    maxIndicators: level === 'high' ? 3 : 2,
    debounceDelay: level === 'high' ? 100 : level === 'medium' ? 200 : 300,
    throttleDelay: level === 'high' ? 50 : level === 'medium' ? 100 : 150,
    enableHardwareAcceleration: true,
    lazyLoadImages: level !== 'high'
  }
}
