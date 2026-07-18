/**
 * Python策略执行引擎
 * 支持Python策略的解析和执行
 */
const { spawn } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class PythonStrategyEngine {
  constructor() {
    this.tempDir = path.join(__dirname, '../../temp/python_strategies');
    this.initTempDir();
  }

  /**
   * 初始化临时目录
   */
  async initTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      console.log('Python策略临时目录已创建:', this.tempDir);
    } catch (error) {
      console.error('创建临时目录失败:', error);
    }
  }

  /**
   * 确保临时目录存在
   */
  async ensureTempDir() {
    try {
      await fs.access(this.tempDir);
    } catch (error) {
      // 目录不存在，创建它
      await fs.mkdir(this.tempDir, { recursive: true });
    }
  }

  /**
   * 生成策略文件名
   */
  generateStrategyFileName() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `strategy_${timestamp}_${random}.py`;
  }

  /**
   * 创建Python策略包装器
   * @param {string} userCode - 用户的Python策略代码
   * @returns {string} 完整的Python脚本
   */
  createPythonWrapper(userCode) {
    return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
import sys
import pandas as pd
import numpy as np
from typing import List, Dict, Any
import inspect
import re

# User strategy code
${userCode}

def detect_strategy_functions():
    """Detect possible strategy entry points"""
    current_module = sys.modules[__name__]
    functions = []
    
    # Get all functions in current module, excluding our internal functions
    internal_functions = {
        'main', 'detect_strategy_functions', 'try_call_function', 
        'try_call_class_methods', 'execute_strategy_code'
    }
    
    for name, obj in inspect.getmembers(current_module):
        if (inspect.isfunction(obj) and 
            not name.startswith('_') and 
            name not in internal_functions):
            
            # Check function signature
            sig = inspect.signature(obj)
            params = list(sig.parameters.keys())
            
            # Score function based on name and parameters
            score = 0
            if name in ['strategy', 'execute', 'run', 'main', 'trade']:
                score += 10
            if len(params) >= 2:
                score += 5
            if 'data' in params or 'df' in params:
                score += 3
            if 'params' in params or 'parameters' in params:
                score += 3
                
            functions.append({
                'name': name,
                'score': score,
                'params': params
            })
    
    # Sort by score (highest first)
    functions.sort(key=lambda x: x['score'], reverse=True)
    return functions

def try_call_function(func_info, data, params):
    """Try to call a function with different parameter combinations"""
    # Get the function by name from current module
    current_module = sys.modules[__name__]
    func_name = func_info['name']
    
    if not hasattr(current_module, func_name):
        raise ValueError(f"Function {func_name} not found")
    
    func = getattr(current_module, func_name)
    func_params = func_info['params']
    
    try:
        # Try different calling patterns
        if len(func_params) == 0:
            return func()
        elif len(func_params) == 1:
            # Try with data first, then params
            try:
                return func(data)
            except:
                return func(params)
        elif len(func_params) == 2:
            # Standard two-parameter call
            return func(data, params)
        elif len(func_params) >= 3:
            # Try with additional None parameters
            return func(data, params, None)
    except Exception as e:
        raise e

def try_call_class_methods(data, params):
    """Try to find and call class methods"""
    current_module = sys.modules[__name__]
    
    for name, obj in inspect.getmembers(current_module):
        if inspect.isclass(obj) and not name.startswith('_'):
            try:
                # Try to instantiate the class
                instance = obj()
                
                # Try common method names
                method_names = ['execute', 'run', 'strategy', 'trade', 'main']
                for method_name in method_names:
                    if hasattr(instance, method_name):
                        method = getattr(instance, method_name)
                        if callable(method):
                            try:
                                # Try different parameter combinations
                                sig = inspect.signature(method)
                                params_count = len(sig.parameters)
                                
                                if params_count == 0:
                                    result = method()
                                elif params_count == 1:
                                    result = method(data)
                                elif params_count == 2:
                                    result = method(data, params)
                                else:
                                    result = method(data, params, None)
                                
                                if result is not None and isinstance(result, list):
                                    return result
                            except Exception as e:
                                continue
            except Exception as e:
                continue
    
    return None

def execute_strategy_code(data, params):
    """Execute strategy code with intelligent function detection"""
    
    # Try to detect and call functions
    functions = detect_strategy_functions()
    
    for func_info in functions:
        try:
            result = try_call_function(func_info, data, params)
            if result is not None and isinstance(result, list):
                return result
        except Exception as e:
            continue  # Try next function
    
    # Try class methods
    try:
        result = try_call_class_methods(data, params)
        if result is not None and isinstance(result, list):
            return result
    except:
        pass
    
    # Try with DataFrame if pandas is available
    try:
        df = pd.DataFrame(data)
        if 'timestamp' in df.columns:
            df['timestamp'] = pd.to_datetime(df['timestamp'])
        
        for func_info in functions:
            try:
                # Try calling with DataFrame
                if len(func_info['params']) >= 1:
                    result = func_info['function'](df, params)
                    if result is not None and isinstance(result, list):
                        return result
            except Exception as e:
                continue
    except:
        pass
    
    # Try to execute code directly and look for results
    try:
        # Set global variables
        globals()['data'] = data
        globals()['params'] = params
        globals()['df'] = pd.DataFrame(data) if data else pd.DataFrame()
        
        # Look for common result variable names
        result_vars = ['signals', 'result', 'output', 'trades']
        for var_name in result_vars:
            if var_name in globals() and isinstance(globals()[var_name], list):
                return globals()[var_name]
    except:
        pass
    
    # If all else fails, return empty signals
    return []

def main():
    try:
        # Read data from command line arguments
        if len(sys.argv) < 3:
            raise ValueError("Missing required parameters")
        
        data_json = sys.argv[1]
        params_json = sys.argv[2]
        
        # Parse data
        data = json.loads(data_json)
        params = json.loads(params_json)
        
        # Execute strategy with intelligent detection
        signals = execute_strategy_code(data, params)
        
        # Validate signal format
        if not isinstance(signals, list):
            signals = []
        
        # Output result
        print(json.dumps(signals, ensure_ascii=False))
        
    except Exception as e:
        error_result = {
            "error": str(e),
            "type": type(e).__name__
        }
        print(json.dumps(error_result, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
`;
  }

  /**
   * 执行Python策略
   * @param {string} code - Python策略代码
   * @param {Array} data - K线数据
   * @param {Object} params - 策略参数
   * @returns {Promise<Array>} 交易信号
   */
  async executeStrategy(code, data, params = {}) {
    const fileName = this.generateStrategyFileName();
    const filePath = path.join(this.tempDir, fileName);
    
    try {
      console.log('执行Python策略，数据条数:', data.length);
      console.log('策略参数:', params);
      
      // 确保临时目录存在
      await this.ensureTempDir();
      
      // 创建Python脚本
      const pythonScript = this.createPythonWrapper(code);
      await fs.writeFile(filePath, pythonScript, 'utf8');
      
      // 准备数据和参数
      const dataJson = JSON.stringify(data);
      const paramsJson = JSON.stringify(params);
      
      // 执行Python脚本
      const result = await this.runPythonScript(filePath, [dataJson, paramsJson]);
      
      // 解析结果
      const signals = JSON.parse(result);
      
      if (signals.error) {
        throw new Error(`Python策略执行错误: ${signals.error}`);
      }
      
      console.log('Python策略返回信号数:', signals ? signals.length : 0);
      
      if (!signals || !Array.isArray(signals)) {
        throw new Error('Python策略必须返回信号数组');
      }
      
      const validatedSignals = this.validateSignals(signals, data);
      console.log('验证后的信号数:', validatedSignals.length);
      console.log('买入信号:', validatedSignals.filter(s => s.type === 'buy').length);
      console.log('卖出信号:', validatedSignals.filter(s => s.type === 'sell').length);
      
      return validatedSignals;
      
    } catch (error) {
      console.error('Python策略执行失败:', error);
      throw error;
    } finally {
      // 清理临时文件
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        console.warn('清理临时文件失败:', cleanupError);
      }
    }
  }

  /**
   * 运行Python脚本
   * @param {string} scriptPath - 脚本路径
   * @param {Array} args - 命令行参数
   * @returns {Promise<string>} 脚本输出
   */
  runPythonScript(scriptPath, args = []) {
    return new Promise((resolve, reject) => {
      const pythonCmd = require('../utils/pythonPath').findPython();
      let python;
      try {
        python = spawn(pythonCmd, [scriptPath, ...args], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (spawnError) {
        console.error('❌ 无法启动Python进程:', spawnError.message);
        reject(new Error(`Python不可用: ${spawnError.message}`));
        return;
      }
      
      let stdout = '';
      let stderr = '';
      let _settled = false;

      // Activity-aware idle timeout: user-supplied strategy scripts can loop
      // forever; without this the child is never killed and the Promise hangs.
      let _idleTimer = null;
      const IDLE_MS = 120000;
      const _clearIdle = () => { if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; } };
      const _resetIdle = () => {
        _clearIdle();
        _idleTimer = setTimeout(() => {
          if (_settled) return;
          _settled = true;
          if (python && !python.killed) safeKill(python);
          reject(new Error(`Python脚本空闲超时（${IDLE_MS / 1000}s 内无输出）`));
        }, IDLE_MS);
      };
      _resetIdle();

      // 🔥 添加错误事件监听器
      python.on('error', (error) => {
        if (_settled) return;
        _settled = true;
        _clearIdle();
        console.error('❌ Python进程错误:', error.message);
        reject(new Error(`Python进程错误: ${error.message}`));
      });

      python.stdout.on('data', (data) => {
        stdout += data.toString();
        _resetIdle();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
        _resetIdle();
      });

      python.on('close', (code) => {
        if (_settled) return;
        _settled = true;
        _clearIdle();
        console.log('Python脚本执行完成，退出码:', code);

        if (code !== 0) {
          reject(new Error(`Python脚本执行失败 (退出码: ${code}): ${stderr || stdout}`));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  /**
   * 验证交易信号
   */
  validateSignals(signals, data) {
    if (!Array.isArray(signals)) {
      throw new Error('策略必须返回数组');
    }

    return signals.map((signal, index) => {
      if (!signal || typeof signal !== 'object') {
        return null;
      }

      return {
        index: signal.index !== undefined ? signal.index : index,
        type: signal.type || 'hold', // buy, sell, hold
        price: signal.price || (data[index] ? data[index].close : 0),
        quantity: signal.quantity || 0,
        reason: signal.reason || '',
        timestamp: data[signal.index || index]?.timestamp
      };
    }).filter(s => s !== null);
  }

  /**
   * 回测Python策略
   * @param {string} code - Python策略代码
   * @param {Array} data - K线数据
   * @param {Object} params - 策略参数
   * @param {number} initialCapital - 初始资金
   */
  async backtest(code, data, params = {}, initialCapital = 100000) {
    try {
      console.log('开始Python策略回测，数据条数:', data.length);
      console.log('初始资金:', initialCapital);
      
      const signals = await this.executeStrategy(code, data, params);
      
      console.log('总信号数:', signals.length);
      const tradeSignals = signals.filter(s => s.type !== 'hold');
      console.log('交易信号数:', tradeSignals.length);
      
      // 计算回测结果（与JavaScript版本相同的逻辑）
      let capital = initialCapital;
      let position = 0;
      let trades = [];
      let equity = [initialCapital];
      let buyPrice = 0;

      for (const signal of signals) {
        const dataPoint = data[signal.index];
        if (!dataPoint) {
          console.warn('信号索引超出数据范围:', signal.index);
          continue;
        }

        if (signal.type === 'buy' && capital > 0 && position === 0) {
          // 买入
          const quantity = Math.floor(capital / signal.price);
          if (quantity > 0) {
            position = quantity;
            capital -= quantity * signal.price;
            buyPrice = signal.price;
            trades.push({
              type: 'buy',
              price: signal.price,
              quantity,
              timestamp: signal.timestamp,
              reason: signal.reason
            });
            console.log(`买入: 价格=${signal.price}, 数量=${quantity}, 原因=${signal.reason}`);
          }
        } else if (signal.type === 'sell' && position > 0) {
          // 卖出
          const quantity = position;
          const sellAmount = quantity * signal.price;
          capital += sellAmount;
          const profit = (signal.price - buyPrice) * quantity;
          position = 0;
          trades.push({
            type: 'sell',
            price: signal.price,
            quantity,
            timestamp: signal.timestamp,
            reason: signal.reason,
            profit: profit
          });
          console.log(`卖出: 价格=${signal.price}, 数量=${quantity}, 盈亏=${profit.toFixed(2)}, 原因=${signal.reason}`);
        }

        // 记录权益曲线
        const currentEquity = capital + position * dataPoint.close;
        equity.push(currentEquity);
      }

      // 计算最终权益
      const finalEquity = capital + position * data[data.length - 1].close;
      const totalReturn = ((finalEquity - initialCapital) / initialCapital * 100).toFixed(2);
      
      // 计算胜率
      const sellTrades = trades.filter(t => t.type === 'sell');
      const winTrades = sellTrades.filter(t => t.profit > 0).length;
      const totalTrades = sellTrades.length;
      const winRate = totalTrades > 0 ? (winTrades / totalTrades * 100).toFixed(2) : 0;

      console.log('Python策略回测完成:');
      console.log('- 最终权益:', finalEquity);
      console.log('- 总收益率:', totalReturn + '%');
      console.log('- 交易次数:', totalTrades);
      console.log('- 胜率:', winRate + '%');

      return {
        initialCapital,
        finalEquity: parseFloat(finalEquity.toFixed(2)),
        totalReturn: parseFloat(totalReturn),
        totalTrades,
        winTrades,
        winRate: parseFloat(winRate),
        trades,
        signals: tradeSignals,
        equity
      };
    } catch (error) {
      console.error('Python策略回测失败:', error);
      throw error;
    }
  }

  /**
   * 获取Python策略模板
   */
  getTemplates() {
    return {
      ma_cross_python: {
        name: '双均线策略 (Python)',
        description: '使用Python实现的双均线交叉策略',
        language: 'python',
        code: `import pandas as pd
import numpy as np

def strategy(data, params):
    """
    Double Moving Average Crossover Strategy
    Buy when short MA crosses above long MA, sell when crosses below
    """
    short_period = params.get('shortPeriod', 5)
    long_period = params.get('longPeriod', 10)
    
    # Convert to DataFrame
    df = pd.DataFrame(data)
    
    # Calculate moving averages
    df['ma_short'] = df['close'].rolling(window=short_period).mean()
    df['ma_long'] = df['close'].rolling(window=long_period).mean()
    
    signals = []
    
    for i in range(1, len(df)):
        if pd.isna(df.iloc[i]['ma_short']) or pd.isna(df.iloc[i]['ma_long']):
            signals.append({'type': 'hold', 'index': i})
            continue
        
        # Golden cross: buy signal
        if (df.iloc[i-1]['ma_short'] <= df.iloc[i-1]['ma_long'] and 
            df.iloc[i]['ma_short'] > df.iloc[i]['ma_long']):
            signals.append({
                'type': 'buy',
                'index': i,
                'price': df.iloc[i]['close'],
                'reason': f'MA{short_period} crosses above MA{long_period}'
            })
        # Death cross: sell signal
        elif (df.iloc[i-1]['ma_short'] >= df.iloc[i-1]['ma_long'] and 
              df.iloc[i]['ma_short'] < df.iloc[i]['ma_long']):
            signals.append({
                'type': 'sell',
                'index': i,
                'price': df.iloc[i]['close'],
                'reason': f'MA{short_period} crosses below MA{long_period}'
            })
        else:
            signals.append({'type': 'hold', 'index': i})
    
    return signals`,
        params: {
          shortPeriod: 5,
          longPeriod: 10
        }
      },
      rsi_python: {
        name: 'RSI策略 (Python)',
        description: '使用Python实现的RSI超买超卖策略',
        language: 'python',
        code: `import pandas as pd
import numpy as np

def strategy(data, params):
    """
    RSI Overbought/Oversold Strategy
    Buy when RSI < oversold, sell when RSI > overbought
    """
    period = params.get('period', 14)
    overbought = params.get('overbought', 65)
    oversold = params.get('oversold', 35)
    
    # Convert to DataFrame
    df = pd.DataFrame(data)
    
    # Calculate RSI
    delta = df['close'].diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / loss
    df['rsi'] = 100 - (100 / (1 + rs))
    
    signals = []
    
    for i in range(1, len(df)):
        if pd.isna(df.iloc[i]['rsi']):
            signals.append({'type': 'hold', 'index': i})
            continue
        
        current_rsi = df.iloc[i]['rsi']
        prev_rsi = df.iloc[i-1]['rsi']
        
        # RSI crosses below oversold line: buy
        if current_rsi < oversold and prev_rsi >= oversold:
            signals.append({
                'type': 'buy',
                'index': i,
                'price': df.iloc[i]['close'],
                'reason': f'RSI oversold ({current_rsi:.2f})'
            })
        # RSI crosses above overbought line: sell
        elif current_rsi > overbought and prev_rsi <= overbought:
            signals.append({
                'type': 'sell',
                'index': i,
                'price': df.iloc[i]['close'],
                'reason': f'RSI overbought ({current_rsi:.2f})'
            })
        else:
            signals.append({'type': 'hold', 'index': i})
    
    return signals`,
        params: {
          period: 14,
          overbought: 65,
          oversold: 35
        }
      },
      bollinger_bands_python: {
        name: '布林带策略 (Python)',
        description: '使用Python实现的布林带突破策略',
        language: 'python',
        code: `import pandas as pd
import numpy as np

def strategy(data, params):
    """
    Bollinger Bands Strategy
    Buy when price breaks below lower band, sell when breaks above upper band
    """
    period = params.get('period', 20)
    std_dev = params.get('stdDev', 2)
    
    # Convert to DataFrame
    df = pd.DataFrame(data)
    
    # Calculate Bollinger Bands
    df['ma'] = df['close'].rolling(window=period).mean()
    df['std'] = df['close'].rolling(window=period).std()
    df['upper_band'] = df['ma'] + (df['std'] * std_dev)
    df['lower_band'] = df['ma'] - (df['std'] * std_dev)
    
    signals = []
    
    for i in range(1, len(df)):
        if pd.isna(df.iloc[i]['upper_band']) or pd.isna(df.iloc[i]['lower_band']):
            signals.append({'type': 'hold', 'index': i})
            continue
        
        current_price = df.iloc[i]['close']
        prev_price = df.iloc[i-1]['close']
        upper_band = df.iloc[i]['upper_band']
        lower_band = df.iloc[i]['lower_band']
        prev_lower_band = df.iloc[i-1]['lower_band']
        prev_upper_band = df.iloc[i-1]['upper_band']
        
        # Price breaks below lower band: buy
        if current_price < lower_band and prev_price >= prev_lower_band:
            signals.append({
                'type': 'buy',
                'index': i,
                'price': current_price,
                'reason': f'Break below lower band ({current_price:.2f} < {lower_band:.2f})'
            })
        # Price breaks above upper band: sell
        elif current_price > upper_band and prev_price <= prev_upper_band:
            signals.append({
                'type': 'sell',
                'index': i,
                'price': current_price,
                'reason': f'Break above upper band ({current_price:.2f} > {upper_band:.2f})'
            })
        else:
            signals.append({'type': 'hold', 'index': i})
    
    return signals`,
        params: {
          period: 20,
          stdDev: 2
        }
      }
    };
  }
}

module.exports = new PythonStrategyEngine();