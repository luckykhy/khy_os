const axios = require('axios');
const { MarketData } = require('../models');

/**
 * 市场数据服务
 * 使用新浪财经API获取真实股票数据
 */
class MarketDataService {
  constructor() {
    // 新浪财经API（免费，无需密钥）
    this.sinaApiBase = 'https://hq.sinajs.cn/list=';
  }

  /**
   * 获取实时行情
   * @param {string} symbol - 股票代码（如：sh600000）
   */
  async getRealTimeQuote(symbol) {
    try {
      const response = await axios.get(`${this.sinaApiBase}${symbol}`, {
        timeout: 5000,
        responseType: 'arraybuffer',
        headers: {
          'Referer': 'https://finance.sina.com.cn'
        }
      });

      // Sina API returns GBK-encoded data
      const decoder = new TextDecoder('gbk');
      const data = decoder.decode(response.data);
      const parts = data.split('"')[1].split(',');

      if (parts.length < 32) {
        throw new Error('数据格式错误');
      }

      return {
        symbol: symbol,
        name: parts[0],
        open: parseFloat(parts[1]),
        preClose: parseFloat(parts[2]),
        current: parseFloat(parts[3]),
        high: parseFloat(parts[4]),
        low: parseFloat(parts[5]),
        bid: parseFloat(parts[6]),
        ask: parseFloat(parts[7]),
        volume: parseInt(parts[8]),
        amount: parseFloat(parts[9]),
        date: parts[30],
        time: parts[31],
        timestamp: new Date(`${parts[30]} ${parts[31]}`)
      };
    } catch (error) {
      console.error('获取实时行情失败:', error.message);
      throw error;
    }
  }

  /**
   * 生成模拟K线数据（用于演示）
   * @param {string} symbol - 股票代码
   * @param {number} days - 天数
   */
  async generateMockKLineData(symbol, days = 100) {
    const data = [];
    const fallbackPrices = {
      'sh000300': 4660, '000300': 4660, 'sh000001': 3350, '000001': 3350,
      'sz399001': 10800, 'sz399006': 2100, 'sh600519': 1680, '600519': 1680,
      'sh600036': 38, 'sz000001': 11, 'sz000858': 148, 'sh600000': 7.8,
      'rb_main': 3380, 'rb2510': 3380,
    };
    const clean = symbol ? symbol.replace(/^(sh|sz)/i, '') : '';
    let basePrice = fallbackPrices[symbol] || fallbackPrices[clean] || 50;
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      
      // 跳过周末
      if (date.getDay() === 0 || date.getDay() === 6) {
        continue;
      }

      // 生成随机波动
      const change = (Math.random() - 0.5) * 5;
      basePrice = Math.max(basePrice + change, 50);

      const open = basePrice + (Math.random() - 0.5) * 2;
      const close = basePrice + (Math.random() - 0.5) * 2;
      const high = Math.max(open, close) + Math.random() * 3;
      const low = Math.min(open, close) - Math.random() * 3;
      const volume = Math.floor(Math.random() * 10000000) + 1000000;

      data.push({
        symbol,
        timestamp: date,
        open_price: parseFloat(open.toFixed(2)),
        high_price: parseFloat(high.toFixed(2)),
        low_price: parseFloat(low.toFixed(2)),
        close_price: parseFloat(close.toFixed(2)),
        volume
      });
    }

    return data;
  }

  /**
   * 保存K线数据到数据库
   */
  async saveKLineData(data) {
    try {
      await MarketData.bulkCreate(data, {
        updateOnDuplicate: ['open_price', 'high_price', 'low_price', 'close_price', 'volume']
      });
      return true;
    } catch (error) {
      console.error('保存K线数据失败:', error.message);
      throw error;
    }
  }

  /**
   * 从数据库获取K线数据
   */
  async getKLineData(symbol, startDate, endDate, limit = 200) {
    try {
      const { Op } = require('sequelize');
      const where = { symbol };
      
      if (startDate || endDate) {
        where.timestamp = {};
        if (startDate) where.timestamp[Op.gte] = new Date(startDate);
        if (endDate) where.timestamp[Op.lte] = new Date(endDate);
      }

      console.log('查询K线数据:', { symbol, startDate, endDate, limit });

      const data = await MarketData.findAll({
        where,
        limit: parseInt(limit),
        order: [['timestamp', 'ASC']],
        raw: true  // 返回普通对象而不是模型实例
      });

      console.log('查询到K线数据条数:', data.length);
      
      // 如果数据为空，返回空数组而不是null
      return data || [];
    } catch (error) {
      console.error('获取K线数据失败:', error.message);
      throw error;
    }
  }

  /**
   * 计算技术指标 - MA均线
   */
  calculateMA(data, period) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        result.push('-');
        continue;
      }
      let sum = 0;
      for (let j = 0; j < period; j++) {
        // 支持两种字段格式：close_price（数据库格式）和close（转换后格式）
        const price = data[i - j].close_price || data[i - j].close;
        sum += price;
      }
      result.push((sum / period).toFixed(2));
    }
    return result;
  }
}

module.exports = new MarketDataService();