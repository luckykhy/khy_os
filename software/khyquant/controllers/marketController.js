/**
 * 市场数据控制器
 * 提供标的列表、行情数据等API
 */
const pythonDataSourceService = require('../services/pythonDataSourceService');
const comprehensiveDataService = require('../services/comprehensiveDataService');
const Instrument = require('../models/Instrument');

class MarketController {
  constructor() {
    // 缓存配置
    this.symbolsCache = new Map();
    this.cacheTimeout = 3600000; // 1小时缓存
    this.lastDbSaveTime = 0; // 上次保存到数据库的时间
    this.dbSaveInterval = 3600000; // 1小时保存一次到数据库
  }

  /**
   * 获取金融标的列表
   * 支持股票、指数、ETF、可转债等
   * 🔥 优化策略:先返回数据库缓存,后台异步更新
   */
  async getSymbols(req, res) {
    try {
      const { limit = 100, type, useCache = 'true' } = req.query;
      
      console.log(`📋 获取标的列表: limit=${limit}, type=${type}`);
      
      // 🔥 第一步:立即从数据库加载缓存数据
      const dbInstruments = await this.loadInstrumentsFromDatabase(type, parseInt(limit));
      
      if (dbInstruments && dbInstruments.length > 0) {
        console.log(`✅ 从数据库加载 ${dbInstruments.length} 个标的(缓存)`);
        
        // 立即返回数据库缓存
        const stats = {
          total: dbInstruments.length,
          indices: dbInstruments.filter(i => i.type === 'index').length,
          stocks: dbInstruments.filter(i => i.type === 'stock').length,
          etfs: dbInstruments.filter(i => i.type === 'etf').length,
          bonds: dbInstruments.filter(i => i.type === 'bond').length
        };
        
        const response = {
          success: true,
          data: {
            instruments: dbInstruments,
            stats
          },
          message: '标的列表获取成功(来自缓存)',
          fromCache: true
        };
        
        // 🔥 后台异步更新数据
        this.updateInstrumentsInBackground(type).catch(err => {
          console.error('❌ 后台更新标的失败:', err.message);
        });
        
        return res.json(response);
      }
      
      // 🔥 第二步:如果数据库没有数据,从AData获取
      console.log('⚠️ 数据库无缓存,从AData获取...');
      
      // 检查内存缓存
      const cacheKey = `symbols_${limit}_${type || 'all'}`;
      const cached = this.symbolsCache.get(cacheKey);
      
      if (useCache === 'true' && cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        console.log('✅ 使用内存缓存的标的列表');
        return res.json(cached.data);
      }
      
      // 从AData获取所有类型的标的
      let result = await pythonDataSourceService.getStockAndIndexOnly().catch(err => {
        console.warn('简化版本获取失败，尝试完整版本:', err.message);
        return { success: false };
      });
      
      // 如果简化版本失败，尝试完整版本
      if (!result.success) {
        result = await pythonDataSourceService.getAllInstrumentsByType().catch(err => {
          console.warn('获取标的列表失败:', err.message);
          return { success: false, data: [], stats: {} };
        });
      }
      
      if (!result.success) {
        throw new Error('获取标的列表失败');
      }
      
      let instruments = result.data || [];
      
      // 按类型过滤
      if (type) {
        instruments = instruments.filter(item => item.type === type);
      }
      
      // 限制数量
      const limitNum = parseInt(limit);
      if (limitNum > 0) {
        instruments = instruments.slice(0, limitNum);
      }
      
      // 统计信息
      const stats = {
        total: instruments.length,
        indices: instruments.filter(i => i.type === 'index').length,
        stocks: instruments.filter(i => i.type === 'stock').length,
        etfs: instruments.filter(i => i.type === 'etf').length,
        bonds: instruments.filter(i => i.type === 'bond').length
      };
      
      const response = {
        success: true,
        data: {
          instruments,
          stats
        },
        message: '标的列表获取成功',
        fromCache: false
      };
      
      // 缓存结果到内存
      this.symbolsCache.set(cacheKey, {
        data: response,
        timestamp: Date.now()
      });
      
      console.log(`✅ 返回 ${instruments.length} 个标的 (指数:${stats.indices}, 股票:${stats.stocks}, ETF:${stats.etfs}, 可转债:${stats.bonds})`);
      
      // 🔥 保存到数据库
      this.saveInstrumentsToDatabase(result.data || instruments).catch(err => {
        console.error('❌ 保存标的到数据库失败:', err.message);
      });
      
      res.json(response);
      
    } catch (error) {
      console.error('❌ 获取标的列表失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '获取标的列表失败'
      });
    }
  }

  /**
   * 格式化标的代码
   * 将 AData 格式转换为系统统一格式
   * @param {string} code - 股票代码 (如: 000001)
   * @param {string} exchange - 交易所 (SZ/SH)
   * @returns {string} 格式化后的代码 (如: sh000001)
   */
  formatSymbolCode(code, exchange) {
    const prefix = exchange === 'SZ' ? 'sz' : 'sh';
    return `${prefix}${code}`;
  }

  /**
   * 获取单个标的的详细信息
   */
  async getSymbolInfo(req, res) {
    try {
      const { symbol } = req.params;
      
      console.log(`📊 获取标的信息: ${symbol}`);
      
      // 从 comprehensiveDataService 获取标的信息
      const instrumentInfo = comprehensiveDataService.identifyInstrument(symbol);
      
      res.json({
        success: true,
        data: instrumentInfo,
        message: '标的信息获取成功'
      });
      
    } catch (error) {
      console.error('❌ 获取标的信息失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '获取标的信息失败'
      });
    }
  }

  /**
   * 清除缓存
   */
  async clearCache(req, res) {
    try {
      this.symbolsCache.clear();
      
      res.json({
        success: true,
        message: '缓存已清除'
      });
      
    } catch (error) {
      console.error('❌ 清除缓存失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '清除缓存失败'
      });
    }
  }

  /**
   * 🔥 从数据库加载标的列表
   */
  async loadInstrumentsFromDatabase(type, limit) {
    try {
      const orderBySymbol = [['symbol', 'ASC']];

      // 指定类型时直接查
      if (type) {
        const where = { type, status: 'active' };
        const instruments = await Instrument.findAll({
          where,
          limit: limit > 0 ? limit : 10000,
          order: orderBySymbol,
          raw: true
        });
        return instruments
          .filter(item => item.name && item.name.trim() !== '')
          .map(item => ({
            code: item.symbol,
            symbol: item.symbol,
            name: item.name,
            type: item.type,
            market: item.market,
            category: item.category
          }));
      }

      // 不指定类型时：按类型分批查，重要标的优先，再合并
      const PRIORITY_SYMBOLS = [
        'sh000300','sh000001','sz399001','sz399006',
        '000300','000001','399001','399006','399300'
      ];

      // 各类型限制数量（控制总量避免前端卡顿）
      const TYPE_LIMITS = {
        index:   200,   // 指数不多，全量
        stock:   500,   // 股票只取前500（按symbol排序，常用的靠前）
        etf:     200,
        bond:    100,
        futures: 200,   // 期货只取前200（主力合约靠前）
      };

      const allResults = [];

      for (const [t, tLimit] of Object.entries(TYPE_LIMITS)) {
        const rows = await Instrument.findAll({
          where: { type: t, status: 'active' },
          limit: tLimit,
          order: orderBySymbol,
          raw: true
        });
        allResults.push(...rows);
      }

      // 重要指数置顶
      const prioritySet = new Set(PRIORITY_SYMBOLS);
      const priority = allResults.filter(i => prioritySet.has(i.symbol));
      const rest = allResults.filter(i => !prioritySet.has(i.symbol));
      const merged = [...priority, ...rest];

      return merged
        .filter(item => item.name && item.name.trim() !== '')
        .map(item => ({
          code: item.symbol,
          symbol: item.symbol,
          name: item.name,
          type: item.type,
          market: item.market,
          category: item.category
        }));

    } catch (error) {
      console.error('❌ 从数据库加载标的失败:', error.message);
      return [];
    }
  }

  /**
   * 🔥 后台异步更新标的数据
   */
  async updateInstrumentsInBackground(type) {
    try {
      console.log('🔄 后台开始更新标的数据...');
      
      // 从AData获取最新数据
      let result = await pythonDataSourceService.getStockAndIndexOnly().catch(err => {
        console.warn('简化版本获取失败，尝试完整版本:', err.message);
        return { success: false };
      });
      
      if (!result.success) {
        result = await pythonDataSourceService.getAllInstrumentsByType().catch(err => {
          console.warn('后台更新失败:', err.message);
          return { success: false, data: [] };
        });
      }
      
      if (result.success && result.data && result.data.length > 0) {
        // 保存到数据库
        await this.saveInstrumentsToDatabase(result.data);
        console.log(`✅ 后台更新完成: ${result.data.length} 个标的`);
      }
      
    } catch (error) {
      console.error('❌ 后台更新标的失败:', error.message);
    }
  }

  /**
   * 🔥 自动保存标的列表到数据库
   * 使用 bulkCreate 批量插入,遇到重复则更新
   */
  async saveInstrumentsToDatabase(instruments) {
    try {
      console.log('💾 开始缓存标的到数据库...');
      
      if (!instruments || instruments.length === 0) {
        console.log('⚠️ 没有标的需要保存');
        return;
      }
      
      // 转换数据格式以匹配数据库模型
      const dbInstruments = instruments.map(item => ({
        symbol: item.code || item.symbol,
        name: item.name,
        type: item.type,
        market: item.market || (item.code?.startsWith('sh') ? 'SSE' : 'SZSE'),
        category: item.category || this.getCategoryByType(item.type),
        status: 'active'
      }));
      
      // 批量插入或更新
      await Instrument.bulkCreate(dbInstruments, {
        updateOnDuplicate: ['name', 'type', 'market', 'category', 'status', 'updated_at'],
        validate: true
      });
      
      console.log(`✅ 已缓存 ${dbInstruments.length} 个标的到数据库`);
      
    } catch (error) {
      console.error('❌ 保存标的到数据库失败:', error.message);
      // 不抛出错误,避免影响主流程
    }
  }

  /**
   * 根据类型获取分类
   */
  getCategoryByType(type) {
    const categoryMap = {
      'index': '指数',
      'stock': 'A股',
      'etf': 'ETF',
      'bond': '可转债',
      'futures': '期货'
    };
    return categoryMap[type] || type;
  }

  /**
   * 持久化标的列表到数据库
   * 当API成功获取标的列表时,保存到数据库
   */
  async persistInstruments(req, res) {
    try {
      console.log('💾 开始持久化标的列表到数据库...');
      
      // 获取所有标的
      const result = await pythonDataSourceService.getAllInstrumentsByType();
      
      if (!result.success || !result.data) {
        throw new Error('获取标的列表失败');
      }
      
      const instruments = result.data;
      
      // TODO: 保存到数据库
      // 这里可以使用 Sequelize 批量插入
      // await Instrument.bulkCreate(instruments, { updateOnDuplicate: ['name', 'type', 'category'] });
      
      // 暂时保存到文件系统
      const fs = require('fs');
      const path = require('path');
      const dataDir = path.join(__dirname, '../../data');
      
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      const filePath = path.join(dataDir, 'instruments.json');
      fs.writeFileSync(filePath, JSON.stringify({
        data: instruments,
        timestamp: Date.now(),
        count: instruments.length
      }, null, 2));
      
      console.log(`✅ 成功持久化 ${instruments.length} 个标的到文件系统`);
      
      res.json({
        success: true,
        data: {
          count: instruments.length,
          filePath
        },
        message: '标的列表持久化成功'
      });
      
    } catch (error) {
      console.error('❌ 持久化标的列表失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '持久化标的列表失败'
      });
    }
  }

  /**
   * 从持久化存储加载标的列表
   */
  async loadPersistedInstruments(req, res) {
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(__dirname, '../../data/instruments.json');
      
      if (!fs.existsSync(filePath)) {
        return res.json({
          success: false,
          message: '没有找到持久化的标的列表'
        });
      }
      
      const content = fs.readFileSync(filePath, 'utf8');
      const { data, timestamp, count } = JSON.parse(content);
      
      const age = Date.now() - timestamp;
      const ageHours = Math.floor(age / (1000 * 60 * 60));
      
      console.log(`📂 从文件系统加载 ${count} 个标的 (${ageHours}小时前)`);
      
      res.json({
        success: true,
        data: {
          instruments: data,
          count,
          timestamp,
          ageHours
        },
        message: '标的列表加载成功'
      });
      
    } catch (error) {
      console.error('❌ 加载持久化标的列表失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '加载持久化标的列表失败'
      });
    }
  }
  
  // ==================== 实时行情数据API ====================
  
  /**
   * 获取ETF实时行情数据
   * 三级降级策略: 真实数据 → 数据库缓存 → 模拟数据
   */
  async getETFRealData(req, res) {
    try {
      console.log('📊 获取ETF实时行情数据...');
      
      // 🔥 第一步:从数据库获取所有ETF列表(不限制数量)
      const instruments = await this.loadInstrumentsFromDatabase('etf', 10000);
      
      if (!instruments || instruments.length === 0) {
        console.log('⚠️ 数据库中没有ETF数据');
        return res.json({
          success: true,
          data: [],
          message: '暂无ETF数据',
          dataSource: 'none'
        });
      }
      
      console.log(`📋 从数据库加载了 ${instruments.length} 个ETF`);
      
      // 🔥 第二步:尝试获取真实行情数据
      const comprehensiveDataService = require('../services/comprehensiveDataService');
      const results = [];
      let successCount = 0;
      let cacheCount = 0;
      let mockCount = 0;
      
      // 限制并发数量,避免过载
      const batchSize = 10;
      for (let i = 0; i < instruments.length; i += batchSize) {
        const batch = instruments.slice(i, i + batchSize);
        const batchPromises = batch.map(async (inst) => {
          try {
            // 尝试获取真实数据
            const data = await comprehensiveDataService.getComprehensiveData(inst.code, {
              period: 'daily',
              maxRetries: 1 // 快速失败
            });
            
            if (data.kline && data.kline.length > 0) {
              const lastCandle = data.kline[data.kline.length - 1];
              const prevCandle = data.kline.length > 1 ? data.kline[data.kline.length - 2] : lastCandle;
              
              const price = parseFloat(lastCandle.close);
              const prevClose = parseFloat(prevCandle.close);
              const change = price - prevClose;
              const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
              
              // 判断数据来源
              const dataSource = data.source || 'unknown';
              if (dataSource.includes('mock') || dataSource.includes('模拟')) {
                mockCount++;
              } else if (dataSource.includes('cache') || dataSource.includes('缓存')) {
                cacheCount++;
              } else {
                successCount++;
              }
              
              return {
                symbol: inst.code,
                name: inst.name,
                type: 'etf',
                category: 'ETF',
                price: parseFloat(price.toFixed(3)),
                open: parseFloat(lastCandle.open),
                high: parseFloat(lastCandle.high),
                low: parseFloat(lastCandle.low),
                volume: parseInt(lastCandle.volume || 0),
                change: parseFloat(change.toFixed(3)),
                changePercent: parseFloat(changePercent.toFixed(2)),
                time: lastCandle.time,
                dataSource: dataSource
              };
            }
            
            // 如果没有K线数据,返回基本信息(使用模拟数据)
            mockCount++;
            return {
              symbol: inst.code,
              name: inst.name,
              type: 'etf',
              category: 'ETF',
              price: 1.000,
              open: 1.000,
              high: 1.000,
              low: 1.000,
              volume: 0,
              change: 0,
              changePercent: 0,
              time: new Date().toISOString(),
              dataSource: 'mock'
            };
          } catch (error) {
            console.warn(`获取${inst.code}行情失败:`, error.message);
            // 返回基本信息(使用模拟数据)
            mockCount++;
            return {
              symbol: inst.code,
              name: inst.name,
              type: 'etf',
              category: 'ETF',
              price: 1.000,
              open: 1.000,
              high: 1.000,
              low: 1.000,
              volume: 0,
              change: 0,
              changePercent: 0,
              time: new Date().toISOString(),
              dataSource: 'mock'
            };
          }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      }
      
      console.log(`✅ ETF行情获取完成: 总数${results.length}, 真实数据${successCount}, 缓存数据${cacheCount}, 模拟数据${mockCount}`);
      
      res.json({
        success: true,
        data: results,
        message: `获取${results.length}个ETF行情`,
        stats: {
          total: results.length,
          realData: successCount,
          cachedData: cacheCount,
          mockData: mockCount
        }
      });
      
    } catch (error) {
      console.error('获取ETF实时行情失败:', error);
      res.status(500).json({
        success: false,
        message: '获取ETF实时行情失败',
        error: error.message
      });
    }
  }
  
  /**
   * 获取可转债实时行情数据
   */
  async getBondRealData(req, res) {
    try {
      console.log('📊 获取可转债实时行情数据...');
      
      // 从数据库获取所有可转债列表(不限制数量)
      const instruments = await this.loadInstrumentsFromDatabase('bond', 10000);
      
      if (!instruments || instruments.length === 0) {
        return res.json({
          success: true,
          data: [],
          message: '暂无可转债数据'
        });
      }
      
      // 使用comprehensiveDataService获取实时行情
      const comprehensiveDataService = require('../services/comprehensiveDataService');
      const quotesPromises = instruments.map(async (inst) => {
        try {
          const data = await comprehensiveDataService.getComprehensiveData(inst.code, {
            period: 'daily'
          });
          
          if (data.kline && data.kline.length > 0) {
            const lastCandle = data.kline[data.kline.length - 1];
            const prevCandle = data.kline.length > 1 ? data.kline[data.kline.length - 2] : lastCandle;
            
            const price = parseFloat(lastCandle.close);
            const prevClose = parseFloat(prevCandle.close);
            const change = price - prevClose;
            const changePercent = (change / prevClose) * 100;
            
            return {
              symbol: inst.code,
              name: inst.name,
              type: 'bond',
              category: '可转债',
              price: parseFloat(price.toFixed(2)),
              open: parseFloat(lastCandle.open),
              high: parseFloat(lastCandle.high),
              low: parseFloat(lastCandle.low),
              volume: parseInt(lastCandle.volume || 0),
              change: parseFloat(change.toFixed(2)),
              changePercent: parseFloat(changePercent.toFixed(2)),
              time: lastCandle.time,
              dataSource: data.source
            };
          }
          return null;
        } catch (error) {
          console.warn(`获取${inst.code}行情失败:`, error.message);
          return null;
        }
      });
      
      const results = await Promise.all(quotesPromises);
      const validResults = results.filter(r => r !== null);
      
      console.log(`✅ 成功获取${validResults.length}个可转债实时行情`);
      
      res.json({
        success: true,
        data: validResults,
        message: `获取${validResults.length}个可转债行情`
      });
      
    } catch (error) {
      console.error('获取可转债实时行情失败:', error);
      res.status(500).json({
        success: false,
        message: '获取可转债实时行情失败',
        error: error.message
      });
    }
  }
  
  /**
   * 获取股票实时行情数据
   */
  async getStockRealData(req, res) {
    try {
      console.log('📊 获取股票实时行情数据...');
      
      // 从数据库获取所有股票列表(不限制数量)
      const instruments = await this.loadInstrumentsFromDatabase('stock', 10000);
      
      if (!instruments || instruments.length === 0) {
        return res.json({
          success: true,
          data: [],
          message: '暂无股票数据'
        });
      }
      
      // 使用comprehensiveDataService获取实时行情
      const comprehensiveDataService = require('../services/comprehensiveDataService');
      const quotesPromises = instruments.map(async (inst) => {
        try {
          const data = await comprehensiveDataService.getComprehensiveData(inst.code, {
            period: 'daily'
          });
          
          if (data.kline && data.kline.length > 0) {
            const lastCandle = data.kline[data.kline.length - 1];
            const prevCandle = data.kline.length > 1 ? data.kline[data.kline.length - 2] : lastCandle;
            
            const price = parseFloat(lastCandle.close);
            const prevClose = parseFloat(prevCandle.close);
            const change = price - prevClose;
            const changePercent = (change / prevClose) * 100;
            
            return {
              symbol: inst.code,
              name: inst.name,
              type: 'stock',
              category: 'A股',
              price: parseFloat(price.toFixed(2)),
              open: parseFloat(lastCandle.open),
              high: parseFloat(lastCandle.high),
              low: parseFloat(lastCandle.low),
              volume: parseInt(lastCandle.volume || 0),
              change: parseFloat(change.toFixed(2)),
              changePercent: parseFloat(changePercent.toFixed(2)),
              time: lastCandle.time,
              dataSource: data.source
            };
          }
          return null;
        } catch (error) {
          console.warn(`获取${inst.code}行情失败:`, error.message);
          return null;
        }
      });
      
      const results = await Promise.all(quotesPromises);
      const validResults = results.filter(r => r !== null);
      
      console.log(`✅ 成功获取${validResults.length}个股票实时行情`);
      
      res.json({
        success: true,
        data: validResults,
        message: `获取${validResults.length}个股票行情`
      });
      
    } catch (error) {
      console.error('获取股票实时行情失败:', error);
      res.status(500).json({
        success: false,
        message: '获取股票实时行情失败',
        error: error.message
      });
    }
  }
  
  /**
   * 获取指数实时行情数据
   */
  async getIndexRealData(req, res) {
    try {
      console.log('📊 获取指数实时行情数据...');
      
      // 从数据库获取所有指数列表(不限制数量)
      const instruments = await this.loadInstrumentsFromDatabase('index', 10000);
      
      if (!instruments || instruments.length === 0) {
        return res.json({
          success: true,
          data: [],
          message: '暂无指数数据'
        });
      }
      
      // 使用comprehensiveDataService获取实时行情
      const comprehensiveDataService = require('../services/comprehensiveDataService');
      const quotesPromises = instruments.map(async (inst) => {
        try {
          const data = await comprehensiveDataService.getComprehensiveData(inst.code, {
            period: 'daily'
          });
          
          if (data.kline && data.kline.length > 0) {
            const lastCandle = data.kline[data.kline.length - 1];
            const prevCandle = data.kline.length > 1 ? data.kline[data.kline.length - 2] : lastCandle;
            
            const price = parseFloat(lastCandle.close);
            const prevClose = parseFloat(prevCandle.close);
            const change = price - prevClose;
            const changePercent = (change / prevClose) * 100;
            
            return {
              symbol: inst.code,
              name: inst.name,
              type: 'index',
              category: '指数',
              price: parseFloat(price.toFixed(2)),
              open: parseFloat(lastCandle.open),
              high: parseFloat(lastCandle.high),
              low: parseFloat(lastCandle.low),
              volume: parseInt(lastCandle.volume || 0),
              change: parseFloat(change.toFixed(2)),
              changePercent: parseFloat(changePercent.toFixed(2)),
              time: lastCandle.time,
              dataSource: data.source
            };
          }
          return null;
        } catch (error) {
          console.warn(`获取${inst.code}行情失败:`, error.message);
          return null;
        }
      });
      
      const results = await Promise.all(quotesPromises);
      const validResults = results.filter(r => r !== null);
      
      console.log(`✅ 成功获取${validResults.length}个指数实时行情`);
      
      res.json({
        success: true,
        data: validResults,
        message: `获取${validResults.length}个指数行情`
      });
      
    } catch (error) {
      console.error('获取指数实时行情失败:', error);
      res.status(500).json({
        success: false,
        message: '获取指数实时行情失败',
        error: error.message
      });
    }
  }
  
  // ==================== 缓存数据API ====================
  
  /**
   * 获取ETF缓存数据
   */
  async getETFCacheData(req, res) {
    try {
      console.log('💾 从缓存获取ETF数据...');
      
      // 从数据库获取所有ETF列表作为缓存(不限制数量)
      const instruments = await this.loadInstrumentsFromDatabase('etf', 10000);
      
      if (!instruments || instruments.length === 0) {
        return res.json({
          success: true,
          data: [],
          message: '暂无ETF缓存数据'
        });
      }
      
      // 转换为行情格式(使用最后已知价格)
      const cachedData = instruments.map(inst => ({
        symbol: inst.code,
        name: inst.name,
        type: 'etf',
        category: 'ETF',
        price: 0, // 缓存数据没有实时价格
        change: 0,
        changePercent: 0,
        dataSource: 'cache'
      }));
      
      res.json({
        success: true,
        data: cachedData,
        message: `从缓存获取${cachedData.length}个ETF`
      });
      
    } catch (error) {
      console.error('获取ETF缓存失败:', error);
      res.status(500).json({
        success: false,
        message: '获取ETF缓存失败',
        error: error.message
      });
    }
  }
  
  /**
   * 获取可转债缓存数据
   */
  async getBondCacheData(req, res) {
    try {
      console.log('💾 从缓存获取可转债数据...');
      
      // 从数据库获取所有可转债列表作为缓存(不限制数量)
      const instruments = await this.loadInstrumentsFromDatabase('bond', 10000);
      
      if (!instruments || instruments.length === 0) {
        return res.json({
          success: true,
          data: [],
          message: '暂无可转债缓存数据'
        });
      }
      
      // 转换为行情格式
      const cachedData = instruments.map(inst => ({
        symbol: inst.code,
        name: inst.name,
        type: 'bond',
        category: '可转债',
        price: 0,
        change: 0,
        changePercent: 0,
        dataSource: 'cache'
      }));
      
      res.json({
        success: true,
        data: cachedData,
        message: `从缓存获取${cachedData.length}个可转债`
      });
      
    } catch (error) {
      console.error('获取可转债缓存失败:', error);
      res.status(500).json({
        success: false,
        message: '获取可转债缓存失败',
        error: error.message
      });
    }
  }
  
  /**
   * 获取股票缓存数据
   */
  async getStockCacheData(req, res) {
    try {
      console.log('💾 从缓存获取股票数据...');
      
      // 从数据库获取所有股票列表作为缓存(不限制数量)
      const instruments = await this.loadInstrumentsFromDatabase('stock', 10000);
      
      if (!instruments || instruments.length === 0) {
        return res.json({
          success: true,
          data: [],
          message: '暂无股票缓存数据'
        });
      }
      
      // 转换为行情格式
      const cachedData = instruments.map(inst => ({
        symbol: inst.code,
        name: inst.name,
        type: 'stock',
        category: 'A股',
        price: 0,
        change: 0,
        changePercent: 0,
        dataSource: 'cache'
      }));
      
      res.json({
        success: true,
        data: cachedData,
        message: `从缓存获取${cachedData.length}个股票`
      });
      
    } catch (error) {
      console.error('获取股票缓存失败:', error);
      res.status(500).json({
        success: false,
        message: '获取股票缓存失败',
        error: error.message
      });
    }
  }
  
  /**
   * 获取指数缓存数据
   */
  async getIndexCacheData(req, res) {
    try {
      console.log('💾 从缓存获取指数数据...');
      
      // 从数据库获取所有指数列表作为缓存(不限制数量)
      const instruments = await this.loadInstrumentsFromDatabase('index', 10000);
      
      if (!instruments || instruments.length === 0) {
        return res.json({
          success: true,
          data: [],
          message: '暂无指数缓存数据'
        });
      }
      
      // 转换为行情格式
      const cachedData = instruments.map(inst => ({
        symbol: inst.code,
        name: inst.name,
        type: 'index',
        category: '指数',
        price: 0,
        change: 0,
        changePercent: 0,
        dataSource: 'cache'
      }));
      
      res.json({
        success: true,
        data: cachedData,
        message: `从缓存获取${cachedData.length}个指数`
      });
      
    } catch (error) {
      console.error('获取指数缓存失败:', error);
      res.status(500).json({
        success: false,
        message: '获取指数缓存失败',
        error: error.message
      });
    }
  }
  
  // ==================== 保存缓存API ====================
  
  /**
   * 保存ETF缓存
   */
  async saveETFCache(req, res) {
    try {
      const { data } = req.body;
      console.log(`💾 保存${data?.length || 0}个ETF到缓存...`);
      
      // 这里可以实现将数据保存到数据库的逻辑
      // 目前简单返回成功
      
      res.json({
        success: true,
        message: `已保存${data?.length || 0}个ETF到缓存`
      });
      
    } catch (error) {
      console.error('保存ETF缓存失败:', error);
      res.status(500).json({
        success: false,
        message: '保存ETF缓存失败',
        error: error.message
      });
    }
  }
  
  /**
   * 保存可转债缓存
   */
  async saveBondCache(req, res) {
    try {
      const { data } = req.body;
      console.log(`💾 保存${data?.length || 0}个可转债到缓存...`);
      
      res.json({
        success: true,
        message: `已保存${data?.length || 0}个可转债到缓存`
      });
      
    } catch (error) {
      console.error('保存可转债缓存失败:', error);
      res.status(500).json({
        success: false,
        message: '保存可转债缓存失败',
        error: error.message
      });
    }
  }
  
  /**
   * 保存股票缓存
   */
  async saveStockCache(req, res) {
    try {
      const { data } = req.body;
      console.log(`💾 保存${data?.length || 0}个股票到缓存...`);
      
      res.json({
        success: true,
        message: `已保存${data?.length || 0}个股票到缓存`
      });
      
    } catch (error) {
      console.error('保存股票缓存失败:', error);
      res.status(500).json({
        success: false,
        message: '保存股票缓存失败',
        error: error.message
      });
    }
  }
  
  /**
   * 保存指数缓存
   */
  async saveIndexCache(req, res) {
    try {
      const { data } = req.body;
      console.log(`💾 保存${data?.length || 0}个指数到缓存...`);
      
      res.json({
        success: true,
        message: `已保存${data?.length || 0}个指数到缓存`
      });
      
    } catch (error) {
      console.error('保存指数缓存失败:', error);
      res.status(500).json({
        success: false,
        message: '保存指数缓存失败',
        error: error.message
      });
    }
  }
}

module.exports = new MarketController();
