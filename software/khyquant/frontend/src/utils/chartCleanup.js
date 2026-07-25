/**
 * 安全地清理 lightweight-charts 图表对象
 * 防止 "Object is disposed" 错误
 */

/**
 * 清理图表系列
 * @param {Object} chart - 图表对象
 * @param {Object} series - 系列对象
 */
export function removeSeries(chart, series) {
  if (!chart || !series) return
  
  try {
    chart.removeSeries(series)
  } catch (error) {
    console.log('移除系列时出错:', error.message)
  }
}

/**
 * 安全地清理图表对象
 * @param {Object} chart - 图表对象
 * @param {Array} seriesList - 系列对象数组
 */
export function safelyDisposeChart(chart, seriesList = []) {
  if (!chart) return
  
  try {
    // 先移除所有系列
    seriesList.forEach(series => {
      if (series) {
        removeSeries(chart, series)
      }
    })
    
    // 然后移除图表
    chart.remove()
  } catch (error) {
    console.log('清理图表时出错:', error.message)
  }
}

/**
 * 创建安全的图表清理函数
 * @param {Object} chartRef - 图表ref对象
 * @param {Object} seriesRefs - 系列ref对象
 * @returns {Function} 清理函数
 */
export function createChartCleanup(chartRef, seriesRefs = {}) {
  return () => {
    if (!chartRef.value) return
    
    try {
      // 收集所有系列
      const seriesList = Object.values(seriesRefs)
        .filter(ref => ref && ref.value)
        .map(ref => ref.value)
      
      // 清理图表
      safelyDisposeChart(chartRef.value, seriesList)
      
      // 清空所有ref
      chartRef.value = null
      Object.keys(seriesRefs).forEach(key => {
        if (seriesRefs[key]) {
          seriesRefs[key].value = null
        }
      })
    } catch (error) {
      console.log('清理图表时出错:', error.message)
    }
  }
}
