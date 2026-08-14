/**
 * Python数据源服务包装器
 * 调用 AData 和 EFinance Python库
 */
const { spawn } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const path = require('path');

class PythonDataSourceService {
  constructor() {
    // 根据操作系统选择Python命令
    // Windows: 优先使用py (Python Launcher), 其次python
    // Linux: python3
    this.pythonPath = require('../utils/pythonPath').findPython();
    this.adataScriptPath = path.join(__dirname, 'adataService.py');
    this.efinanceScriptPath = path.join(__dirname, 'efinanceService.py');
    this.akshareScriptPath = path.join(__dirname, 'akshareService.py');
    this.ifindScriptPath = path.join(__dirname, 'ifindService.py');
    this.khyshareScriptPath = path.join(__dirname, 'khyshareService.py');
  }

  /**
   * 执行Python脚本
   */
  async executePythonScript(scriptPath, args) {
    return new Promise((resolve, reject) => {
      // 设置环境变量，确保Python输出UTF-8编码
      const env = { ...process.env };
      env.PYTHONIOENCODING = 'utf-8';
      
      // 🔥 禁用代理 - 解决代理连接卡住问题
      env.HTTP_PROXY = '';
      env.HTTPS_PROXY = '';
      env.http_proxy = '';
      env.https_proxy = '';
      env.NO_PROXY = '*';
      env.no_proxy = '*';
      
      let childProcess;
      try {
        childProcess = spawn(this.pythonPath, [scriptPath, ...args], {
          env: env,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024 // 🔥 增加缓冲区到10MB，支持大量历史数据
        });
      } catch (spawnError) {
        console.error('❌ 无法启动Python进程:', spawnError.message);
        reject(new Error(`Python不可用: ${spawnError.message}`));
        return;
      }
      
      // Activity-aware idle timeout (resets on stdout/stderr data)
      let _idleTimer = null;
      const IDLE_MS = 120000;
      const _resetIdle = () => {
        if (_idleTimer) clearTimeout(_idleTimer);
        _idleTimer = setTimeout(() => {
          if (childProcess && !childProcess.killed) {
            console.error('❌ Python进程空闲超时，强制终止');
            safeKill(childProcess);
            reject(new Error(`Python进程空闲超时（${IDLE_MS / 1000}s 内无输出）`));
          }
        }, IDLE_MS);
      };
      _resetIdle();

      // 🔥 添加错误事件监听器,防止进程崩溃
      childProcess.on('error', (error) => {
        console.error('❌ Python进程错误:', error.message);
        reject(new Error(`Python进程错误: ${error.message}`));
      });

      let stdout = '';
      let stderr = '';

      // 使用UTF-8编码读取输出
      childProcess.stdout.setEncoding('utf8');
      childProcess.stderr.setEncoding('utf8');

      childProcess.stdout.on('data', (data) => {
        stdout += data;
        _resetIdle();
      });

      childProcess.stderr.on('data', (data) => {
        stderr += data;
        _resetIdle();
        // 实时输出Python的调试信息
        console.log('[Python]', data.trim());
      });

      childProcess.on('close', (code) => {
        if (_idleTimer) clearTimeout(_idleTimer);

        if (code !== 0) {
          reject(new Error(`Python进程退出码: ${code}, 错误: ${stderr}`));
          return;
        }

        try {
          // 🔥 改进：直接解析完整的stdout，不再只取最后一行
          // 清理stdout，移除可能的调试信息
          const lines = stdout.split('\n').filter(line => line.trim());
          
          // 尝试找到JSON对象
          let jsonStr = '';
          let braceCount = 0;
          let inJson = false;
          
          for (const line of lines) {
            for (const char of line) {
              if (char === '{') {
                if (!inJson) inJson = true;
                braceCount++;
              } else if (char === '}') {
                braceCount--;
              }
              
              if (inJson) {
                jsonStr += char;
              }
              
              if (inJson && braceCount === 0) {
                // 找到完整的JSON对象
                break;
              }
            }
            
            if (inJson && braceCount === 0) break;
            
            // 如果这一行没有完成JSON，添加换行符
            if (inJson && braceCount > 0) {
              jsonStr += '\n';
            }
          }
          
          if (!jsonStr) {
            reject(new Error(`未找到有效的JSON输出, stdout长度: ${stdout.length}, 前200字符: ${stdout.substring(0, 200)}`));
            return;
          }
          
          console.log(`📊 解析JSON，长度: ${jsonStr.length} 字符`);
          const result = JSON.parse(jsonStr);
          resolve(result);
        } catch (error) {
          reject(new Error(`解析Python输出失败: ${error.message}, stdout长度: ${stdout.length}, 前500字符: ${stdout.substring(0, 500)}`));
        }
      });

      childProcess.on('error', (error) => {
        clearTimeout(timeout); // 🔥 清除超时定时器
        reject(new Error(`启动Python进程失败: ${error.message}`));
      });
    });
  }

  /**
   * 使用AData获取K线数据
   */
  async getKlineFromAData(symbol, options = {}) {
    const {
      kType = 1, // 1-日线 2-周线 3-月线
      startDate = '2020-01-01'
      // 注意: AData的get_market_index不支持end_date参数
    } = options;

    try {
      console.log(`📊 AData获取K线: ${symbol}`);
      const args = ['kline', symbol, kType.toString(), startDate];
      // 不传递end_date参数

      const result = await this.executePythonScript(this.adataScriptPath, args);
      
      if (!result.success) {
        throw new Error(result.error || 'AData获取失败');
      }

      return result.data;
    } catch (error) {
      console.warn(`⚠️ AData获取失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 使用EFinance获取K线数据
   */
  async getKlineFromEFinance(symbol, options = {}) {
    const {
      klt = 101, // 101-日线 102-周线 103-月线
      startDate = '20200101',
      endDate = null
    } = options;

    try {
      console.log(`📊 EFinance获取K线: ${symbol}`);
      const args = ['kline', symbol, klt.toString(), startDate];
      if (endDate) args.push(endDate);

      const result = await this.executePythonScript(this.efinanceScriptPath, args);
      
      if (!result.success) {
        throw new Error(result.error || 'EFinance获取失败');
      }

      return result.data;
    } catch (error) {
      console.warn(`⚠️ EFinance获取失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 使用AData获取实时行情
   */
  async getRealtimeFromAData(symbol) {
    try {
      console.log(`📊 AData获取实时行情: ${symbol}`);
      const result = await this.executePythonScript(this.adataScriptPath, ['realtime', symbol]);
      
      if (!result.success) {
        throw new Error(result.error || 'AData获取实时行情失败');
      }

      return result.data;
    } catch (error) {
      console.warn(`⚠️ AData获取实时行情失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 使用EFinance获取实时行情
   */
  async getRealtimeFromEFinance(symbols) {
    try {
      const symbolList = Array.isArray(symbols) ? symbols : [symbols];
      console.log(`📊 EFinance获取实时行情: ${symbolList.join(',')}`);
      
      const result = await this.executePythonScript(this.efinanceScriptPath, ['realtime', ...symbolList]);
      
      if (!result.success) {
        throw new Error(result.error || 'EFinance获取实时行情失败');
      }

      return result.data;
    } catch (error) {
      console.warn(`⚠️ EFinance获取实时行情失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 使用AKShare获取K线数据
   */
  async getKlineFromAKShare(symbol, options = {}) {
    const {
      period = 'daily', // daily/weekly/monthly
      startDate = null,  // 🔥 移除默认值，使用传入的参数
      endDate = null,
      adjust = 'qfq',
      instrumentType = 'stock', // 🔥 添加标的类型参数
      count = null // 🔥 添加count参数，但当有startDate时不使用
    } = options;

    try {
      console.log(`📊 AKShare获取K线: ${symbol}, 类型: ${instrumentType}`);
      console.log(`   日期范围: ${startDate || '无'} 至 ${endDate || '无'}`);
      console.log(`   count限制: ${count || '无'}`);
      
      // 🔥 使用新的简化版脚本 akshare_data_v2.py
      const scriptPath = path.join(__dirname, '../../akshare_scripts/akshare_data_v2.py');
      
      // 构建参数: kline symbol period startDate endDate instrumentType
      const args = ['kline', symbol, period];
      
      // 🔥 必须按顺序传递参数，即使某些为空也要占位
      if (startDate) {
        args.push(startDate);
        // 如果有startDate，必须传endDate（即使为空）
        args.push(endDate || '');
        args.push(instrumentType);
      } else {
        // 如果没有startDate，也不传其他参数
        args.push(instrumentType);
      }

      console.log(`   执行脚本: ${scriptPath}`);
      console.log(`   参数: ${args.join(' ')}`);

      const result = await this.executePythonScript(scriptPath, args);
      
      if (!result.success) {
        throw new Error(result.error || 'AKShare获取失败');
      }

      console.log(`✅ AKShare获取成功: ${result.count || result.kline?.length || 0} 条数据`);
      return result;
    } catch (error) {
      console.warn(`⚠️ AKShare获取失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 使用AKShare获取实时行情
   */
  async getRealtimeFromAKShare(symbol) {
    try {
      console.log(`📊 AKShare获取实时行情: ${symbol}`);
      const result = await this.executePythonScript(this.akshareScriptPath, ['realtime', symbol]);
      
      if (!result.success) {
        throw new Error(result.error || 'AKShare获取实时行情失败');
      }

      return result.data;
    } catch (error) {
      console.warn(`⚠️ AKShare获取实时行情失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 测试AData连接
   */
  async testAData() {
    try {
      const result = await this.executePythonScript(this.adataScriptPath, ['test']);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 测试EFinance连接
   */
  async testEFinance() {
    try {
      const result = await this.executePythonScript(this.efinanceScriptPath, ['test']);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 测试AKShare连接
   */
  async testAKShare() {
    try {
      const result = await this.executePythonScript(this.akshareScriptPath, ['test']);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 测试所有Python数据源
   */
  async testAll() {
    const results = {
      adata: await this.testAData(),
      efinance: await this.testEFinance(),
      akshare: await this.testAKShare()
    };

    return {
      success: results.adata.success || results.efinance.success || results.akshare.success,
      results
    };
  }

  /**
   * 获取所有股票代码（使用AData）
   */
  async getAllStockCodes() {
    try {
      const scriptPath = path.join(__dirname, 'get_all_stock_codes.py');
      const result = await this.executePythonScript(scriptPath, []);
      
      if (!result.success) {
        throw new Error(result.error || '获取股票代码失败');
      }

      console.log(`✅ 获取到 ${result.count} 个股票代码`);
      return { success: true, data: result.data, count: result.count };
    } catch (error) {
      console.error('❌ 获取股票代码失败:', error.message);
      return { success: false, error: error.message, data: [] };
    }
  }

  /**
   * 从iFinD获取K线数据
   */
  async getKlineFromIFind(symbol, options = {}) {
    try {
      const { period = 'daily', startDate, endDate } = options;
      
      const args = ['kline', symbol, period];
      if (startDate) args.push(startDate);
      if (endDate) args.push(endDate);
      
      const result = await this.executePythonScript(this.ifindScriptPath, args);
      
      if (!result.success) {
        throw new Error(result.error || 'iFinD获取K线失败');
      }

      console.log(`✅ iFinD获取K线成功: ${result.count} 条数据`);
      return result;
    } catch (error) {
      console.error('❌ iFinD获取K线失败:', error.message);
      throw error;
    }
  }

  /**
   * 从iFinD批量获取行情
   */
  async getBatchQuotesFromIFind(symbols, instrumentType = 'stock') {
    try {
      const symbolStr = Array.isArray(symbols) ? symbols.join(',') : symbols;
      const result = await this.executePythonScript(this.ifindScriptPath, ['batch_quotes', symbolStr, instrumentType]);
      
      if (!result.success) {
        throw new Error(result.error || 'iFinD获取行情失败');
      }

      console.log(`✅ iFinD获取行情成功: ${result.count} 条数据`);
      return result;
    } catch (error) {
      console.error('❌ iFinD获取行情失败:', error.message);
      throw error;
    }
  }

  /**
   * 测试iFinD连接
   */
  async testIFindConnection() {
    try {
      const result = await this.executePythonScript(this.ifindScriptPath, ['test']);
      return result;
    } catch (error) {
      console.error('❌ iFinD连接测试失败:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取所有指数代码（使用AData）
   */
  async getAllIndexCodes() {
    try {
      const scriptPath = path.join(__dirname, 'get_all_index_codes.py');
      const result = await this.executePythonScript(scriptPath, []);
      
      if (!result.success) {
        throw new Error(result.error || '获取指数代码失败');
      }

      console.log(`✅ 获取到 ${result.count} 个指数代码`);
      return { success: true, data: result.data, count: result.count };
    } catch (error) {
      console.error('❌ 获取指数代码失败:', error.message);
      return { success: false, error: error.message, data: [] };
    }
  }

  /**
   * 获取所有类型的标的（使用AData）
   * 包括：股票、指数、ETF、可转债
   */
  async getAllInstrumentsByType() {
    try {
      const scriptPath = path.join(__dirname, 'get_all_instruments_by_type.py');
      const result = await this.executePythonScript(scriptPath, []);
      
      if (!result.success) {
        throw new Error(result.error || '获取标的列表失败');
      }

      console.log(`✅ 获取到 ${result.stats.total} 个标的 (指数:${result.stats.indices}, 股票:${result.stats.stocks}, ETF:${result.stats.etfs}, 可转债:${result.stats.bonds})`);
      return { success: true, data: result.data, stats: result.stats };
    } catch (error) {
      console.error('❌ 获取标的列表失败:', error.message);
      return { success: false, error: error.message, data: [], stats: {} };
    }
  }

  /**
   * 获取股票和指数标的（简化版，只获取已验证可用的数据）
   * 包括：股票、指数
   */
  async getStockAndIndexOnly() {
    try {
      const scriptPath = path.join(__dirname, 'get_instruments_stock_index_only.py');
      const result = await this.executePythonScript(scriptPath, []);
      
      if (!result.success) {
        throw new Error(result.error || '获取标的列表失败');
      }

      console.log(`✅ 获取到 ${result.stats.total} 个标的 (指数:${result.stats.indices}, 股票:${result.stats.stocks})`);
      return { success: true, data: result.data, stats: result.stats };
    } catch (error) {
      console.error('❌ 获取标的列表失败:', error.message);
      return { success: false, error: error.message, data: [], stats: {} };
    }
  }

  /**
   * 从KHYShare获取K线数据
   */
  async getKlineFromKHYShare(symbol, options = {}) {
    try {
      const { period = 'daily', startDate = null, endDate = null, useHistory = false } = options;
      
      console.log(`📊 调用KHYShare服务: ${symbol}, period=${period}, useHistory=${useHistory}`);
      
      // 🔥 如果需要历史数据，调用kline_history命令
      if (useHistory || startDate) {
        const args = ['kline_history', symbol];
        if (startDate) args.push(startDate);
        if (endDate) args.push(endDate);
        if (period) args.push(period);
        
        const result = await this.executePythonScript(this.khyshareScriptPath, args);
        
        if (!result.success) {
          throw new Error(result.error || 'KHYShare获取历史数据失败');
        }

        console.log(`✅ KHYShare获取历史数据成功: ${result.name}, K线数量=${result.count}`);
        
        return {
          success: true,
          symbol: symbol,
          name: result.name,
          kline: result.kline,
          source: result.source,
          count: result.count,
          period: result.period,
          start_date: result.start_date,
          end_date: result.end_date
        };
      }
      
      // 🔥 否则获取实时数据
      const args = ['realtime', symbol];
      const result = await this.executePythonScript(this.khyshareScriptPath, args);
      
      if (!result.success) {
        throw new Error(result.error || 'KHYShare获取数据失败');
      }

      // 将实时数据转换为K线格式
      const kline = [{
        time: new Date().toISOString().split('T')[0],
        open: result.open || result.price,
        high: result.high || result.price,
        low: result.low || result.price,
        close: result.price,
        volume: result.volume || 0
      }];

      console.log(`✅ KHYShare获取数据成功: ${result.name}, 价格=${result.price}`);
      
      return {
        success: true,
        symbol: symbol,
        name: result.name,
        kline: kline,
        source: result.source,
        count: 1
      };
    } catch (error) {
      console.error('❌ KHYShare获取数据失败:', error.message);
      throw error;
    }
  }

  /**
   * 测试KHYShare连接
   */
  async testKHYShareConnection() {
    try {
      const result = await this.executePythonScript(this.khyshareScriptPath, ['test']);
      return result;
    } catch (error) {
      console.error('❌ KHYShare连接测试失败:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 从KHYShare获取所有A股和指数列表
   */
  async getAllInstrumentsFromKHYShare() {
    try {
      const result = await this.executePythonScript(this.khyshareScriptPath, ['get_all_instruments']);
      
      if (!result.success) {
        throw new Error(result.error || '获取标的列表失败');
      }

      console.log(`✅ KHYShare获取到 ${result.count} 个标的 (股票:${result.stocks}, 指数:${result.indices})`);
      return result;
    } catch (error) {
      console.error('❌ KHYShare获取标的列表失败:', error.message);
      return { success: false, error: error.message, data: [], count: 0 };
    }
  }
}

module.exports = new PythonDataSourceService();
