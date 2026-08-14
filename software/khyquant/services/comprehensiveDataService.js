/**
 * Comprehensive Data Service (数据治理层核心)
 *
 * Implements the four-level data fallback chain described in
 * thesis Chapter 4.5, Table 15:
 *   Level 1: Redis memory cache (millisecond response)
 *   Level 2: PostgreSQL / SQLite historical database
 *   Level 3: External APIs (AKShare, efinance, iFind, etc.)
 *   Level 4: Enhanced mock data (marked with isSimulated: true)
 *
 * Design patterns: Chain of Responsibility + Factory.
 * See thesis Code Block 9 (four-level fallback implementation).
 */

const axios = require('axios');

const akshareDataService = require('./akshareDataService');

const jsDataSources = require('./jsDataSources');

const freeStockDataService = require('./freeStockDataService');

const pythonDataSourceService = require('./pythonDataSourceService');

const { MarketData } = require('../models');

const {
  createDataSourcesConfig,
  createMarketsConfig,
  createImportantInstrumentsConfig
} = require('./comprehensiveDataStaticConfig');



class ComprehensiveDataService {

  constructor() {

    this.cache = new Map();

    this.cacheTimeout = 60000; // 1分钟缓存(从5分钟改为1分钟,更快更新数据)

    

    // 初始化数据源服务实例

    this.jsDataSourcesService = jsDataSources; // jsDataSources 已经是实例

    

    // 🔥 新增：数据源锁定机制（确保价格统一性）

    this.lockedDataSource = null

    this.lockExpireTime = 0

    this.lockDuration = 60000 // 60秒锁定时间

    

    // Data source config — priority: AKShare > AData > EFinance > Enhanced Mock

    this.dataSources = createDataSourcesConfig();

    // 全球市场配置

    this.markets = createMarketsConfig();




    // 预定义的重要标的

    this.importantInstruments = this.initializeImportantInstruments();

  }



  /**
   * 初始化重要标的列表 - 全球金融市场
   */
  initializeImportantInstruments() {
    return createImportantInstrumentsConfig();
  }




  /**

   * 获取当前应该显示的数据源名称

   * 优先级：锁定数据源 > 第一个启用的真实数据源 > 增强模拟数据

   * 

   * @param {string} actualSource - 实际数据来源（可选，用于缓存数据）

   */

  getCurrentDataSourceName(actualSource = null) {

    // 🔥 如果提供了实际数据源，优先使用

    if (actualSource && actualSource !== '未知' && actualSource !== 'Unknown') {

      return actualSource;

    }

    

    // 1. 如果有锁定的数据源，使用锁定的数据源名称

    if (this.lockedDataSource && Date.now() < this.lockExpireTime) {

      return this.lockedDataSource.name;

    }

    

    // 2. 获取所有启用的真实数据源（排除模拟数据源）

    const enabledRealSources = Object.entries(this.dataSources)

      .filter(([key, source]) => source.enabled && key !== 'mock')

      .sort((a, b) => a[1].priority - b[1].priority);

    

    // 3. 如果有启用的真实数据源，使用第一个

    if (enabledRealSources.length > 0) {

      return enabledRealSources[0][1].name;

    }

    

    // 4. 如果模拟数据源启用，使用模拟数据源

    if (this.dataSources.mock.enabled) {

      return this.dataSources.mock.name;

    }

    

    // 5. 兜底：返回"增强模拟数据"（即使未启用，也作为最后的兜底）

    return '增强模拟数据';

  }



  /**

   * 获取综合数据（包含数据源阶段信息）

   * 🔥 增强版：支持数据库缓存和增量更新

   */

  async getComprehensiveData(symbol, options = {}) {

    const {

      startDate = null,

      endDate = null,

      period = 'daily',

      includeIndicators = true,

      maxRetries = 3,

      instrumentType: instrumentTypeOverride = null

    } = options;



    const cacheKey = `comprehensive_${symbol}_${startDate}_${endDate}_${period}`;

    const cached = this.cache.get(cacheKey);



    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {

      console.log(`使用内存缓存数据: ${symbol}`);

      return cached.data;

    }



    // Priority 0: Delegate futures symbols to klineDataService (which has tick ZIP support)

    const isFuturesSymbol = instrumentTypeOverride === 'futures' ||
      // 期货合约：字母开头+数字，但排除 sh/sz/SH/SZ 开头的A股/指数代码
      (/^[a-zA-Z]{1,3}[\d_]/i.test(symbol) && !/^(sh|sz|SH|SZ)\d/i.test(symbol)) ||
      /^[a-zA-Z]{1,3}[-_]?main$/i.test(symbol);



    if (isFuturesSymbol) {

      try {

        const klineDataService = require('./klineDataService');

        console.log(`📊 Futures symbol detected: ${symbol}, delegating to klineDataService`);

        const result = await klineDataService.getKlineData(symbol, period, startDate, endDate, null, {

          instrumentType: 'futures'

        });

        if (result && result.kline && result.kline.length > 0) {

          const data = {

            symbol,

            name: symbol,

            kline: result.kline,

            source: result.data_source || 'futures-tick',

            dataQuality: result.isMock ? 'low' : 'high',

            sourceInfo: { name: result.data_source || 'futures-tick' },

            isHybrid: false,

            dataComposition: { [result.data_source || 'futures-tick']: result.kline.length }

          };

          this.cache.set(cacheKey, { data, timestamp: Date.now() });

          return data;

        }

        console.log(`⚠️ klineDataService returned no data for futures ${symbol}, falling through`);

      } catch (err) {

        console.error(`❌ Futures delegation failed for ${symbol}:`, err.message);

      }

    }



    // 识别标的类型和市场

    const instrumentInfo = this.identifyInstrument(symbol);

    

    // 🔥 步骤1: 检查数据库缓存

    console.log(`\n🔍 步骤1: 检查数据库缓存...`);

    const latestCachedDate = await this.getLatestCachedDate(symbol, period);

    

    let result = null;

    let lastError = null;

    

    if (latestCachedDate) {

      // 有缓存数据

      const today = new Date().toISOString().split('T')[0];

      const cachedDate = new Date(latestCachedDate);

      const todayDate = new Date(today);

      const daysGap = Math.floor((todayDate - cachedDate) / (1000 * 60 * 60 * 24));

      

      console.log(`✅ 找到缓存数据，最新日期: ${latestCachedDate}, 距今${daysGap}天`);

      

       if (daysGap <= 1) {
         // 缓存是最新的，检查数据量是否足够
        const cachedKline = await this.getKlineFromCache(symbol, period, startDate, endDate);
        //  数据量不足时跳过缓存，走步骤2重新从数据源拉取完整历史
        const MIN_CACHE_COUNT = 100;
        if (!cachedKline || cachedKline.length < MIN_CACHE_COUNT) {
          console.log(`⚠️ 缓存数据量不足 (${cachedKline?.length || 0} 条)，跳过缓存，重新拉取完整历史`);
          // result 保持 null，走步骤2
        } else {

          // 🔥 修复：从缓存数据中获取实际数据源

          const actualSource = cachedKline[0]?.dataSource || 'AKShare';

          console.log(`📊 缓存数据源: ${actualSource}`);

          

          result = {

            symbol,

            name: instrumentInfo.name || symbol,

            kline: cachedKline,

            source: actualSource,  // 使用缓存中记录的实际数据源

            dataQuality: 'cached',  // 🔥 数据库缓存数据

            coverage: 'complete',

            count: cachedKline.length,

            instrumentInfo,

            cacheInfo: {

              latestDate: latestCachedDate,

              daysOld: daysGap,

              isFresh: true,

              fromCache: true  // 标记数据来自缓存

            }

          };

        }

      } else {

        // 缓存过期，需要增量更新

        console.log(`🔄 缓存过期，尝试增量更新...`);

        

        // 获取缓存的历史数据

        const cachedKline = await this.getKlineFromCache(symbol, period, startDate, endDate);

        

        // 获取增量数据

        const nextDay = new Date(cachedDate);

        nextDay.setDate(nextDay.getDate() + 1);

        const incrementalStartDate = nextDay.toISOString().split('T')[0];

        

        console.log(`📡 获取增量数据: 从 ${incrementalStartDate} 到 ${today}`);

        

        const incrementalData = await this.fetchIncrementalData(symbol, period, incrementalStartDate);

        

        if (incrementalData && incrementalData.kline && incrementalData.kline.length > 0) {

          console.log(`✅ 获取到 ${incrementalData.kline.length} 条增量数据`);

          

          // 合并缓存数据和增量数据

          const mergedKline = [...cachedKline, ...incrementalData.kline];

          

          // 🔥 智能缓存策略：只缓存真实数据，不缓存模拟数据

          const isRealIncrementalData = incrementalData.source && 

                                        incrementalData.source !== '混合数据' && 

                                        incrementalData.source !== '基础模拟数据' && 

                                        incrementalData.source !== '增强模拟数据' &&

                                        incrementalData.source !== '增强模拟数据（完整智能混合）' &&

                                        incrementalData.dataQuality !== 'enhanced_simulation' &&

                                        !incrementalData.isHybrid;

          

          if (isRealIncrementalData) {

            console.log(`💾 保存增量数据到数据库...`);

            await this.saveKlineToCache(symbol, period, incrementalData.kline, incrementalData.source);

            console.log(`✅ 增量数据已缓存`);

          } else {

            console.log(`⏭️ 跳过缓存：检测到模拟增量数据（source=${incrementalData.source}, dataQuality=${incrementalData.dataQuality}）`);

          }

          

          // 🔥 修复：使用增量数据的实际数据源

          const actualSource = incrementalData.source || 'AKShare';

          console.log(`📊 增量数据源: ${actualSource}`);

          

          result = {

            symbol,

            name: instrumentInfo.name || symbol,

            kline: mergedKline,

            source: actualSource,  // 使用增量数据的实际数据源

            dataQuality: 'cached_incremental',

            coverage: 'complete',

            count: mergedKline.length,

            instrumentInfo,

            cacheInfo: {

              cachedCount: cachedKline.length,

              incrementalCount: incrementalData.kline.length,

              totalCount: mergedKline.length,

              latestDate: today,

              updateMethod: 'incremental',

              fromCache: true  // 标记数据来自缓存

            }

          };

        } else {

          console.warn(`⚠️ 无法获取增量数据，使用缓存数据`);

          

          // 即使无法获取增量数据，也返回缓存数据

          if (cachedKline && cachedKline.length > 0) {

            // 🔥 修复：从缓存数据中获取实际数据源

            const actualSource = cachedKline[0]?.dataSource || 'AKShare';

            console.log(`📊 缓存数据源（过期）: ${actualSource}`);

            

            result = {

              symbol,

              name: instrumentInfo.name || symbol,

              kline: cachedKline,

              source: actualSource,  // 使用缓存中记录的实际数据源

              dataQuality: 'cached_stale',

              coverage: 'complete',

              count: cachedKline.length,

              instrumentInfo,

              cacheInfo: {

                latestDate: latestCachedDate,

                daysOld: daysGap,

                isFresh: false,

                warning: '无法获取增量数据',

                fromCache: true  // 标记数据来自缓存

              }

            };

          }

        }

      }

    }

    

    // 🔥 步骤2: 如果没有缓存或缓存处理失败，从数据源获取完整数据

    if (!result) {

      console.log(`\n📡 步骤2: 从数据源获取完整数据...`);

      

      // 确定数据获取策略

      const dataStrategy = this.determineDataStrategy(instrumentInfo, startDate, endDate);

      

      // 按优先级尝试数据源

      for (const stage of dataStrategy.stages) {

        try {

          console.log(`🔄 尝试数据源: ${stage.name} (source=${stage.source}, priority=${stage.priority || 'N/A'})`);

          

          const data = await this.fetchDataFromSource(

            stage.source,

            symbol,

            instrumentInfo,

            {

              startDate: stage.startDate,

              endDate: stage.endDate,

              period

            }

          );



          if (data && data.kline && data.kline.length > 0) {

            console.log(`✅ 数据源 ${stage.name} 成功返回 ${data.kline.length} 条数据`);

            console.log(`   source字段: ${data.source}`);

            console.log(`   dataQuality: ${data.dataQuality}`);

            

            // 🔥 智能缓存策略：只缓存真实数据，不缓存模拟数据

            const isRealData = data.source && 

                              data.source !== '混合数据' && 

                              data.source !== '基础模拟数据' && 

                              data.source !== '增强模拟数据' &&

                              data.source !== '增强模拟数据（完整智能混合）' &&

                              data.dataQuality !== 'enhanced_simulation' &&

                              !data.isHybrid;

            

            if (isRealData && data.kline.length >= 100) {

              console.log(`💾 检测到完整真实数据（${data.kline.length}条，来源：${data.source}），保存到数据库缓存...`);

              try {

                await this.saveKlineToCache(symbol, period, data.kline, data.source);

                console.log(`✅ 数据已缓存到数据库，下次可快速加载`);

              } catch (cacheError) {

                console.warn(`⚠️ 缓存保存失败（不影响返回）:`, cacheError.message);

              }

            } else {

              if (!isRealData) {

                console.log(`⏭️ 跳过缓存：检测到模拟数据（source=${data.source}, dataQuality=${data.dataQuality}）`);

              } else {

                console.log(`⏭️ 跳过缓存：数据量不足（${data.kline.length}条，需要至少100条）`);

              }

            }

            

            result = {

              ...data,

              instrumentInfo,

              dataStrategy,

              currentStage: stage,

              totalStages: dataStrategy.stages.length

            };

            // 成功后锁定该数据源60秒，避免频繁切换
            if (stage.source !== 'mock') {
              this.lockedDataSource = { key: stage.source, ...this.dataSources[stage.source] };
              this.lockExpireTime = Date.now() + this.lockDuration;
              console.log(`🔒 锁定成功数据源: ${stage.name} (${this.lockDuration / 1000}秒)`);
            }

            break;

          } else {

            console.warn(`⚠️ 数据源 ${stage.name} 返回空数据`);

          }

        } catch (error) {

          console.error(`❌ 数据源 ${stage.name} 失败: ${error.message}`);

          console.error(`   错误堆栈:`, error.stack);

          lastError = error;

          continue;

        }

      }

    }



    // 🔥 步骤3: 如果所有数据源都失败，尝试混合数据策略

    if (!result) {

      console.log('\n⚠️ 所有API数据源都失败，尝试混合数据策略...');

      

      // 从数据库获取历史真实数据

      const historicalData = await this.getHistoricalKlineFromDB(symbol, period, startDate, endDate);

      

      if (historicalData && historicalData.length > 0) {

        console.log(`✅ 从数据库获取到 ${historicalData.length} 条历史数据`);

        console.log(`   最早日期: ${historicalData[0].time}`);

        console.log(`   最新日期: ${historicalData[historicalData.length - 1].time}`);

        

        // 检查是否需要补充数据

        const latestHistoricalDate = new Date(historicalData[historicalData.length - 1].time);

        const today = new Date();

        const daysGap = Math.floor((today - latestHistoricalDate) / (1000 * 60 * 60 * 24));

        

        console.log(`   距今天数: ${daysGap}天`);

        

        let finalKlineData = [...historicalData];

        let dataComposition = {

          historical: historicalData.length,

          simulated: 0,

          total: historicalData.length

        };

        

        // 如果历史数据不是最新的，用模拟数据补充

        if (daysGap > 1) {

          console.log(`🔄 历史数据不完整，使用模拟数据补充最近${daysGap}天...`);

          

          // 生成补充的模拟数据

          const simulatedData = this.generateSimulatedKlineData(

            symbol,

            latestHistoricalDate,

            today,

            historicalData[historicalData.length - 1].close,

            period

          );

          

          if (simulatedData && simulatedData.length > 0) {

            console.log(`✅ 生成 ${simulatedData.length} 条模拟数据用于补充`);

            finalKlineData = [...historicalData, ...simulatedData];

            dataComposition.simulated = simulatedData.length;

            dataComposition.total = finalKlineData.length;

          }

        }

        

        // 返回混合数据

        result = {

          kline: finalKlineData,

          source: '混合数据',

          dataQuality: 'mixed',

          dataComposition: dataComposition,

          message: `使用${dataComposition.historical}条历史真实数据 + ${dataComposition.simulated}条模拟数据`,

          isHybrid: true,

          historicalRange: {

            start: historicalData[0].time,

            end: historicalData[historicalData.length - 1].time

          },

          instrumentInfo

        };

        

        console.log(`✅ 混合数据策略成功: ${dataComposition.historical}条真实 + ${dataComposition.simulated}条模拟`);

        

      } else {

        // 如果数据库也没有数据，检查是否启用了模拟数据源

        const mockSource = this.dataSources.mock;

        if (mockSource && mockSource.enabled) {

          console.log('⚠️ 数据库也没有历史数据，使用纯模拟数据');

          result = await this.generateComprehensiveMockData(symbol, instrumentInfo, options);

        } else {

          console.error('❌ 所有数据源都失败，且模拟数据源未启用');

          throw lastError || new Error('所有数据源都失败，无法获取数据');

        }

      }

    }



    // 🔥 保存K线数据到数据库缓存（如果是真实数据）

    if (result && result.kline && result.kline.length > 0) {

      // 只缓存真实数据，不缓存模拟数据

      const isRealData = result.source && 

                         result.source !== '混合数据' && 

                         result.source !== '基础模拟数据' && 

                         result.source !== '增强模拟数据' &&

                         result.source !== '增强模拟数据（完整智能混合）' &&

                         result.dataQuality !== 'enhanced_simulation' &&

                         !result.isHybrid &&

                         !result.source?.includes('数据库缓存'); // 不重复缓存已经在数据库中的数据

      

      if (isRealData) {

        try {

          console.log(`💾 保存K线数据到数据库缓存: ${symbol}, ${result.kline.length}条`);

          await this.saveKlineToCache(symbol, period, result.kline, result.source);

        } catch (error) {

          console.warn(`⚠️ 保存K线缓存失败: ${error.message}`);

          // 不影响主流程，继续返回数据

        }

      } else {

        console.log(`⏭️ 跳过缓存：检测到模拟数据或混合数据（source=${result.source}, dataQuality=${result.dataQuality}, isHybrid=${result.isHybrid}）`);

      }

    }



    // 添加技术指标

    if (includeIndicators && result.kline) {

      result.indicators = this.calculateTechnicalIndicators(result.kline);

    }



    // 缓存结果到内存

    this.cache.set(cacheKey, {

      data: result,

      timestamp: Date.now()

    });



    return result;

  }



  /**

   * 识别金融标的信息 - 支持全球市场

   */

  identifyInstrument(symbol) {

    // 标准化符号格式

    const normalizedSymbol = this.normalizeSymbol(symbol);

    

    // 在预定义列表中查找

    for (const category of Object.values(this.importantInstruments)) {

      const found = category.find(item => 

        item.symbol === normalizedSymbol || 

        item.symbol === symbol ||

        this.normalizeSymbol(item.symbol) === normalizedSymbol

      );

      if (found) {

        return {

          ...found,

          category: this.getCategoryName(found.type)

        };

      }

    }



    // 根据符号规则推断

    return this.inferInstrumentInfo(normalizedSymbol);

  }



  /**

   * 标准化符号格式 - 支持全球格式

   */

  normalizeSymbol(symbol) {

    // 移除常见前缀和空格

    symbol = symbol.trim().toUpperCase();

    

    // 🔥 处理前端传递的 sh/sz 前缀格式（如：sh000300, sz399001）

    if (/^SH\d{6}$/.test(symbol)) {

      // sh000300 -> 000300.SS

      return symbol.substring(2) + '.SS';

    }

    if (/^SZ\d{6}$/.test(symbol)) {

      // sz399001 -> 399001.SZ

      return symbol.substring(2) + '.SZ';

    }

    

    // 统一中国股票格式为 Yahoo Finance 标准

    if (symbol.includes('.SH')) {

      return symbol.replace('.SH', '.SS'); // 转换为Yahoo格式

    } else if (symbol.includes('.SS')) {

      return symbol; // 上海证券交易所 (Yahoo格式)

    } else if (symbol.includes('.SZ')) {

      return symbol; // 深圳证券交易所 (Yahoo格式)

    }

    

    // 中国股票代码处理

    if (symbol.length === 6 && /^\d+$/.test(symbol)) {

      if (symbol.startsWith('6')) {

        return `${symbol}.SS`; // 上海A股

      } else if (symbol.startsWith('0') || symbol.startsWith('3')) {

        return `${symbol}.SZ`; // 深圳A股

      }

    }

    

    // 美股代码通常不需要后缀

    if (/^[A-Z]{1,5}$/.test(symbol)) {

      return symbol; // 美股代码

    }

    

    // 指数代码

    if (symbol.startsWith('^')) {

      return symbol; // Yahoo Finance指数格式

    }

    

    // 期货代码

    if (symbol.includes('=F')) {

      return symbol; // Yahoo Finance期货格式

    }

    

    // 外汇代码

    if (symbol.includes('=X')) {

      return symbol; // Yahoo Finance外汇格式

    }

    

    // 加密货币代码

    if (symbol.includes('-USD') || symbol.includes('-USDT')) {

      return symbol; // 加密货币格式

    }

    

    return symbol;

  }



  /**

   * 推断标的信息 - 支持全球市场

   */

  inferInstrumentInfo(symbol) {

    // 美国指数

    if (symbol.startsWith('^')) {

      return {

        symbol,

        type: 'index',

        market: this.inferMarketFromSymbol(symbol),

        country: 'US',

        category: '指数',

        established: '未知',

        description: '美国股票指数'

      };

    }

    

    // 期货合约

    if (symbol.includes('=F')) {

      return {

        symbol,

        type: 'futures',

        market: this.inferMarketFromSymbol(symbol),

        country: 'US',

        category: '期货',

        established: '未知',

        description: '期货合约'

      };

    }

    

    // 外汇

    if (symbol.includes('=X')) {

      return {

        symbol,

        type: 'forex',

        market: 'FOREX',

        country: 'GLOBAL',

        category: '外汇',

        established: '未知',

        description: '外汇汇率'

      };

    }

    

    // 加密货币

    if (symbol.includes('-USD') || symbol.includes('-USDT')) {

      return {

        symbol,

        type: 'cryptocurrency',

        market: 'CRYPTO',

        country: 'GLOBAL',

        category: '加密货币',

        established: '未知',

        description: '加密货币'

      };

    }

    

    // 中国指数 - 必须在股票判断之前！

    // 🔥 修复: 精确判断指数,避免将股票误判为指数

    const codeMatch = symbol.match(/^(\d{6})\.(SS|SZ)$/);

    if (codeMatch) {

      const code = codeMatch[1];

      const market = codeMatch[2];

      

      // 明确的指数代码列表

      const indexCodes = new Set([

        '000001', '000300', '000016', '000905', '000852',  // 上海主要指数

        '000116', '000131'  // 其他上海指数

      ]);

      

      // 判断是否为指数: 只有在明确的指数列表中或以399开头才是指数

      const isIndex = indexCodes.has(code) || code.startsWith('399');

      

      if (isIndex) {

        return {

          symbol,

          type: 'index',

          market: market === 'SS' ? 'SSE' : 'SZSE',

          country: 'CN',

          category: '指数',

          established: '未知',

          description: market === 'SS' ? '上海证券交易所指数' : '深圳证券交易所指数'

        };

      }

    }

    

    // 中国股票

    if (symbol.includes('.SS')) {

      return {

        symbol,

        type: 'stock',

        market: 'SSE',

        country: 'CN',

        category: '股票',

        established: '未知',

        description: '上海证券交易所股票'

      };

    }

    

    if (symbol.includes('.SZ')) {

      return {

        symbol,

        type: 'stock',

        market: 'SZSE',

        country: 'CN',

        category: '股票',

        established: '未知',

        description: '深圳证券交易所股票'

      };

    }

    

    // 其他国际股票

    if (symbol.includes('.')) {

      const suffix = symbol.split('.')[1];

      const marketInfo = this.getMarketFromSuffix(suffix);

      return {

        symbol,

        type: 'stock',

        market: marketInfo.market,

        country: marketInfo.country,

        category: '股票',

        established: '未知',

        description: `${marketInfo.description}股票`

      };

    }

    

    // 美股 (无后缀)

    if (/^[A-Z]{1,5}$/.test(symbol)) {

      return {

        symbol,

        type: 'stock',

        market: 'NASDAQ', // 默认为纳斯达克

        country: 'US',

        category: '股票',

        established: '未知',

        description: '美国股票'

      };

    }

    

    // 默认

    return {

      symbol,

      type: 'unknown',

      market: 'unknown',

      country: 'unknown',

      category: '未知',

      established: '未知',

      description: '未知金融标的'

    };

  }



  /**

   * 从后缀推断市场信息

   */

  getMarketFromSuffix(suffix) {

    const suffixMap = {

      'T': { market: 'TSE', country: 'JP', description: '东京证券交易所' },

      'HK': { market: 'HKEX', country: 'HK', description: '香港交易所' },

      'KS': { market: 'KRX', country: 'KR', description: '韩国交易所' },

      'TW': { market: 'TWSE', country: 'TW', description: '台湾证券交易所' },

      'L': { market: 'LSE', country: 'UK', description: '伦敦证券交易所' },

      'DE': { market: 'XETRA', country: 'DE', description: '德国电子交易系统' },

      'PA': { market: 'EPA', country: 'FR', description: '巴黎泛欧交易所' },

      'AS': { market: 'AEX', country: 'NL', description: '阿姆斯特丹交易所' }

    };

    

    return suffixMap[suffix] || { market: 'unknown', country: 'unknown', description: '未知交易所' };

  }



  /**

   * 从符号推断市场

   */

  inferMarketFromSymbol(symbol) {

    if (symbol.startsWith('^GSPC') || symbol.startsWith('^DJI')) return 'NYSE';

    if (symbol.startsWith('^IXIC')) return 'NASDAQ';

    if (symbol.includes('GC=F') || symbol.includes('SI=F')) return 'COMEX';

    if (symbol.includes('CL=F') || symbol.includes('NG=F')) return 'NYMEX';

    if (symbol.includes('ZC=F') || symbol.includes('ZS=F')) return 'CBOT';

    

    return 'unknown';

  }



  /**

   * 确定数据获取策略 - 多数据源优先级策略（带锁定机制）

   */

  determineDataStrategy(instrumentInfo, startDate, endDate) {

    const now = Date.now()

    

    // 🔥 如果数据源已锁定且未过期，继续使用锁定的数据源

    if (this.lockedDataSource && now < this.lockExpireTime) {

      const remainingSeconds = Math.floor((this.lockExpireTime - now) / 1000)

      console.log(`🔒 使用锁定的数据源: ${this.lockedDataSource.name} (剩余 ${remainingSeconds}秒)`)

      

      // 确定历史数据范围

      const establishedDate = instrumentInfo.established !== '未知' ? 

        new Date(instrumentInfo.established) : new Date('1990-01-01')

      const actualStartDate = startDate ? new Date(startDate) : establishedDate

      const actualEndDate = endDate ? new Date(endDate) : new Date()

      

      return {

        stages: [{

          name: `${this.lockedDataSource.name}数据`,

          source: this.lockedDataSource.key,

          startDate: actualStartDate.toISOString().split('T')[0],

          endDate: actualEndDate.toISOString().split('T')[0],

          coverage: this.lockedDataSource.historicalRange,

          priority: this.lockedDataSource.priority,

          language: this.lockedDataSource.language,

          successRate: this.lockedDataSource.successRate || 50,

          description: this.lockedDataSource.description,

          locked: true

        }],

        totalCoverage: '完整历史数据',

        description: `锁定数据源: ${this.lockedDataSource.name}`

      }

    }

    

    const strategy = {

      stages: [],

      totalCoverage: '完整历史数据',

      description: '多数据源智能切换'

    };



    // 确定历史数据范围

    const establishedDate = instrumentInfo.established !== '未知' ? 

      new Date(instrumentInfo.established) : new Date('1990-01-01');

    const actualStartDate = startDate ? new Date(startDate) : establishedDate;

    const actualEndDate = endDate ? new Date(endDate) : new Date();



    // 🔥 只选择用户激活的数据源（enabled=true），包括模拟数据源

    const enabledSources = Object.entries(this.dataSources)

      .filter(([key, source]) => source.enabled)

      .sort((a, b) => a[1].priority - b[1].priority);



    // 🔥 如果没有启用的数据源，自动兜底启用模拟数据源

    if (enabledSources.length === 0) {

      console.warn('⚠️ 没有启用的数据源，自动切换到增强模拟数据源');

      this.dataSources.mock.enabled = true;

      enabledSources.push(['mock', this.dataSources.mock]);

    } else {

      console.log(`📊 当前启用的数据源 (${enabledSources.length}个):`, 

        enabledSources.map(([key, config]) => `${config.name}(priority=${config.priority})`).join(', ')

      );

    }



    // 不提前锁定，等数据源成功后再锁定（避免锁定到失败的数据源）
    console.log(`📊 按优先级尝试 ${enabledSources.length} 个数据源...`)



    for (const [sourceKey, sourceConfig] of enabledSources) {

      strategy.stages.push({

        name: `${sourceConfig.name}数据`,

        source: sourceKey,

        startDate: actualStartDate.toISOString().split('T')[0],

        endDate: actualEndDate.toISOString().split('T')[0],

        coverage: sourceConfig.historicalRange,

        priority: sourceConfig.priority,

        language: sourceConfig.language,

        successRate: sourceConfig.successRate || 50,

        description: sourceConfig.description

      });

    }



    return strategy;

  }

  

  /**

   * 手动解锁数据源（用于数据源切换）

   */

  unlockDataSource() {

    console.log('🔓 手动解锁数据源')

    this.lockedDataSource = null

    this.lockExpireTime = 0

  }



  /**

   * 从指定数据源获取数据 - 支持多数据源

   */

  async fetchDataFromSource(source, symbol, instrumentInfo, options) {

    switch (source) {

      case 'akshare':

        return await this.fetchFromAKShare(symbol, instrumentInfo, options);

      case 'adata':

        return await this.fetchFromAData(symbol, instrumentInfo, options);

      case 'efinance':

        return await this.fetchFromEFinance(symbol, instrumentInfo, options);

      case 'mock': {
        const enhancedMock = require('./enhancedMockDataService');
        const period = options.period || 'daily';
        const isIntraday = ['1m','1min','5m','5min','15m','15min','30m','30min','60m','60min','1h'].includes(period);

        // 分钟/小时线：先尝试从Tick文件聚合
        if (isIntraday) {
          try {
            const futuresTickDataService = require('./futuresTickDataService');
            const dates = await futuresTickDataService.getAvailableDates();
            const upperSymbol = symbol.replace(/^(sh|sz)/i, '').toUpperCase();

            if (dates.length > 0) {
              // 找到包含该标的的日期
              const matchDates = [];
              for (const date of dates) {
                const syms = await futuresTickDataService.getAvailableSymbols(date);
                if (syms.includes(upperSymbol)) matchDates.push(date);
              }

              if (matchDates.length > 0) {
                const periodMap = { '1m':'1m','1min':'1m','5m':'5m','5min':'5m','15m':'15m','15min':'15m','30m':'30m','30min':'30m','60m':'1h','60min':'1h','1h':'1h' };
                const tickPeriod = periodMap[period] || '1m';
                const allBars = [];
                for (const date of matchDates) {
                  const { bars, dataSource } = await futuresTickDataService.getKlineFromTicks(upperSymbol, date, tickPeriod);
                  allBars.push(...bars);
                }
                if (allBars.length > 0) {
                  const kline = allBars.map(b => ({
                    time: b.date || new Date(b.timestamp).toISOString().slice(0,16).replace('T',' '),
                    date: b.date || new Date(b.timestamp).toISOString().slice(0,16).replace('T',' '),
                    open: b.open, high: b.high, low: b.low, close: b.close,
                    volume: b.volume || 0, amount: b.amount || 0
                  }));
                  console.log(`✅ Tick聚合成功: ${symbol} ${period}, ${kline.length}条`);
                  return {
                    symbol,
                    name: instrumentInfo.name || symbol,
                    kline,
                    currentPrice: kline[kline.length - 1].close,
                    source: 'tick-folder-aggregated',
                    dataQuality: 'high',
                    sourceInfo: { name: 'Tick文件聚合', description: `从本地Tick CSV文件聚合为${period}K线` },
                    dataComposition: { 'tick-folder-aggregated': kline.length }
                  };
                }
              }
            }
          } catch (tickErr) {
            console.warn(`[mock] Tick聚合失败: ${tickErr.message}`);
          }
        }

        // 无Tick数据时使用模拟
        const symbolCode = instrumentInfo.prefix ? instrumentInfo.prefix + symbol.replace(/^(sh|sz)/i, '') : symbol;
        const kline = enhancedMock.generateEnhancedKLineData({
          symbol: symbolCode,
          period,
          startDate: options.startDate || null,
          endDate: options.endDate || null,
          limit: options.count || 1000
        });
        const mockSource = isIntraday ? `模拟${period}数据` : '增强模拟数据';
        return {
          symbol,
          name: instrumentInfo.name || symbol,
          kline,
          currentPrice: kline.length > 0 ? kline[kline.length - 1].close : 0,
          source: mockSource,
          dataQuality: 'enhanced_simulation',
          sourceInfo: { name: mockSource, description: '无真实数据，使用模拟K线（仅供展示）' },
          dataComposition: { [mockSource]: kline.length }
        };
      }
            default:

        console.warn(`Unsupported data source "${source}" — falling back to mock`);

        return await this.generateComprehensiveMockData(symbol, instrumentInfo, options);

    }

  }



  /**

   * 从iFinD获取数据（Python数据源）

   */

  async fetchFromIFind(symbol, instrumentInfo, options) {

    try {

      console.log(`📊 从iFinD获取数据: ${symbol}`);

      

      // 转换标的代码格式

      let ifindSymbol = symbol;

      ifindSymbol = ifindSymbol.replace(/^(sh|sz)/i, '');

      if (ifindSymbol.includes('.')) {

        ifindSymbol = ifindSymbol.split('.')[0];

      }

      

      console.log(`   转换标的代码: ${symbol} -> ${ifindSymbol}`);

      

      // 转换日期格式

      const startDate = options.startDate || '2020-01-01';

      const endDate = options.endDate || null;

      

      // 转换K线类型

      const period = options.period || 'daily';

      

      // 调用Python服务

      const result = await pythonDataSourceService.getKlineFromIFind(ifindSymbol, {

        period,

        startDate,

        endDate

      });

      

      if (!result || !result.kline || result.kline.length === 0) {

        throw new Error('iFinD返回空数据');

      }

      

      // 转换数据格式

      const klineData = result.kline.map(item => ({

        time: item.time,

        open: parseFloat(item.open),

        high: parseFloat(item.high),

        low: parseFloat(item.low),

        close: parseFloat(item.close),

        volume: parseInt(item.volume)

      }));

      

      // 检查是否为预定义数据

      const dataQuality = result.isPredefined ? 'enhanced_simulation' : 'high';

      

      return {

        symbol: result.symbol,

        name: symbol,

        kline: klineData,

        source: 'iFinD',

        sourceInfo: this.dataSources.ifind,

        dataQuality: dataQuality,

        isPredefined: result.isPredefined || false,

        coverage: 'complete',

        count: klineData.length

      };

    } catch (error) {

      console.warn(`⚠️ iFinD获取失败: ${error.message}`);

      throw error;

    }

  }



  /**

   * 从东方财富获取数据

   */

  async fetchFromEastMoney(symbol, instrumentInfo, options) {

    try {

      console.log(`📊 从东方财富获取数据: ${symbol}`);

      

      // reliableDataService was removed — delegate to akshareDataService

      const data = await akshareDataService.getStockData(symbol, options);



      if (!data || !data.kline || data.kline.length === 0) {

        throw new Error('EastMoney source returned empty data');

      }



      return {

        ...data,

        source: '东方财富',

        sourceInfo: this.dataSources.eastmoney,

        dataQuality: 'high',

        coverage: 'complete'

      };

    } catch (error) {

      console.warn(`⚠️ 东方财富获取失败: ${error.message}`);

      throw error;

    }

  }



  /**

   * 从新浪财经获取数据

   */

  async fetchFromSina(symbol, instrumentInfo, options) {

    try {

      console.log(`📊 从新浪财经获取数据: ${symbol}`);

      

      // reliableDataService was removed — delegate to akshareDataService

      const data = await akshareDataService.getStockData(symbol, options);



      if (!data || !data.kline || data.kline.length === 0) {

        throw new Error('Sina source returned empty data');

      }



      return {

        ...data,

        source: '新浪财经',

        sourceInfo: this.dataSources.sina,

        dataQuality: 'medium',

        coverage: 'recent'

      };

    } catch (error) {

      console.warn(`⚠️ 新浪财经获取失败: ${error.message}`);

      throw error;

    }

  }



  /**

   * 从腾讯财经获取数据

   */

  async fetchFromTencent(symbol, instrumentInfo, options) {

    try {

      console.log(`📊 从腾讯财经获取数据: ${symbol}`);

      

      // reliableDataService was removed — delegate to akshareDataService

      const data = await akshareDataService.getStockData(symbol, options);



      if (!data || !data.kline || data.kline.length === 0) {

        throw new Error('Tencent source returned empty data');

      }



      return {

        ...data,

        source: '腾讯财经',

        sourceInfo: this.dataSources.tencent,

        dataQuality: 'medium',

        coverage: 'recent'

      };

    } catch (error) {

      console.warn(`⚠️ 腾讯财经获取失败: ${error.message}`);

      throw error;

    }

  }



  /**

   * 从网易财经获取数据

   */

  async fetchFromNetease(symbol, instrumentInfo, options) {

    try {

      console.log(`📊 从网易财经获取数据: ${symbol}`);

      

      // 使用 jsDataSources 获取数据

      const data = await this.jsDataSourcesService.fetchFromNetease(symbol, options);

      

      if (!data || !data.kline || data.kline.length === 0) {

        throw new Error('网易财经返回空数据');

      }

      

      return {

        ...data,

        source: '网易财经',

        sourceInfo: this.dataSources.netease,

        dataQuality: 'medium',

        coverage: 'recent'

      };

    } catch (error) {

      console.warn(`⚠️ 网易财经获取失败: ${error.message}`);

      throw error;

    }

  }



  /**

   * 从EFinance获取数据（Python数据源）

   */

  async fetchFromEFinance(symbol, instrumentInfo, options) {

    try {

      console.log(`📊 从EFinance获取数据: ${symbol}`);

      

      // 转换日期格式：YYYY-MM-DD -> YYYYMMDD

      const startDate = options.startDate ? options.startDate.replace(/-/g, '') : '20200101';

      const endDate = options.endDate ? options.endDate.replace(/-/g, '') : null;

      

      // 转换K线类型

      const klt = this.convertPeriodToEFinanceKlt(options.period || 'daily');

      

      // 调用Python服务

      const result = await pythonDataSourceService.getKlineFromEFinance(symbol, {

        klt,

        startDate,

        endDate

      });

      

      if (!result || !result.kline || result.kline.length === 0) {

        throw new Error('EFinance返回空数据');

      }

      

      // 转换数据格式

      const klineData = result.kline.map(item => ({

        time: item.time,

        open: parseFloat(item.open),

        high: parseFloat(item.high),

        low: parseFloat(item.low),

        close: parseFloat(item.close),

        volume: parseInt(item.volume)

      }));

      

      // 🔥 修复：检查是否为预定义数据，设置正确的数据质量

      const dataQuality = result.isPredefined ? 'enhanced_simulation' : 'high';

      

      return {

        symbol: result.symbol,

        name: result.name || symbol,

        kline: klineData,

        source: 'EFinance',

        sourceInfo: this.dataSources.efinance,

        dataQuality: dataQuality,

        isPredefined: result.isPredefined || false,

        coverage: 'complete',

        count: klineData.length

      };

    } catch (error) {

      console.warn(`⚠️ EFinance获取失败: ${error.message}`);

      throw error;

    }

  }



  /**

   * 从AData获取数据（Python数据源）- 增强版：支持重试机制

   */

  async fetchFromAData(symbol, instrumentInfo, options) {

    const maxRetries = 3;

    let lastError = null;

    

    for (let attempt = 1; attempt <= maxRetries; attempt++) {

      try {

        console.log(`📊 从AData获取数据 (尝试 ${attempt}/${maxRetries}): ${symbol}`);

        console.log(`   参数:`, { startDate: options.startDate, endDate: options.endDate, period: options.period });

        

        // 🔥 转换标的代码格式：sh000300 -> 000300, 000300.SS -> 000300

        let adataSymbol = symbol;

        

        // 移除sh/sz前缀

        adataSymbol = adataSymbol.replace(/^(sh|sz)/i, '');

        

        // 移除.SS/.SZ后缀

        if (adataSymbol.includes('.')) {

          adataSymbol = adataSymbol.split('.')[0];

        }

        

        console.log(`   转换标的代码: ${symbol} -> ${adataSymbol}`);

        

        // 转换日期格式：YYYY-MM-DD -> YYYY-MM-DD (AData使用标准格式)

        const startDate = options.startDate || '2020-01-01';

        const endDate = options.endDate || null;

        

        // 转换K线类型

        const kType = this.convertPeriodToADataKType(options.period || 'daily');

        console.log(`   K线类型: ${kType} (${options.period || 'daily'})`);

        

        // 调用Python服务

        console.log(`   调用Python服务获取数据...`);

        const result = await pythonDataSourceService.getKlineFromAData(adataSymbol, {

          kType,

          startDate,

          endDate

        });

        

        console.log(`   Python服务返回:`, { 

          success: !!result, 

          hasKline: !!(result && result.kline),

          klineLength: result?.kline?.length || 0 

        });

        

        if (!result || !result.kline || result.kline.length === 0) {

          throw new Error('AData返回空数据');

        }

        

        // 转换数据格式

        const klineData = result.kline.map(item => ({

          time: item.time,

          open: parseFloat(item.open),

          high: parseFloat(item.high),

          low: parseFloat(item.low),

          close: parseFloat(item.close),

          volume: parseInt(item.volume)

        }));

        

        console.log(`✅ AData数据获取成功: ${klineData.length} 条数据`);

        

        return {

          symbol: result.symbol,

          name: symbol,

          kline: klineData,

          source: 'AData',  // 🔥 确保返回正确的source

          sourceInfo: this.dataSources.adata,

          dataQuality: 'high',

          coverage: 'complete',

          count: klineData.length

        };

      } catch (error) {

        lastError = error;

        console.error(`❌ AData获取失败 (尝试 ${attempt}/${maxRetries}): ${error.message}`);

        console.error(`   错误堆栈:`, error.stack);

        

        if (attempt < maxRetries) {

          // 等待后重试

          const delay = attempt * 1000; // 1秒, 2秒, 3秒

          console.log(`   等待 ${delay}ms 后重试...`);

          await new Promise(resolve => setTimeout(resolve, delay));

        }

      }

    }

    

    // 所有重试都失败

    console.error(`❌ AData所有重试都失败，最后错误:`, lastError.message);

    throw lastError;

  }



  /**

   * 转换周期到EFinance的klt参数

   */

  convertPeriodToEFinanceKlt(period) {

    const periodMap = {

      '1min': 1,

      '5min': 5,

      '15min': 15,

      '30min': 30,

      '60min': 60,

      'daily': 101,

      'weekly': 102,

      'monthly': 103

    };

    return periodMap[period] || 101; // 默认日线

  }



  /**

   * 转换周期到AData的kType参数

   */

  convertPeriodToADataKType(period) {

    const periodMap = {

      'daily': 1,

      'weekly': 2,

      'monthly': 3

    };

    return periodMap[period] || 1; // 默认日线

  }



  /**

   * 从Yahoo Finance获取数据

   */

  async fetchFromYahoo(symbol, instrumentInfo, options) {

    try {

      console.log(`📊 从Yahoo Finance获取数据: ${symbol}`);

      

      // 使用 jsDataSources 获取数据

      const data = await this.jsDataSourcesService.fetchFromYahoo(symbol, options);

      

      if (!data || !data.kline || data.kline.length === 0) {

        throw new Error('Yahoo Finance返回空数据');

      }

      

      return {

        ...data,

        source: 'Yahoo Finance',

        sourceInfo: this.dataSources.yahoo,

        dataQuality: 'high',

        coverage: 'complete'

      };

    } catch (error) {

      console.warn(`⚠️ Yahoo Finance获取失败: ${error.message}`);

      throw error;

    }

  }



  /**

   * 直接从东方财富获取数据（保留兼容性）

   */

  async fetchFromEastMoneyDirect(symbol, instrumentInfo, options) {

    return await this.fetchFromEastMoney(symbol, instrumentInfo, options);

  }



  /**

   * 直接从新浪财经获取数据（保留兼容性）

   */

  async fetchFromSinaDirect(symbol, instrumentInfo, options) {

    return await this.fetchFromSina(symbol, instrumentInfo, options);

  }



  /**

   * 直接从腾讯财经获取数据（保留兼容性）

   */

  async fetchFromTencentDirect(symbol, instrumentInfo, options) {

    return await this.fetchFromTencent(symbol, instrumentInfo, options);

  }



  /**

   * 从Yahoo Finance获取数据

   */

  async fetchFromYahoo(symbol, instrumentInfo, options) {

    try {

      console.log(`从Yahoo Finance获取数据: ${symbol}`);

      const data = await jsDataSources.fetchFromYahoo(symbol, options);

      

      return {

        ...data,

        sourceInfo: this.dataSources.yahoo,

        dataQuality: 'high',

        coverage: 'complete'

      };

    } catch (error) {

      throw new Error(`Yahoo Finance数据获取失败: ${error.message}`);

    }

  }



  /**

   * 从网易财经获取数据

   */

  async fetchFromNeteaseJS(symbol, instrumentInfo, options) {

    try {

      console.log(`从网易财经获取数据: ${symbol}`);

      const data = await jsDataSources.fetchFromNetease(symbol, options);

      

      return {

        ...data,

        sourceInfo: this.dataSources.netease_js,

        dataQuality: 'medium',

        coverage: 'recent'

      };

    } catch (error) {

      throw new Error(`网易财经数据获取失败: ${error.message}`);

    }

  }



  /**

   * 从Alpha Vantage获取数据

   */

  async fetchFromAlphaVantage(symbol, instrumentInfo, options) {

    try {

      console.log(`从Alpha Vantage获取数据: ${symbol}`);

      const data = await jsDataSources.fetchFromAlphaVantage(symbol, options);

      

      return {

        ...data,

        source: 'Alpha Vantage',

        sourceInfo: this.dataSources.alphavantage,

        dataQuality: 'high',

        coverage: 'complete'

      };

    } catch (error) {

      throw new Error(`Alpha Vantage数据获取失败: ${error.message}`);

    }

  }

  /**

   * 从AKShare获取数据 - 唯一真实数据源

   * 🔥 修复：直接调用已修复的akshareService.py，使用每日历史数据替代实时数据

   */

  async fetchFromAKShare(symbol, instrumentInfo, options) {

    try {

      console.log(`从AKShare获取数据: ${symbol}, 类型: ${instrumentInfo.type}`);

      console.log(`请求参数:`, options);

      

      // 转换为AKShare格式 (移除sh/sz前缀和.SS/.SZ后缀)

      const akshareSymbol = this.convertToAKShareFormat(symbol, instrumentInfo);

      console.log(`AKShare符号: ${akshareSymbol}`);

      

      // 🔥 使用传入的日期范围，如果没有传入则使用默认值

      let startDate, endDate;

      

      if (options.startDate) {

        // 使用传入的开始日期（格式：YYYY-MM-DD）

        startDate = options.startDate.replace(/-/g, '');

        console.log(`使用传入的开始日期: ${options.startDate} -> ${startDate}`);

      } else {

        // 🔥 指数默认从上市日期开始，股票默认获取最近1年

        if (instrumentInfo.type === 'index') {

          startDate = '20050101';  // 指数从2005年开始（沪深300上市日期）

        } else {

          // 股票默认获取最近1年的数据

          const oneYearAgo = new Date();

          oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

          startDate = oneYearAgo.toISOString().split('T')[0].replace(/-/g, '');

        }

        console.log(`使用默认开始日期: ${startDate}`);

      }

      

      if (options.endDate) {

        // 使用传入的结束日期

        endDate = options.endDate.replace(/-/g, '');

        console.log(`使用传入的结束日期: ${options.endDate} -> ${endDate}`);

      } else {

        // 默认到今天

        endDate = new Date().toISOString().split('T')[0].replace(/-/g, '');

        console.log(`使用默认结束日期（今天）: ${endDate}`);

      }

      

      console.log(`📅 数据范围: ${startDate} 至 ${endDate}`);

      

      // 🔥 使用修复后的pythonDataSourceService调用akshareService.py

      // 这个服务已经修复为使用每日历史数据API

      const result = await pythonDataSourceService.getKlineFromAKShare(akshareSymbol, {

        period: options.period || 'daily',

        startDate: startDate,

        endDate: endDate,

        count: options.count || 10000,  // 增加count限制，支持完整历史数据

        instrumentType: instrumentInfo.type // 🔥 传入标的类型（index 或 stock）

      });

      

      // 🔥 检查返回数据结构

      if (!result) {

        throw new Error('AKShare返回null');

      }

      

      if (!result.success) {

        throw new Error(result.error || 'AKShare返回失败');

      }

      

      if (!result.kline || result.kline.length === 0) {

        throw new Error('AKShare返回空K线数据');

      }

      

      console.log(`✅ AKShare数据获取成功，K线数量: ${result.kline.length}`);

      

      // 从K线数据中提取最新价格信息

      const latestKline = result.kline[result.kline.length - 1];

      const prevKline = result.kline.length > 1 ? result.kline[result.kline.length - 2] : latestKline;

      

      // 计算涨跌

      const change = latestKline.close - prevKline.close;

      const changePercent = prevKline.close !== 0 ? (change / prevKline.close) * 100 : 0;

      

      return {

        symbol: symbol,

        name: result.name || akshareSymbol,

        currentPrice: latestKline.close,

        open: latestKline.open,

        high: latestKline.high,

        low: latestKline.low,

        volume: latestKline.volume || 0,

        amount: latestKline.amount || 0,

        change: change,

        changePercent: changePercent,

        kline: result.kline,

        source: 'AKShare每日数据',

        sourceInfo: this.dataSources.akshare,

        dataQuality: 'high',

        coverage: 'complete',

        isPredefined: false  // 🔥 明确标记为真实数据

      };

    } catch (error) {

      console.error(`AKShare数据获取失败: ${error.message}`);

      throw new Error(`AKShare数据获取失败: ${error.message}`);

    }

  }



  /**

   * 转换为AKShare格式

   * 注意：指数需要保留sh/sz前缀，股票需要移除

   */

  convertToAKShareFormat(symbol, instrumentInfo) {

    // 移除.SS和.SZ后缀

    let akshareSymbol = symbol.replace('.SS', '').replace('.SZ', '');

    

    // 🔥 对于指数，保留sh/sz前缀；对于股票，移除前缀

    if (instrumentInfo.type === 'index') {

      // 指数保留前缀

      console.log(`符号转换(指数): ${symbol} -> ${akshareSymbol} (保留前缀)`);

    } else {

      // 股票移除前缀

      akshareSymbol = akshareSymbol.replace(/^sh/i, '').replace(/^sz/i, '');

      console.log(`符号转换(股票): ${symbol} -> ${akshareSymbol} (移除前缀)`);

    }

    

    return akshareSymbol;

  }



  /**

   * 获取期货数据 (暂未实现)

   */

  async fetchFuturesFromAKShare(symbol, options) {

    // TODO: 实现期货数据获取

    throw new Error('期货数据获取功能暂未实现');

  }



  /**

   * 从KHYShare智能爬虫获取数据

   */

  async fetchFromKHYShare(symbol, instrumentInfo, options) {

    try {

      console.log(`📊 从KHYShare获取数据: ${symbol}`);

      

      // KHYShare使用sh/sz前缀格式

      let khyshareSymbol = symbol;

      

      // 如果symbol包含.SS或.SZ后缀,转换为sh/sz前缀格式

      if (symbol.includes('.SS')) {

        khyshareSymbol = 'sh' + symbol.replace('.SS', '');

      } else if (symbol.includes('.SZ')) {

        khyshareSymbol = 'sz' + symbol.replace('.SZ', '');

      } else if (!symbol.match(/^(sh|sz)/i)) {

        // 如果没有前缀,根据代码判断

        const code = symbol.replace(/[^\d]/g, '');

        if (code.startsWith('6')) {

          khyshareSymbol = 'sh' + code;

        } else if (code.startsWith('0') || code.startsWith('3')) {

          khyshareSymbol = 'sz' + code;

        }

      }

      

      console.log(`   转换标的代码: ${symbol} -> ${khyshareSymbol}`);

      

      // 🔥 判断是否需要历史数据

      const needHistory = options.startDate || options.endDate || options.period !== 'realtime';

      

      // 调用Python服务获取数据

      const result = await pythonDataSourceService.getKlineFromKHYShare(khyshareSymbol, {

        period: options.period || 'daily',

        startDate: options.startDate,

        endDate: options.endDate,

        useHistory: needHistory

      });

      

      if (!result || !result.kline || result.kline.length === 0) {

        throw new Error('KHYShare返回空数据');

      }

      

      console.log(`✅ KHYShare数据获取成功，K线数量: ${result.kline.length}`);

      

      return {

        ...result,

        source: 'KHYShare',

        sourceInfo: this.dataSources.khyshare,

        dataQuality: 'high',

        coverage: needHistory ? 'complete' : 'realtime'

      };

    } catch (error) {

      console.error(`❌ KHYShare数据获取失败: ${error.message}`);

      throw new Error(`KHYShare数据获取失败: ${error.message}`);

    }

  }



  /**

   * 从东方财富获取数据

   */

  async fetchFromEastMoney(symbol, instrumentInfo, options) {

    try {

      // 东方财富API实现

      const emSymbol = this.convertToEastMoneyFormat(symbol, instrumentInfo);

      

      // 这里需要实现东方财富的具体API调用

      // 暂时返回模拟数据结构

      const data = await this.generateMockDataForSource(symbol, instrumentInfo, options, 'eastmoney');

      

      return {

        ...data,

        source: '东方财富',

        sourceInfo: this.dataSources.eastmoney,

        dataQuality: 'high',

        coverage: 'complete'

      };

    } catch (error) {

      throw new Error(`东方财富数据获取失败: ${error.message}`);

    }

  }



  /**

   * 生成综合模拟数据 - 使用完整的智能混合策略（增强版）

   * 优先级：实时API数据 > 数据库历史数据 > 模拟补充数据

   */

  async generateComprehensiveMockData(symbol, instrumentInfo, options) {

    const { startDate, endDate, period = 'daily' } = options;

    

    console.log(`🎯 生成增强模拟数据（完整智能混合策略）: ${symbol}, 周期: ${period}`);

    console.log(`   策略: 实时API数据 > 数据库历史数据 > 模拟补充数据`);

    

    try {

      let allRealData = [];

      let dataComposition = {

        api: 0,

        database: 0,

        simulated: 0,

        total: 0

      };

      

      // 🔥 步骤1: 尝试从真实数据源API获取数据

      console.log(`\n📡 步骤1: 尝试从真实数据源API获取数据...`);

      let apiData = null;

      

      // 尝试所有启用的真实数据源

      const enabledSources = Object.entries(this.dataSources)

        .filter(([key, source]) => source.enabled && key !== 'mock')

        .sort((a, b) => a[1].priority - b[1].priority);

      

      for (const [sourceKey, sourceConfig] of enabledSources) {

        try {

          console.log(`   尝试 ${sourceConfig.name} API...`);

          const data = await this.fetchDataFromSource(

            sourceKey,

            symbol,

            instrumentInfo,

            { startDate, endDate, period }

          );

          

          if (data && data.kline && data.kline.length > 0) {

            apiData = data.kline;

            console.log(`   ✅ ${sourceConfig.name} API成功: ${apiData.length}条数据`);

            console.log(`      日期范围: ${apiData[0].time} 到 ${apiData[apiData.length - 1].time}`);

            break;

          }

        } catch (error) {

          console.log(`   ❌ ${sourceConfig.name} API失败: ${error.message}`);

        }

      }

      

      // 🔥 步骤2: 从数据库获取历史真实数据

      console.log(`\n📊 步骤2: 从数据库获取历史真实数据...`);

      const dbData = await this.getHistoricalKlineFromDB(symbol, period, startDate, endDate);

      

      if (dbData && dbData.length > 0) {

        console.log(`   ✅ 数据库历史数据: ${dbData.length}条`);

        console.log(`      日期范围: ${dbData[0].time} 到 ${dbData[dbData.length - 1].time}`);

      } else {

        console.log(`   ⚠️  数据库中没有历史数据`);

      }

      

      // 🔥 步骤3: 智能合并API数据和数据库数据

      console.log(`\n🔄 步骤3: 智能合并真实数据...`);

      

      if (apiData && apiData.length > 0 && dbData && dbData.length > 0) {

        // 场景1: 两者都有数据，需要智能合并

        console.log(`   场景: API数据 + 数据库数据 智能合并`);

        

        const apiStartDate = new Date(apiData[0].time);

        const dbEndDate = new Date(dbData[dbData.length - 1].time);

        

        // 如果数据库数据比API数据更早，用数据库数据补充前面的部分

        if (dbEndDate < apiStartDate) {

          console.log(`   数据库数据更早，用于补充历史数据`);

          allRealData = [...dbData, ...apiData];

          dataComposition.database = dbData.length;

          dataComposition.api = apiData.length;

        } else {

          // 数据有重叠，去重后合并

          console.log(`   数据有重叠，去重后合并`);

          const apiDateSet = new Set(apiData.map(d => d.time));

          const uniqueDbData = dbData.filter(d => !apiDateSet.has(d.time));

          allRealData = [...uniqueDbData, ...apiData].sort((a, b) => 

            new Date(a.time) - new Date(b.time)

          );

          dataComposition.database = uniqueDbData.length;

          dataComposition.api = apiData.length;

        }

        

        console.log(`   ✅ 合并完成: ${dataComposition.database}条数据库 + ${dataComposition.api}条API`);

        

      } else if (apiData && apiData.length > 0) {

        // 场景2: 只有API数据

        console.log(`   场景: 仅API数据`);

        allRealData = apiData;

        dataComposition.api = apiData.length;

        

      } else if (dbData && dbData.length > 0) {

        // 场景3: 只有数据库数据

        console.log(`   场景: 仅数据库数据`);

        allRealData = dbData;

        dataComposition.database = dbData.length;

        

      } else {

        // 场景4: 没有任何真实数据

        console.log(`   场景: 无真实数据，使用纯模拟数据`);

      }

      

      // 🔥 步骤4: 检查是否需要模拟数据补充

      console.log(`\n🎲 步骤4: 检查是否需要模拟数据补充...`);

      

      let finalKlineData = [...allRealData];

      

      if (allRealData.length > 0) {

        // 有真实数据，检查是否需要补充

        const latestRealDate = new Date(allRealData[allRealData.length - 1].time);

        const targetEndDate = endDate ? new Date(endDate) : new Date();

        const daysGap = Math.floor((targetEndDate - latestRealDate) / (1000 * 60 * 60 * 24));

        

        console.log(`   最新真实数据日期: ${latestRealDate.toISOString().split('T')[0]}`);

        console.log(`   目标结束日期: ${targetEndDate.toISOString().split('T')[0]}`);

        console.log(`   数据缺口: ${daysGap}天`);

        

        if (daysGap > 1) {

          console.log(`   🔄 使用模拟数据补充最近${daysGap}天...`);

          

          const simulatedData = this.generateSimulatedKlineData(

            symbol,

            latestRealDate,

            targetEndDate,

            allRealData[allRealData.length - 1].close,

            period

          );

          

          if (simulatedData && simulatedData.length > 0) {

            console.log(`   ✅ 生成 ${simulatedData.length} 条模拟数据用于补充`);

            finalKlineData = [...allRealData, ...simulatedData];

            dataComposition.simulated = simulatedData.length;

          }

        } else {

          console.log(`   ✅ 真实数据已是最新，无需补充`);

        }

        

        dataComposition.total = finalKlineData.length;

        

        // 🔥 步骤5: 返回完整的混合数据

        console.log(`\n✅ 完整智能混合策略成功:`);

        console.log(`   API数据: ${dataComposition.api}条`);

        console.log(`   数据库数据: ${dataComposition.database}条`);

        console.log(`   模拟数据: ${dataComposition.simulated}条`);

        console.log(`   总计: ${dataComposition.total}条`);

        

        return {

          symbol,

          name: instrumentInfo.name || symbol,

          kline: finalKlineData,

          currentPrice: finalKlineData[finalKlineData.length - 1]?.close || 0,

          volume: finalKlineData[finalKlineData.length - 1]?.volume || 0,

          source: '增强模拟数据（完整智能混合）',

          sourceInfo: {

            name: '增强模拟数据生成器',

            description: `${dataComposition.api}条API + ${dataComposition.database}条数据库 + ${dataComposition.simulated}条模拟`,

            coverage: '完整历史数据',

            dataQuality: 'enhanced_hybrid_complete'

          },

          dataQuality: 'enhanced_hybrid_complete',

          coverage: 'complete',

          isHybrid: true,

          dataComposition: dataComposition,

          realDataRange: allRealData.length > 0 ? {

            start: allRealData[0].time,

            end: allRealData[allRealData.length - 1].time

          } : null,

          instrumentInfo,

          generationInfo: {

            strategy: 'api + database + simulation',

            apiDataCount: dataComposition.api,

            databaseDataCount: dataComposition.database,

            simulatedDataCount: dataComposition.simulated,

            totalDataPoints: dataComposition.total,

            algorithm: 'intelligent_hybrid_complete'

          }

        };

        

      } else {

        // 🔥 步骤6: 没有任何真实数据，使用enhancedMockDataService

        console.log(`\n⚠️  没有任何真实数据，使用增强模拟数据生成器`);



        const enhancedMockDataService = require('./enhancedMockDataService');

        const kline = enhancedMockDataService.generateEnhancedKLineData({

          symbol,

          period: period || 'daily',

          startDate: startDate || null,

          endDate: endDate || null,

          limit: 1000

        });



        console.log(`Enhanced mock data generated: ${kline.length} K-line entries`);



        return {

          symbol,

          name: instrumentInfo.name || symbol,

          kline,

          currentPrice: kline.length > 0 ? kline[kline.length - 1].close : 0,

          volume: kline.length > 0 ? kline[kline.length - 1].volume : 0,

          source: '增强模拟数据',

          dataQuality: 'enhanced_simulation',

          instrumentInfo,

          sourceInfo: {

            name: '增强模拟数据生成器',

            description: 'Enhanced mock data with realistic per-symbol prices',

            coverage: 'complete',

            dataQuality: 'enhanced_simulation'

          }

        };

      }

      

    } catch (error) {

      console.warn(`⚠️ 增强模拟数据生成失败，使用基础模拟数据: ${error.message}`);

      

      // 如果增强模拟数据失败，回退到基础模拟数据

      return this.generateBasicMockData(symbol, instrumentInfo, options);

    }

  }



  /**

   * 生成基础模拟数据（作为兜底方案）

   */

  async generateBasicMockData(symbol, instrumentInfo, options) {

    const { startDate, endDate, period = 'daily' } = options;

    

    // 确定数据范围

    const establishedDate = instrumentInfo.established !== '未知' ? 

      new Date(instrumentInfo.established) : new Date('1990-01-01');

    const actualStartDate = startDate ? new Date(startDate) : establishedDate;

    const actualEndDate = endDate ? new Date(endDate) : new Date();

    

    // 生成基础价格

    const basePrice = this.getBasePriceForInstrument(instrumentInfo);

    

    // 生成K线数据

    const kline = this.generateHistoricalKLineData(

      actualStartDate,

      actualEndDate,

      basePrice,

      instrumentInfo,

      period

    );



    return {

      symbol,

      name: instrumentInfo.name || symbol,

      kline,

      currentPrice: kline[kline.length - 1]?.close || basePrice,

      volume: kline[kline.length - 1]?.volume || 1000000,

      source: '基础模拟数据',

      sourceInfo: {

        name: '基础模拟数据生成器',

        description: '简单的市场模拟数据',

        coverage: '完整历史数据',

        dataQuality: 'basic_simulation'

      },

      dataQuality: 'basic_simulation',

      coverage: 'complete',

      generationInfo: {

        basePrice,

        dataPoints: kline.length,

        startDate: actualStartDate.toISOString().split('T')[0],

        endDate: actualEndDate.toISOString().split('T')[0],

        algorithm: 'basic_market_simulation'

      }

    };

  }



  /**

   * 生成历史K线数据 - 使用v5.0简单高效算法

   */

  generateHistoricalKLineData(startDate, endDate, basePrice, instrumentInfo, period) {

    const kline = [];

    const currentDate = new Date(startDate);

    const endDateTime = endDate.getTime();



    let currentPrice = basePrice;

    const volatility = this.getVolatilityForInstrument(instrumentInfo);

    const trend = this.getTrendForInstrument(instrumentInfo);



    while (currentDate.getTime() <= endDateTime) {

      // 跳过周末（股票和指数）

      if ((instrumentInfo.type === 'stock' || instrumentInfo.type === 'index') &&

          (currentDate.getDay() === 0 || currentDate.getDay() === 6)) {

        currentDate.setDate(currentDate.getDate() + 1);

        continue;

      }



      // 生成当日数据

      const dayData = this.generateDayData(currentPrice, volatility, trend, instrumentInfo);



      kline.push({

        time: currentDate.toISOString().split('T')[0],

        open: dayData.open,

        high: dayData.high,

        low: dayData.low,

        close: dayData.close,

        volume: dayData.volume

      });



      currentPrice = dayData.close;



      // 移动到下一个交易日

      if (period === 'daily' || !period) {

        currentDate.setDate(currentDate.getDate() + 1);

      } else if (period === 'weekly') {

        currentDate.setDate(currentDate.getDate() + 7);

      } else if (period === 'monthly') {

        currentDate.setMonth(currentDate.getMonth() + 1);

      } else {

        currentDate.setDate(currentDate.getDate() + 1);

      }

    }



    return kline;

  }



  /**

   * 生成单日数据 - v5.0简单高效算法

   */

  generateDayData(basePrice, volatility, trend, instrumentInfo) {

    // 趋势影响

    const trendChange = (Math.random() - 0.5) * trend * basePrice * 0.001;



    // 随机波动

    const randomChange = (Math.random() - 0.5) * volatility * basePrice * 0.01;



    const open = basePrice;

    const close = Math.max(basePrice + trendChange + randomChange, basePrice * 0.5);



    // 生成高低价

    const range = Math.abs(close - open) + (Math.random() * volatility * basePrice * 0.005);

    const high = Math.max(open, close) + range * Math.random();

    const low = Math.min(open, close) - range * Math.random();



    // 生成成交量

    const baseVolume = this.getBaseVolumeForInstrument(instrumentInfo);

    const volumeVariation = 0.5 + Math.random();

    const volume = Math.floor(baseVolume * volumeVariation);



    return {

      open: parseFloat(open.toFixed(2)),

      high: parseFloat(high.toFixed(2)),

      low: parseFloat(low.toFixed(2)),

      close: parseFloat(close.toFixed(2)),

      volume

    };

  }



  /**

   * 计算技术指标

   */

  calculateTechnicalIndicators(kline) {

    // Use fast indicator engine (20-28x speedup over legacy inline methods).
    // Toggle via env INDICATOR_ENGINE=fast|legacy (default: fast).
    const engine = require('./indicators');

    return {

      ma5: engine.calculateMA(kline, 5),

      ma10: engine.calculateMA(kline, 10),

      ma20: engine.calculateMA(kline, 20),

      ma60: engine.calculateMA(kline, 60),

      ema12: engine.calculateEMA(kline, 12),

      ema26: engine.calculateEMA(kline, 26),

      macd: engine.calculateMACD(kline),

      rsi: engine.calculateRSI(kline, 14),

      bollinger: engine.calculateBollingerBands(kline, 20, 2)

    };

  }



  /**

   * 计算移动平均线

   */

  calculateMA(data, period) {

    const ma = [];

    for (let i = 0; i < data.length; i++) {

      if (i < period - 1) {

        ma.push(null);

      } else {

        let sum = 0;

        for (let j = 0; j < period; j++) {

          sum += data[i - j].close;

        }

        ma.push(parseFloat((sum / period).toFixed(2)));

      }

    }

    return ma;

  }



  /**

   * 计算指数移动平均线

   */

  calculateEMA(data, period) {

    const ema = [];

    const multiplier = 2 / (period + 1);

    

    // 第一个EMA值使用SMA

    let sum = 0;

    for (let i = 0; i < period && i < data.length; i++) {

      sum += data[i].close;

      if (i < period - 1) {

        ema.push(null);

      } else {

        ema.push(sum / period);

      }

    }

    

    // 后续EMA值

    for (let i = period; i < data.length; i++) {

      const currentEMA = (data[i].close * multiplier) + (ema[i - 1] * (1 - multiplier));

      ema.push(parseFloat(currentEMA.toFixed(2)));

    }

    

    return ema;

  }



  /**

   * 计算MACD

   */

  calculateMACD(data) {

    const ema12 = this.calculateEMA(data, 12);

    const ema26 = this.calculateEMA(data, 26);

    

    const dif = [];

    const dea = [];

    const macd = [];

    

    // 计算DIF

    for (let i = 0; i < data.length; i++) {

      if (ema12[i] !== null && ema26[i] !== null) {

        dif.push(ema12[i] - ema26[i]);

      } else {

        dif.push(null);

      }

    }

    

    // 计算DEA (DIF的9日EMA)

    const difData = dif.map((value, index) => ({ close: value || 0 }));

    const deaValues = this.calculateEMA(difData, 9);

    

    // 计算MACD

    for (let i = 0; i < data.length; i++) {

      if (dif[i] !== null && deaValues[i] !== null) {

        dea.push(deaValues[i]);

        macd.push((dif[i] - deaValues[i]) * 2);

      } else {

        dea.push(null);

        macd.push(null);

      }

    }

    

    // 返回数组格式，而不是对象

    return macd; // 只返回MACD柱状图数据，这是最常用的

  }



  /**

   * 计算RSI

   */

  calculateRSI(data, period) {

    const rsi = [];

    

    if (data.length < period + 1) {

      return new Array(data.length).fill(null);

    }

    

    // 计算价格变化

    const changes = [];

    for (let i = 1; i < data.length; i++) {

      changes.push(data[i].close - data[i - 1].close);

    }

    

    // 前面的值设为null

    for (let i = 0; i < period; i++) {

      rsi.push(null);

    }

    

    // 计算第一个RSI值

    let avgGain = 0;

    let avgLoss = 0;

    

    for (let i = 0; i < period; i++) {

      if (changes[i] > 0) {

        avgGain += changes[i];

      } else {

        avgLoss += Math.abs(changes[i]);

      }

    }

    

    avgGain /= period;

    avgLoss /= period;

    

    if (avgLoss === 0) {

      rsi.push(100);

    } else {

      const rs = avgGain / avgLoss;

      rsi.push(parseFloat((100 - (100 / (1 + rs))).toFixed(2)));

    }

    

    // 计算后续RSI值

    for (let i = period; i < changes.length; i++) {

      const change = changes[i];

      const gain = change > 0 ? change : 0;

      const loss = change < 0 ? Math.abs(change) : 0;

      

      // 使用指数移动平均

      avgGain = ((avgGain * (period - 1)) + gain) / period;

      avgLoss = ((avgLoss * (period - 1)) + loss) / period;

      

      if (avgLoss === 0) {

        rsi.push(100);

      } else {

        const rs = avgGain / avgLoss;

        rsi.push(parseFloat((100 - (100 / (1 + rs))).toFixed(2)));

      }

    }

    

    return rsi;

  }



  /**

   * 计算布林带

   */

  calculateBollingerBands(data, period, stdDev) {

    const ma = this.calculateMA(data, period);

    const upper = [];

    const lower = [];

    

    for (let i = 0; i < data.length; i++) {

      if (i < period - 1) {

        upper.push(null);

        lower.push(null);

      } else {

        // 计算标准差

        let sum = 0;

        for (let j = 0; j < period; j++) {

          sum += Math.pow(data[i - j].close - ma[i], 2);

        }

        const std = Math.sqrt(sum / period);

        

        upper.push(parseFloat((ma[i] + stdDev * std).toFixed(2)));

        lower.push(parseFloat((ma[i] - stdDev * std).toFixed(2)));

      }

    }

    

    return { upper, middle: ma, lower };

  }



  // 辅助方法

  getCategoryName(type) {

    const categoryMap = {

      'stock': '股票',

      'index': '指数',

      'futures': '期货',

      'fund': '基金',

      'bond': '债券'

    };

    return categoryMap[type] || '未知';

  }



  getBasePriceForInstrument(instrumentInfo) {

    // 🔥 更新为2026年2月接近真实的市场价格

    const priceMap = {

      'index': {

        // 中国主要指数（2026年2月参考价格）

        '000001.SS': 3350,    // 上证指数

        '000001.SH': 3350,    // 上证指数（别名）

        '399001.SZ': 10800,   // 深证成指

        '399006.SZ': 2100,    // 创业板指

        '000300.SS': 4660,    // 沪深300

        '000300.SH': 4660,    // 沪深300（别名）

        'sh000300': 4660,     // 沪深300（简写）

        '000016.SH': 2750,    // 上证50

        '000905.SH': 5100,    // 中证500

        '000852.SH': 6200,    // 中证1000

        

        // 美国指数

        '^GSPC': 5800,        // 标普500

        '^DJI': 38500,        // 道琼斯

        '^IXIC': 18200,       // 纳斯达克

        

        // 其他亚洲指数

        '^HSI': 17500,        // 恒生指数

        '^N225': 38000,       // 日经225

        '^KS11': 2600         // 韩国综合

      },

      'stock': {

        // 中国A股（2026年2月参考价格）

        '600519.SS': 1680,    // 贵州茅台

        '600519.SH': 1680,    // 贵州茅台（别名）

        '000858.SZ': 148,     // 五粮液

        '600036.SS': 38,      // 招商银行

        '600036.SH': 38,      // 招商银行（别名）

        '000001.SZ': 11,      // 平安银行

        '000002.SZ': 8.5,     // 万科A

        '600000.SH': 7.8,     // 浦发银行

        '601318.SH': 52,      // 中国平安

        '601398.SH': 5.8,     // 工商银行

        '600030.SH': 28,      // 中信证券

        '000333.SZ': 52,      // 美的集团

        '002594.SZ': 280,     // 比亚迪

        

        // 美股

        'AAPL': 185,          // 苹果

        'MSFT': 420,          // 微软

        'GOOGL': 145,         // 谷歌

        'AMZN': 175,          // 亚马逊

        'TSLA': 195,          // 特斯拉

        'NVDA': 880,          // 英伟达

        'META': 485           // Meta

      },

      'futures': {

        // 中国期货

        'CU2403.SHFE': 68500,  // 沪铜

        'AU2406.SHFE': 485,    // 沪金

        'RB2405.SHFE': 3650,   // 螺纹钢

        'AL2403.SHFE': 19200,  // 沪铝

        'ZN2403.SHFE': 22800,  // 沪锌

        'AG2406.SHFE': 5850,   // 沪银

        

        // 国际期货

        'GC=F': 2050,          // 黄金

        'SI=F': 23.5,          // 白银

        'CL=F': 78,            // 原油WTI

        'NG=F': 2.2            // 天然气

      },

      'fund': {

        // ETF基金

        '510300.SH': 4.2,      // 沪深300ETF

        '510500.SH': 6.8,      // 中证500ETF

        '159915.SZ': 1.05,     // 创业板ETF

        '512880.SH': 1.85,     // 证券ETF

        '515050.SH': 1.12      // 5GETF

      },

      'forex': {

        // 外汇

        'USDCNY': 7.2,         // 美元/人民币

        'EURUSD': 1.08,        // 欧元/美元

        'GBPUSD': 1.27,        // 英镑/美元

        'USDJPY': 148          // 美元/日元

      },

      'cryptocurrency': {

        // 加密货币

        'BTC-USD': 52000,      // 比特币

        'ETH-USD': 2850,       // 以太坊

        'BNB-USD': 385         // 币安币

      }

    };

    

    // 尝试从映射表中获取价格

    const mappedPrice = priceMap[instrumentInfo.type]?.[instrumentInfo.symbol];

    if (mappedPrice) {

      return mappedPrice;

    }

    

    // 如果没有映射，根据类型返回合理的默认价格

    const defaultPrices = {

      'index': 3000,

      'stock': 15.0,

      'futures': 5000,

      'fund': 1.5,

      'forex': 7.0,

      'cryptocurrency': 50000,

      'bond': 100

    };

    

    return defaultPrices[instrumentInfo.type] || 15.0;

  }



  getVolatilityForInstrument(instrumentInfo) {

    const volatilityMap = {

      'index': 1.5,

      'stock': 2.0,

      'futures': 3.0,

      'fund': 1.0,

      'bond': 0.5

    };

    return volatilityMap[instrumentInfo.type] || 2.0;

  }



  getTrendForInstrument(instrumentInfo) {

    // 简单的趋势模拟，实际应用中可以更复杂

    return (Math.random() - 0.5) * 2; // -1 到 1 之间

  }



  getBaseVolumeForInstrument(instrumentInfo) {

    const volumeMap = {

      'index': 0, // 指数没有成交量

      'stock': 1000000,

      'futures': 50000,

      'fund': 500000,

      'bond': 100000

    };

    return volumeMap[instrumentInfo.type] || 1000000;

  }



  // 格式转换方法

  convertToAKShareFormat(symbol, instrumentInfo) {

    // 移除.SS和.SZ后缀

    let akshareSymbol = symbol.replace('.SS', '').replace('.SZ', '');

    

    // 🔥 对于指数，保留sh/sz前缀；对于股票，移除前缀

    if (instrumentInfo.type === 'index') {

      // 指数保留前缀

      console.log(`符号转换(指数): ${symbol} -> ${akshareSymbol} (保留前缀)`);

    } else {

      // 股票移除前缀

      akshareSymbol = akshareSymbol.replace(/^sh/i, '').replace(/^sz/i, '');

      console.log(`符号转换(股票): ${symbol} -> ${akshareSymbol} (移除前缀)`);

    }

    

    return akshareSymbol;

  }



  convertToEastMoneyFormat(symbol, instrumentInfo) {

    // 东方财富格式转换

    return symbol;

  }



  convertToSinaFormat(symbol, instrumentInfo) {

    const code = symbol.split('.')[0];

    const market = symbol.split('.')[1];

    

    if (market === 'SH') {

      return 'sh' + code;

    } else if (market === 'SZ') {

      return 'sz' + code;

    }

    

    return symbol;

  }



  convertToTencentFormat(symbol, instrumentInfo) {

    const code = symbol.split('.')[0];

    const market = symbol.split('.')[1];

    

    if (market === 'SH') {

      return 'sh' + code;

    } else if (market === 'SZ') {

      return 'sz' + code;

    }

    

    return symbol;

  }



  // 数据解析方法

  parseSinaData(data, symbol, instrumentInfo, options) {

    // 实现新浪数据解析

    // 这里需要根据实际API响应格式实现

    return this.generateMockDataForSource(symbol, instrumentInfo, options, 'sina');

  }



  parseTencentData(data, symbol, instrumentInfo, options) {

    // 实现腾讯数据解析

    // 这里需要根据实际API响应格式实现

    return this.generateMockDataForSource(symbol, instrumentInfo, options, 'tencent');

  }



  generateMockDataForSource(symbol, instrumentInfo, options, source) {

    // 为特定数据源生成模拟数据

    return this.generateComprehensiveMockData(symbol, instrumentInfo, options);

  }



  /**

   * 获取数据源状态

   */

  getDataSourceStatus() {

    return {

      sources: this.dataSources,

      markets: this.markets,

      supportedInstruments: {

        total: Object.values(this.importantInstruments).reduce((sum, arr) => sum + arr.length, 0),

        byCategory: {

          globalIndices: this.importantInstruments.globalIndices.length,

          globalStocks: this.importantInstruments.globalStocks.length,

          globalETFs: this.importantInstruments.globalETFs.length,

          globalCommodities: this.importantInstruments.globalCommodities.length,

          globalForex: this.importantInstruments.globalForex.length,

          globalCrypto: this.importantInstruments.globalCrypto.length

        }

      },

      capabilities: {

        historicalData: true,

        realtimeData: true,

        technicalIndicators: true,

        multipleDataSources: true,

        dataQualityTracking: true,

        globalMarkets: true,

        multiLanguageSupport: true

      }

    };

  }



  /**

   * 清理过期缓存

   */

  clearExpiredCache() {

    const now = Date.now();

    for (const [key, value] of this.cache.entries()) {

      if (now - value.timestamp > this.cacheTimeout) {

        this.cache.delete(key);

      }

    }

  }



  /**

   * 清除所有缓存

   */

  clearAllCache() {

    const size = this.cache.size;

    this.cache.clear();

    console.log(`✅ 已清除 ${size} 个缓存项`);

    return { success: true, cleared: size };

  }



  /**

   * 测试单个数据源

   */

  /**

     * 测试单个数据源

     * 🔥 修复: 直接测试指定数据源,而不是通过getComprehensiveData自动选择

     */

    async testSingleDataSource(sourceKey, symbol, options = {}) {

      const source = this.dataSources[sourceKey];



      if (!source) {

        throw new Error(`数据源 ${sourceKey} 不存在`);

      }



      const result = {

        sourceKey,

        sourceName: source.name,

        symbol,

        status: 'unknown',

        dataCount: 0,

        message: '',

        error: null,

        sampleData: null,

        instrumentInfo: null,

        isRealData: false,

        dataSource: null

      };



      try {

        console.log(`开始测试数据源: ${source.name} (${sourceKey})`);



        // 识别标的信息

        result.instrumentInfo = this.identifyInstrument(symbol);



        // 测试选项

        const testOptions = {

          ...options,

          startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],

          endDate: new Date().toISOString().split('T')[0]

        };



        // 🔥 关键修复: 直接调用fetchDataFromSource测试指定数据源

        let data = null;

        try {

          data = await this.fetchDataFromSource(

            sourceKey,

            symbol,

            result.instrumentInfo,

            testOptions

          );



          if (data) {

            result.dataSource = data.source || source.name;

            result.isRealData = data.source !== '模拟数据' && 

                               data.source !== '增强模拟数据' && 

                               data.source !== '基础模拟数据' &&

                               !data.isMockData;

          }

        } catch (error) {

          console.error(`测试数据源 ${source.name} 失败:`, error);

          throw error;

        }



        // 处理返回的数据

        if (data && data.kline && data.kline.length > 0) {

          result.status = result.isRealData ? 'success' : 'mock';

          result.dataCount = data.kline.length;

          result.message = result.isRealData 

            ? `✅ 成功获取真实数据 ${data.kline.length} 条` 

            : `✅ 模拟数据测试成功 ${data.kline.length} 条`;

          result.sampleData = data.kline.slice(0, 5);

          result.dataRange = {

            start: data.kline[0].time || data.kline[0].date,

            end: data.kline[data.kline.length - 1].time || data.kline[data.kline.length - 1].date

          };

        } else if (data && data.data && data.data.length > 0) {

          result.status = result.isRealData ? 'success' : 'mock';

          result.dataCount = data.data.length;

          result.message = result.isRealData 

            ? `✅ 成功获取真实数据 ${data.data.length} 条` 

            : `✅ 模拟数据测试成功 ${data.data.length} 条`;

          result.sampleData = data.data.slice(0, 5);

          result.dataRange = {

            start: data.data[0].date,

            end: data.data[data.data.length - 1].date

          };

        } else {

          result.status = 'empty';

          result.message = '❌ 数据源返回空数据';

          console.log('数据源返回的数据结构:', JSON.stringify(data).substring(0, 200));

        }



      } catch (error) {

        console.error(`测试数据源 ${source.name} 失败:`, error);

        result.status = 'error';

        result.error = error.message;

        result.message = `❌ 测试失败: ${error.message}`;

      }



      return result;

    }





  /**

   * 批量测试所有数据源

   */

  async testAllDataSources(symbol, options = {}) {

    const results = {

      symbol,

      testedAt: new Date().toISOString(),

      sources: {},

      summary: {

        total: 0,

        success: 0,

        failed: 0,

        empty: 0

      }

    };



    // 获取所有启用的数据源

    const enabledSources = Object.entries(this.dataSources)

      .filter(([key, source]) => source.enabled)

      .map(([key]) => key);



    results.summary.total = enabledSources.length;



    // 并发测试所有数据源

    const testPromises = enabledSources.map(async (sourceKey) => {

      try {

        const result = await this.testSingleDataSource(sourceKey, symbol, options);

        results.sources[sourceKey] = result;

        

        if (result.status === 'success') {

          results.summary.success++;

        } else if (result.status === 'empty') {

          results.summary.empty++;

        } else {

          results.summary.failed++;

        }

      } catch (error) {

        results.sources[sourceKey] = {

          sourceKey,

          sourceName: this.dataSources[sourceKey].name,

          status: 'error',

          error: error.message,

          message: `测试异常: ${error.message}`

        };

        results.summary.failed++;

      }

    });



    await Promise.all(testPromises);



    return results;

  }



  /**

   * 从数据库获取最近的历史真实数据（作为API失败时的兜底）

   * @param {string} symbol - 标的代码

   * @returns {Object|null} - 历史数据或null

   */

  async getHistoricalDataFromDB(symbol) {

    try {

      const KlineData = require('../models/KlineData');

      const { Op } = require('sequelize');

      

      console.log(`📊 尝试从数据库获取 ${symbol} 的历史数据...`);

      

      // 查询最近的日线数据（最多查询最近30天）

      const thirtyDaysAgo = new Date();

      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      

      const latestData = await KlineData.findOne({

        where: {

          symbol: symbol,

          period: 'daily',

          trade_date: {

            [Op.gte]: thirtyDaysAgo

          }

        },

        order: [['trade_date', 'DESC']],

        limit: 1

      });

      

      if (latestData) {

        const daysOld = Math.floor((new Date() - new Date(latestData.trade_date)) / (1000 * 60 * 60 * 24));

        console.log(`✅ 找到历史数据: ${latestData.name || symbol}, 日期=${latestData.trade_date}, ${daysOld}天前`);

        

        return {

          current: parseFloat(latestData.close_price),

          close: parseFloat(latestData.close_price),

          open: parseFloat(latestData.open_price),

          high: parseFloat(latestData.high_price),

          low: parseFloat(latestData.low_price),

          change_percent: parseFloat(latestData.change_percent || 0),

          volume: parseInt(latestData.volume || 0),

          name: latestData.name || symbol,

          isPredefined: false,  // 🔥 历史真实数据，不是预定义的

          dataSource: 'database',  // 🔥 标记为数据库来源

          isHistorical: true,  // 🔥 标记为历史数据

          historicalDate: latestData.trade_date,  // 🔥 历史数据的日期

          daysOld: daysOld,  // 🔥 数据的天数

          source: 'database'

        };

      }

      

      console.log(`⚠️  数据库中没有找到 ${symbol} 的历史数据`);

      return null;

      

    } catch (error) {

      console.error(`❌ 从数据库获取历史数据失败:`, error.message);

      return null;

    }

  }



  /**

   * 从数据库获取历史K线数据（用于混合数据策略）

   * @param {string} symbol - 标的代码

   * @param {string} period - 周期

   * @param {string} startDate - 开始日期

   * @param {string} endDate - 结束日期

   * @returns {Array} - K线数据数组

   */

  async getHistoricalKlineFromDB(symbol, period = 'daily', startDate = null, endDate = null) {

    try {

      const KlineData = require('../models/KlineData');

      const { Op } = require('sequelize');

      

      console.log(`📊 从数据库获取K线数据: ${symbol}, period=${period}`);

      

      const where = {

        symbol: symbol,

        period: period

      };

      

      // 如果没有指定日期范围，获取最近一年的数据

      if (!startDate) {

        const oneYearAgo = new Date();

        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        where.trade_date = { [Op.gte]: oneYearAgo };

      } else {

        where.trade_date = {};

        if (startDate) {

          where.trade_date[Op.gte] = new Date(startDate);

        }

        if (endDate) {

          where.trade_date[Op.lte] = new Date(endDate);

        }

      }

      

      const klineData = await KlineData.findAll({

        where,

        order: [['trade_date', 'ASC']],

        limit: 1000 // 限制最多返回1000条

      });

      

      if (klineData && klineData.length > 0) {

        console.log(`✅ 从数据库获取到 ${klineData.length} 条K线数据`);

        

        // 转换为标准K线格式

        return klineData.map(item => ({

          time: item.trade_date,

          open: parseFloat(item.open_price),

          high: parseFloat(item.high_price),

          low: parseFloat(item.low_price),

          close: parseFloat(item.close_price),

          volume: parseInt(item.volume || 0),

          isHistorical: true,  // 标记为历史真实数据

          dataSource: 'database'

        }));

      }

      

      console.log(`⚠️  数据库中没有找到 ${symbol} 的K线数据`);

      return [];

      

    } catch (error) {

      console.error(`❌ 从数据库获取K线数据失败:`, error.message);

      return [];

    }

  }



  /**

   * 生成模拟K线数据来补充缺失的部分

   * @param {string} symbol - 标的代码

   * @param {Date} startDate - 开始日期（从历史数据的最后一天开始）

   * @param {Date} endDate - 结束日期（通常是今天）

   * @param {number} lastPrice - 最后一个真实价格（用作起始价格）

   * @param {string} period - 周期

   * @returns {Array} - 模拟K线数据数组

   */

  generateSimulatedKlineData(symbol, startDate, endDate, lastPrice, period = 'daily') {

    try {

      console.log(`🎲 生成模拟K线数据: ${symbol}, 从 ${startDate.toISOString().split('T')[0]} 到 ${endDate.toISOString().split('T')[0]}`);

      

      const klineData = [];

      let currentDate = new Date(startDate);

      currentDate.setDate(currentDate.getDate() + 1); // 从下一天开始

      

      let currentPrice = lastPrice;

      

      while (currentDate <= endDate) {

        // 跳过周末（简化处理）

        const dayOfWeek = currentDate.getDay();

        if (dayOfWeek !== 0 && dayOfWeek !== 6) {

          // 生成随机波动（±2%）

          const changePercent = (Math.random() - 0.5) * 4; // -2% 到 +2%

          const change = currentPrice * (changePercent / 100);

          

          const open = currentPrice;

          const close = currentPrice + change;

          const high = Math.max(open, close) * (1 + Math.random() * 0.01); // 最高价

          const low = Math.min(open, close) * (1 - Math.random() * 0.01);  // 最低价

          const volume = Math.floor(Math.random() * 100000000) + 10000000; // 随机成交量

          

          klineData.push({

            time: currentDate.toISOString().split('T')[0],

            open: parseFloat(open.toFixed(2)),

            high: parseFloat(high.toFixed(2)),

            low: parseFloat(low.toFixed(2)),

            close: parseFloat(close.toFixed(2)),

            volume: volume,

            isSimulated: true,  // 🔥 标记为模拟数据

            dataSource: 'simulated'

          });

          

          currentPrice = close; // 更新当前价格

        }

        

        // 移动到下一天

        currentDate.setDate(currentDate.getDate() + 1);

      }

      

      console.log(`✅ 生成了 ${klineData.length} 条模拟K线数据`);

      return klineData;

      

    } catch (error) {

      console.error(`❌ 生成模拟K线数据失败:`, error.message);

      return [];

    }

  }



  /**

   * 从指定数据源获取数据

   */

  async getDataFromSource(sourceId, symbol) {

    try {

      console.log(`从数据源 ${sourceId} 获取 ${symbol} 的数据`);

      

      // 根据数据源ID调用相应的服务

      switch (sourceId) {

        case 'eastmoney': {

          // 东方财富数据源 — 模块尚未实现，回退到默认源

          throw new Error('东方财富独立数据源模块尚未实现，请使用 akshare 或 adata 数据源');

        }



        case 'sina': {

          // 新浪数据源 — 模块尚未实现，回退到默认源

          throw new Error('新浪财经独立数据源模块尚未实现，请使用 akshare 或 adata 数据源');

        }



        case 'tencent': {

          // 腾讯数据源 — 模块尚未实现，回退到默认源

          throw new Error('腾讯财经独立数据源模块尚未实现，请使用 akshare 或 adata 数据源');

        }

        

        case 'akshare': {

          // 使用AKShare数据源

          console.log(`AKShare: 获取行情数据...`);

          

          try {

            const { spawn } = require('child_process');

            const path = require('path');

            

            // 转换标的代码格式

            let cleanSymbol = symbol.replace(/^(sh|sz)/i, '');

            console.log(`AKShare: 原始标的=${symbol}, 清理后=${cleanSymbol}`);

            

            // 判断类型

            const isIndex = (

              cleanSymbol.startsWith('000') && cleanSymbol.length === 6 && parseInt(cleanSymbol) <= 999

            ) || cleanSymbol.startsWith('399');

            

            const instrumentType = isIndex ? 'index' : 'stock';

            console.log(`AKShare: 标的类型=${instrumentType}`);

            

            // 🔥 设置环境变量，禁用代理

            const env = { ...process.env };

            env.PYTHONIOENCODING = 'utf-8';

            env.HTTP_PROXY = '';

            env.HTTPS_PROXY = '';

            env.http_proxy = '';

            env.https_proxy = '';

            env.NO_PROXY = '*';

            env.no_proxy = '*';

            

            // 调用AKShare服务

            const scriptPath = path.join(__dirname, 'akshareService.py');

            const pythonCmd = require('../utils/pythonPath').findPython();

            let python;

            try {

              python = spawn(pythonCmd, [scriptPath, 'batch_quotes', cleanSymbol, instrumentType], { env });

            } catch (spawnError) {

              console.error(`❌ 无法启动Python进程: ${spawnError.message}`);

              throw new Error('Python不可用,无法获取AKShare数据');

            }

            

            let stdout = '';

            let stderr = '';

            let _idleTimer = null;
            const _resetIdle = () => {
              if (_idleTimer) clearTimeout(_idleTimer);
              _idleTimer = setTimeout(() => { try { require('../tools/platformUtils').safeKill(python); } catch {} }, 10000);
            };
            _resetIdle();

            python.on('error', (error) => {

              console.error(`❌ Python进程错误: ${error.message}`);

              stderr += `Python进程错误: ${error.message}`;

            });



            python.stdout.on('data', (data) => {

              stdout += data.toString();
              _resetIdle();

            });



            python.stderr.on('data', (data) => {

              stderr += data.toString();
              _resetIdle();

            });



            const result = await new Promise((resolve, reject) => {

              python.on('close', (code) => {

                if (_idleTimer) clearTimeout(_idleTimer);

                if (code === 0) {

                  try {

                    const data = JSON.parse(stdout);

                    resolve(data);

                  } catch (e) {

                    reject(new Error(`解析JSON失败: ${e.message}`));

                  }

                } else {

                  reject(new Error(`Python脚本执行失败: ${stderr}`));

                }

              });

            });

            

            if (result.success && result.data && result.data.length > 0) {

              const quote = result.data[0];

              console.log(`AKShare: 成功获取行情 - ${quote.name}: ¥${quote.price}, 预定义=${quote.isPredefined || false}`);

              

              return {

                current: quote.price,

                close: quote.price,

                open: quote.open,

                high: quote.high,

                low: quote.low,

                change_percent: quote.changePercent,

                volume: quote.volume,

                name: quote.name,

                isPredefined: quote.isPredefined || false,  // 🔥 传递预定义标识

                dataSource: quote.dataSource || 'akshare',  // 🔥 传递数据来源

                source: 'akshare'

              };

            }

            

            throw new Error('AKShare未返回有效数据');

            

          } catch (error) {

            console.error(`AKShare: API获取失败 - ${error.message}`);

            

            // 🔥 尝试从数据库获取历史真实数据

            const historicalData = await this.getHistoricalDataFromDB(symbol);

            if (historicalData) {

              console.log(`✅ AKShare: 使用数据库历史数据（${historicalData.daysOld}天前）`);

              return historicalData;

            }

            

            // 🔥 如果数据库也没有，才抛出错误

            throw new Error(`AKShare数据获取失败: ${error.message}`);

          }

        }

        

        case 'efinance': {

          // 使用EFinance数据源

          console.log(`EFinance: 获取行情数据...`);

          

          try {

            const { spawn } = require('child_process');

            const path = require('path');

            

            // 转换标的代码格式

            let cleanSymbol = symbol.replace(/^(sh|sz)/i, '');

            console.log(`EFinance: 原始标的=${symbol}, 清理后=${cleanSymbol}`);

            

            // 判断类型

            const isIndex = (

              cleanSymbol.startsWith('000') && cleanSymbol.length === 6 && parseInt(cleanSymbol) <= 999

            ) || cleanSymbol.startsWith('399');

            

            const instrumentType = isIndex ? 'index' : 'stock';

            console.log(`EFinance: 标的类型=${instrumentType}`);

            

            // 调用EFinance服务

            const scriptPath = path.join(__dirname, 'efinanceService.py');

            const pythonCmd = require('../utils/pythonPath').findPython();

            let python;

            try {

              python = spawn(pythonCmd, [scriptPath, 'batch_quotes', cleanSymbol, instrumentType]);

            } catch (spawnError) {

              console.error(`❌ 无法启动Python进程: ${spawnError.message}`);

              throw new Error('Python不可用,无法获取EFinance数据');

            }

            

            let stdout = '';

            let stderr = '';

            let _idleTimer = null;
            const _resetIdle = () => {
              if (_idleTimer) clearTimeout(_idleTimer);
              _idleTimer = setTimeout(() => { try { require('../tools/platformUtils').safeKill(python); } catch {} }, 10000);
            };
            _resetIdle();

            python.on('error', (error) => {

              console.error(`❌ Python进程错误: ${error.message}`);

              stderr += `Python进程错误: ${error.message}`;

            });



            python.stdout.on('data', (data) => {

              stdout += data.toString();
              _resetIdle();

            });



            python.stderr.on('data', (data) => {

              stderr += data.toString();
              _resetIdle();

            });



            const result = await new Promise((resolve, reject) => {

              python.on('close', (code) => {

                if (_idleTimer) clearTimeout(_idleTimer);

                if (code === 0) {

                  try {

                    const data = JSON.parse(stdout);

                    resolve(data);

                  } catch (e) {

                    reject(new Error(`解析JSON失败: ${e.message}`));

                  }

                } else {

                  reject(new Error(`Python脚本执行失败: ${stderr}`));

                }

              });

            });

            

            if (result.success && result.data && result.data.length > 0) {

              const quote = result.data[0];

              console.log(`EFinance: 成功获取行情 - ${quote.name}: ¥${quote.price}, 预定义=${quote.isPredefined || false}`);

              

              return {

                current: quote.price,

                close: quote.price,

                open: quote.open,

                high: quote.high,

                low: quote.low,

                change_percent: quote.changePercent,

                volume: quote.volume,

                name: quote.name,

                isPredefined: quote.isPredefined || false,  // 🔥 传递预定义标识

                dataSource: quote.dataSource || 'efinance',  // 🔥 传递数据来源

                source: 'efinance'

              };

            }

            

            throw new Error('EFinance未返回有效数据');

            

          } catch (error) {

            console.error(`EFinance: API获取失败 - ${error.message}`);

            

            // 🔥 尝试从数据库获取历史真实数据

            const historicalData = await this.getHistoricalDataFromDB(symbol);

            if (historicalData) {

              console.log(`✅ EFinance: 使用数据库历史数据（${historicalData.daysOld}天前）`);

              return historicalData;

            }

            

            // 🔥 如果数据库也没有，才抛出错误

            throw new Error(`EFinance数据获取失败: ${error.message}`);

          }

        }

        

        case 'adata': {

          // 使用AData数据源 - 批量获取行情

          console.log(`AData: 获取行情数据...`);

          

          try {

            const { spawn } = require('child_process');

            const path = require('path');

            

            // 转换标的代码格式 (sh000001 -> 000001)

            let cleanSymbol = symbol.replace(/^(sh|sz)/i, '');

            console.log(`AData: 原始标的=${symbol}, 清理后=${cleanSymbol}`);

            

            // 判断是指数还是股票

            const isIndex = (

              cleanSymbol.startsWith('000') && cleanSymbol.length === 6 && parseInt(cleanSymbol) <= 999

            ) || cleanSymbol.startsWith('399');

            

            const instrumentType = isIndex ? 'index' : 'stock';

            console.log(`AData: 标的类型=${instrumentType}`);

            

            // 调用新的市场数据服务

            const scriptPath = path.join(__dirname, 'adataMarketService.py');

            const pythonCmd = require('../utils/pythonPath').findPython();

            let python;

            try {

              python = spawn(pythonCmd, [scriptPath, 'batch_quotes', cleanSymbol, instrumentType]);

            } catch (spawnError) {

              console.error(`❌ 无法启动Python进程: ${spawnError.message}`);

              throw new Error('Python不可用,无法获取AData数据');

            }

            

            let stdout = '';

            let stderr = '';

            let _idleTimer = null;
            const _resetIdle = () => {
              if (_idleTimer) clearTimeout(_idleTimer);
              _idleTimer = setTimeout(() => { try { require('../tools/platformUtils').safeKill(python); } catch {} }, 10000);
            };
            _resetIdle();

            // 🔥 添加错误事件监听器,防止进程崩溃

            python.on('error', (error) => {

              console.error(`❌ Python进程错误: ${error.message}`);

              stderr += `Python进程错误: ${error.message}`;

            });



            python.stdout.on('data', (data) => {

              stdout += data.toString();
              _resetIdle();

            });



            python.stderr.on('data', (data) => {

              stderr += data.toString();
              _resetIdle();

            });



            const result = await new Promise((resolve, reject) => {

              python.on('close', (code) => {

                if (_idleTimer) clearTimeout(_idleTimer);

                if (code === 0) {

                  try {

                    const data = JSON.parse(stdout);

                    resolve(data);

                  } catch (e) {

                    reject(new Error(`解析JSON失败: ${e.message}`));

                  }

                } else {

                  reject(new Error(`Python脚本执行失败: ${stderr}`));

                }

              });

            });

            

            if (result.success && result.data && result.data.length > 0) {

              const quote = result.data[0];

              console.log(`AData: 成功获取行情 - ${quote.name}: ¥${quote.price}, 预定义=${quote.isPredefined || false}`);

              

              return {

                current: quote.price,

                close: quote.price,

                open: quote.open,

                high: quote.high,

                low: quote.low,

                change_percent: quote.changePercent,

                volume: quote.volume,

                name: quote.name,

                isPredefined: quote.isPredefined || false,  // 🔥 传递预定义标识

                dataSource: quote.dataSource || 'adata',    // 🔥 传递数据来源

                source: 'adata'

              };

            }

            

            throw new Error('AData未返回有效数据');

            

          } catch (error) {

            console.error(`AData: API获取失败 - ${error.message}`);

            

            // 🔥 尝试从数据库获取历史真实数据

            const historicalData = await this.getHistoricalDataFromDB(symbol);

            if (historicalData) {

              console.log(`✅ AData: 使用数据库历史数据（${historicalData.daysOld}天前）`);

              return historicalData;

            }

            

            // 🔥 如果数据库也没有，才抛出错误

            throw new Error(`AData数据获取失败: ${error.message}`);

          }

        }

        

        case 'ifind': {

          // 使用iFinD数据源

          console.log(`iFinD: 获取行情数据...`);

          

          try {

            const { spawn } = require('child_process');

            const path = require('path');

            

            // 转换标的代码格式

            let cleanSymbol = symbol.replace(/^(sh|sz)/i, '');

            console.log(`iFinD: 原始标的=${symbol}, 清理后=${cleanSymbol}`);

            

            // 判断类型

            const isIndex = (

              cleanSymbol.startsWith('000') && cleanSymbol.length === 6 && parseInt(cleanSymbol) <= 999

            ) || cleanSymbol.startsWith('399');

            

            const instrumentType = isIndex ? 'index' : 'stock';

            console.log(`iFinD: 标的类型=${instrumentType}`);

            

            // 调用iFinD服务

            const scriptPath = path.join(__dirname, 'ifindService.py');

            const pythonCmd = require('../utils/pythonPath').findPython();

            let python;

            try {

              python = spawn(pythonCmd, [scriptPath, 'batch_quotes', cleanSymbol, instrumentType]);

            } catch (spawnError) {

              console.error(`❌ 无法启动Python进程: ${spawnError.message}`);

              throw new Error('Python不可用,无法获取iFinD数据');

            }

            

            let stdout = '';

            let stderr = '';

            let _idleTimer = null;
            const _resetIdle = () => {
              if (_idleTimer) clearTimeout(_idleTimer);
              _idleTimer = setTimeout(() => { try { require('../tools/platformUtils').safeKill(python); } catch {} }, 10000);
            };
            _resetIdle();

            python.on('error', (error) => {

              console.error(`❌ Python进程错误: ${error.message}`);

              stderr += `Python进程错误: ${error.message}`;

            });



            python.stdout.on('data', (data) => {

              stdout += data.toString();
              _resetIdle();

            });



            python.stderr.on('data', (data) => {

              stderr += data.toString();
              _resetIdle();

            });



            const result = await new Promise((resolve, reject) => {

              python.on('close', (code) => {

                if (_idleTimer) clearTimeout(_idleTimer);

                if (code === 0) {

                  try {

                    const data = JSON.parse(stdout);

                    resolve(data);

                  } catch (e) {

                    reject(new Error(`解析JSON失败: ${e.message}`));

                  }

                } else {

                  reject(new Error(`Python脚本执行失败: ${stderr}`));

                }

              });

            });

            

            if (result.success && result.data && result.data.length > 0) {

              const quote = result.data[0];

              console.log(`iFinD: 成功获取行情 - ${quote.name}: ¥${quote.price}, 预定义=${quote.isPredefined || false}`);

              

              return {

                current: quote.price,

                close: quote.price,

                open: quote.open,

                high: quote.high,

                low: quote.low,

                change_percent: quote.changePercent,

                volume: quote.volume,

                name: quote.name,

                isPredefined: quote.isPredefined || false,  // 🔥 传递预定义标识

                dataSource: quote.dataSource || 'ifind',    // 🔥 传递数据来源

                source: 'ifind'

              };

            }

            

            throw new Error('iFinD未返回有效数据');

            

          } catch (error) {

            console.error(`iFinD: API获取失败 - ${error.message}`);

            

            // 🔥 尝试从数据库获取历史真实数据

            const historicalData = await this.getHistoricalDataFromDB(symbol);

            if (historicalData) {

              console.log(`✅ iFinD: 使用数据库历史数据（${historicalData.daysOld}天前）`);

              return historicalData;

            }

            

            // 🔥 如果数据库也没有，才抛出错误

            throw new Error(`iFinD数据获取失败: ${error.message}`);

          }

        }

        

        case 'khyshare': {

          // 使用KHYShare智能爬虫数据源

          console.log(`KHYShare: 获取行情数据...`);

          

          try {

            const { spawn } = require('child_process');

            const path = require('path');

            

            // KHYShare使用sh/sz前缀格式

            let khyshareSymbol = symbol;

            if (!symbol.match(/^(sh|sz)/i)) {

              const cleanSymbol = symbol.replace(/[^\d]/g, '');

              if (cleanSymbol.startsWith('6')) {

                khyshareSymbol = 'sh' + cleanSymbol;

              } else if (cleanSymbol.startsWith('0') || cleanSymbol.startsWith('3')) {

                khyshareSymbol = 'sz' + cleanSymbol;

              }

            }

            

            console.log(`KHYShare: 原始标的=${symbol}, 转换后=${khyshareSymbol}`);

            

            // 🔥 设置环境变量，禁用代理

            const env = { ...process.env };

            env.PYTHONIOENCODING = 'utf-8';

            env.HTTP_PROXY = '';

            env.HTTPS_PROXY = '';

            env.http_proxy = '';

            env.https_proxy = '';

            env.NO_PROXY = '*';

            env.no_proxy = '*';

            

            // 调用KHYShare服务

            const scriptPath = path.join(__dirname, 'khyshareService.py');

            const pythonCmd = require('../utils/pythonPath').findPython();

            let python;

            try {

              python = spawn(pythonCmd, [scriptPath, 'realtime', khyshareSymbol], { env });

            } catch (spawnError) {

              console.error(`❌ 无法启动Python进程: ${spawnError.message}`);

              throw new Error('Python不可用,无法获取KHYShare数据');

            }

            

            let stdout = '';

            let stderr = '';

            let _idleTimer = null;
            const _resetIdle = () => {
              if (_idleTimer) clearTimeout(_idleTimer);
              _idleTimer = setTimeout(() => { try { require('../tools/platformUtils').safeKill(python); } catch {} }, 10000);
            };
            _resetIdle();

            python.on('error', (error) => {

              console.error(`❌ Python进程错误: ${error.message}`);

              stderr += `Python进程错误: ${error.message}`;

            });



            python.stdout.on('data', (data) => {

              stdout += data.toString();
              _resetIdle();

            });



            python.stderr.on('data', (data) => {

              stderr += data.toString();
              _resetIdle();

            });



            const result = await new Promise((resolve, reject) => {

              python.on('close', (code) => {

                if (_idleTimer) clearTimeout(_idleTimer);

                if (code === 0) {

                  try {

                    const data = JSON.parse(stdout);

                    resolve(data);

                  } catch (e) {

                    reject(new Error(`解析JSON失败: ${e.message}`));

                  }

                } else {

                  reject(new Error(`Python脚本执行失败: ${stderr}`));

                }

              });

            });

            

            if (result.success) {

              console.log(`KHYShare: 成功获取行情 - ${result.name}: ¥${result.price}, 来源=${result.source}`);

              

              return {

                current: result.price,

                close: result.price,

                open: result.open || result.price,

                high: result.high || result.price,

                low: result.low || result.price,

                change_percent: result.changePercent || 0,

                volume: result.volume || 0,

                name: result.name,

                isPredefined: false,  // KHYShare是真实数据

                dataSource: result.source,  // 实际数据来源(eastmoney/sina/tencent/163)

                source: 'khyshare'

              };

            }

            

            throw new Error('KHYShare未返回有效数据');

            

          } catch (error) {

            console.error(`KHYShare: API获取失败 - ${error.message}`);

            throw new Error(`KHYShare数据获取失败: ${error.message}`);

          }

        }

        

        case 'mock': {

          // 使用模拟数据源

          console.log(`Mock: 生成模拟数据...`);

          

          try {

            // 生成模拟行情数据

            const mockData = {

              '000001': { name: '上证指数', price: 3350, open: 3345, high: 3368, low: 3330, changePercent: 0.15 },

              '000300': { name: '沪深300', price: 4660, open: 4652, high: 4685, low: 4640, changePercent: 0.17 },

              '399001': { name: '深证成指', price: 10800, open: 10785, high: 10830, low: 10760, changePercent: 0.14 },

              '399006': { name: '创业板指', price: 2100, open: 2095, high: 2115, low: 2088, changePercent: 0.24 },

              '600519': { name: '贵州茅台', price: 1680, open: 1675, high: 1695, low: 1670, changePercent: 0.30 },

              '000858': { name: '五粮液', price: 148, open: 147.2, high: 149.5, low: 146.8, changePercent: 0.54 },

              '600036': { name: '招商银行', price: 38, open: 37.8, high: 38.3, low: 37.6, changePercent: 0.53 },

              'sz000001': { name: '平安银行', price: 11, open: 10.95, high: 11.1, low: 10.9, changePercent: 0.46 }

            };

            

            // 清理symbol格式

            let cleanSymbol = symbol.replace(/^(sh|sz)/i, '');

            

            // 查找模拟数据

            const data = mockData[cleanSymbol];

            

            if (data) {

              console.log(`Mock: 成功生成模拟数据 - ${data.name}: ¥${data.price}`);

              

              return {

                current: data.price,

                close: data.price,

                open: data.open,

                high: data.high,

                low: data.low,

                change_percent: data.changePercent,

                volume: 100000000,

                name: data.name,

                isPredefined: true,  // 🔥 模拟数据标记为预定义

                dataSource: 'mock',  // 🔥 数据来源

                source: 'mock'

              };

            }

            

            // 如果没有预定义数据，生成随机数据

            const randomPrice = 10 + Math.random() * 90;

            const randomChange = (Math.random() - 0.5) * 10;

            

            console.log(`Mock: 生成随机模拟数据 - ${cleanSymbol}: ¥${randomPrice.toFixed(2)}`);

            

            return {

              current: randomPrice,

              close: randomPrice,

              open: randomPrice * (1 + (Math.random() - 0.5) * 0.02),

              high: randomPrice * (1 + Math.random() * 0.03),

              low: randomPrice * (1 - Math.random() * 0.03),

              change_percent: randomChange,

              volume: Math.floor(Math.random() * 200000000),

              name: `模拟标的${cleanSymbol}`,

              isPredefined: true,  // 🔥 模拟数据标记为预定义

              dataSource: 'mock',  // 🔥 数据来源

              source: 'mock'

            };

            

          } catch (error) {

            console.error(`Mock: 生成失败 - ${error.message}`);

            throw new Error(`模拟数据生成失败: ${error.message}`);

          }

        }

        

        default:

          throw new Error(`不支持的数据源: ${sourceId}`);

      }

    } catch (error) {

      console.error(`从数据源 ${sourceId} 获取数据失败:`, error);

      throw error;

    }

  }



  /**

   * 获取标的名称

   */

  getSymbolName(symbol) {

    const symbolMap = {

      'sh000001': '上证指数',

      '000001': '上证指数',

      'sz399001': '深证成指',

      '399001': '深证成指',

      'sh600000': '浦发银行',

      '600000': '浦发银行',

      'IF2503': '沪深300期货',

      '000300': '沪深300',

      'sh000300': '沪深300'

    };

    return symbolMap[symbol] || symbol;

  }



  /**

   * 获取标的类型

   */

  getSymbolType(symbol) {

    if (symbol.match(/^(sh|sz)?00[01]/i)) return '指数';

    if (symbol.match(/^(sh|sz)?39/i)) return '指数';

    if (symbol.match(/^IF|IC|IH/i)) return '期货';

    if (symbol.match(/^(sh|sz)?[36]/i)) return '股票';

    return '股票';

  }



  /**

   * 保存K线数据到数据库缓存

   * @param {string} symbol - 标的代码

   * @param {string} period - 周期

   * @param {Array} klineData - K线数据数组

   * @param {string} dataSource - 数据来源

   */

  async saveKlineToCache(symbol, period, klineData, dataSource) {

    try {

      const { KlineCache } = require('../models');

      const { Op } = require('sequelize');

      

      console.log(`💾 开始保存K线缓存: ${symbol}, period=${period}, 数据量=${klineData.length}`);

      

      // 批量插入或更新数据

      const records = klineData.map(item => ({

        symbol: symbol,

        period: period,

        trade_date: item.time,

        open: item.open,

        high: item.high,

        low: item.low,

        close: item.close,

        volume: item.volume || 0,

        amount: item.amount || 0,

        data_source: dataSource

      }));

      

      // 使用bulkCreate with updateOnDuplicate来实现upsert

      await KlineCache.bulkCreate(records, {

        updateOnDuplicate: ['open', 'high', 'low', 'close', 'volume', 'amount', 'data_source', 'updated_at']

      });

      

      console.log(`✅ K线缓存保存成功: ${records.length}条记录`);

      

      return { success: true, count: records.length };

    } catch (error) {

      console.error(`❌ 保存K线缓存失败:`, error.message);

      throw error;

    }

  }



  /**

   * 从数据库缓存获取K线数据

   * @param {string} symbol - 标的代码

   * @param {string} period - 周期

   * @param {string} startDate - 开始日期

   * @param {string} endDate - 结束日期

   * @returns {Array} - K线数据数组

   */

  async getKlineFromCache(symbol, period = 'daily', startDate = null, endDate = null) {

    try {

      const { KlineCache } = require('../models');

      const { Op } = require('sequelize');

      

      console.log(`📊 从缓存获取K线数据: ${symbol}, period=${period}`);

      

      const where = {

        symbol: symbol,

        period: period

      };

      

      // 如果没有指定日期范围，获取最近一年的数据

      if (!startDate) {

        const oneYearAgo = new Date();

        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        where.trade_date = { [Op.gte]: oneYearAgo };

      } else {

        where.trade_date = {};

        if (startDate) {

          where.trade_date[Op.gte] = new Date(startDate);

        }

        if (endDate) {

          where.trade_date[Op.lte] = new Date(endDate);

        }

      }

      

      const klineData = await KlineCache.findAll({

        where,

        order: [['trade_date', 'ASC']],

        limit: 10000 // 限制最多返回10000条

      });

      

      if (klineData && klineData.length > 0) {

        console.log(`✅ 从缓存获取到 ${klineData.length} 条K线数据`);

        

        // 转换为标准K线格式

        return klineData.map(item => ({

          time: item.trade_date,

          open: parseFloat(item.open),

          high: parseFloat(item.high),

          low: parseFloat(item.low),

          close: parseFloat(item.close),

          volume: parseInt(item.volume || 0),

          amount: parseFloat(item.amount || 0),

          dataSource: item.data_source

        }));

      }

      

      console.log(`⚠️  缓存中没有找到 ${symbol} 的K线数据`);

      return [];

      

    } catch (error) {

      console.error(`❌ 从缓存获取K线数据失败:`, error.message);

      return [];

    }

  }



  /**

   * 获取数据库中最新的缓存日期

   * @param {string} symbol - 标的代码

   * @param {string} period - 周期

   * @returns {string|null} - 最新日期或null

   */

  async getLatestCachedDate(symbol, period = 'daily') {

    try {

      const { KlineCache } = require('../models');
      const { Op } = require('sequelize');

      

      const latestRecord = await KlineCache.findOne({

        where: {

          symbol: symbol,

          period: period,

          // 只读取真实数据缓存，不读模拟数据
          [Op.and]: [
            { data_source: { [Op.notLike]: '%模拟%' } },
            { data_source: { [Op.notLike]: '%mock%' } },
            { data_source: { [Op.notLike]: '%enhanced%' } },
          ]

        },

        order: [['trade_date', 'DESC']],

        limit: 1

      });

      

      if (latestRecord) {

        console.log(`📅 最新缓存日期: ${symbol} = ${latestRecord.trade_date}`);

        return latestRecord.trade_date;

      }

      

      console.log(`⚠️  没有找到 ${symbol} 的缓存数据`);

      return null;

      

    } catch (error) {

      console.error(`❌ 获取最新缓存日期失败:`, error.message);

      return null;

    }

  }



  /**

   * 清除K线缓存

   * @param {string} symbol - 标的代码

   * @param {string} period - 周期

   * @returns {boolean} - 是否成功

   */

  async clearKlineCache(symbol, period = 'daily') {

    try {

      const { KlineCache } = require('../models');

      

      const deletedCount = await KlineCache.destroy({

        where: {

          symbol: symbol,

          period: period

        }

      });

      

      console.log(`✅ 已清除 ${symbol} 的缓存数据，删除了 ${deletedCount} 条记录`);

      return true;

      

    } catch (error) {

      console.error(`❌ 清除缓存失败:`, error.message);

      return false;

    }

  }



  /**

   * 获取增量数据（从指定日期之后的数据）

   * @param {string} symbol - 标的代码

   * @param {string} period - 周期

   * @param {string} fromDate - 起始日期

   * @returns {Object} - 增量数据

   */

  async fetchIncrementalData(symbol, period, fromDate) {

    try {

      console.log(`🔄 获取增量数据: ${symbol}, 从 ${fromDate} 开始`);

      

      // 识别标的信息

      const instrumentInfo = this.identifyInstrument(symbol);

      

      // 获取今天的日期

      const today = new Date().toISOString().split('T')[0];

      

      // 确定数据获取策略

      const dataStrategy = this.determineDataStrategy(instrumentInfo, fromDate, today);

      

      // 尝试从数据源获取增量数据

      for (const stage of dataStrategy.stages) {

        try {

          console.log(`🔄 尝试数据源: ${stage.name}`);

          

          const data = await this.fetchDataFromSource(

            stage.source,

            symbol,

            instrumentInfo,

            {

              startDate: fromDate,

              endDate: today,

              period

            }

          );

          

          if (data && data.kline && data.kline.length > 0) {

            console.log(`✅ 获取到 ${data.kline.length} 条增量数据`);

            return data;

          }

        } catch (error) {

          console.warn(`⚠️ 数据源 ${stage.name} 失败: ${error.message}`);

          continue;

        }

      }

      

      console.warn(`⚠️ 所有数据源都无法获取增量数据`);

      return null;

      

    } catch (error) {

      console.error(`❌ 获取增量数据失败:`, error.message);

      return null;

    }

  }



  /**

   * 更新数据源配置

   * @param {string} sourceKey - 数据源标识 (adata/akshare/efinance/mock)

   * @param {boolean} enabled - 是否启用

   */

  updateDataSourceConfig(sourceKey, enabled) {

    if (!this.dataSources[sourceKey]) {

      throw new Error(`未知的数据源: ${sourceKey}`);

    }



    // 🔥 数据源配置变更时，解锁当前数据源

    this.unlockDataSource();



    // 🔥 多选模式：允许同时启用多个数据源

    this.dataSources[sourceKey].enabled = enabled;



    console.log(`✅ 数据源配置已更新: ${sourceKey} = ${enabled ? '启用' : '禁用'}`);

    

    const enabledSources = Object.entries(this.dataSources)

      .filter(([key, config]) => config.enabled)

      .map(([key, config]) => `${config.name}(${key})`)

      .join(', ');

    

    console.log(`📊 当前启用的数据源:`, enabledSources || '无');



    return {

      success: true,

      currentSource: sourceKey,

      enabled: enabled,

      allSources: Object.entries(this.dataSources).map(([key, config]) => ({

        key,

        name: config.name,

        enabled: config.enabled,

        priority: config.priority

      }))

    };

  }



  /**

   * 获取当前激活的数据源

   */

  getActiveDataSource() {

    const activeSource = Object.entries(this.dataSources)

      .filter(([key, config]) => config.enabled)

      .sort((a, b) => a[1].priority - b[1].priority)[0];



    if (activeSource) {

      return {

        key: activeSource[0],

        name: activeSource[1].name,

        priority: activeSource[1].priority

      };

    }



    return null;

  }

}



module.exports = new ComprehensiveDataService();

