/**
 * 通达信公式语言解析和执行引擎 - Python版本
 * 使用Python引擎执行通达信公式
 */

const TdxPythonBridge = require('./tdxPythonBridge');

class TDXFormulaEngine {
  constructor() {
    this.pythonBridge = new TdxPythonBridge();
  }

  /**
   * 回测通达信策略
   * @param {string} code - 通达信公式代码
   * @param {Array} klineData - K线数据
   * @param {Object} options - 配置选项
   * @returns {Promise<Object>} 回测结果
   */
  async backtest(code, klineData, options = {}) {
    try {
      console.log('TDXFormulaEngine: 开始回测通达信策略');
      console.log('K线数据条数:', klineData.length);
      console.log('初始资金:', options.initialCapital || 100000);
      
      // 调用Python引擎执行
      const result = await this.pythonBridge.execute(code, klineData, {
        initialCapital: options.initialCapital || 100000,
        commission: options.commission || 0.0003,
      });
      
      console.log('TDXFormulaEngine: 回测完成');
      console.log('总交易次数:', result.totalTrades);
      console.log('总收益率:', result.totalReturn);
      
      return result;
    } catch (error) {
      console.error('TDXFormulaEngine: 回测失败:', error);
      throw error;
    }
  }
}

module.exports = TDXFormulaEngine;
