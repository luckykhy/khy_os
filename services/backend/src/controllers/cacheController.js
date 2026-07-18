/**
 * 数据缓存控制器
 * 用于保存行情和K线数据到数据库,实现离线访问
 */

const klineDataService = require('../services/klineDataService');
const instrumentService = require('../services/instrumentService');
const comprehensiveDataService = require('../services/comprehensiveDataService');

function detectInstrumentType(symbol = '') {
  const normalizedSymbol = String(symbol || '');
  if (/^[A-Za-z]{1,3}\d{3,4}$/.test(normalizedSymbol) || /^(IF|IC|IH|IM)\d{4}$/i.test(normalizedSymbol)) {
    return 'futures';
  }
  if (/^(sh|sz|SH|SZ)?(000|399)\d{3}$/.test(normalizedSymbol)) {
    return 'index';
  }
  return 'stock';
}

function inferDataTypeFromPeriod(period = 'daily') {
  const normalizedPeriod = String(period || '').toLowerCase();
  if (normalizedPeriod === 'tick') return 'tick';
  if (['1m', '5m', '15m', '30m', '60m', '1min', '5min', '15min', '30min', '60min', 'minute'].includes(normalizedPeriod)) {
    return 'minute';
  }
  return 'daily';
}

function normalizeDataType(dataType, period = 'daily') {
  const normalized = String(dataType || '').toLowerCase().trim();
  if (['daily', 'minute', 'tick'].includes(normalized)) return normalized;
  return inferDataTypeFromPeriod(period);
}

class CacheController {
  /**
   * 保存标的和K线数据到数据库
   * POST /api/cache/save-instrument-data
   */
  async saveInstrumentData(req, res) {
    try {
      const { symbol, name, type, periods = ['daily'], dataType, instrumentType } = req.body;
      
      if (!symbol) {
        return res.status(400).json({
          success: false,
          message: '标的代码不能为空'
        });
      }
      
      console.log(`💾 开始缓存标的数据: ${symbol} ${name || ''}`);
      
      const result = {
        symbol,
        name,
        instrumentType: instrumentType || type || detectInstrumentType(symbol),
        instrument: null,
        klineData: {}
      };
      
      // 1. 保存标的信息
      try {
        const instrument = await instrumentService.saveInstrumentIfNotExists(
          symbol,
          name,
          type || 'unknown'
        );
        result.instrument = {
          success: true,
          data: instrument
        };
        console.log(`✅ 标的信息已保存: ${symbol}`);
      } catch (error) {
        result.instrument = {
          success: false,
          error: error.message
        };
        console.error(`❌ 保存标的信息失败: ${error.message}`);
      }
      
      // 2. 获取并保存K线数据
      for (const period of periods) {
        const normalizedDataType = normalizeDataType(dataType, period);
        const resolvedInstrumentType = instrumentType || type || detectInstrumentType(symbol);

        try {
          console.log(`📊 获取 ${symbol} 的 ${period} K线数据 (dataType=${normalizedDataType}, instrumentType=${resolvedInstrumentType})...`);
          
          // 从数据源获取K线数据
          const klineData = await comprehensiveDataService.getComprehensiveData(symbol, {
            period: period,
            limit: 500, // 获取最近500条数据
            dataType: normalizedDataType,
            instrumentType: resolvedInstrumentType
          });
          
          console.log(`🔍 getComprehensiveData返回:`, {
            hasData: !!klineData,
            hasKline: !!(klineData && klineData.kline),
            klineLength: klineData?.kline?.length || 0,
            keys: klineData ? Object.keys(klineData) : []
          });
          
          if (klineData && klineData.kline && klineData.kline.length > 0) {
            // 保存到数据库
            const saveResult = await klineDataService.saveKlineData(
              symbol,
              name || klineData.name,
              period,
              klineData.kline,
              {
                dataType: normalizedDataType,
                instrumentType: resolvedInstrumentType
              }
            );
            
            result.klineData[period] = {
              success: saveResult.success,
              count: saveResult.count,
              dataType: saveResult.dataType || normalizedDataType,
              instrumentType: saveResult.instrumentType || resolvedInstrumentType,
              message: `保存了 ${saveResult.count} 条${period}数据`
            };
            
            console.log(`✅ ${period} K线数据已保存: ${saveResult.count} 条`);
          } else {
            result.klineData[period] = {
              success: false,
              count: 0,
              message: '未获取到K线数据'
            };
            console.warn(`⚠️ 未获取到 ${period} K线数据`);
          }
        } catch (error) {
          result.klineData[period] = {
            success: false,
            error: error.message
          };
          console.error(`❌ 保存 ${period} K线数据失败: ${error.message}`);
        }
      }
      
      // 3. 统计结果
      const totalSaved = Object.values(result.klineData)
        .reduce((sum, item) => sum + (item.count || 0), 0);
      
      const allSuccess = result.instrument.success && 
        Object.values(result.klineData).every(item => item.success);
      
      res.json({
        success: allSuccess,
        data: result,
        message: `数据缓存${allSuccess ? '成功' : '部分成功'}: 共保存 ${totalSaved} 条K线数据`
      });
      
    } catch (error) {
      console.error('❌ 缓存数据失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '缓存数据失败'
      });
    }
  }
  
  /**
   * 批量保存多个标的数据
   * POST /api/cache/batch-save
   */
  async batchSaveInstruments(req, res) {
    try {
      const { instruments, periods = ['daily'], dataType, instrumentType } = req.body;
      
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
        return res.status(400).json({
          success: false,
          message: '标的列表不能为空'
        });
      }
      
      console.log(`💾 批量缓存 ${instruments.length} 个标的数据...`);
      
      const results = [];
      let successCount = 0;
      let failCount = 0;
      
      for (const inst of instruments) {
        try {
          const resolvedInstrumentType = inst.instrumentType || inst.type || instrumentType || detectInstrumentType(inst.symbol);

          // 保存标的信息
          await instrumentService.saveInstrumentIfNotExists(
            inst.symbol,
            inst.name,
            resolvedInstrumentType
          );
          
          // 保存K线数据
          for (const period of periods) {
            const normalizedDataType = normalizeDataType(dataType || inst.dataType, period);
            const klineData = await comprehensiveDataService.getComprehensiveData(inst.symbol, {
              period: period,
              limit: 500,
              dataType: normalizedDataType,
              instrumentType: resolvedInstrumentType
            });
            
            if (klineData && klineData.kline && klineData.kline.length > 0) {
              await klineDataService.saveKlineData(
                inst.symbol,
                inst.name || klineData.name,
                period,
                klineData.kline,
                {
                  dataType: normalizedDataType,
                  instrumentType: resolvedInstrumentType
                }
              );
            }
          }
          
          successCount++;
          results.push({
            symbol: inst.symbol,
            success: true
          });
          
          console.log(`✅ ${inst.symbol} 缓存成功`);
        } catch (error) {
          failCount++;
          results.push({
            symbol: inst.symbol,
            success: false,
            error: error.message
          });
          console.error(`❌ ${inst.symbol} 缓存失败:`, error.message);
        }
      }
      
      res.json({
        success: true,
        data: {
          total: instruments.length,
          successCount,
          failCount,
          results
        },
        message: `批量缓存完成: 成功 ${successCount}, 失败 ${failCount}`
      });
      
    } catch (error) {
      console.error('❌ 批量缓存失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '批量缓存失败'
      });
    }
  }
  
  /**
   * 获取缓存的K线数据
   * GET /api/cache/kline-data/:symbol
   */
  async getCachedKlineData(req, res) {
    try {
      const { symbol } = req.params;
      const { period = 'daily', startDate, endDate, limit, dataType, instrumentType } = req.query;
      const normalizedDataType = normalizeDataType(dataType, period);
      const resolvedInstrumentType = instrumentType || detectInstrumentType(symbol);
      
      const data = await klineDataService.getKlineData(
        symbol,
        period,
        startDate,
        endDate,
        limit ? parseInt(limit, 10) : 1000,
        {
          dataType: normalizedDataType,
          instrumentType: resolvedInstrumentType
        }
      );
      const kline = Array.isArray(data?.kline) ? data.kline : [];
      
      res.json({
        success: true,
        data: {
          symbol,
          period,
          dataType: data?.dataType || normalizedDataType,
          instrumentType: data?.instrumentType || resolvedInstrumentType,
          kline,
          count: kline.length,
          cached: true
        },
        message: `获取缓存数据成功: ${kline.length} 条`
      });
      
    } catch (error) {
      console.error('❌ 获取缓存数据失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '获取缓存数据失败'
      });
    }
  }
  
  /**
   * 获取缓存统计信息
   * GET /api/cache/stats/:symbol
   */
  async getCacheStats(req, res) {
    try {
      const { symbol } = req.params;
      const { period = 'daily' } = req.query;
      
      const stats = await klineDataService.getDataStats(symbol, period);
      
      res.json({
        success: true,
        data: stats,
        message: '获取统计信息成功'
      });
      
    } catch (error) {
      console.error('❌ 获取统计信息失败:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: '获取统计信息失败'
      });
    }
  }
}

module.exports = new CacheController();
