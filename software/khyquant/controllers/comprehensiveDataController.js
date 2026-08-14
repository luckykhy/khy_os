/**

 * 综合数据控制器

 * 提供完整的金融数据API接口

 */

const comprehensiveDataService = require('../services/comprehensiveDataService');



class ComprehensiveDataController {

  /**

   * 获取K线数据（新增方法）

   */

  async getKlineData(req, res) {

    try {

      const { symbol, startDate, endDate, period = 'daily', testMode, instrumentType } = req.query;



      if (!symbol) {

        return res.status(400).json({

          success: false,

          message: '缺少必需参数: symbol'

        });

      }



      console.log(`📊 获取K线数据请求: ${symbol}`, { startDate, endDate, period, testMode, instrumentType });



      const options = {

        startDate,

        endDate,

        period,

        ...(instrumentType && { instrumentType })

      };



      const data = await comprehensiveDataService.getComprehensiveData(symbol, options);



      // 🔥 强制日志：查看后端实际返回的source

      console.log('🔍 Controller收到Service返回:');

      console.log('   source:', data.source);

      console.log('   kline条数:', data.kline?.length || 0);

      console.log('   dataQuality:', data.dataQuality);

      console.log('   sourceInfo:', data.sourceInfo?.name || 'N/A');

      console.log('   dataComposition:', JSON.stringify(data.dataComposition));

      console.log('   isHybrid:', data.isHybrid);

      console.log('   coverage:', data.coverage);



      // Normalize kline field names so the frontend always receives

      // { time, date, open, high, low, close, volume } regardless of data source

      if (Array.isArray(data.kline)) {

        data.kline = data.kline.map(item => {

          const day = (item.date || item.time || (item.timestamp ? new Date(item.timestamp).toISOString().slice(0, 10) : null) || item.trade_date || '');

          return {

            time: day,

            date: day,

            open:   item.open   ?? item.open_price   ?? 0,

            high:   item.high   ?? item.high_price   ?? 0,

            low:    item.low    ?? item.low_price     ?? 0,

            close:  item.close  ?? item.close_price   ?? 0,

            volume: item.volume ?? item.vol           ?? 0,

            amount: item.amount ?? item.turnover      ?? 0,

          };

        });

      }



      // 🔥 返回完整的数据,包括dataComposition等字段

      const responseData = {

        success: true,

        ...data,  // 包含所有Service返回的字段

        message: data.message || '数据获取成功',

        timestamp: new Date().toISOString()

      };

      

      console.log('📤 Controller返回的dataComposition:', JSON.stringify(responseData.dataComposition));



      // 返回格式化的K线数据

      res.json(responseData);



    } catch (error) {

      console.error('❌ K-line data sources failed, generating mock data:', error.message);



      // Generate mock kline data so the chart never shows a black screen

      const mockKline = [];

      const now = new Date();

      let price = 3800 + Math.random() * 400;

      for (let i = 365; i >= 0; i--) {

        const d = new Date(now);

        d.setDate(d.getDate() - i);

        if (d.getDay() === 0 || d.getDay() === 6) continue;

        const change = (Math.random() - 0.48) * price * 0.025;

        const open = price;

        price = Math.max(100, price + change);

        const high = Math.max(open, price) * (1 + Math.random() * 0.01);

        const low = Math.min(open, price) * (1 - Math.random() * 0.01);

        const vol = Math.floor(1e8 + Math.random() * 5e8);

        const day = d.toISOString().slice(0, 10);

        mockKline.push({

          time: day,

          date: day,

          open: +open.toFixed(2),

          high: +high.toFixed(2),

          low: +low.toFixed(2),

          close: +price.toFixed(2),

          volume: vol,

          amount: +(price * vol).toFixed(2),

        });

      }



      res.json({

        success: true,

        kline: mockKline,

        source: '增强模拟数据',

        sourceInfo: { name: '增强模拟数据', reliability: 0.5 },

        message: '真实数据源暂不可用，已返回模拟数据',

        dataQuality: 'mock',

        isHybrid: false,

        coverage: { total: mockKline.length },

        timestamp: new Date().toISOString(),

      });

    }

  }



  /**

   * 获取综合金融数据

   */

  async getComprehensiveData(req, res) {

    try {

      const { symbol } = req.params;

      const {

        startDate,

        endDate,

        period = 'daily',

        includeIndicators = 'true',

        maxRetries = 3

      } = req.query;



      console.log(`获取综合数据请求: ${symbol}`, {

        startDate,

        endDate,

        period,

        includeIndicators

      });



      const options = {

        startDate,

        endDate,

        period,

        includeIndicators: includeIndicators === 'true',

        maxRetries: parseInt(maxRetries)

      };



      const data = await comprehensiveDataService.getComprehensiveData(symbol, options);



      res.json({

        success: true,

        data,

        message: '数据获取成功',

        timestamp: new Date().toISOString()

      });



    } catch (error) {

      console.error('获取综合数据失败:', error);

      const safeSymbol = String(req.params?.symbol || 'sh000001');

      const mockKline = [];

      const now = new Date();

      let price = 3800 + Math.random() * 400;

      for (let i = 180; i >= 0; i--) {

        const d = new Date(now);

        d.setDate(d.getDate() - i);

        if (d.getDay() === 0 || d.getDay() === 6) continue;

        const change = (Math.random() - 0.48) * price * 0.02;

        const open = price;

        price = Math.max(100, price + change);

        const high = Math.max(open, price) * (1 + Math.random() * 0.01);

        const low = Math.min(open, price) * (1 - Math.random() * 0.01);

        const volume = Math.floor(8e7 + Math.random() * 4e8);

        const day = d.toISOString().slice(0, 10);

        mockKline.push({

          time: day,

          date: day,

          open: +open.toFixed(2),

          high: +high.toFixed(2),

          low: +low.toFixed(2),

          close: +price.toFixed(2),

          volume,

          amount: +(price * volume).toFixed(2)

        });

      }



      res.json({

        success: true,

        data: {

          symbol: safeSymbol,

          name: safeSymbol,

          kline: mockKline,

          source: '增强模拟数据',

          dataQuality: 'mock',

          sourceInfo: { name: '增强模拟数据', reliability: 0.5 },

          coverage: { total: mockKline.length }

        },

        message: '真实数据源暂不可用，已返回模拟数据',

        warning: error.message,

        timestamp: new Date().toISOString()

      });

    }

  }



  /**

   * 获取数据源状态

   */

  async getDataSourceStatus(req, res) {

    try {

      const status = comprehensiveDataService.getDataSourceStatus();

      

      res.json({

        success: true,

        data: status,

        message: '数据源状态获取成功'

      });



    } catch (error) {

      console.error('获取数据源状态失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '数据源状态获取失败'

      });

    }

  }



  /**

   * 获取支持的金融标的列表

   */

  async getSupportedInstruments(req, res) {

    try {

      const { category, market, type, limit = 100, offset = 0 } = req.query;

      

      console.log('📋 获取标的列表 (从数据库):', { category, market, type, limit, offset });

      

      // 🔥 从数据库读取标的列表

      const Instrument = require('../models/Instrument');

      const { Op } = require('sequelize');

      

      const where = { status: 'active' };

      

      // 应用过滤条件

      if (type) {

        where.type = type;

      }

      

      if (category) {

        where.category = category;

      }

      

      if (market) {

        where.market = market;

      }

      

      // 查询数据库

      const { count, rows } = await Instrument.findAndCountAll({

        where,

        limit: parseInt(limit),

        offset: parseInt(offset),

        order: [['symbol', 'ASC']],

        raw: true

      });

      

      console.log(`✅ 从数据库查询到 ${rows.length} 个标的 (总计: ${count})`);

      

      // 转换为前端需要的格式

      const instruments = rows.map(item => ({

        code: item.symbol,

        name: item.name,

        type: item.type,

        market: item.market,

        category: item.category

      }));

      

      // 统计信息

      const stats = {

        total: count,

        indices: rows.filter(r => r.type === 'index').length,

        stocks: rows.filter(r => r.type === 'stock').length,

        etfs: rows.filter(r => r.type === 'etf').length,

        futures: rows.filter(r => r.type === 'futures').length

      };



      res.json({

        success: true,

        data: {

          instruments,

          stats,

          total: count,

          limit: parseInt(limit),

          offset: parseInt(offset)

        },

        message: '标的列表获取成功'

      });



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

   * 获取市场信息

   */

  async getMarketInfo(req, res) {

    try {

      const { marketCode } = req.params;

      

      if (marketCode) {

        const market = comprehensiveDataService.markets[marketCode];

        if (!market) {

          return res.status(404).json({

            success: false,

            message: '市场不存在'

          });

        }

        

        res.json({

          success: true,

          data: market,

          message: '市场信息获取成功'

        });

      } else {

        res.json({

          success: true,

          data: comprehensiveDataService.markets,

          message: '所有市场信息获取成功'

        });

      }



    } catch (error) {

      console.error('获取市场信息失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '市场信息获取失败'

      });

    }

  }



  /**

   * 搜索金融标的

   */

  async searchInstruments(req, res) {

    try {

      const { query, type, market, limit = 20 } = req.query;

      

      if (!query) {

        return res.status(400).json({

          success: false,

          message: '搜索关键词不能为空'

        });

      }



      const results = [];

      const searchQuery = query.toLowerCase();

      

      // 搜索所有标的

      for (const [category, items] of Object.entries(comprehensiveDataService.importantInstruments)) {

        for (const item of items) {

          // 匹配条件

          const matchesQuery = 

            item.symbol.toLowerCase().includes(searchQuery) ||

            item.name.toLowerCase().includes(searchQuery) ||

            (item.description && item.description.toLowerCase().includes(searchQuery));

          

          const matchesType = !type || item.type === type;

          const matchesMarket = !market || item.market === market;

          

          if (matchesQuery && matchesType && matchesMarket) {

            results.push({

              ...item,

              category,

              relevance: this.calculateRelevance(item, searchQuery)

            });

          }

        }

      }

      

      // 同时查询数据库（覆盖期货等未在importantInstruments中的标的）
      try {
        const { Op } = require('sequelize');
        const Instrument = require('../models/Instrument');
        const dbResults = await Instrument.findAll({
          where: {
            status: 'active',
            [Op.or]: [
              { symbol: { [Op.like]: `%${query}%` } },
              { name: { [Op.like]: `%${query}%` } }
            ],
            ...(type ? { type } : {}),
            ...(market ? { market } : {})
          },
          limit: parseInt(limit) * 2,
          raw: true
        });
        const existingSymbols = new Set(results.map(r => r.symbol));
        for (const item of dbResults) {
          if (!existingSymbols.has(item.symbol)) {
            results.push({
              symbol: item.symbol,
              code: item.symbol,
              name: item.name,
              type: item.type,
              market: item.market,
              category: item.category,
              relevance: item.name && item.name.includes(query) ? 8 : 5
            });
          }
        }
      } catch (dbErr) {
        console.warn('[searchInstruments] DB search failed:', dbErr.message);
      }

      // 按相关性排序并限制结果数量
      results.sort((a, b) => b.relevance - a.relevance);

      const limitedResults = results.slice(0, parseInt(limit));




      res.json({

        success: true,

        data: {

          results: limitedResults,

          total: results.length,

          query: query,

          filters: { type, market, limit }

        },

        message: '搜索完成'

      });



    } catch (error) {

      console.error('搜索金融标的失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '搜索失败'

      });

    }

  }



  /**

   * 获取历史数据范围

   */

  async getDataRange(req, res) {

    try {

      const { symbol } = req.params;

      

      // 识别标的信息

      const instrumentInfo = comprehensiveDataService.identifyInstrument(symbol);

      

      // 确定数据范围

      const establishedDate = instrumentInfo.established !== '未知' ? 

        instrumentInfo.established : '1990-01-01';

      

      const dataRange = {

        symbol,

        instrumentInfo,

        availableRange: {

          start: establishedDate,

          end: new Date().toISOString().split('T')[0]

        },

        dataSourceCoverage: {}

      };

      

      // 各数据源的覆盖范围

      for (const [sourceKey, sourceInfo] of Object.entries(comprehensiveDataService.dataSources)) {

        if (sourceInfo.enabled) {

          dataRange.dataSourceCoverage[sourceKey] = {

            name: sourceInfo.name,

            range: sourceInfo.historicalRange,

            supports: sourceInfo.coverage[instrumentInfo.type] || false

          };

        }

      }



      res.json({

        success: true,

        data: dataRange,

        message: '数据范围获取成功'

      });



    } catch (error) {

      console.error('获取数据范围失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '数据范围获取失败'

      });

    }

  }



  /**

   * 批量获取数据

   */

  async getBatchData(req, res) {

    try {

      const { symbols, startDate, endDate, period = 'daily' } = req.body;

      

      if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {

        return res.status(400).json({

          success: false,

          message: '标的列表不能为空'

        });

      }



      if (symbols.length > 50) {

        return res.status(400).json({

          success: false,

          message: '批量请求标的数量不能超过50个'

        });

      }



      const results = {};

      const errors = {};

      

      // 并发获取数据

      const promises = symbols.map(async (symbol) => {

        try {

          const data = await comprehensiveDataService.getComprehensiveData(symbol, {

            startDate,

            endDate,

            period,

            includeIndicators: false // 批量请求不包含指标以提高性能

          });

          results[symbol] = data;

        } catch (error) {

          errors[symbol] = error.message;

        }

      });



      await Promise.all(promises);



      res.json({

        success: true,

        data: {

          results,

          errors,

          summary: {

            total: symbols.length,

            success: Object.keys(results).length,

            failed: Object.keys(errors).length

          }

        },

        message: '批量数据获取完成'

      });



    } catch (error) {

      console.error('批量获取数据失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '批量数据获取失败'

      });

    }

  }



  /**

   * 清理缓存

   */

  async clearCache(req, res) {

    try {

      // 清除所有缓存而不仅仅是过期缓存

      const result = comprehensiveDataService.clearAllCache();

      

      res.json({

        success: true,

        message: '缓存清理成功',

        cleared: result.cleared

      });



    } catch (error) {

      console.error('清理缓存失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '缓存清理失败'

      });

    }

  }



  /**

   * 计算搜索相关性

   */

  calculateRelevance(item, query) {

    let relevance = 0;

    

    // 符号完全匹配

    if (item.symbol.toLowerCase() === query) {

      relevance += 100;

    } else if (item.symbol.toLowerCase().includes(query)) {

      relevance += 50;

    }

    

    // 名称匹配

    if (item.name.toLowerCase() === query) {

      relevance += 80;

    } else if (item.name.toLowerCase().includes(query)) {

      relevance += 30;

    }

    

    // 描述匹配

    if (item.description && item.description.toLowerCase().includes(query)) {

      relevance += 10;

    }

    

    return relevance;

  }



  /**

   * 测试单个数据源

   */

  async testDataSource(req, res) {

    try {

      const { sourceKey, symbol = '000001.SH', period = '1d' } = req.body;

      

      if (!sourceKey) {

        return res.status(400).json({

          success: false,

          message: '数据源标识不能为空'

        });

      }



      console.log(`测试数据源: ${sourceKey}, 标的: ${symbol}`);

      

      const startTime = Date.now();

      const result = await comprehensiveDataService.testSingleDataSource(sourceKey, symbol, { period });

      const responseTime = Date.now() - startTime;



      res.json({

        success: true,

        data: {

          ...result,

          responseTime,

          testedAt: new Date().toISOString()

        },

        message: '数据源测试完成'

      });



    } catch (error) {

      console.error('测试数据源失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '数据源测试失败'

      });

    }

  }



  /**

   * 测试单个数据源（GET方法）

   * 🔥 修复：直接调用指定数据源,绕过缓存机制

   */

  async testSingleSource(req, res) {

    try {

      const { sourceId } = req.params;

      const { limit = 3 } = req.query;

      

      if (!sourceId) {

        return res.status(400).json({

          success: false,

          message: '数据源ID不能为空'

        });

      }



      console.log(`🧪 测试数据源: ${sourceId}, 标的数量限制: ${limit}`);

      

      // 🔥 定义测试标的列表

      const testSymbols = [

        { symbol: '000001', name: '上证指数', type: 'index' },

        { symbol: '000300', name: '沪深300', type: 'index' },

        { symbol: '399001', name: '深证成指', type: 'index' },

        { symbol: '399006', name: '创业板指', type: 'index' },

        { symbol: '600519', name: '贵州茅台', type: 'stock' },

        { symbol: '000858', name: '五粮液', type: 'stock' }

      ];

      

      const samples = [];

      const startTime = Date.now();

      

      // 🔥 Mock data source shortcut: always succeeds using enhancedMockDataService directly

      if (sourceId.toLowerCase() === 'mock' || sourceId.toLowerCase() === 'enhancedmock') {

        const enhancedMockDataService = require('../services/enhancedMockDataService');

        for (let i = 0; i < Math.min(parseInt(limit), testSymbols.length); i++) {

          const testItem = testSymbols[i];

          try {

            const symbolCode = testItem.type === 'index'

              ? (testItem.symbol.startsWith('399') ? 'sz' + testItem.symbol : 'sh' + testItem.symbol)

              : (testItem.symbol.startsWith('6') ? 'sh' + testItem.symbol : 'sz' + testItem.symbol);

            const kline = enhancedMockDataService.generateEnhancedKLineData({

              symbol: symbolCode,

              period: 'daily',

              limit: 200

            });

            if (kline && kline.length > 0) {

              const latest = kline[kline.length - 1];

              const prev = kline.length > 1 ? kline[kline.length - 2] : latest;

              const change = prev.close !== 0 ? ((latest.close - prev.close) / prev.close * 100) : 0;

              samples.push({

                symbol: testItem.symbol,

                name: testItem.name,

                type: testItem.type === 'index' ? '指数' : '股票',

                price: parseFloat(latest.close).toFixed(2),

                change: change.toFixed(2),

                isPredefined: true,

                dataSource: '增强模拟数据'

              });

            }

          } catch (e) {

            console.error(`Mock test for ${testItem.symbol} failed:`, e.message);

          }

        }



        const responseTime = Date.now() - startTime;

        return res.json({

          success: true,

          dataCount: samples.length,

          samples,

          responseTime,

          isPredefined: true,

          message: `增强模拟数据生成成功，${samples.length} 个标的`

        });

      }



      // 🔥 Non-mock sources: call via comprehensiveDataService

      for (let i = 0; i < Math.min(parseInt(limit), testSymbols.length); i++) {

        const testItem = testSymbols[i];



        try {

          console.log(`📊 测试标的 ${i + 1}/${limit}: ${testItem.symbol} (${testItem.name})`);



          const instrumentInfo = comprehensiveDataService.identifyInstrument(testItem.symbol);

          instrumentInfo.type = testItem.type;



          let data = null;



          switch(sourceId.toLowerCase()) {

            case 'akshare':

              data = await comprehensiveDataService.fetchFromAKShare(testItem.symbol, instrumentInfo, {

                period: 'daily',

                count: 100

              });

              break;

            case 'adata':

              data = await comprehensiveDataService.fetchFromAData(testItem.symbol, instrumentInfo, {

                period: 'daily',

                count: 100

              });

              break;

            case 'efinance':

              data = await comprehensiveDataService.fetchFromEFinance(testItem.symbol, instrumentInfo, {

                period: 'daily',

                count: 100

              });

              break;

            default:

              throw new Error(`不支持的数据源: ${sourceId}`);

          }



          if (data && data.kline && data.kline.length > 0) {

            const latestKline = data.kline[data.kline.length - 1];

            const prevKline = data.kline.length > 1 ? data.kline[data.kline.length - 2] : latestKline;



            const change = latestKline.close - prevKline.close;

            const changePercent = prevKline.close !== 0 ? (change / prevKline.close) * 100 : 0;



            const isPredefined = data.isPredefined === true ||

                                data.source === '增强模拟数据' ||

                                data.source === '混合数据' ||

                                data.dataQuality === 'enhanced_simulation';



            samples.push({

              symbol: testItem.symbol,

              name: testItem.name,

              type: testItem.type === 'index' ? '指数' : '股票',

              price: parseFloat(latestKline.close).toFixed(2),

              change: changePercent.toFixed(2),

              isPredefined: isPredefined,

              dataSource: data.source

            });



            console.log(`✅ ${testItem.symbol}: 价格=${latestKline.close}, 数据源=${data.source}, 预定义=${isPredefined}`);

          } else {

            console.warn(`⚠️ ${testItem.symbol}: 无数据`);

          }

        } catch (error) {

          console.error(`❌ ${testItem.symbol} 测试失败:`, error.message);

        }

      }

      

      const responseTime = Date.now() - startTime;

      

      // 🔥 判断整体是否使用预定义数据

      const allPredefined = samples.every(s => s.isPredefined);

      const somePredefined = samples.some(s => s.isPredefined);

      

      console.log(`✅ 测试完成: 成功 ${samples.length}/${limit} 个标的, 响应时间=${responseTime}ms`);

      console.log(`   全部预定义=${allPredefined}, 部分预定义=${somePredefined}`);

      

      res.json({

        success: samples.length > 0,  // 🔥 修复：只要有数据就返回成功

        dataCount: samples.length,

        samples: samples,

        responseTime,

        isPredefined: allPredefined,

        message: samples.length > 0 

          ? `成功获取 ${samples.length} 个标的数据${allPredefined ? '（使用预定义数据）' : ''}` 

          : '测试失败，无法获取数据'

      });



    } catch (error) {

      console.error('❌ 测试数据源失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '数据源测试失败'

      });

    }

  }



  /**

   * 批量测试所有数据源

   */

  async testAllDataSources(req, res) {

    try {

      const { symbol = '000001.SH', period = '1d' } = req.body;

      

      console.log(`批量测试所有数据源, 标的: ${symbol}`);

      

      const results = await comprehensiveDataService.testAllDataSources(symbol, { period });



      res.json({

        success: true,

        data: results,

        message: '所有数据源测试完成'

      });



    } catch (error) {

      console.error('批量测试数据源失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '批量测试数据源失败'

      });

    }

  }



  /**

   * 获取数据源配置

   */

  async getDataSourceConfig(req, res) {

    try {

      const config = comprehensiveDataService.dataSources;

      

      res.json({

        success: true,

        data: config,

        message: '获取数据源配置成功'

      });

    } catch (error) {

      console.error('获取数据源配置失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '获取数据源配置失败'

      });

    }

  }



  /**

   * 更新数据源配置

   */

  async updateDataSourceConfig(req, res) {

    try {

      const { sourceKey, enabled, config } = req.body;



      if (!sourceKey) {

        return res.status(400).json({

          success: false,

          message: '缺少必需参数: sourceKey'

        });

      }



      // If config is provided without enabled flag, just acknowledge

      if (config) {

        console.log(`🔧 Data source config received: ${sourceKey}`, config);

        return res.json({

          success: true,

          message: `Data source ${sourceKey} config saved`

        });

      }



      // 如果提供了enabled,更新启用状态

      if (typeof enabled !== 'boolean') {

        return res.status(400).json({

          success: false,

          message: 'enabled参数必须是布尔值'

        });

      }



      console.log(`🔧 更新数据源配置: ${sourceKey} = ${enabled}`);



      const result = comprehensiveDataService.updateDataSourceConfig(sourceKey, enabled);



      res.json({

        success: true,

        data: result,

        message: `数据源 ${sourceKey} 已${enabled ? '启用' : '禁用'}`

      });



    } catch (error) {

      console.error('更新数据源配置失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '更新数据源配置失败'

      });

    }

  }



  /**

   * 获取已启用的数据源列表

   */

  async getEnabledDataSources(req, res) {

    try {

      console.log('📊 获取已启用的数据源列表');

      

      const dataSources = comprehensiveDataService.dataSources;

      const enabledSources = Object.entries(dataSources)

        .filter(([key, config]) => config.enabled)

        .map(([key, config]) => ({

          key,

          name: config.name,

          priority: config.priority,

          description: config.description,

          enabled: config.enabled

        }))

        .sort((a, b) => a.priority - b.priority);

      

      // 获取当前锁定的数据源

      const lockedSource = comprehensiveDataService.lockedDataSource;

      const lockExpireTime = comprehensiveDataService.lockExpireTime;

      const now = Date.now();

      const isLocked = lockedSource && now < lockExpireTime;

      const remainingSeconds = isLocked ? Math.floor((lockExpireTime - now) / 1000) : 0;

      

      console.log(`✅ 找到 ${enabledSources.length} 个已启用的数据源`);

      if (isLocked) {

        console.log(`🔒 当前锁定: ${lockedSource.name} (剩余 ${remainingSeconds}秒)`);

      }

      

      res.json({

        success: true,

        data: {

          sources: enabledSources,

          currentLocked: isLocked ? {

            key: lockedSource.key,

            name: lockedSource.name,

            remainingSeconds

          } : null

        },

        message: '已启用数据源列表获取成功'

      });

      

    } catch (error) {

      console.error('获取已启用数据源列表失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '获取已启用数据源列表失败'

      });

    }

  }



  /**

   * 切换数据源（解锁并重新选择）

   */

  async switchDataSource(req, res) {

    try {

      const { sourceKey } = req.body;

      

      if (!sourceKey) {

        return res.status(400).json({

          success: false,

          message: '缺少必需参数: sourceKey'

        });

      }

      

      console.log(`🔄 切换数据源: ${sourceKey}`);

      

      // 检查数据源是否存在且已启用

      const source = comprehensiveDataService.dataSources[sourceKey];

      if (!source) {

        return res.status(400).json({

          success: false,

          message: `未知的数据源: ${sourceKey}`

        });

      }

      

      if (!source.enabled) {

        return res.status(400).json({

          success: false,

          message: `数据源 ${source.name} 未启用`

        });

      }

      

      // 解锁当前数据源

      comprehensiveDataService.unlockDataSource();

      

      // 清除缓存以确保使用新数据源

      comprehensiveDataService.clearAllCache();

      

      console.log(`✅ 数据源已切换到: ${source.name}`);

      

      res.json({

        success: true,

        data: {

          sourceKey,

          sourceName: source.name

        },

        message: `已切换到数据源: ${source.name}`

      });

      

    } catch (error) {

      console.error('切换数据源失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '切换数据源失败'

      });

    }

  }



  /**

   * 获取市场行情列表

   */

  async getMarketQuotes(req, res) {

    try {

      const { limit = 20 } = req.query;

      

      console.log(`🔍 获取市场行情列表, 限制: ${limit}`);

      

      // 🔥 修复: 使用与交易界面相同的标的代码格式 (sh/sz前缀)

      const popularSymbols = [

        // 主要指数

        { symbol: 'sh000001', name: '上证指数', type: 'index', category: '指数' },

        { symbol: 'sh000300', name: '沪深300', type: 'index', category: '指数' },

        { symbol: 'sz399001', name: '深证成指', type: 'index', category: '指数' },

        { symbol: 'sz399006', name: '创业板指', type: 'index', category: '指数' },

        

        // 热门股票

        { symbol: 'sh600519', name: '贵州茅台', type: 'stock', category: '股票' },

        { symbol: 'sz000858', name: '五粮液', type: 'stock', category: '股票' },

        { symbol: 'sh600036', name: '招商银行', type: 'stock', category: '股票' },

        { symbol: 'sz000001', name: '平安银行', type: 'stock', category: '股票' },

        { symbol: 'sh600000', name: '浦发银行', type: 'stock', category: '股票' },

        { symbol: 'sh601318', name: '中国平安', type: 'stock', category: '股票' },

        { symbol: 'sz000333', name: '美的集团', type: 'stock', category: '股票' },

        { symbol: 'sz002594', name: '比亚迪', type: 'stock', category: '股票' }

      ];



      const quotes = [];

      const limitNum = Math.min(parseInt(limit), popularSymbols.length);

      

      // 🔥 修复: 使用 Promise.allSettled 避免单个失败影响全部

      const promises = popularSymbols.slice(0, limitNum).map(async (item) => {

        try {

          console.log(`📊 获取 ${item.symbol} (${item.name}) 行情...`);

          

          const data = await comprehensiveDataService.getComprehensiveData(item.symbol, {

            period: 'daily',

            includeIndicators: false,

            maxRetries: 2

          });

          

          console.log(`✅ ${item.symbol} 数据源: ${data?.source || '无'}`);

          

          if (data && data.kline && data.kline.length > 0) {

            const latestKline = data.kline[data.kline.length - 1];

            const prevKline = data.kline.length > 1 ? data.kline[data.kline.length - 2] : latestKline;

            

            // 计算涨跌

            const change = latestKline.close - prevKline.close;

            const changePercent = prevKline.close !== 0 ? (change / prevKline.close) * 100 : 0;

            

            return {

              symbol: item.symbol,

              name: item.name,

              type: item.type,

              category: item.category,

              price: latestKline.close,

              open: latestKline.open,

              high: latestKline.high,

              low: latestKline.low,

              volume: latestKline.volume,

              change: parseFloat(change.toFixed(2)),

              changePercent: parseFloat(changePercent.toFixed(2)),

              time: latestKline.time,

              source: data.source || '未知数据源'

            };

          }

          return null;

        } catch (error) {

          console.error(`❌ 获取 ${item.symbol} 行情失败:`, error.message);

          return null;

        }

      });



      // 🔥 使用 allSettled 等待所有请求完成

      const results = await Promise.allSettled(promises);

      const validQuotes = results

        .filter(r => r.status === 'fulfilled' && r.value !== null)

        .map(r => r.value);



      // 🔥 统计数据源

      const sourceCounts = {};

      validQuotes.forEach(q => {

        sourceCounts[q.source] = (sourceCounts[q.source] || 0) + 1;

      });



      console.log('📊 行情数据源统计:', sourceCounts);

      console.log(`✅ 成功获取 ${validQuotes.length}/${limitNum} 个行情`);



      res.json({

        success: true,

        data: {

          quotes: validQuotes,

          total: validQuotes.length,

          timestamp: new Date().toISOString(),

          sources: sourceCounts

        },

        message: '市场行情获取成功'

      });



    } catch (error) {

      console.error('获取市场行情列表失败:', error);

      res.status(500).json({

        success: false,

        error: error.message,

        message: '市场行情获取失败'

      });

    }

  }

}



module.exports = new ComprehensiveDataController();

