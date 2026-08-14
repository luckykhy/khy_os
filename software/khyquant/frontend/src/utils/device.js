/**
 * 设备检测工具
 * 用于判断当前设备类型（手机、平板、桌面）
 */

/**
 * 检测是否为移动设备
 * @returns {boolean}
 */
export function isMobile() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera
  
  // 检测移动设备的User Agent
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i
  
  // 检测屏幕宽度
  const screenWidth = window.innerWidth
  
  return mobileRegex.test(userAgent) || screenWidth <= 768
}

/**
 * 检测是否为平板设备
 * @returns {boolean}
 */
export function isTablet() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera
  const tabletRegex = /iPad|Android(?!.*Mobile)/i
  const screenWidth = window.innerWidth
  
  return tabletRegex.test(userAgent) || (screenWidth > 768 && screenWidth <= 1024)
}

/**
 * 检测是否为桌面设备
 * @returns {boolean}
 */
export function isDesktop() {
  return !isMobile() && !isTablet()
}

/**
 * 获取设备类型
 * @returns {'mobile' | 'tablet' | 'desktop'}
 */
export function getDeviceType() {
  if (isMobile()) return 'mobile'
  if (isTablet()) return 'tablet'
  return 'desktop'
}

/**
 * 检测是否为触摸设备
 * @returns {boolean}
 */
export function isTouchDevice() {
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    navigator.msMaxTouchPoints > 0
  )
}

/**
 * 获取屏幕尺寸信息
 * @returns {object}
 */
export function getScreenInfo() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    orientation: window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'
  }
}

/**
 * 监听屏幕尺寸变化
 * @param {Function} callback
 * @returns {Function} 取消监听的函数
 */
export function onResize(callback) {
  const handler = () => {
    callback({
      deviceType: getDeviceType(),
      screenInfo: getScreenInfo(),
      isMobile: isMobile(),
      isTablet: isTablet(),
      isDesktop: isDesktop()
    })
  }
  
  window.addEventListener('resize', handler)
  window.addEventListener('orientationchange', handler)
  
  // 返回取消监听的函数
  return () => {
    window.removeEventListener('resize', handler)
    window.removeEventListener('orientationchange', handler)
  }
}

/**
 * 获取操作系统信息
 * @returns {string}
 */
export function getOS() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera
  
  if (/windows phone/i.test(userAgent)) return 'Windows Phone'
  if (/android/i.test(userAgent)) return 'Android'
  if (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) return 'iOS'
  if (/Mac/.test(userAgent)) return 'MacOS'
  if (/Win/.test(userAgent)) return 'Windows'
  if (/Linux/.test(userAgent)) return 'Linux'
  
  return 'Unknown'
}

/**
 * 获取浏览器信息
 * @returns {string}
 */
export function getBrowser() {
  const userAgent = navigator.userAgent
  
  if (userAgent.indexOf('Firefox') > -1) return 'Firefox'
  if (userAgent.indexOf('Opera') > -1 || userAgent.indexOf('OPR') > -1) return 'Opera'
  if (userAgent.indexOf('Trident') > -1) return 'IE'
  if (userAgent.indexOf('Edge') > -1) return 'Edge'
  if (userAgent.indexOf('Chrome') > -1) return 'Chrome'
  if (userAgent.indexOf('Safari') > -1) return 'Safari'
  
  return 'Unknown'
}

/**
 * 获取完整的设备信息
 * @returns {object}
 */
export function getDeviceInfo() {
  return {
    deviceType: getDeviceType(),
    isMobile: isMobile(),
    isTablet: isTablet(),
    isDesktop: isDesktop(),
    isTouchDevice: isTouchDevice(),
    os: getOS(),
    browser: getBrowser(),
    screenInfo: getScreenInfo(),
    userAgent: navigator.userAgent
  }
}

// 默认导出
export default {
  isMobile,
  isTablet,
  isDesktop,
  getDeviceType,
  isTouchDevice,
  getScreenInfo,
  onResize,
  getOS,
  getBrowser,
  getDeviceInfo
}
