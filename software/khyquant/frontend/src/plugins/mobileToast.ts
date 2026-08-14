/**
 * @pattern Flyweight
 */
import { createApp, h } from 'vue'
import MobileToast from '@/components/MobileToast.vue'
import type { App } from 'vue'

interface ToastOptions {
  message: string
  description?: string
  type?: 'success' | 'error' | 'warning' | 'info'
  duration?: number
  important?: boolean
  vibrate?: boolean
}

class MobileToastManager {
  private container: HTMLElement | null = null
  private currentToast: any = null

  constructor() {
    this.createContainer()
  }

  private createContainer() {
    if (typeof document === 'undefined') return
    
    this.container = document.createElement('div')
    this.container.id = 'mobile-toast-container'
    document.body.appendChild(this.container)
  }

  show(options: ToastOptions) {
    // 如果已有Toast，先关闭
    if (this.currentToast) {
      this.currentToast.unmount()
    }

    // 创建新的Toast实例
    const toastApp = createApp({
      render() {
        return h(MobileToast, {
          ...options,
          onClose: () => {
            toastApp.unmount()
            if (this.container) {
              this.container.innerHTML = ''
            }
            this.currentToast = null
          }
        })
      }
    })

    if (this.container) {
      this.currentToast = toastApp.mount(this.container)
    }

    return this.currentToast
  }

  success(message: string, description?: string, duration?: number) {
    return this.show({
      message,
      description,
      type: 'success',
      duration: duration ?? 3000
    })
  }

  error(message: string, description?: string, important?: boolean) {
    return this.show({
      message,
      description,
      type: 'error',
      duration: important ? 0 : 3000,
      important
    })
  }

  warning(message: string, description?: string, duration?: number) {
    return this.show({
      message,
      description,
      type: 'warning',
      duration: duration ?? 3000
    })
  }

  info(message: string, description?: string, duration?: number) {
    return this.show({
      message,
      description,
      type: 'info',
      duration: duration ?? 3000
    })
  }
}

// 创建单例
const mobileToast = new MobileToastManager()

// Vue插件
export default {
  install(app: App) {
    app.config.globalProperties.$mobileToast = mobileToast
  }
}

// 导出实例供直接使用
export { mobileToast }

// TypeScript类型声明
declare module '@vue/runtime-core' {
  interface ComponentCustomProperties {
    $mobileToast: MobileToastManager
  }
}
