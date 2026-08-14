/**
 * mobileChartConfig.js — Mobile chart configuration utilities
 *
 * Provides chart options for desktop and mobile candlestick charts
 * used by SimpleTradingInterface.
 */

/**
 * Get desktop chart options
 * @param {Object} customOptions - Override default options
 * @returns {Object} ECharts-compatible option object
 */
export function getChartOptions(customOptions = {}) {
  return {
    backgroundColor: 'transparent',
    grid: { left: '5%', right: '5%', top: '10%', bottom: '10%' },
    xAxis: { type: 'category', axisLine: { show: false } },
    yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { type: 'dashed' } } },
    series: [{ type: 'candlestick' }],
    ...customOptions,
  }
}

/**
 * Get mobile candlestick chart options with touch-friendly sizing
 * @param {Object} customOptions - Override default options
 * @returns {Object} ECharts-compatible option object
 */
export function getMobileCandlestickOptions(customOptions = {}) {
  return {
    backgroundColor: 'transparent',
    grid: { left: 8, right: 8, top: 20, bottom: 20 },
    xAxis: { type: 'category', axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 10 } },
    series: [{ type: 'candlestick', itemStyle: { borderWidth: 1 } }],
    ...customOptions,
  }
}
