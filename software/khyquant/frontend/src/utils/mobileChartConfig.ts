/**
 * @pattern Flyweight
 */
import { CrosshairMode } from 'lightweight-charts'

/**
 * 移动端 K线图配置
 * 提供针对移动设备优化的图表配置参数
 */

/**
 * 获取移动端图表配置
 * @param width 图表宽度
 * @param height 图表高度
 * @returns 移动端优化的图表配置
 */
export function getMobileChartOptions(width: number, height: number) {
  return {
    width,
    height,
    layout: {
      background: { color: '#0a0a0a' },
      textColor: '#e0e0e0',
      fontSize: 12 // 移动端增大字体
    },
    grid: {
      vertLines: {
        color: '#404040',
        visible: true,
        style: 0
      },
      horzLines: {
        color: '#404040',
        visible: true,
        style: 0
      }
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        width: 2, // 移动端加粗十字线
        color: '#758696',
        style: 0,
        labelBackgroundColor: '#4682B4'
      },
      horzLine: {
        width: 2, // 移动端加粗十字线
        color: '#758696',
        style: 0,
        labelBackgroundColor: '#4682B4'
      }
    },
    rightPriceScale: {
      borderColor: '#606060',
      scaleMargins: {
        top: 0.1,
        bottom: 0.2
      },
      autoScale: true
    },
    timeScale: {
      borderColor: '#606060',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 5, // 移动端减少右侧偏移
      barSpacing: 8, // 移动端增大K线间距
      minBarSpacing: 4,
      fixLeftEdge: false,
      fixRightEdge: false,
      lockVisibleTimeRangeOnResize: true,
      rightBarStaysOnScroll: true,
      borderVisible: true,
      visible: true,
      tickMarkFormatter: (time: any) => {
        const date = new Date(time * 1000)
        return `${date.getMonth() + 1}/${date.getDate()}`
      }
    },
    localization: {
      locale: 'zh-CN',
      dateFormat: 'yyyy年MM月dd日',
      timeFormatter: (time: any) => {
        const date = new Date(time * 1000)
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const hour = String(date.getHours()).padStart(2, '0')
        const minute = String(date.getMinutes()).padStart(2, '0')
        
        // 如果有时分信息，显示完整时间
        if (hour !== '00' || minute !== '00') {
          return `${year}年${month}月${day}日 ${hour}:${minute}`
        }
        // 否则只显示日期
        return `${year}年${month}月${day}日`
      }
    },
    // 禁用默认的鼠标和触摸事件处理，使用自定义手势
    handleScroll: {
      mouseWheel: false, // 禁用鼠标滚轮
      pressedMouseMove: false,
      horzTouchDrag: false, // 禁用默认水平触摸拖动
      vertTouchDrag: false // 禁用默认垂直触摸拖动
    },
    handleScale: {
      axisPressedMouseMove: false,
      mouseWheel: false,
      pinch: false // 禁用默认缩放，使用自定义手势
    },
    kineticScroll: {
      touch: false, // 禁用默认惯性滚动
      mouse: false
    }
  }
}

/**
 * 获取移动端 K线系列配置
 * @returns 移动端优化的 K线系列配置
 */
export function getMobileCandlestickOptions() {
  return {
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: true,
    wickVisible: true,
    borderColor: '#26a69a',
    wickColor: '#26a69a',
    borderUpColor: '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
    priceFormat: {
      type: 'price',
      precision: 2,
      minMove: 0.01
    }
  }
}

/**
 * 获取移动端价格轴配置
 * @returns 移动端优化的价格轴配置
 */
export function getMobilePriceScaleOptions() {
  return {
    autoScale: true,
    scaleMargins: {
      top: 0.1,
      bottom: 0.2
    },
    borderVisible: true,
    borderColor: '#606060',
    textColor: '#e0e0e0',
    fontSize: 12, // 移动端增大价格标签字体
    entireTextOnly: false,
    visible: true,
    alignLabels: true,
    mode: 0 // Normal mode
  }
}

/**
 * 获取移动端时间轴配置
 * @returns 移动端优化的时间轴配置
 */
export function getMobileTimeScaleOptions() {
  return {
    rightOffset: 5,
    barSpacing: 8,
    minBarSpacing: 4,
    fixLeftEdge: false,
    fixRightEdge: false,
    lockVisibleTimeRangeOnResize: true,
    rightBarStaysOnScroll: true,
    borderVisible: true,
    borderColor: '#606060',
    visible: true,
    timeVisible: true,
    secondsVisible: false,
    tickMarkFormatter: (time: any) => {
      const date = new Date(time * 1000)
      return `${date.getMonth() + 1}/${date.getDate()}`
    }
  }
}

/**
 * 获取桌面端图表配置
 * @param width 图表宽度
 * @param height 图表高度
 * @returns 桌面端图表配置
 */
export function getDesktopChartOptions(width: number, height: number) {
  return {
    width,
    height,
    layout: {
      background: { color: '#0a0a0a' },
      textColor: '#d1d4dc',
      fontSize: 11
    },
    grid: {
      vertLines: {
        color: '#2B2B43',
        visible: true
      },
      horzLines: {
        color: '#2B2B43',
        visible: true
      }
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        width: 1,
        color: '#758696',
        style: 0,
        labelBackgroundColor: '#4682B4'
      },
      horzLine: {
        width: 1,
        color: '#758696',
        style: 0,
        labelBackgroundColor: '#4682B4'
      }
    },
    rightPriceScale: {
      borderColor: '#2B2B43',
      scaleMargins: {
        top: 0.1,
        bottom: 0.2
      },
      autoScale: true
    },
    timeScale: {
      borderColor: '#2B2B43',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 10,
      barSpacing: 6,
      minBarSpacing: 2,
      fixLeftEdge: false,
      fixRightEdge: false
    },
    localization: {
      locale: 'zh-CN',
      dateFormat: 'yyyy年MM月dd日',
      timeFormatter: (time: any) => {
        const date = new Date(time * 1000)
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const hour = String(date.getHours()).padStart(2, '0')
        const minute = String(date.getMinutes()).padStart(2, '0')
        
        // 如果有时分信息，显示完整时间
        if (hour !== '00' || minute !== '00') {
          return `${year}年${month}月${day}日 ${hour}:${minute}`
        }
        // 否则只显示日期
        return `${year}年${month}月${day}日`
      }
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true
    }
  }
}

/**
 * 获取图表配置（根据设备类型自动选择）
 * @param isMobile 是否为移动端
 * @param width 图表宽度
 * @param height 图表高度
 * @returns 适配的图表配置
 */
export function getChartOptions(isMobile: boolean, width: number, height: number) {
  return isMobile 
    ? getMobileChartOptions(width, height)
    : getDesktopChartOptions(width, height)
}
