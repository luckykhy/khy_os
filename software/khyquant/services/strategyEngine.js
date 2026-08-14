/**
 * Strategy Execution Engine (策略适配层 - 执行引擎)
 *
 * Supports three heterogeneous strategy languages:
 *   - JavaScript (VM2 sandbox execution)
 *   - Python (subprocess execution via pythonStrategyEngine)
 *   - TDX formulas (interpreted via tdxFormulaEngine)
 *
 * Uses the Strategy design pattern for runtime engine selection.
 * See thesis Chapter 4.3, Code Block 6 (dual-language execution flow).
 */
const PythonStrategyEngine = require('./pythonStrategyEngine');
const TDXFormulaEngine = require('./tdxFormulaEngine');
const vm = require('vm');

class StrategyEngine {
  constructor() {
    this.strategies = new Map();
    this.pythonEngine = PythonStrategyEngine;
    this.tdxEngine = new TDXFormulaEngine();
  }

  /**
   * 解析策略代码 - 智能检测函数入口
   * @param {string} code - 策略代码
   * @returns {Function} 策略函数
   */
  parseStrategy(code) {
    try {
      // 智能检测可能的策略函数
      const possibleFunctions = this.detectStrategyFunctions(code);
      const callAttempts = this.generateCallAttempts(possibleFunctions);

      // Return a function that executes inside a vm sandbox
      // Wrap in IIFE so top-level `return` statements are valid inside vm.Script
      const wrappedCode = `'use strict'; (function() {\n${code}\n${callAttempts}\n})()`;
      const script = new vm.Script(wrappedCode, { timeout: 10000 });

      return (data, params) => {
        const sandbox = Object.create(null);
        sandbox.data = data;
        sandbox.params = params;
        sandbox.console = { log() {}, warn() {}, error() {} };
        // Wrap every function to cut prototype chain (prevents .constructor.constructor → Function → process escape)
        const w = (fn) => { const f = (...args) => fn(...args); Object.setPrototypeOf(f, null); return f; };
        sandbox.Math = Object.freeze({
          abs: w(Math.abs), ceil: w(Math.ceil), floor: w(Math.floor),
          max: w(Math.max), min: w(Math.min), pow: w(Math.pow),
          round: w(Math.round), sqrt: w(Math.sqrt), log: w(Math.log),
          log2: w(Math.log2), log10: w(Math.log10), exp: w(Math.exp),
          sign: w(Math.sign), trunc: w(Math.trunc), random: w(Math.random),
          PI: Math.PI, E: Math.E,
        });
        sandbox.JSON = Object.freeze({ parse: w(JSON.parse), stringify: w(JSON.stringify) });
        sandbox.Date = Object.freeze({ now: w(Date.now) });
        sandbox.parseInt = w(parseInt);
        sandbox.parseFloat = w(parseFloat);
        sandbox.isNaN = w(isNaN);
        sandbox.isFinite = w(isFinite);
        sandbox.Number = w(Number);
        sandbox.Array = Object.freeze({ isArray: w(Array.isArray), from: w(Array.from), of: w(Array.of) });
        return script.runInNewContext(sandbox, { timeout: 10000 });
      };
    } catch (error) {
      throw new Error(`策略解析失败: ${error.message}`);
    }
  }

  /**
   * 检测策略代码中可能的函数入口点
   */
  detectStrategyFunctions(code) {
    const functions = [];
    
    // 检测函数定义
    const functionRegex = /function\s+(\w+)\s*\([^)]*\)/g;
    let match;
    while ((match = functionRegex.exec(code)) !== null) {
      functions.push({
        name: match[1],
        type: 'function',
        callPattern: `${match[1]}(data, params)`
      });
    }
    
    // 检测箭头函数
    const arrowFunctionRegex = /(?:const|let|var)\s+(\w+)\s*=\s*\([^)]*\)\s*=>/g;
    while ((match = arrowFunctionRegex.exec(code)) !== null) {
      functions.push({
        name: match[1],
        type: 'arrow',
        callPattern: `${match[1]}(data, params)`
      });
    }
    
    // 检测类定义
    const classRegex = /class\s+(\w+)/g;
    while ((match = classRegex.exec(code)) !== null) {
      functions.push({
        name: match[1],
        type: 'class',
        callPattern: `new ${match[1]}().execute(data, params)`,
        altCallPattern: `new ${match[1]}().run(data, params)`
      });
    }
    
    // 检测对象方法
    const objectMethodRegex = /(\w+)\s*:\s*function\s*\([^)]*\)/g;
    while ((match = objectMethodRegex.exec(code)) !== null) {
      functions.push({
        name: match[1],
        type: 'method',
        callPattern: `${match[1]}(data, params)`
      });
    }
    
    return functions;
  }

  /**
   * 生成多种调用尝试的代码
   */
  generateCallAttempts(functions) {
    let attempts = [];
    
    // 优先尝试标准函数名
    const standardNames = ['strategy', 'execute', 'run', 'main', 'trade'];
    for (const name of standardNames) {
      attempts.push(`
        if (typeof ${name} === 'function') {
          return ${name}(data, params);
        }`);
    }
    
    // 尝试检测到的函数
    for (const func of functions) {
      attempts.push(`
        try {
          if (typeof ${func.name} !== 'undefined') {
            return ${func.callPattern};
          }
        } catch (e) { /* ignore */ }`);
      
      // 如果有备选调用模式
      if (func.altCallPattern) {
        attempts.push(`
          try {
            return ${func.altCallPattern};
          } catch (e) { /* ignore */ }`);
      }
    }
    
    // 最后的fallback
    attempts.push(`
      // 如果所有尝试都失败，返回空信号数组
      console.warn('无法找到策略入口点，返回空信号数组');
      return [];
    `);
    
    return attempts.join('\n');
  }

  /**
   * 执行策略（支持JavaScript和Python）
   * @param {string} code - 策略代码
   * @param {Array} data - K线数据
   * @param {Object} params - 策略参数
   * @param {string} language - 策略语言 ('javascript' 或 'python')
   * @returns {Array} 交易信号
   */
  async executeStrategy(code, data, params = {}, language = 'javascript') {
    if (language === 'python') {
      return await this.pythonEngine.executeStrategy(code, data, params);
    } else if (language === 'tdx' || language === 'tongdaxin') {
      return await this.tdxEngine.backtest(code, data, params);
    } else {
      return await this.executeJavaScriptStrategy(code, data, params);
    }
  }

  /**
   * Detect per-bar callback format: code uses `bars` and `i` and returns 'buy'/'sell'/null
   */
  isPerBarFormat(code) {
    // Detect: uses `bars[i]` or `bars[` indexed access + returns 'buy'/'sell'/null string literal
    // Must reference bars with index access to avoid false positives on strategies that merely use variable `i`
    return /\bbars\s*\[/.test(code) && /return\s+['"](?:buy|sell)['"]/.test(code) && !/function\s+\w+\s*\(\s*data/.test(code);
  }

  /**
   * 执行JavaScript策略
   * @param {string} code - 策略代码
   * @param {Array} data - K线数据
   * @param {Object} params - 策略参数
   * @returns {Array} 交易信号
   */
  async executeJavaScriptStrategy(code, data, params = {}) {
    try {
      console.log('执行策略，数据条数:', data.length);
      console.log('策略参数:', params);

      let result;

      if (this.isPerBarFormat(code)) {
        // Per-bar callback strategy (seed strategies) — single pre-created vm context
        console.log('检测到逐bar回调格式，循环执行');
        // Wrap in IIFE so top-level `return` statements are valid inside vm.Script
        const script = new vm.Script(`'use strict'; (function() {\n${code}\n})()`, { timeout: 5000 });
        const sandbox = Object.create(null);
        sandbox.bars = Object.freeze(data.map(d => Object.freeze({ ...d })));
        sandbox.i = 0;
        sandbox.params = Object.freeze({ ...params });
        sandbox.console = { log() {}, warn() {} };
        const w = (fn) => { const f = (...args) => fn(...args); Object.setPrototypeOf(f, null); return f; };
        sandbox.Math = Object.freeze({
          abs: w(Math.abs), ceil: w(Math.ceil), floor: w(Math.floor),
          max: w(Math.max), min: w(Math.min), pow: w(Math.pow),
          round: w(Math.round), sqrt: w(Math.sqrt), log: w(Math.log),
          random: w(Math.random), PI: Math.PI, E: Math.E,
        });
        sandbox.Number = w(Number);
        sandbox.parseInt = w(parseInt);
        sandbox.parseFloat = w(parseFloat);
        sandbox.isNaN = w(isNaN);
        sandbox.isFinite = w(isFinite);
        const ctx = vm.createContext(sandbox);
        const signals = [];
        let barErrors = 0;
        for (let i = 0; i < data.length; i++) {
          try {
            sandbox.i = i;
            const signal = script.runInContext(ctx, { timeout: 1000 });
            if (signal === 'buy' || signal === 'sell') {
              signals.push({
                index: i,
                type: signal,
                price: data[i].close,
                time: data[i].time || data[i].date
              });
            }
          } catch (e) {
            barErrors++;
            if (barErrors <= 3) console.log(`Bar ${i} error:`, e.message);
          }
        }
        if (barErrors > 3) console.log(`... and ${barErrors - 3} more bar errors`);
        console.log('逐bar策略执行完成，信号数:', signals.length);
        result = { signals, auxiliaryData: {} };
      } else {
        const strategyFn = this.parseStrategy(code);
        result = strategyFn(data, params);
      }
      
      console.log('策略返回结果类型:', typeof result);
      console.log('策略返回结果:', result);
      
      let signals = [];
      let auxiliaryData = {};
      
      // 处理不同的返回格式
      if (Array.isArray(result)) {
        // 传统格式：直接返回信号数组
        signals = result;
        auxiliaryData = result.auxiliaryLines || {};
      } else if (result && typeof result === 'object') {
        // 新格式：返回包含signals和auxiliaryData的对象
        signals = result.signals || [];
        auxiliaryData = result.auxiliaryData || {};
        console.log('检测到新格式返回值');
        console.log('信号数量:', signals.length);
        console.log('辅助数据键:', Object.keys(auxiliaryData));
      } else {
        throw new Error('策略必须返回信号数组或包含signals的对象');
      }
      
      if (!Array.isArray(signals)) {
        console.error('信号不是数组:', signals);
        throw new Error('策略必须返回信号数组');
      }
      
      console.log('策略返回信号数:', signals.length);
      
      const validatedSignals = this.validateSignals(signals, data);
      console.log('验证后的信号数:', validatedSignals.length);
      console.log('买入信号:', validatedSignals.filter(s => s.type === 'buy' || s.type === 'open_long').length);
      console.log('卖出信号:', validatedSignals.filter(s => s.type === 'sell' || s.type === 'close_long').length);
      
      // 将辅助数据附加到结果中
      const finalResult = {
        signals: validatedSignals,
        auxiliaryData: auxiliaryData
      };
      
      console.log('最终返回结果:', {
        signalCount: finalResult.signals.length,
        auxiliaryDataKeys: Object.keys(finalResult.auxiliaryData)
      });
      
      return finalResult;
    } catch (error) {
      console.error('策略执行失败:', error);
      console.error('错误堆栈:', error.stack);
      throw error;
    }
  }

  /**
   * 验证交易信号
   */
  validateSignals(signals, data) {
    if (!Array.isArray(signals)) {
      throw new Error('策略必须返回数组');
    }

    // 提取辅助线数据（如果存在）
    const auxiliaryLines = signals.auxiliaryLines || {};

    const validatedSignals = signals.map((signal, index) => {
      if (!signal || typeof signal !== 'object') {
        return null;
      }

      // 🔑 关键修复：确保信号包含时间字段
      const signalIndex = signal.index !== undefined ? signal.index : index;
      const dataPoint = data[signalIndex];
      
      return {
        index: signalIndex,
        type: signal.type || 'hold', // buy, sell, hold, open_long, close_long, open_short, close_short
        price: signal.price || (dataPoint ? dataPoint.close : 0),
        quantity: signal.quantity || 0,
        reason: signal.reason || '',
        // 🔑 关键修复：添加时间字段，支持多种时间格式
        time: signal.time || signal.date || signal.timestamp || (dataPoint ? (dataPoint.time || dataPoint.date || dataPoint.timestamp) : null),
        timestamp: signal.timestamp || (dataPoint ? dataPoint.timestamp : null),
        action: signal.action || (signal.type === 'buy' || signal.type === 'open_long' ? 'buy' : 
                                 signal.type === 'sell' || signal.type === 'close_long' || signal.type === 'close_short' ? 'sell' : 'hold'),
        auxiliaryData: signal.auxiliaryData || null
      };
    }).filter(s => s !== null); // 保留所有有效信号，让前端决定显示哪些

    // 将辅助线数据附加到结果中
    if (Object.keys(auxiliaryLines).length > 0) {
      validatedSignals.auxiliaryLines = auxiliaryLines;
    }

    console.log('🔍 信号验证完成:');
    console.log(`   原始信号数: ${signals.length}`);
    console.log(`   有效交易信号数: ${validatedSignals.length}`);
    
    // 验证时间字段
    const signalsWithTime = validatedSignals.filter(s => s.time);
    console.log(`   包含时间字段的信号: ${signalsWithTime.length}/${validatedSignals.length}`);
    
    if (validatedSignals.length > 0 && signalsWithTime.length === 0) {
      console.warn('⚠️ 警告：所有信号都缺少时间字段，前端可能无法正确显示');
    }

    return validatedSignals;
  }

  /**
   * 回测策略（支持JavaScript和Python）
   * @param {string} code - 策略代码
   * @param {Array} data - K线数据
   * @param {Object} params - 策略参数
   * @param {number} initialCapital - 初始资金
   * @param {string} language - 策略语言 ('javascript', 'python', 'tdx')
   */
  async backtest(code, data, params = {}, initialCapital = 100000, language = 'javascript') {
    if (language === 'python') {
      return await this.pythonEngine.backtest(code, data, params, initialCapital);
    } else if (language === 'tdx' || language === 'tongdaxin') {
      return await this.backtestTDX(code, data, params, initialCapital);
    } else {
      return await this.backtestJavaScript(code, data, params, initialCapital);
    }
  }

  /**
   * 回测通达信公式策略
   * @param {string} code - 通达信公式代码
   * @param {Array} data - K线数据
   * @param {Object} params - 策略参数
   * @param {number} initialCapital - 初始资金
   */
  async backtestTDX(code, data, params = {}, initialCapital = 100000) {
    try {
      console.log('开始回测通达信公式，数据条数:', data.length);
      console.log('初始资金:', initialCapital);
      
      const result = await this.tdxEngine.backtest(code, data, {
        ...params,
        initialCapital
      });
      
      console.log('回测完成，总交易次数:', result.totalTrades);
      console.log('最终资金:', result.finalCapital);
      console.log('总收益率:', result.totalReturn.toFixed(2) + '%');
      
      return result;
    } catch (error) {
      console.error('通达信公式回测失败:', error);
      throw new Error(`通达信公式回测失败: ${error.message}`);
    }
  }

  /**
   * 回测JavaScript策略
   * @param {string} code - 策略代码
   * @param {Array} data - K线数据
   * @param {Object} params - 策略参数
   * @param {number} initialCapital - 初始资金
   */
  async backtestJavaScript(code, data, params = {}, initialCapital = 100000) {
    try {
      console.log('开始回测，数据条数:', data.length);
      console.log('初始资金:', initialCapital);
      
      const result = await this.executeJavaScriptStrategy(code, data, params);
      
      // 🔑 关键修复：正确提取信号数组
      let signals = [];
      if (Array.isArray(result)) {
        // 传统格式：直接返回信号数组
        signals = result;
      } else if (result && typeof result === 'object' && result.signals) {
        // 新格式：返回包含signals的对象
        signals = result.signals;
      } else {
        throw new Error('策略返回格式不正确，无法提取信号数组');
      }
      
      console.log('总信号数:', signals.length);
      const tradeSignals = signals.filter(s => s.type !== 'hold');
      console.log('交易信号数:', tradeSignals.length);
      
      // 🔑 新的回测逻辑：每次交易独立计算，不使用复利
      let capital = initialCapital; // 可用资金（始终从初始资金开始）
      let position = 0; // 当前持仓数量
      let trades = []; // 交易记录
      let equity = [initialCapital]; // 权益曲线
      let buyPrice = 0; // 买入价格
      let buyCost = 0; // 买入总成本（包括手续费）
      let totalProfit = 0; // 累计总盈亏
      
      // 🔑 关键：每次使用固定金额买入，不使用复利
      const FIXED_INVESTMENT = initialCapital * 0.95; // 每次使用初始资金的95%

      for (const signal of signals) {
        const dataPoint = data[signal.index];
        if (!dataPoint) {
          console.warn('信号索引超出数据范围:', signal.index);
          continue;
        }

        // 🔑 修复：支持新的信号类型
        const isBuySignal = signal.type === 'buy' || signal.type === 'open_long';
        const isSellSignal = signal.type === 'sell' || signal.type === 'close_long' || signal.type === 'close_short';

        if (isBuySignal && position === 0) {
          // 买入/开仓 - 🔑 关键：忽略策略建议的数量，使用固定金额计算
          // 策略可能使用凯利公式等动态计算数量，但我们强制使用固定金额
          const quantity = Math.floor(FIXED_INVESTMENT / signal.price);
          
          if (quantity > 0) {
            const cost = quantity * signal.price;
            const commission = cost * 0.0003; // 0.03% 手续费
            buyCost = cost + commission; // 记录总成本
            
            position = quantity;
            buyPrice = signal.price;
            
            // 🔥 记录策略建议的数量（用于对比）
            const suggestedQuantity = signal.quantity || 0;
            
            trades.push({
              type: 'buy',
              price: signal.price,
              quantity,
              suggestedQuantity, // 策略建议的数量
              timestamp: signal.timestamp || signal.time,
              reason: signal.reason,
              commission: commission,
              cost: buyCost
            });
            console.log(`买入: 价格=${signal.price}, 实际数量=${quantity}, 策略建议=${suggestedQuantity}, 成本=${buyCost.toFixed(2)}, 手续费=${commission.toFixed(2)}`);
          }
        } else if (isSellSignal && position > 0) {
          // 卖出/平仓 - 计算本次交易盈亏
          const quantity = position;
          const sellAmount = quantity * signal.price;
          const commission = sellAmount * 0.0003; // 0.03% 手续费
          const stampTax = sellAmount * 0.001; // 0.1% 印花税
          const totalFee = commission + stampTax;
          const netAmount = sellAmount - totalFee; // 卖出净收入
          
          // 🔑 关键：本次交易盈亏 = 卖出净收入 - 买入总成本
          const profit = netAmount - buyCost;
          totalProfit += profit; // 累加到总盈亏
          
          position = 0;
          trades.push({
            type: 'sell',
            price: signal.price,
            quantity,
            timestamp: signal.timestamp || signal.time,
            reason: signal.reason,
            profit: profit,
            commission: commission,
            stampTax: stampTax,
            netAmount: netAmount,
            buyCost: buyCost
          });
          console.log(`卖出: 价格=${signal.price}, 数量=${quantity}, 卖出净收入=${netAmount.toFixed(2)}, 买入成本=${buyCost.toFixed(2)}, 本次盈亏=${profit.toFixed(2)}, 累计盈亏=${totalProfit.toFixed(2)}`);
        }

        // 记录权益曲线（初始资金 + 累计盈亏 + 当前持仓市值）
        const currentEquity = initialCapital + totalProfit + (position > 0 ? position * dataPoint.close - buyCost : 0);
        equity.push(currentEquity);
      }

      // 🔑 计算最终权益：初始资金 + 累计盈亏 + 剩余持仓市值
      let finalEquity = initialCapital + totalProfit;
      if (position > 0) {
        // 如果还有持仓，按最后价格计算市值
        const lastPrice = data[data.length - 1].close;
        const positionValue = position * lastPrice;
        finalEquity = initialCapital + totalProfit + positionValue - buyCost;
      }
      
      const totalReturn = ((finalEquity - initialCapital) / initialCapital * 100).toFixed(2);
      
      // 计算胜率
      const sellTrades = trades.filter(t => t.type === 'sell');
      const winTrades = sellTrades.filter(t => t.profit > 0).length;
      const totalTrades = sellTrades.length;
      const winRate = totalTrades > 0 ? (winTrades / totalTrades * 100).toFixed(2) : 0;

      console.log('回测完成:');
      console.log('- 最终权益:', finalEquity);
      console.log('- 总收益率:', totalReturn + '%');
      console.log('- 交易次数:', totalTrades);
      console.log('- 胜率:', winRate + '%');

      // 🔥 新增：计算每次交易的盈亏明细（用于前端显示加法式子）
      const profitBreakdown = sellTrades.map((trade, index) => ({
        tradeNumber: index + 1,
        profit: trade.profit,
        profitFormatted: trade.profit > 0 ? `+${trade.profit.toFixed(2)}` : trade.profit.toFixed(2)
      }));
      
      // 生成加法式子字符串
      const profitFormula = profitBreakdown.map(item => item.profitFormatted).join(' + ');
      const totalProfitCalculated = profitBreakdown.reduce((sum, item) => sum + item.profit, 0);

      return {
        initialCapital,
        finalEquity: parseFloat(finalEquity.toFixed(2)),
        totalReturn: parseFloat(totalReturn),
        totalTrades,
        winTrades,
        winRate: parseFloat(winRate),
        trades,
        signals: tradeSignals,
        equity,
        // 🔥 新增：盈亏明细
        profitBreakdown: profitBreakdown,
        profitFormula: profitFormula,
        totalProfit: parseFloat(totalProfit.toFixed(2)),
        totalProfitCalculated: parseFloat(totalProfitCalculated.toFixed(2))
      };
    } catch (error) {
      console.error('回测失败:', error);
      console.error('错误堆栈:', error.stack);
      throw error;
    }
  }

  /**
   * 获取内置策略模板（包括JavaScript和Python）
   */
  getTemplates() {
    const jsTemplates = this.getJavaScriptTemplates();
    const pythonTemplates = this.pythonEngine.getTemplates();
    
    return {
      ...jsTemplates,
      ...pythonTemplates
    };
  }

  /**
   * 获取JavaScript策略模板
   */
  getJavaScriptTemplates() {
    return {
      macd: {
        name: 'MACD策略 (JavaScript)',
        description: 'MACD指标交叉策略，基于DIF和DEA线的金叉死叉进行交易',
        language: 'javascript',
        code: `function strategy(data, params) {
  const { fastPeriod = 12, slowPeriod = 26, signalPeriod = 9 } = params;
  const signals = [];
  
  // 计算EMA
  const calculateEMA = (data, period) => {
    const ema = [];
    const multiplier = 2 / (period + 1);
    
    if (data.length === 0) return ema;
    
    // 第一个值使用收盘价
    ema[0] = data[0].close;
    
    // 后续值使用EMA公式
    for (let i = 1; i < data.length; i++) {
      ema[i] = (data[i].close - ema[i - 1]) * multiplier + ema[i - 1];
    }
    
    return ema;
  };
  
  // 计算MACD指标
  const fastEMA = calculateEMA(data, fastPeriod);
  const slowEMA = calculateEMA(data, slowPeriod);
  
  // 计算DIF线 (快线 - 慢线)
  const dif = [];
  for (let i = 0; i < data.length; i++) {
    if (i < slowPeriod - 1) {
      dif.push(null);
    } else {
      dif.push(fastEMA[i] - slowEMA[i]);
    }
  }
  
  // 计算DEA线 (DIF的EMA)
  const dea = [];
  const deaMultiplier = 2 / (signalPeriod + 1);
  
  for (let i = 0; i < dif.length; i++) {
    if (dif[i] === null) {
      dea.push(null);
    } else if (dea.length === 0 || dea[dea.length - 1] === null) {
      dea.push(dif[i]);
    } else {
      dea.push((dif[i] - dea[dea.length - 1]) * deaMultiplier + dea[dea.length - 1]);
    }
  }
  
  // 计算MACD柱状图
  const macd = [];
  for (let i = 0; i < dif.length; i++) {
    if (dif[i] === null || dea[i] === null) {
      macd.push(null);
    } else {
      macd.push((dif[i] - dea[i]) * 2);
    }
  }
  
  // 生成交易信号
  for (let i = 1; i < data.length; i++) {
    if (dif[i] === null || dea[i] === null || dif[i - 1] === null || dea[i - 1] === null) {
      signals.push({ type: 'hold', index: i });
      continue;
    }
    
    // MACD金叉：DIF上穿DEA，买入信号
    if (dif[i - 1] <= dea[i - 1] && dif[i] > dea[i]) {
      signals.push({
        type: 'buy',
        index: i,
        price: data[i].close,
        reason: 'MACD金叉(DIF:' + dif[i].toFixed(4) + ', DEA:' + dea[i].toFixed(4) + ')',
        auxiliaryData: {
          dif: dif[i],
          dea: dea[i],
          macd: macd[i]
        }
      });
    }
    // MACD死叉：DIF下穿DEA，卖出信号
    else if (dif[i - 1] >= dea[i - 1] && dif[i] < dea[i]) {
      signals.push({
        type: 'sell',
        index: i,
        price: data[i].close,
        reason: 'MACD死叉(DIF:' + dif[i].toFixed(4) + ', DEA:' + dea[i].toFixed(4) + ')',
        auxiliaryData: {
          dif: dif[i],
          dea: dea[i],
          macd: macd[i]
        }
      });
    } else {
      signals.push({ 
        type: 'hold', 
        index: i,
        auxiliaryData: {
          dif: dif[i],
          dea: dea[i],
          macd: macd[i]
        }
      });
    }
  }
  
  // 添加辅助线数据用于图表显示
  signals.auxiliaryLines = {
    dif: dif,
    dea: dea,
    macd: macd
  };
  
  return signals;
}`,
        params: {
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9
        }
      },
      ma_cross: {
        name: '双均线策略 (JavaScript)',
        description: '使用JavaScript实现的双均线交叉策略',
        language: 'javascript',
        code: `function strategy(data, params) {
  const { shortPeriod = 5, longPeriod = 10 } = params;
  const signals = [];
  
  // 计算均线
  const calculateMA = (data, period) => {
    const ma = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        ma.push(null);
      } else {
        let sum = 0;
        for (let j = 0; j < period; j++) {
          sum += data[i - j].close;
        }
        ma.push(sum / period);
      }
    }
    return ma;
  };
  
  const shortMA = calculateMA(data, shortPeriod);
  const longMA = calculateMA(data, longPeriod);
  
  // 生成交易信号
  for (let i = 1; i < data.length; i++) {
    if (shortMA[i] === null || longMA[i] === null) {
      signals.push({ type: 'hold', index: i });
      continue;
    }
    
    // 金叉：买入信号
    if (shortMA[i - 1] <= longMA[i - 1] && shortMA[i] > longMA[i]) {
      signals.push({
        type: 'buy',
        index: i,
        price: data[i].close,
        reason: 'MA' + shortPeriod + '上穿MA' + longPeriod
      });
    }
    // 死叉：卖出信号
    else if (shortMA[i - 1] >= longMA[i - 1] && shortMA[i] < longMA[i]) {
      signals.push({
        type: 'sell',
        index: i,
        price: data[i].close,
        reason: 'MA' + shortPeriod + '下穿MA' + longPeriod
      });
    } else {
      signals.push({ type: 'hold', index: i });
    }
  }
  
  return signals;
}`,
        params: {
          shortPeriod: 5,
          longPeriod: 10
        }
      },
      rsi: {
        name: 'RSI策略 (JavaScript)',
        description: 'JavaScript实现的RSI超买超卖策略',
        language: 'javascript',
        code: `function strategy(data, params) {
  const { period = 14, overbought = 65, oversold = 35 } = params;
  const signals = [];
  
  // 计算RSI
  const calculateRSI = (data, period) => {
    const rsi = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period) {
        rsi.push(null);
        continue;
      }
      
      let gains = 0;
      let losses = 0;
      
      for (let j = 0; j < period; j++) {
        const change = data[i - j].close - data[i - j - 1].close;
        if (change > 0) gains += change;
        else losses += Math.abs(change);
      }
      
      const avgGain = gains / period;
      const avgLoss = losses / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi.push(100 - (100 / (1 + rs)));
    }
    return rsi;
  };
  
  const rsi = calculateRSI(data, period);
  
  // 生成交易信号
  for (let i = 1; i < data.length; i++) {
    if (rsi[i] === null) {
      signals.push({ type: 'hold', index: i });
      continue;
    }
    
    // RSI < 30: 超卖，买入
    if (rsi[i] < oversold && rsi[i - 1] >= oversold) {
      signals.push({
        type: 'buy',
        index: i,
        price: data[i].close,
        reason: 'RSI超卖(' + rsi[i].toFixed(2) + ')'
      });
    }
    // RSI > 70: 超买，卖出
    else if (rsi[i] > overbought && rsi[i - 1] <= overbought) {
      signals.push({
        type: 'sell',
        index: i,
        price: data[i].close,
        reason: 'RSI超买(' + rsi[i].toFixed(2) + ')'
      });
    } else {
      signals.push({ type: 'hold', index: i });
    }
  }
  
  return signals;
}`,
        params: {
          period: 14,
          overbought: 65,
          oversold: 35
        }
      }
    };
  }
}

module.exports = new StrategyEngine();
