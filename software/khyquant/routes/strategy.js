/**
 * 策略管理 REST API —— 策略的增删改查及实时执行
 *
 * 架构角色：属于 Express 路由层（接入与路由层），
 *   接收前端 HTTP 请求 → 校验参数 → 委托 strategyEngine 服务处理 → 返回 JSON
 *
 * 设计模式：
 *   - 适配器模式：统一处理 JavaScript / Python / 通达信 三种策略语言
 *   - 白名单校验：ALLOWED_STRATEGY_TYPES / LANGUAGES / STATUS 枚举约束
 *   - Result 类型：parseStrategyParameters 返回 {ok, value, message} 避免抛异常
 *
 * 对应论文：第4.3节（策略适配层），代码块6
 *
 * API 端点一览：
 *   GET    /api/strategies              获取策略列表（分页+筛选）
 *   POST   /api/strategies              创建新策略
 *   GET    /api/strategies/templates     获取策略模板列表
 *   GET    /api/strategies/:id           获取策略详情
 *   PUT    /api/strategies/:id           更新策略
 *   DELETE /api/strategies/:id           删除策略
 *   POST   /api/strategies/:id/execute   执行策略（实时回测）
 *   POST   /api/strategies/:id/backtest  历史回测
 *   POST   /api/strategies/quick-backtest 快速回测（无需保存策略）
 */
const express = require('express');
const router = express.Router();
const { Sequelize } = require('sequelize');
const { Strategy } = require('../models');
const { authMiddleware } = require('../middleware/auth');
const strategyEngine = require('../services/strategyEngine');
const intelligentAdapter = require('../services/intelligentStrategyAdapter');
const mockDataService = require('../services/marketDataService');
const marketDataService = require('../services/marketDataService');
const { Op } = Sequelize;

// 策略类型白名单 —— 只允许这些类型存入数据库
const ALLOWED_STRATEGY_TYPES = new Set([
  'trend',
  'mean_reversion',
  'arbitrage',
  'market_making',
  'other'
]);

// 策略语言白名单 —— 系统支持的三种策略编写语言
const ALLOWED_STRATEGY_LANGUAGES = new Set(['javascript', 'python', 'tdx']);
// 策略状态白名单 —— 策略生命周期的四个阶段
const ALLOWED_STRATEGY_STATUS = new Set(['draft', 'active', 'paused', 'archived']);

/**
 * 解析策略参数 —— 支持 JSON 字符串 / 对象 / null / undefined
 *
 * 采用 Result 类型设计模式（{ok, value, message}），
 * 避免在校验失败时抛出异常，让调用方可以统一用 if(!result.ok) 处理错误。
 *
 * @param {string|object|null|undefined} parameters - 前端传入的策略参数（可能是 JSON 字符串或对象）
 * @returns {{ok: boolean, value?: object, message?: string}} Result 类型
 *   - ok=true 时 value 为解析后的参数对象
 *   - ok=false 时 message 为错误描述
 *
 * 对应论文：第4.3节（策略适配层 — 参数标准化）
 */
function parseStrategyParameters(parameters) {
  if (parameters === undefined) {
    return { ok: true, value: undefined };
  }
  if (parameters === null || parameters === '') {
    return { ok: true, value: {} };
  }
  if (typeof parameters === 'string') {
    try {
      const parsed = JSON.parse(parameters);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, message: 'Strategy parameters must be a JSON object' };
      }
      return { ok: true, value: parsed };
    } catch (error) {
      return { ok: false, message: `Invalid parameters JSON: ${error.message}` };
    }
  }
  if (typeof parameters !== 'object' || Array.isArray(parameters)) {
    return { ok: false, message: 'Strategy parameters must be an object' };
  }
  return { ok: true, value: parameters };
}

/**
 * 标准化策略类型 —— 不在白名单中的类型统一存为 "other"
 *
 * 适配器模式的体现：前端可能传入 "momentum" 等非标准类型，
 * 本函数将其映射为白名单内的合法值，并通过 warning 告知调用方。
 *
 * @param {string|null|undefined} type - 前端传入的策略类型
 * @returns {{value: string|undefined, warning: string|null}}
 *   - value: 标准化后的类型（白名单内的值或 "other"）
 *   - warning: 如果发生了类型转换，则给出提示信息
 *
 * 对应论文：第4.3节（策略适配层 — 类型白名单校验）
 */
function normalizeStrategyType(type) {
  if (type === undefined || type === null || type === '') {
    return { value: undefined, warning: null };
  }
  const normalized = String(type).trim();
  if (ALLOWED_STRATEGY_TYPES.has(normalized)) {
    return { value: normalized, warning: null };
  }
  // Some UIs provide "momentum". Persist as "other" to avoid enum errors.
  if (normalized === 'momentum') {
    return {
      value: 'other',
      warning: 'Type "momentum" is stored as "other" in current backend schema'
    };
  }
  return { value: 'other', warning: `Type "${normalized}" is not supported and was stored as "other"` };
}

/**
 * 标准化策略语言 —— 只允许 javascript / python / tdx 三种
 *
 * 将输入转为小写后与白名单比对；非法语言被忽略并通过 warning 告知。
 * 这是多语言策略适配器模式的入口校验。
 *
 * @param {string|null|undefined} language - 前端传入的策略语言
 * @returns {{value: string|undefined, warning: string|null}}
 *
 * 对应论文：第4.3节（策略适配层 — 多语言支持）
 */
function normalizeStrategyLanguage(language) {
  if (language === undefined || language === null || language === '') {
    return { value: undefined, warning: null };
  }
  const normalized = String(language).trim().toLowerCase();
  if (ALLOWED_STRATEGY_LANGUAGES.has(normalized)) {
    return { value: normalized, warning: null };
  }
  return { value: undefined, warning: `Language "${language}" is invalid and was ignored` };
}

/**
 * 校验策略状态是否在允许范围内
 *
 * 策略生命周期有四个阶段：draft（草稿）→ active（运行中）→ paused（暂停）→ archived（归档）
 * 本函数确保前端传入的 status 必须是其中之一。
 *
 * @param {string|null|undefined} status - 前端传入的策略状态
 * @returns {{ok: boolean, value?: string, message?: string}} Result 类型
 *
 * 对应论文：第4.3节（策略生命周期管理）
 */
function validateStrategyStatus(status) {
  if (status === undefined || status === null || status === '') {
    return { ok: true, value: undefined };
  }
  const normalized = String(status).trim();
  if (!ALLOWED_STRATEGY_STATUS.has(normalized)) {
    return {
      ok: false,
      message: `Invalid strategy status "${normalized}", allowed: ${Array.from(ALLOWED_STRATEGY_STATUS).join(', ')}`
    };
  }
  return { ok: true, value: normalized };
}

/**
 * 校验策略代码语法 —— 根据语言类型做不同层次的静态检查
 *
 * - JavaScript：调用 strategyEngine.parseStrategy() 做 AST 解析
 * - Python：正则检查是否包含 def 或 class 定义
 * - 通达信（TDX）：正则检查是否包含赋值表达式（:= 或 NAME:expr;）
 *
 * 这是适配器模式在代码校验环节的体现：同一个校验入口，
 * 根据 language 参数分发到不同的校验逻辑。
 *
 * @param {string} code - 策略源代码
 * @param {string} language - 策略语言（javascript / python / tdx）
 * @returns {{ok: boolean, message?: string}} Result 类型
 *
 * 对应论文：第4.3节（策略适配层 — 语法预检）
 */
function validateStrategyCode(code, language) {
  if (!code || !String(code).trim()) {
    return { ok: false, message: 'Strategy code cannot be empty' };
  }

  if (language === 'javascript') {
    try {
      strategyEngine.parseStrategy(String(code));
    } catch (error) {
      return {
        ok: false,
        message: `JavaScript strategy syntax error: ${error.message}`
      };
    }
  } else if (language === 'python') {
    const text = String(code);
    if (!/def\s+\w+\s*\(/.test(text) && !/class\s+\w+/.test(text)) {
      return {
        ok: false,
        message: 'Python strategy should define at least one function (def ...) or class'
      };
    }
  } else if (language === 'tdx') {
    const text = String(code);
    // Require TDX assignment (:=) or named output (IDENTIFIER:expression;)
    if (!/:=/.test(text) && !/^[A-Z_]\w*\s*:/m.test(text)) {
      return {
        ok: false,
        message: 'TDX formula should contain at least one assignment (:=) or named output (NAME:expr;) expression'
      };
    }
  }

  return { ok: true };
}

/**
 * POST /api/strategies/analyze —— 智能分析策略代码
 *
 * 调用 intelligentStrategyAdapter 对用户粘贴的代码做自动识别：
 * 检测策略语言（JS/Python/TDX）、策略类型、置信度等。
 * 需要登录认证（authMiddleware）。
 *
 * 对应论文：第4.3节（智能策略识别）
 */
router.post('/analyze', authMiddleware, async (req, res) => {
  try {
    const { code, name = '', description = '' } = req.body;
    
    if (!code || !code.trim()) {
      return res.status(400).json({
        success: false,
        message: '策略代码不能为空'
      });
    }

    console.log('🔍 开始智能分析策略代码...');
    console.log('代码长度:', code.length);
    console.log('策略名称:', name);
    
    // 使用智能适配器分析代码
    const result = intelligentAdapter.intelligentCreateStrategy(code, name, description);
    
    console.log('✅ 智能分析完成');
    console.log('检测语言:', result.analysis.detectedLanguage.language);
    console.log('检测类型:', result.analysis.detectedType.type);
    console.log('置信度:', result.analysis.confidence);
    
    res.json({
      success: true,
      data: result,
      message: '智能分析完成'
    });
  } catch (error) {
    console.error('❌ 智能分析失败:', error);
    res.status(500).json({
      success: false,
      message: '智能分析失败: ' + error.message
    });
  }
});

/**
 * GET /api/strategies/templates —— 获取策略模板列表
 *
 * 返回系统内置的策略模板（MACD、RSI、双均线、KDJ、布林带等），
 * 包含 JS 和通达信两种语言的模板代码及默认参数。
 * 无需认证，前端首页即可展示模板供用户选用。
 *
 * 对应论文：第4.3节（策略模板库）
 */
router.get('/templates', async (req, res) => {
  try {
    console.log('📋 获取策略模板列表');
    
    // 模拟策略模板数据
    const templates = [
      {
        id: 1,
        name: 'MACD动量策略',
        description: '基于MACD指标的金叉死叉交易策略',
        type: 'momentum',
        language: 'javascript',
        codeStyle: 'standard_function',
        code: `// MACD动量策略
function strategy(data, params) {
  const signals = [];
  const fastPeriod = params.fastPeriod || 12;
  const slowPeriod = params.slowPeriod || 26;
  const signalPeriod = params.signalPeriod || 9;

  // 计算EMA
  function calculateEMA(prices, period) {
    const ema = [];
    const multiplier = 2 / (period + 1);
    ema[0] = prices[0];
    for (let i = 1; i < prices.length; i++) {
      ema[i] = (prices[i] * multiplier) + (ema[i - 1] * (1 - multiplier));
    }
    return ema;
  }

  const closePrices = data.map(candle => candle.close);
  const emaFast = calculateEMA(closePrices, fastPeriod);
  const emaSlow = calculateEMA(closePrices, slowPeriod);
  const macdLine = emaFast.map((fast, i) => fast - emaSlow[i]);
  const signalLine = calculateEMA(macdLine, signalPeriod);

  for (let i = slowPeriod; i < data.length; i++) {
    if (macdLine[i] > signalLine[i] && macdLine[i-1] <= signalLine[i-1]) {
      signals.push({
        type: 'buy',
        index: i,
        price: data[i].close,
        reason: 'MACD金叉买入信号'
      });
    } else if (macdLine[i] < signalLine[i] && macdLine[i-1] >= signalLine[i-1]) {
      signals.push({
        type: 'sell',
        index: i,
        price: data[i].close,
        reason: 'MACD死叉卖出信号'
      });
    } else {
      signals.push({type: 'hold', index: i});
    }
  }

  return signals;
}`,
        params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
        tags: ['MACD', '动量', '金叉', '死叉'],
        category: 'technical',
        difficulty: 'intermediate'
      },
      {
        id: 2,
        name: 'RSI超买超卖策略',
        description: '基于RSI指标的超买超卖交易策略',
        type: 'mean_reversion',
        language: 'javascript',
        codeStyle: 'standard_function',
        code: `// RSI超买超卖策略
function strategy(data, params) {
  const signals = [];
  const period = params.period || 14;
  const overbought = params.overbought || 70;
  const oversold = params.oversold || 30;
  
  // 计算RSI
  const gains = [];
  const losses = [];
  
  for (let i = 1; i < data.length; i++) {
    const change = data[i].close - data[i-1].close;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  
  for (let i = period; i < data.length; i++) {
    const avgGain = gains.slice(i - period, i).reduce((a, b) => a + b) / period;
    const avgLoss = losses.slice(i - period, i).reduce((a, b) => a + b) / period;
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    
    if (rsi < oversold) {
      signals.push({
        type: 'buy',
        index: i,
        price: data[i].close,
        reason: \`RSI超卖买入信号 (RSI: \${rsi.toFixed(1)})\`
      });
    } else if (rsi > overbought) {
      signals.push({
        type: 'sell',
        index: i,
        price: data[i].close,
        reason: \`RSI超买卖出信号 (RSI: \${rsi.toFixed(1)})\`
      });
    } else {
      signals.push({type: 'hold', index: i});
    }
  }
  
  return signals;
}`,
        params: { period: 14, overbought: 70, oversold: 30 },
        tags: ['RSI', '超买', '超卖', '均值回归'],
        category: 'technical',
        difficulty: 'beginner'
      },
      {
        id: 3,
        name: '双均线策略',
        description: '基于快慢均线交叉的趋势跟踪策略',
        type: 'trend',
        language: 'javascript',
        codeStyle: 'standard_function',
        code: `// 双均线策略
function strategy(data, params) {
  const signals = [];
  const fastPeriod = params.fastPeriod || 5;
  const slowPeriod = params.slowPeriod || 20;
  
  for (let i = slowPeriod; i < data.length; i++) {
    const fastMA = data.slice(i - fastPeriod, i).reduce((sum, candle) => sum + candle.close, 0) / fastPeriod;
    const slowMA = data.slice(i - slowPeriod, i).reduce((sum, candle) => sum + candle.close, 0) / slowPeriod;
    const prevFastMA = data.slice(i - fastPeriod - 1, i - 1).reduce((sum, candle) => sum + candle.close, 0) / fastPeriod;
    const prevSlowMA = data.slice(i - slowPeriod - 1, i - 1).reduce((sum, candle) => sum + candle.close, 0) / slowPeriod;
    
    if (fastMA > slowMA && prevFastMA <= prevSlowMA) {
      signals.push({
        type: 'buy',
        index: i,
        price: data[i].close,
        reason: '快线上穿慢线买入'
      });
    } else if (fastMA < slowMA && prevFastMA >= prevSlowMA) {
      signals.push({
        type: 'sell',
        index: i,
        price: data[i].close,
        reason: '快线下穿慢线卖出'
      });
    } else {
      signals.push({type: 'hold', index: i});
    }
  }
  
  return signals;
}`,
        params: { fastPeriod: 5, slowPeriod: 20 },
        tags: ['均线', '趋势', '金叉', '死叉'],
        category: 'technical',
        difficulty: 'beginner'
      },
      {
        id: 4,
        name: '双均线交叉策略',
        description: '基于快慢均线金叉死叉的趋势跟踪策略',
        type: 'tdx_ma_cross',
        language: 'tdx',
        codeStyle: 'tdx_formula',
        code: `// 双均线交叉策略
MA5:=MA(CLOSE,5);
MA20:=MA(CLOSE,20);

// 金叉买入
多入:CROSS(MA5,MA20);

// 死叉卖出
空出:CROSS(MA20,MA5);`,
        params: { 
          shortPeriod: 5, 
          longPeriod: 20 
        },
        parameters: { 
          shortPeriod: 5, 
          longPeriod: 20 
        },
        tags: ['通达信', '均线', '金叉', '死叉'],
        category: 'tdx',
        difficulty: 'beginner'
      },
      {
        id: 5,
        name: 'KDJ指标策略',
        description: '基于KDJ指标的超买超卖交易策略',
        type: 'tdx_kdj',
        language: 'tdx',
        codeStyle: 'tdx_formula',
        code: `// KDJ指标策略
N:=9;
M1:=3;
M2:=3;

RSV:=(CLOSE-LLV(LOW,N))/(HHV(HIGH,N)-LLV(LOW,N))*100;
K:=SMA(RSV,M1,1);
D:=SMA(K,M2,1);
J:=3*K-2*D;

// 超卖买入
多入:CROSS(J,20);

// 超买卖出
空出:CROSS(80,J);`,
        params: { 
          N: 9, 
          M1: 3, 
          M2: 3,
          oversold: 20,
          overbought: 80
        },
        parameters: { 
          N: 9, 
          M1: 3, 
          M2: 3,
          oversold: 20,
          overbought: 80
        },
        tags: ['通达信', 'KDJ', '超买', '超卖'],
        category: 'tdx',
        difficulty: 'beginner'
      },
      {
        id: 6,
        name: '布林带策略',
        description: '基于布林带上下轨突破的交易策略',
        type: 'tdx_boll',
        language: 'tdx',
        codeStyle: 'tdx_formula',
        code: `// 布林带策略
N:=20;
P:=2;

MID:=MA(CLOSE,N);
UPPER:=MID+P*STD(CLOSE,N);
LOWER:=MID-P*STD(CLOSE,N);

// 突破下轨买入
多入:CROSS(CLOSE,LOWER);

// 突破上轨卖出
空出:CROSS(CLOSE,UPPER);`,
        params: { 
          N: 20, 
          P: 2 
        },
        parameters: { 
          N: 20, 
          P: 2 
        },
        tags: ['通达信', '布林带', '突破'],
        category: 'tdx',
        difficulty: 'intermediate'
      }
    ];
    
    // 🔥 调试：输出ID 4-6的params
    console.log('🔍 模板ID 4-6的params:');
    templates.filter(t => [4,5,6].includes(t.id)).forEach(t => {
      console.log(`  ID ${t.id}: params=`, JSON.stringify(t.params), ', parameters=', JSON.stringify(t.parameters));
    });
    
    // 🔥 强制设置params（临时测试）
    templates.forEach(t => {
      if (t.id === 4 && (!t.params || Object.keys(t.params).length === 0)) {
        console.log('⚠️ ID 4的params为空，强制设置');
        t.params = { shortPeriod: 5, longPeriod: 20 };
        t.parameters = { shortPeriod: 5, longPeriod: 20 };
      }
      if (t.id === 5 && (!t.params || Object.keys(t.params).length === 0)) {
        console.log('⚠️ ID 5的params为空，强制设置');
        t.params = { N: 9, M1: 3, M2: 3, oversold: 20, overbought: 80 };
        t.parameters = { N: 9, M1: 3, M2: 3, oversold: 20, overbought: 80 };
      }
      if (t.id === 6 && (!t.params || Object.keys(t.params).length === 0)) {
        console.log('⚠️ ID 6的params为空，强制设置');
        t.params = { N: 20, P: 2 };
        t.parameters = { N: 20, P: 2 };
      }
    });
    
    res.json({
      success: true,
      data: templates,
      message: '策略模板获取成功'
    });
    
  } catch (error) {
    console.error('❌ 获取策略模板失败:', error);
    res.status(500).json({
      success: false,
      message: '获取策略模板失败: ' + error.message
    });
  }
});

/**
 * POST /api/strategies/recommend —— 策略推荐
 *
 * 根据用户持有的策略和指定标的，调用 strategyRecommender 服务
 * 进行智能策略推荐。支持 AI 增强推荐模式。
 * 无需认证，本地模式下也可使用。
 *
 * 对应论文：第4.4节（策略推荐引擎）
 */
router.post('/recommend', authMiddleware, async (req, res) => {
  try {
    const { symbol = 'sh000300', strategies = [], useAI = false, limit = 10 } = req.body;
    const recommender = require('../services/strategyRecommender');

    // If no strategies provided, load all from DB (deduplicated by normalized name)
    const NAME_ALIASES = {
      'rsi反转策略': 'rsi_reversal', 'rsireversal': 'rsi_reversal',
      'macd动量策略': 'macd_momentum', 'macdmomentum': 'macd_momentum',
      '均线交叉策略': 'ma_crossover', 'macrossover': 'ma_crossover',
      '指数趋势跟踪（均线交叉）': 'ma_crossover',
      'rsi均值回归策略': 'rsi_reversal', 'rsi超买超卖策略': 'rsi_reversal',
      '突破趋势策略': 'trend_breakout', 'trendbreakout': 'trend_breakout',
      '期货价差套利策略': 'futures_spread',
    };
    function dedup(name) {
      const lower = (name || '').toLowerCase().replace(/[\s\-_（）()]/g, '');
      return NAME_ALIASES[lower] || lower;
    }

    let input = strategies;
    if (input.length === 0) {
      const dbStrategies = await Strategy.findAll({ where: { status: ['active', 'draft'] }, raw: true });
      const seen = new Set();
      input = [];
      for (const s of dbStrategies) {
        const key = dedup(s.name);
        if (seen.has(key)) continue;
        seen.add(key);
        input.push({
          id: s.id,
          name: s.name,
          type: s.type,
          language: s.language || 'javascript',
          code: s.code,
          parameters: typeof s.parameters === 'string' ? JSON.parse(s.parameters) : (s.parameters || {}),
          isUserStrategy: true,
        });
      }
    }

    const recommendations = await recommender.recommend(input, symbol, { useAI, limit });
    res.json({ success: true, data: { recommendations, symbol } });
  } catch (error) {
    console.error('Strategy recommendation failed:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/strategies/:strategyType/execute —— 按策略类型执行策略
 *
 * 支持按模板名称（momentum-macd、trend-ma 等）或数据库 ID 执行策略。
 * 自动获取/生成 K 线数据，调用 strategyEngine 执行后返回交易信号。
 * 需要登录认证（authMiddleware），防止未授权代码执行。
 *
 * 对应论文：第4.3节（策略执行流程）
 */
router.post('/:strategyType/execute', authMiddleware, async (req, res) => {
  try {
    const { strategyType } = req.params;
    const { symbol = 'sh000300', startDate, endDate } = req.body;

    console.log('🚀 执行策略类型:', strategyType, '标的:', symbol);
    console.log('📝 strategyType类型:', typeof strategyType, '是否为数字:', /^\d+$/.test(strategyType));

    // 🔥 首先定义策略模板（必须在使用前定义）
    const strategyTemplates = {
      'momentum-macd': {
        name: 'MACD动量策略',
        type: 'momentum',
        code: `// MACD动量策略
function strategy(data, params) {
  const signals = [];
  const fastPeriod = params.fastPeriod || 12;
  const slowPeriod = params.slowPeriod || 26;
  const signalPeriod = params.signalPeriod || 9;

  // 计算EMA
  function calculateEMA(prices, period) {
    const ema = [];
    const multiplier = 2 / (period + 1);
    ema[0] = prices[0];
    for (let i = 1; i < prices.length; i++) {
      ema[i] = (prices[i] * multiplier) + (ema[i - 1] * (1 - multiplier));
    }
    return ema;
  }

  const closePrices = data.map(candle => candle.close);
  const emaFast = calculateEMA(closePrices, fastPeriod);
  const emaSlow = calculateEMA(closePrices, slowPeriod);
  const macdLine = emaFast.map((fast, i) => fast - emaSlow[i]);
  const signalLine = calculateEMA(macdLine, signalPeriod);

  for (let i = slowPeriod; i < data.length; i++) {
    if (macdLine[i] > signalLine[i] && macdLine[i-1] <= signalLine[i-1]) {
      signals.push({
        type: 'buy',
        index: i,
        price: data[i].close,
        time: data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400,
        timestamp: (data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400) * 1000,
        reason: 'MACD金叉买入信号'
      });
    } else if (macdLine[i] < signalLine[i] && macdLine[i-1] >= signalLine[i-1]) {
      signals.push({
        type: 'sell',
        index: i,
        price: data[i].close,
        time: data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400,
        timestamp: (data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400) * 1000,
        reason: 'MACD死叉卖出信号'
      });
    }
  }

  return signals;
}`,
        parameters: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }
      },
      'trend-ma': {
        name: '指数趋势跟踪策略',
        type: 'trend',
        code: `// 指数趋势跟踪策略
function strategy(data, params) {
  const signals = [];
  const shortPeriod = params.shortPeriod || 5;
  const longPeriod = params.longPeriod || 20;
  
  for (let i = longPeriod; i < data.length; i++) {
    const shortMA = data.slice(i - shortPeriod, i).reduce((sum, candle) => sum + candle.close, 0) / shortPeriod;
    const longMA = data.slice(i - longPeriod, i).reduce((sum, candle) => sum + candle.close, 0) / longPeriod;
    const prevShortMA = data.slice(i - shortPeriod - 1, i - 1).reduce((sum, candle) => sum + candle.close, 0) / shortPeriod;
    const prevLongMA = data.slice(i - longPeriod - 1, i - 1).reduce((sum, candle) => sum + candle.close, 0) / longPeriod;

    if (shortMA > longMA && prevShortMA <= prevLongMA) {
      signals.push({
        type: 'buy',
        index: i,
        price: data[i].close,
        time: data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400,
        timestamp: (data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400) * 1000,
        reason: '趋势金叉买入信号'
      });
    } else if (shortMA < longMA && prevShortMA >= prevLongMA) {
      signals.push({
        type: 'sell',
        index: i,
        price: data[i].close,
        time: data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400,
        timestamp: (data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400) * 1000,
        reason: '趋势死叉卖出信号'
      });
    }
  }
  
  return signals;
}`,
        parameters: { shortPeriod: 5, longPeriod: 20 }
      },
      'mean-reversion-rsi': {
        name: 'RSI超买超卖策略',
        type: 'mean_reversion',
        code: `// RSI超买超卖策略
function strategy(data, params) {
  const signals = [];
  const period = params.period || 14;
  const overbought = params.overbought || 70;
  const oversold = params.oversold || 30;
  
  // 计算RSI
  const gains = [];
  const losses = [];
  
  for (let i = 1; i < data.length; i++) {
    const change = data[i].close - data[i-1].close;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  
  for (let i = period; i < data.length; i++) {
    const avgGain = gains.slice(i - period, i).reduce((a, b) => a + b) / period;
    const avgLoss = losses.slice(i - period, i).reduce((a, b) => a + b) / period;
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    
    if (rsi < oversold) {
      signals.push({
        type: 'buy',
        index: i,
        price: data[i].close,
        time: data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400,
        timestamp: (data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400) * 1000,
        reason: \`RSI超卖买入信号 (RSI: \${rsi.toFixed(1)})\`
      });
    } else if (rsi > overbought) {
      signals.push({
        type: 'sell',
        index: i,
        price: data[i].close,
        time: data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400,
        timestamp: (data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400) * 1000,
        reason: \`RSI超买卖出信号 (RSI: \${rsi.toFixed(1)})\`
      });
    }
  }
  
  return signals;
}`,
        parameters: { period: 14, overbought: 70, oversold: 30 }
      }
    };

    // 🔥 现在使用strategyTemplates
    let strategyCode, strategyName, strategyParams, strategyType_actual;

    // 如果是数字ID，从数据库查询策略
    if (/^\d+$/.test(strategyType)) {
      console.log('🔍 检测到数字ID，从数据库查询策略...');
      const strategy = await Strategy.findByPk(strategyType);
      
      if (strategy && strategy.code) {
        console.log('✅ 找到数据库策略:', strategy.name);
        strategyCode = strategy.code;
        strategyName = strategy.name;
        strategyParams = strategy.parameters || {};
        strategyType_actual = strategy.type || 'custom';
      } else {
        console.warn('⚠️ 未找到ID为', strategyType, '的策略，使用默认模板');
        // 使用默认模板
        const template = strategyTemplates['momentum-macd'];
        strategyCode = template.code;
        strategyName = template.name;
        strategyParams = template.parameters;
        strategyType_actual = template.type;
      }
    } else {
      // 使用策略模板
      console.log('📋 使用策略模板:', strategyType);
      
      // 🔥 策略类型映射（处理简写和别名）
      const strategyTypeMap = {
        'trend': 'trend-ma',
        'momentum': 'momentum-macd',
        'mean-reversion': 'mean-reversion-rsi',
        'mean_reversion': 'mean-reversion-rsi'
      };
      
      // 如果是简写，转换为完整的策略类型
      const actualStrategyType = strategyTypeMap[strategyType] || strategyType;
      const template = strategyTemplates[actualStrategyType] || strategyTemplates['momentum-macd'];
      
      if (!strategyTemplates[actualStrategyType]) {
        console.warn(`⚠️ 策略类型 "${strategyType}" (映射为 "${actualStrategyType}") 不存在，使用默认的 momentum-macd`);
      }
      
      strategyCode = template.code;
      strategyName = template.name;
      strategyParams = template.parameters;
      strategyType_actual = template.type;
    }
    
    console.log('✅ 策略选择完成:', {
      name: strategyName,
      type: strategyType_actual,
      hasCode: !!strategyCode,
      paramsCount: Object.keys(strategyParams).length
    });
    
    // 生成模拟K线数据
    const klineData = mockDataService.generateMockKLineData(symbol, 60);
    
    console.log('📊 生成K线数据:', klineData.length, '条');
    
    // 执行策略
    const result = await strategyEngine.executeStrategy(
      strategyCode,
      klineData,
      strategyParams,
      'javascript'
    );

    let signals = [];
    let auxiliaryData = {};
    
    if (Array.isArray(result)) {
      signals = result.filter(s => s.type !== 'hold');
    } else if (result && result.signals) {
      signals = result.signals.filter(s => s.type !== 'hold');
      auxiliaryData = result.auxiliaryData || {};
    }

    console.log('✅ 策略执行完成，生成信号:', signals.length, '个');
    console.log('📊 辅助数据:', Object.keys(auxiliaryData).length, '条');

    res.json({
      success: true,
      data: {
        strategy: {
          name: strategyName,
          type: strategyType_actual
        },
        symbol,
        signals,
        auxiliaryData
      }
    });
  } catch (error) {
    console.error('❌ 执行策略失败:', error);
    console.error('错误详情:', {
      message: error.message,
      stack: error.stack,
      strategyType,
      symbol
    });
    res.status(500).json({
      success: false,
      message: '执行策略失败: ' + error.message,
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * POST /api/strategies/execute-sandbox —— 沙箱执行任意策略代码
 *
 * 接受前端传入的任意代码和 K 线数据，在服务端 VM 沙箱中安全执行。
 * 替代前端 new Function() 的不安全做法，限制代码大小（100KB）和数据量（5000根K线）。
 * 需要登录认证（authMiddleware）。
 *
 * 设计模式：沙箱模式（隔离执行环境，防止恶意代码）
 * 对应论文：第4.3节（安全沙箱执行）
 */
router.post('/execute-sandbox', authMiddleware, async (req, res) => {
  try {
    const { code, klineData, parameters = {}, language = 'javascript' } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, message: 'Missing strategy code' });
    }
    if (!Array.isArray(klineData) || klineData.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing or empty klineData' });
    }
    if (!ALLOWED_STRATEGY_LANGUAGES.has(language)) {
      return res.status(400).json({ success: false, message: `Invalid language: ${language}` });
    }
    if (code.length > 100000) {
      return res.status(400).json({ success: false, message: 'Code too large (max 100KB)' });
    }

    // Limit payload size: max 5000 bars to avoid memory abuse
    const data = klineData.slice(0, 5000);

    const result = await strategyEngine.executeStrategy(code, data, parameters, language);

    let signals = [];
    let auxiliaryData = {};
    if (Array.isArray(result)) {
      signals = result.filter(s => s && s.type !== 'hold');
    } else if (result && result.signals) {
      signals = (result.signals || []).filter(s => s && s.type !== 'hold');
      auxiliaryData = result.auxiliaryData || {};
    }

    res.json({ success: true, data: { signals, auxiliaryData } });
  } catch (error) {
    console.error('Sandbox execution failed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Strategy execution failed: ' + error.message
    });
  }
});

/**
 * POST /api/strategies/:id/backtest —— 历史回测
 *
 * 根据策略 ID 从数据库加载策略代码，获取指定标的的历史 K 线数据，
 * 调用 strategyEngine.backtest() 进行完整回测，返回收益率、胜率等指标。
 * 数据不足时自动回退到模拟数据。需要登录认证并校验策略所有权。
 *
 * 对应论文：第4.4节（回测引擎）
 */
router.post('/:id/backtest', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { symbol, startDate, endDate, initialCapital = 100000 } = req.body;

    console.log('回测请求参数:', { id, symbol, startDate, endDate, initialCapital });

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: '请指定交易标的'
      });
    }

    const strategy = await Strategy.findByPk(id);
    if (!strategy) {
      return res.status(404).json({
        success: false,
        message: '策略不存在'
      });
    }

    console.log('策略信息:', {
      id: strategy.id,
      name: strategy.name,
      parameters: strategy.parameters
    });

    // 检查权限
    if (strategy.user_id !== req.user.id && !strategy.isPublic) {
      return res.status(403).json({
        success: false,
        message: '无权访问该策略'
      });
    }

    // 获取K线数据
    let klineData = await marketDataService.getKLineData(symbol, startDate, endDate, 500);
    
    console.log('从数据库获取的K线数据条数:', klineData ? klineData.length : 0);
    
    // 如果数据不足（少于50条），生成模拟数据
    if (!klineData || klineData.length < 50) {
      console.log(`数据不足（${klineData ? klineData.length : 0}条），生成模拟数据...`);
      try {
        klineData = mockDataService.generateMockKLineData(symbol, 100);
        console.log('生成了模拟数据:', klineData.length, '条');
        
        // 验证生成的数据格式
        if (klineData && klineData.length > 0) {
          console.log('模拟数据样本:', {
            open: klineData[0].open,
            high: klineData[0].high,
            low: klineData[0].low,
            close: klineData[0].close,
            volume: klineData[0].volume
          });
        }
      } catch (error) {
        console.error('生成模拟数据失败:', error);
        throw new Error('无法获取足够的K线数据进行回测');
      }
    } else {
      // 转换数据库字段名为策略引擎期望的字段名
      klineData = klineData.map(item => ({
        date: item.timestamp ? new Date(item.timestamp).toISOString().split('T')[0] : null, // 从timestamp生成date
        time: item.timestamp ? new Date(item.timestamp).toISOString().split('T')[0] : null, // 从timestamp生成time
        timestamp: item.timestamp,
        open: parseFloat(item.open_price),
        high: parseFloat(item.high_price),
        low: parseFloat(item.low_price),
        close: parseFloat(item.close_price),
        close_price: parseFloat(item.close_price), // 保留原字段名供策略使用
        volume: parseInt(item.volume)
      }));
      console.log('转换了数据库数据字段名，数据条数:', klineData.length);
      console.log('转换后的数据样本:', klineData[0]);
    }

    // 执行回测
    console.log('开始执行回测...');
    const result = await strategyEngine.backtest(
      strategy.code,
      klineData,
      strategy.parameters,
      initialCapital,
      strategy.language || 'javascript'
    );

    console.log('回测完成，结果:', {
      totalTrades: result.totalTrades,
      totalReturn: result.totalReturn,
      winRate: result.winRate
    });

    res.json({
      success: true,
      data: {
        strategy: {
          id: strategy.id,
          name: strategy.name
        },
        symbol,
        ...result
      }
    });
  } catch (error) {
    console.error('回测策略错误:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({
      success: false,
      message: '回测失败',
      error: error.message
    });
  }
});

/**
 * POST /api/strategies/execute —— 执行策略（无 ID 版本，strategyId 在 body 中）
 *
 * 从请求体中获取 strategyId 和 K 线数据，执行策略并返回交易信号。
 * 需要登录认证，且只能执行自己拥有的策略。
 *
 * 对应论文：第4.3节（策略执行流程）
 */
router.post('/execute', authMiddleware, async (req, res) => {
  try {
    const { strategyId, klineData } = req.body;

    if (!strategyId) {
      return res.status(400).json({ success: false, message: '请指定策略ID' });
    }

    const strategy = await Strategy.findByPk(strategyId);
    if (!strategy || strategy.user_id !== req.user.id) {
      return res.status(404).json({ success: false, message: '策略不存在或无权访问' });
    }

    // 使用传入的K线数据或空数组
    const data = Array.isArray(klineData) ? klineData : [];

    try {
      const result = await strategyEngine.executeStrategy(strategy, data);
      return res.json({ success: true, data: result });
    } catch (execError) {
      return res.status(500).json({ success: false, message: execError.message || '策略执行失败' });
    }
  } catch (error) {
    console.error('策略执行错误:', error);
    res.status(500).json({ success: false, message: '策略执行失败', error: error.message });
  }
});

/**
 * POST /api/strategies/:id/execute —— 执行策略（获取交易信号）
 *
 * 通过策略 ID（数据库记录）或策略模板名称（内置模板）执行策略。
 * 支持 JS/Python/TDX 三种语言的策略模板，包含浮沉轨道等高级策略。
 * 自动获取 K 线数据并转换字段格式，返回买卖信号和辅助数据。
 * 需要登录认证并校验策略所有权。
 *
 * 设计模式：适配器模式（根据策略语言分发到不同执行引擎）
 * 对应论文：第4.3节（策略执行流程）、第4.4节（多语言策略适配）
 */
router.post('/:id/execute', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { symbol, startDate, endDate } = req.body;

    console.log('执行策略请求参数:', { id, symbol, startDate, endDate });

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: '请指定交易标的'
      });
    }

    // 🔥 如果id不是数字，说明是策略类型（trend/momentum等），使用策略模板
    let strategy;
    if (/^\d+$/.test(id)) {
      // 数字ID - 从数据库查询
      strategy = await Strategy.findByPk(id);
      if (!strategy) {
        return res.status(404).json({
          success: false,
          message: '策略不存在'
        });
      }
      
      // 检查权限
      if (strategy.user_id !== req.user.id && !strategy.isPublic) {
        return res.status(403).json({
          success: false,
          message: '无权访问该策略'
        });
      }
    } else {
      // 字符串类型 - 使用内置策略模板
      console.log('🔍 使用内置策略模板:', id);
      
      // 策略模板定义
      const strategyTemplates = {
        'momentum': {
          name: 'MACD动量策略',
          type: 'momentum',
          code: `function strategy(data, params) {
            const signals = [];
            const fastPeriod = params.fastPeriod || 12;
            const slowPeriod = params.slowPeriod || 26;
            const signalPeriod = params.signalPeriod || 9;
            
            function calculateEMA(prices, period) {
              const ema = [];
              const multiplier = 2 / (period + 1);
              ema[0] = prices[0];
              for (let i = 1; i < prices.length; i++) {
                ema[i] = (prices[i] * multiplier) + (ema[i - 1] * (1 - multiplier));
              }
              return ema;
            }
            
            const closePrices = data.map(candle => candle.close);
            const emaFast = calculateEMA(closePrices, fastPeriod);
            const emaSlow = calculateEMA(closePrices, slowPeriod);
            const macdLine = emaFast.map((fast, i) => fast - emaSlow[i]);
            const signalLine = calculateEMA(macdLine, signalPeriod);
            
            for (let i = slowPeriod; i < data.length; i++) {
              if (macdLine[i] > signalLine[i] && macdLine[i-1] <= signalLine[i-1]) {
                signals.push({
                  type: 'buy',
                  index: i,
                  price: data[i].close,
                  time: data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400,
                  timestamp: (data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400) * 1000,
                  reason: 'MACD金叉买入信号'
                });
              } else if (macdLine[i] < signalLine[i] && macdLine[i-1] >= signalLine[i-1]) {
                signals.push({
                  type: 'sell',
                  index: i,
                  price: data[i].close,
                  time: data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400,
                  timestamp: (data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400) * 1000,
                  reason: 'MACD死叉卖出信号'
                });
              }
            }
            return signals;
          }`,
          parameters: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }
        },
        'float_sink': {
          name: '浮沉轨道等阻时空双向策略',
          type: 'trend',
          code: `function strategy(data, params) {
            // Float-Sink Space-Time Equal-Resistance Track Bilateral Strategy
            // Ported from WenHua WH6 formula language
            var BOX = params.box || 40;
            var KCHENG = params.kcheng || 200;
            var MULTIPLIER = params.multiplier || 10;
            var n = data.length;
            if (n < BOX + 10) return [];

            var high = data.map(function(d){ return d.high; });
            var low  = data.map(function(d){ return d.low; });
            var close = data.map(function(d){ return d.close; });

            // SUMBARS: count bars backward from i until cumulative sum >= target
            function sumbars(arr, idx, target) {
              var acc = 0, bars = 0;
              for (var j = idx; j >= 0; j--) { acc += arr[j]; bars++; if (acc >= target) break; }
              return bars;
            }

            // Wave amplitude
            var waveHigh = new Array(n);
            var waveLow  = new Array(n);
            for (var i = 0; i < n; i++) {
              var hhvC2 = i > 0 ? Math.max(close[i], close[i-1]) : close[i];
              var llvC2 = i > 0 ? Math.min(close[i], close[i-1]) : close[i];
              waveHigh[i] = Math.max(high[i], hhvC2);
              waveLow[i]  = Math.min(low[i], llvC2);
            }
            var waveDist = waveHigh.map(function(wh, i){ return wh - waveLow[i]; });

            // Float-Sink journey & track period
            var fsJourney = new Array(n);
            for (var i = 0; i < n; i++) {
              var start = Math.max(0, i - BOX + 1);
              var hhvDist = 0;
              for (var j = start; j <= i; j++) { if (waveDist[j] > hhvDist) hhvDist = waveDist[j]; }
              fsJourney[i] = Math.max(KCHENG / MULTIPLIER, hhvDist);
            }

            var timeFS = new Array(n);
            for (var i = 0; i < n; i++) {
              var bars = Math.min(sumbars(waveDist, i, fsJourney[i]), i + 1);
              timeFS[i] = Math.max(1, bars);
            }

            // Float and Sink tracks
            var floatTrack = new Array(n);
            var sinkTrack  = new Array(n);
            for (var i = 0; i < n; i++) {
              var period = timeFS[i];
              var start = Math.max(0, i - period + 1);
              if (i === 0) {
                floatTrack[i] = waveHigh[i] + KCHENG / MULTIPLIER / 2;
                sinkTrack[i]  = waveLow[i]  - KCHENG / MULTIPLIER / 2;
              } else {
                var maxWH = waveHigh[start];
                var minWL = waveLow[start];
                for (var j = start + 1; j <= i; j++) {
                  if (waveHigh[j] > maxWH) maxWH = waveHigh[j];
                  if (waveLow[j]  < minWL) minWL = waveLow[j];
                }
                floatTrack[i] = maxWH;
                sinkTrack[i]  = minWL;
              }
            }

            // LLV(float,2) and HHV(sink,2)
            var llvFloat2 = new Array(n);
            var hhvSink2  = new Array(n);
            for (var i = 0; i < n; i++) {
              llvFloat2[i] = i > 0 ? Math.min(floatTrack[i], floatTrack[i-1]) : floatTrack[i];
              hhvSink2[i]  = i > 0 ? Math.max(sinkTrack[i],  sinkTrack[i-1])  : sinkTrack[i];
            }

            // Dual-expansion flag
            var fsDual = new Array(n);
            for (var i = 0; i < n; i++) {
              fsDual[i] = (high[i] > llvFloat2[i]) && (low[i] < hhvSink2[i]);
            }

            // BARSLAST(fsDual == false)
            var barslastND = new Array(n);
            for (var i = 0; i < n; i++) {
              barslastND[i] = (!fsDual[i] || i === 0) ? 0 : barslastND[i-1] + 1;
            }

            // Direction periods
            var floatDirP = new Array(n).fill(0);
            var sinkDirP  = new Array(n).fill(0);
            for (var i = 1; i < n; i++) {
              floatDirP[i] = (high[i] > llvFloat2[i] && !fsDual[i]) ? 0 : floatDirP[i-1] + 1;
              sinkDirP[i]  = (low[i] < hhvSink2[i] && !fsDual[i])  ? 0 : sinkDirP[i-1]  + 1;
            }

            // Float-rise and Sink-fall base signals
            var floatRise = new Array(n).fill(false);
            var sinkFall  = new Array(n).fill(false);
            for (var i = 0; i < n; i++) {
              if (high[i] > llvFloat2[i]) {
                if (fsDual[i]) {
                  var exp = floatDirP[i] > sinkDirP[i] ? 1 : 0;
                  floatRise[i] = (barslastND[i] % 2) === exp;
                } else { floatRise[i] = true; }
              }
              if (low[i] < hhvSink2[i]) {
                if (fsDual[i]) {
                  var exp = floatDirP[i] < sinkDirP[i] ? 1 : 0;
                  sinkFall[i] = (barslastND[i] % 2) === exp;
                } else { sinkFall[i] = true; }
              }
            }

            // First-occurrence filter (浮升 / 沉降)
            var barslastSF = new Array(n);
            var barslastFR = new Array(n);
            for (var i = 0; i < n; i++) {
              barslastSF[i] = (i === 0 || sinkFall[i])  ? 0 : barslastSF[i-1] + 1;
              barslastFR[i] = (i === 0 || floatRise[i])  ? 0 : barslastFR[i-1] + 1;
            }
            var floatLong  = new Array(n).fill(false);
            var sinkShort  = new Array(n).fill(false);
            for (var i = 0; i < n; i++) {
              if (floatRise[i]) {
                var lb = barslastSF[i] > 0 ? barslastSF[i] : i + 1;
                var si = Math.max(0, i - lb);
                var cnt = 0;
                for (var j = si; j <= i; j++) { if (floatRise[j]) cnt++; }
                if (cnt === 1) floatLong[i] = true;
              }
              if (sinkFall[i]) {
                var lb = barslastFR[i] > 0 ? barslastFR[i] : i + 1;
                var si = Math.max(0, i - lb);
                var cnt = 0;
                for (var j = si; j <= i; j++) { if (sinkFall[j]) cnt++; }
                if (cnt === 1) sinkShort[i] = true;
              }
            }

            // Generate buy/sell signals
            var signals = [];
            for (var i = 0; i < n; i++) {
              var t = data[i].time || Math.floor(Date.now() / 1000) - (n - i) * 86400;
              if (floatLong[i]) {
                signals.push({
                  type: 'buy', index: i, price: data[i].close,
                  time: t, timestamp: t * 1000,
                  reason: '浮升突破 — 多头入场 (浮轨=' + floatTrack[i].toFixed(2) + ')'
                });
              }
              if (sinkShort[i]) {
                signals.push({
                  type: 'sell', index: i, price: data[i].close,
                  time: t, timestamp: t * 1000,
                  reason: '沉降跌破 — 空头入场 (沉轨=' + sinkTrack[i].toFixed(2) + ')'
                });
              }
            }

            // Attach auxiliary lines for chart overlay
            return {
              signals: signals,
              auxiliaryData: {
                floatTrack: data.map(function(d, i){ return { time: d.time || d.date, value: floatTrack[i] }; }),
                sinkTrack:  data.map(function(d, i){ return { time: d.time || d.date, value: sinkTrack[i] }; })
              }
            };
          }`,
          parameters: { box: 40, kcheng: 200, multiplier: 10 }
        },
        'trend': {
          name: '指数趋势跟踪策略',
          type: 'trend',
          code: `function strategy(data, params) {
            const signals = [];
            const shortPeriod = params.shortPeriod || 5;
            const longPeriod = params.longPeriod || 20;

            for (let i = longPeriod; i < data.length; i++) {
              const shortMA = data.slice(i - shortPeriod, i).reduce((sum, candle) => sum + candle.close, 0) / shortPeriod;
              const longMA = data.slice(i - longPeriod, i).reduce((sum, candle) => sum + candle.close, 0) / longPeriod;
              const prevShortMA = data.slice(i - shortPeriod - 1, i - 1).reduce((sum, candle) => sum + candle.close, 0) / shortPeriod;
              const prevLongMA = data.slice(i - longPeriod - 1, i - 1).reduce((sum, candle) => sum + candle.close, 0) / longPeriod;

              if (shortMA > longMA && prevShortMA <= prevLongMA) {
                signals.push({
                  type: 'buy',
                  index: i,
                  price: data[i].close,
                  time: data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400,
                  timestamp: (data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400) * 1000,
                  reason: '趋势金叉买入信号'
                });
              } else if (shortMA < longMA && prevShortMA >= prevLongMA) {
                signals.push({
                  type: 'sell',
                  index: i,
                  price: data[i].close,
                  time: data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400,
                  timestamp: (data[i].time || Math.floor(Date.now() / 1000) - (data.length - i) * 86400) * 1000,
                  reason: '趋势死叉卖出信号'
                });
              }
            }
            return signals;
          }`,
          parameters: { shortPeriod: 5, longPeriod: 20 }
        },

        // ========== Python 策略模板 ==========
        'ma_cross_python': {
          name: '双均线交叉策略 (Python)',
          type: 'trend',
          language: 'python',
          code: `import pandas as pd
import numpy as np

def strategy(data, params):
    short_period = params.get('shortPeriod', 5)
    long_period = params.get('longPeriod', 20)
    df = pd.DataFrame(data)
    df['ma_short'] = df['close'].rolling(window=short_period).mean()
    df['ma_long'] = df['close'].rolling(window=long_period).mean()
    signals = []
    for i in range(1, len(df)):
        if pd.isna(df.iloc[i]['ma_short']) or pd.isna(df.iloc[i]['ma_long']):
            continue
        if (df.iloc[i-1]['ma_short'] <= df.iloc[i-1]['ma_long'] and
            df.iloc[i]['ma_short'] > df.iloc[i]['ma_long']):
            signals.append({'type': 'buy', 'index': i, 'price': float(df.iloc[i]['close']),
                            'reason': f'MA{short_period}上穿MA{long_period} 金叉买入'})
        elif (df.iloc[i-1]['ma_short'] >= df.iloc[i-1]['ma_long'] and
              df.iloc[i]['ma_short'] < df.iloc[i]['ma_long']):
            signals.append({'type': 'sell', 'index': i, 'price': float(df.iloc[i]['close']),
                            'reason': f'MA{short_period}下穿MA{long_period} 死叉卖出'})
    return signals`,
          parameters: { shortPeriod: 5, longPeriod: 20 }
        },
        'rsi_python': {
          name: 'RSI超买超卖策略 (Python)',
          type: 'mean_reversion',
          language: 'python',
          code: `import pandas as pd
import numpy as np

def strategy(data, params):
    period = params.get('period', 14)
    overbought = params.get('overbought', 65)
    oversold = params.get('oversold', 35)
    df = pd.DataFrame(data)
    delta = df['close'].diff()
    gain = delta.where(delta > 0, 0).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / loss
    df['rsi'] = 100 - (100 / (1 + rs))
    signals = []
    for i in range(1, len(df)):
        if pd.isna(df.iloc[i]['rsi']):
            continue
        rsi = df.iloc[i]['rsi']
        prev_rsi = df.iloc[i-1]['rsi']
        if rsi < oversold and prev_rsi >= oversold:
            signals.append({'type': 'buy', 'index': i, 'price': float(df.iloc[i]['close']),
                            'reason': f'RSI超卖 ({rsi:.1f})'})
        elif rsi > overbought and prev_rsi <= overbought:
            signals.append({'type': 'sell', 'index': i, 'price': float(df.iloc[i]['close']),
                            'reason': f'RSI超买 ({rsi:.1f})'})
    return signals`,
          parameters: { period: 14, overbought: 65, oversold: 35 }
        },
        'boll_python': {
          name: '布林带突破策略 (Python)',
          type: 'mean_reversion',
          language: 'python',
          code: `import pandas as pd
import numpy as np

def strategy(data, params):
    period = params.get('period', 20)
    std_dev = params.get('stdDev', 2)
    df = pd.DataFrame(data)
    df['ma'] = df['close'].rolling(window=period).mean()
    df['std'] = df['close'].rolling(window=period).std()
    df['upper'] = df['ma'] + df['std'] * std_dev
    df['lower'] = df['ma'] - df['std'] * std_dev
    signals = []
    for i in range(1, len(df)):
        if pd.isna(df.iloc[i]['upper']):
            continue
        c = df.iloc[i]['close']
        pc = df.iloc[i-1]['close']
        lower = df.iloc[i]['lower']
        upper = df.iloc[i]['upper']
        prev_lower = df.iloc[i-1]['lower']
        prev_upper = df.iloc[i-1]['upper']
        if c < lower and pc >= prev_lower:
            signals.append({'type': 'buy', 'index': i, 'price': float(c),
                            'reason': f'跌破布林下轨 ({c:.2f} < {lower:.2f})'})
        elif c > upper and pc <= prev_upper:
            signals.append({'type': 'sell', 'index': i, 'price': float(c),
                            'reason': f'突破布林上轨 ({c:.2f} > {upper:.2f})'})
    return signals`,
          parameters: { period: 20, stdDev: 2 }
        },
        'float_sink_python': {
          name: '浮沉轨道策略 (Python)',
          type: 'trend',
          language: 'python',
          code: `import numpy as np

def strategy(data, params):
    BOX = params.get('box', 40)
    KCHENG = params.get('kcheng', 200)
    MULT = params.get('multiplier', 10)
    n = len(data)
    if n < BOX + 10:
        return []
    high = np.array([d['high'] for d in data], dtype=float)
    low = np.array([d['low'] for d in data], dtype=float)
    close = np.array([d['close'] for d in data], dtype=float)

    def sumbars(arr, idx, target):
        acc, bars = 0.0, 0
        for j in range(idx, -1, -1):
            acc += arr[j]; bars += 1
            if acc >= target:
                break
        return bars

    wh = np.zeros(n); wl = np.zeros(n)
    for i in range(n):
        hhv = max(close[max(0,i-1):i+1]); llv = min(close[max(0,i-1):i+1])
        wh[i] = max(high[i], hhv); wl[i] = min(low[i], llv)
    wd = wh - wl

    fsj = np.zeros(n)
    for i in range(n):
        s = max(0, i - BOX + 1)
        fsj[i] = max(KCHENG / MULT, np.max(wd[s:i+1]))
    tfs = np.zeros(n, dtype=int)
    for i in range(n):
        tfs[i] = max(1, min(sumbars(wd, i, fsj[i]), i+1))

    ft = np.zeros(n); sk = np.zeros(n)
    for i in range(n):
        s = max(0, i - tfs[i] + 1)
        if i == 0:
            ft[i] = wh[i] + KCHENG/MULT/2; sk[i] = wl[i] - KCHENG/MULT/2
        else:
            ft[i] = np.max(wh[s:i+1]); sk[i] = np.min(wl[s:i+1])

    lf2 = np.zeros(n); hs2 = np.zeros(n)
    for i in range(n):
        lf2[i] = min(ft[max(0,i-1):i+1]); hs2[i] = max(sk[max(0,i-1):i+1])
    dual = (high > lf2) & (low < hs2)
    blnd = np.zeros(n, dtype=int)
    for i in range(n):
        blnd[i] = 0 if (not dual[i] or i==0) else blnd[i-1]+1
    fdp = np.zeros(n, dtype=int); sdp = np.zeros(n, dtype=int)
    for i in range(1, n):
        fdp[i] = 0 if (high[i]>lf2[i] and not dual[i]) else fdp[i-1]+1
        sdp[i] = 0 if (low[i]<hs2[i] and not dual[i]) else sdp[i-1]+1
    fr = np.zeros(n, dtype=bool); sf = np.zeros(n, dtype=bool)
    for i in range(n):
        if high[i] > lf2[i]:
            if dual[i]:
                e = 1 if fdp[i]>sdp[i] else 0
                fr[i] = (blnd[i]%2)==e
            else: fr[i] = True
        if low[i] < hs2[i]:
            if dual[i]:
                e = 1 if fdp[i]<sdp[i] else 0
                sf[i] = (blnd[i]%2)==e
            else: sf[i] = True
    blsf = np.zeros(n, dtype=int); blfr = np.zeros(n, dtype=int)
    for i in range(n):
        blsf[i] = 0 if (i==0 or sf[i]) else blsf[i-1]+1
        blfr[i] = 0 if (i==0 or fr[i]) else blfr[i-1]+1
    fl = np.zeros(n, dtype=bool); ss = np.zeros(n, dtype=bool)
    for i in range(n):
        if fr[i]:
            lb = blsf[i] if blsf[i]>0 else i+1
            si = max(0, i-lb)
            if int(np.sum(fr[si:i+1]))==1: fl[i]=True
        if sf[i]:
            lb = blfr[i] if blfr[i]>0 else i+1
            si = max(0, i-lb)
            if int(np.sum(sf[si:i+1]))==1: ss[i]=True
    signals = []
    for i in range(n):
        if fl[i]:
            signals.append({'type':'buy','index':i,'price':float(close[i]),
                'reason':f'浮升突破 — 多头入场 (浮轨={ft[i]:.2f})'})
        if ss[i]:
            signals.append({'type':'sell','index':i,'price':float(close[i]),
                'reason':f'沉降跌破 — 空头入场 (沉轨={sk[i]:.2f})'})
    return {
        'signals': signals,
        'auxiliaryData': {
            'floatTrack': [{'time': data[i].get('time', data[i].get('date')), 'value': float(ft[i])} for i in range(n)],
            'sinkTrack': [{'time': data[i].get('time', data[i].get('date')), 'value': float(sk[i])} for i in range(n)]
        }
    }`,
          parameters: { box: 40, kcheng: 200, multiplier: 10 }
        },

        // ========== 通达信公式策略模板 ==========
        'tdx_float_sink': {
          name: '浮沉轨道策略 (通达信)',
          type: 'trend',
          language: 'tdx',
          code: `BOX:=40;
KCHENG:=200;
UNIT:=10;
波高:=MAX(HIGH,HHV(CLOSE,2));
波低:=MIN(LOW,LLV(CLOSE,2));
波距:=波高-波低;
浮沉路程:=MAX(KCHENG/UNIT,HHV(波距,BOX));
时浮沉:=MAX(1,SUMBARS(波距,浮沉路程));
浮:=HHV(波高,时浮沉);
沉:=LLV(波低,时浮沉);
LLV浮2:=LLV(浮,2);
HHV沉2:=HHV(沉,2);
浮沉双增:=HIGH>LLV浮2 AND LOW<HHV沉2;
浮向周期:=BARSLAST(HIGH>LLV浮2 AND NOT(浮沉双增));
沉向周期:=BARSLAST(LOW<HHV沉2 AND NOT(浮沉双增));
浮升0:=IF(浮沉双增,IF(浮向周期>沉向周期,MOD(BARSLAST(NOT(浮沉双增)),2)=1,MOD(BARSLAST(NOT(浮沉双增)),2)=0),HIGH>LLV浮2);
沉降0:=IF(浮沉双增,IF(浮向周期<沉向周期,MOD(BARSLAST(NOT(浮沉双增)),2)=1,MOD(BARSLAST(NOT(浮沉双增)),2)=0),LOW<HHV沉2);
多入:浮升0 AND BARSLAST(沉降0)>0 AND COUNT(浮升0,BARSLAST(沉降0))=1;
空出:沉降0 AND BARSLAST(浮升0)>0 AND COUNT(沉降0,BARSLAST(浮升0))=1;`,
          parameters: { BOX: 40, KCHENG: 200, UNIT: 10 }
        },
        'tdx_ma_cross': {
          name: '双均线交叉 (通达信)',
          type: 'trend',
          language: 'tdx',
          code: `MA5:=MA(CLOSE,5);
MA20:=MA(CLOSE,20);
多入:CROSS(MA5,MA20);
空出:CROSS(MA20,MA5);`,
          parameters: { shortPeriod: 5, longPeriod: 20 }
        },
        'tdx_kdj': {
          name: 'KDJ指标策略 (通达信)',
          type: 'mean_reversion',
          language: 'tdx',
          code: `N:=9;
M1:=3;
M2:=3;
RSV:=(CLOSE-LLV(LOW,N))/(HHV(HIGH,N)-LLV(LOW,N))*100;
K:=SMA(RSV,M1,1);
D:=SMA(K,M2,1);
J:=3*K-2*D;
多入:CROSS(J,20);
空出:CROSS(80,J);`,
          parameters: { N: 9, M1: 3, M2: 3 }
        },
        'tdx_boll': {
          name: '布林带策略 (通达信)',
          type: 'mean_reversion',
          language: 'tdx',
          code: `N:=20;
P:=2;
MID:=MA(CLOSE,N);
UPPER:=MID+P*STD(CLOSE,N);
LOWER:=MID-P*STD(CLOSE,N);
多入:CROSS(CLOSE,LOWER);
空出:CROSS(CLOSE,UPPER);`,
          parameters: { N: 20, P: 2 }
        },
        'tdx_macd': {
          name: 'MACD策略 (通达信)',
          type: 'trend',
          language: 'tdx',
          code: `SHORT:=12;
LONG:=26;
MID:=9;
DIF:=EMA(CLOSE,SHORT)-EMA(CLOSE,LONG);
DEA:=EMA(DIF,MID);
MACD:=(DIF-DEA)*2;
多入:CROSS(DIF,DEA);
空出:CROSS(DEA,DIF);`,
          parameters: { SHORT: 12, LONG: 26, MID: 9 }
        }
      };
      
      const template = strategyTemplates[id];
      if (!template) {
        return res.status(404).json({
          success: false,
          message: `未找到策略模板: ${id}`
        });
      }
      
      // 构造策略对象（尊重模板自身声明的语言）
      strategy = {
        id: id,
        name: template.name,
        type: template.type,
        code: template.code,
        parameters: template.parameters,
        language: template.language || 'javascript'
      };
    }

    // 获取K线数据
    let klineData = await marketDataService.getKLineData(symbol, startDate, endDate, 500);
    
    console.log('执行策略 - 从数据库获取的K线数据条数:', klineData ? klineData.length : 0);
    
    if (!klineData || klineData.length < 50) {
      console.log('执行策略 - 数据不足，生成模拟数据...');
      try {
        klineData = mockDataService.generateMockKLineData(symbol, 100);
        console.log('执行策略 - 生成了模拟数据:', klineData.length, '条');
      } catch (error) {
        console.error('执行策略 - 生成模拟数据失败:', error);
        throw new Error('无法获取足够的K线数据');
      }
    } else {
      // 转换数据库字段名为策略引擎期望的字段名
      klineData = klineData.map(item => ({
        date: item.timestamp ? new Date(item.timestamp).toISOString().split('T')[0] : null, // 从timestamp生成date
        time: item.timestamp ? new Date(item.timestamp).toISOString().split('T')[0] : null, // 从timestamp生成time
        timestamp: item.timestamp,
        open: parseFloat(item.open_price),
        high: parseFloat(item.high_price),
        low: parseFloat(item.low_price),
        close: parseFloat(item.close_price),
        close_price: parseFloat(item.close_price), // 保留原字段名供策略使用
        volume: parseInt(item.volume)
      }));
      console.log('执行策略 - 转换了数据库数据字段名，数据条数:', klineData.length);
      console.log('执行策略 - 转换后的数据样本:', klineData[0]);
    }

    // 执行策略
    console.log('开始执行策略获取信号...');
    const result = await strategyEngine.executeStrategy(
      strategy.code,
      klineData,
      strategy.parameters,
      strategy.language || 'javascript'
    );

    console.log('策略执行完成，结果类型:', typeof result);
    console.log('result是否为数组:', Array.isArray(result));
    console.log('result是否为对象:', typeof result === 'object' && result !== null);
    
    let signals = [];
    let auxiliaryData = {};
    
    // 处理不同的返回格式
    if (Array.isArray(result)) {
      // 传统格式：直接返回信号数组
      signals = result;
      auxiliaryData = result.auxiliaryLines || {};
      console.log('检测到传统格式返回值（数组）');
    } else if (result && typeof result === 'object') {
      // 新格式：返回包含signals和auxiliaryData的对象
      signals = result.signals || [];
      auxiliaryData = result.auxiliaryData || {};
      console.log('检测到新格式返回值（对象）');
      console.log('信号数量:', signals.length);
      console.log('辅助数据键:', Object.keys(auxiliaryData));
    } else {
      throw new Error('策略返回格式不正确');
    }

    console.log('最终信号数:', signals.length);
    console.log('signals对象类型:', typeof signals);
    console.log('signals是否为数组:', Array.isArray(signals));
    
    const tradeSignals = signals.filter(s => s.type !== 'hold');
    console.log('交易信号数（非hold）:', tradeSignals.length);

    console.log('最终辅助数据键:', Object.keys(auxiliaryData));
    console.log('最终辅助数据类型:', typeof auxiliaryData);

    res.json({
      success: true,
      data: {
        strategy: {
          id: strategy.id,
          name: strategy.name
        },
        symbol,
        signals: tradeSignals,
        klineData,
        auxiliaryData
      }
    });
  } catch (error) {
    console.error('执行策略错误:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({
      success: false,
      message: '执行策略失败',
      error: error.message
    });
  }
});

/**
 * GET /api/strategies —— 获取策略列表（分页+筛选）
 *
 * 支持按策略类型（type）和状态（status）筛选，返回分页结果。
 * 用户只能看到自己创建的策略和标记为公开的策略。
 * 需要登录认证（authMiddleware）。
 *
 * 对应论文：第4.3节（策略管理 CRUD）
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status, type } = req.query;
    const offset = (page - 1) * pageSize;

    const where = {};
    if (status) where.status = status;
    if (type) where.type = type;

    // 用户只能看到自己的策略和公开策略
    const strategies = await Strategy.findAndCountAll({
      where: {
        [Op.or]: [
          { user_id: req.user.id },
          { isPublic: true }
        ],
        ...where
      },
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['createdAt', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        list: strategies.rows,
        total: strategies.count,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    console.error('获取策略列表错误:', error);
    res.status(500).json({
      success: false,
      message: '获取策略列表失败',
      error: error.message
    });
  }
});

/**
 * POST /api/strategies —— 创建新策略
 *
 * 接收策略名称、描述、代码、类型、参数、语言等字段，
 * 经过白名单校验和语法预检后写入数据库。
 * 需要登录认证（authMiddleware）。
 *
 * 校验流程：语言标准化 → 类型标准化 → 参数解析 → 代码语法检查 → 入库
 * 对应论文：第4.3节（策略管理 CRUD — 创建）
 */
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, description, code, type, parameters, isPublic, language } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Strategy name is required'
      });
    }
    if (!code || !String(code).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Strategy code is required'
      });
    }

    const languageResult = normalizeStrategyLanguage(language || 'javascript');
    const normalizedLanguage = languageResult.value || 'javascript';

    const typeResult = normalizeStrategyType(type || 'trend');
    const normalizedType = typeResult.value || 'trend';

    const parameterResult = parseStrategyParameters(parameters);
    if (!parameterResult.ok) {
      return res.status(400).json({
        success: false,
        message: parameterResult.message,
        details: {
          field: 'parameters'
        }
      });
    }

    const codeValidation = validateStrategyCode(code, normalizedLanguage);
    if (!codeValidation.ok) {
      return res.status(400).json({
        success: false,
        message: codeValidation.message,
        details: {
          field: 'code'
        }
      });
    }

    const strategy = await Strategy.create({
      user_id: req.user.id,
      name: String(name).trim(),
      description,
      code: String(code),
      type: normalizedType,
      parameters: parameterResult.value || {},
      isPublic: isPublic || false,
      language: normalizedLanguage
    });

    const warnings = [languageResult.warning, typeResult.warning].filter(Boolean);
    res.status(201).json({
      success: true,
      message: '策略创建成功',
      data: strategy,
      warnings
    });
  } catch (error) {
    console.error('创建策略错误:', error);
    res.status(500).json({
      success: false,
      message: '创建策略失败',
      error: error.message
    });
  }
});

/**
 * GET /api/strategies/:id —— 获取策略详情
 *
 * 根据策略 ID 返回完整的策略信息（含代码、参数等）。
 * 需要登录认证，且只能查看自己的策略或公开策略。
 *
 * 对应论文：第4.3节（策略管理 CRUD — 查询）
 */
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const strategy = await Strategy.findByPk(id);

    if (!strategy) {
      return res.status(404).json({
        success: false,
        message: '策略不存在'
      });
    }

    // 检查权限
    if (strategy.user_id !== req.user.id && !strategy.isPublic) {
      return res.status(403).json({
        success: false,
        message: '无权访问该策略'
      });
    }

    res.json({
      success: true,
      data: strategy
    });
  } catch (error) {
    console.error('获取策略详情错误:', error);
    res.status(500).json({
      success: false,
      message: '获取策略详情失败',
      error: error.message
    });
  }
});

/**
 * PUT /api/strategies/:id —— 更新策略
 *
 * 支持部分更新：只传需要修改的字段，未传的字段保留原值。
 * 更新前会重新做白名单校验、参数解析和代码语法检查。
 * 需要登录认证，且只能修改自己创建的策略。
 *
 * 对应论文：第4.3节（策略管理 CRUD — 更新）
 */
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const strategy = await Strategy.findByPk(id);

    if (!strategy) {
      return res.status(404).json({
        success: false,
        message: '策略不存在'
      });
    }

    // 检查权限
    if (strategy.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '无权修改该策略'
      });
    }

    const { name, description, code, type, parameters, status, isPublic, language } = req.body || {};

    const nextLanguageResult = normalizeStrategyLanguage(language !== undefined ? language : strategy.language);
    const nextLanguage = nextLanguageResult.value || strategy.language;

    const nextTypeResult = normalizeStrategyType(type !== undefined ? type : strategy.type);
    const nextType = nextTypeResult.value || strategy.type;

    const statusResult = validateStrategyStatus(status);
    if (!statusResult.ok) {
      return res.status(400).json({
        success: false,
        message: statusResult.message,
        details: {
          field: 'status'
        }
      });
    }

    const parameterResult = parseStrategyParameters(parameters);
    if (!parameterResult.ok) {
      return res.status(400).json({
        success: false,
        message: parameterResult.message,
        details: {
          field: 'parameters'
        }
      });
    }

    const nextCode = code !== undefined ? String(code) : strategy.code;
    const codeValidation = validateStrategyCode(nextCode, nextLanguage);
    if (!codeValidation.ok) {
      return res.status(400).json({
        success: false,
        message: codeValidation.message,
        details: {
          field: 'code'
        }
      });
    }

    const updatePayload = {
      name: name !== undefined ? String(name).trim() : strategy.name,
      description: description !== undefined ? description : strategy.description,
      code: nextCode,
      type: nextType,
      parameters: parameterResult.value !== undefined ? parameterResult.value : strategy.parameters,
      status: statusResult.value || strategy.status,
      isPublic: isPublic !== undefined ? isPublic : strategy.isPublic,
      language: nextLanguage
    };

    if (!updatePayload.name) {
      return res.status(400).json({
        success: false,
        message: 'Strategy name cannot be empty',
        details: {
          field: 'name'
        }
      });
    }

    await strategy.update(updatePayload);

    const warnings = [nextLanguageResult.warning, nextTypeResult.warning].filter(Boolean);
    res.json({
      success: true,
      message: '策略更新成功',
      data: strategy,
      warnings
    });
  } catch (error) {
    console.error('更新策略错误:', error);
    res.status(500).json({
      success: false,
      message: '更新策略失败',
      error: error.message
    });
  }
});

/**
 * DELETE /api/strategies/:id —— 删除策略
 *
 * 物理删除策略记录。需要登录认证，且只能删除自己创建的策略。
 *
 * 对应论文：第4.3节（策略管理 CRUD — 删除）
 */
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const strategy = await Strategy.findByPk(id);

    if (!strategy) {
      return res.status(404).json({
        success: false,
        message: '策略不存在'
      });
    }

    // 检查权限
    if (strategy.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '无权删除该策略'
      });
    }

    await strategy.destroy();

    res.json({
      success: true,
      message: '策略删除成功'
    });
  } catch (error) {
    console.error('删除策略错误:', error);
    res.status(500).json({
      success: false,
      message: '删除策略失败',
      error: error.message
    });
  }
});

// ======================== 策略监控相关 API ========================
// 以下端点用于策略的实时监控（启动/停止/查看活跃监控/更新行情数据）
const strategyMonitor = require('../services/strategyMonitor');

/**
 * POST /api/strategies/monitor/start —— 启动策略监控
 *
 * 为指定策略开启实时监控，当产生买卖信号时通过 WebSocket 通知前端。
 * 可配合自动下单功能，在收到信号后立即生成订单。
 * 需要登录认证（authMiddleware）。
 *
 * 对应论文：第4.5节（实时监控与自动交易）
 */
router.post('/monitor/start', authMiddleware, async (req, res) => {
  try {
    const { strategyId, symbol, quantity } = req.body;
    const userId = req.user.id;

    if (!strategyId || !symbol || !quantity) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数'
      });
    }

    // 获取策略信息
    const strategy = await Strategy.findByPk(strategyId);
    if (!strategy) {
      return res.status(404).json({
        success: false,
        message: '策略不存在'
      });
    }

    // 启动监控
    const monitorKey = strategyMonitor.startMonitoring({
      strategyId: strategy.id,
      strategyCode: strategy.code,
      strategyLanguage: strategy.language || 'javascript',
      strategyParams: strategy.parameters || {},
      symbol,
      quantity,
      userId,
      onSignal: async (signalData) => {
        // 信号回调：自动下单
        console.log('📊 收到策略信号，自动下单:', signalData);
        
        try {
          // 这里可以调用交易API自动下单
          // 目前先通过事件通知前端
          const orderData = {
            symbol: signalData.symbol,
            side: signalData.signal.type === 'buy' || signalData.signal.type === 'open_long' ? 'buy' : 'sell',
            orderType: 'strategy',
            price: signalData.signal.price,
            quantity: signalData.quantity,
            strategyId: signalData.strategyId,
            strategyName: strategy.name,
            reason: signalData.signal.reason
          };

          // 触发自动下单事件（前端会监听）
          global.io && global.io.to(`user_${userId}`).emit('strategy-signal', orderData);
          
        } catch (error) {
          console.error('自动下单失败:', error);
        }
      }
    });

    res.json({
      success: true,
      data: {
        monitorKey,
        strategyId: strategy.id,
        strategyName: strategy.name,
        symbol,
        quantity
      },
      message: '策略监控已启动'
    });

  } catch (error) {
    console.error('启动策略监控失败:', error);
    res.status(500).json({
      success: false,
      message: '启动失败: ' + error.message
    });
  }
});

/**
 * POST /api/strategies/monitor/stop —— 停止策略监控
 *
 * 根据 monitorKey 停止正在运行的策略监控。
 * 需要登录认证（authMiddleware）。
 *
 * 对应论文：第4.5节（实时监控与自动交易）
 */
router.post('/monitor/stop', authMiddleware, async (req, res) => {
  try {
    const { monitorKey } = req.body;

    if (!monitorKey) {
      return res.status(400).json({
        success: false,
        message: '缺少监控键'
      });
    }

    strategyMonitor.stopMonitoring(monitorKey);

    res.json({
      success: true,
      message: '策略监控已停止'
    });

  } catch (error) {
    console.error('停止策略监控失败:', error);
    res.status(500).json({
      success: false,
      message: '停止失败: ' + error.message
    });
  }
});

/**
 * GET /api/strategies/monitor/active —— 获取用户的活跃监控列表
 *
 * 返回当前用户所有正在运行的策略监控信息。
 * 需要登录认证（authMiddleware）。
 *
 * 对应论文：第4.5节（实时监控与自动交易）
 */
router.get('/monitor/active', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const monitors = strategyMonitor.getUserMonitors(userId);

    res.json({
      success: true,
      data: { monitors }
    });

  } catch (error) {
    console.error('获取活跃监控失败:', error);
    res.status(500).json({
      success: false,
      message: '获取失败: ' + error.message
    });
  }
});

/**
 * POST /api/strategies/monitor/update-market-data —— 更新市场数据
 *
 * 供数据服务调用，将最新的市场行情推送给策略监控模块，
 * 触发各活跃监控重新计算信号。
 * 需要登录认证（authMiddleware）。
 *
 * 对应论文：第4.5节（实时数据推送）
 */
router.post('/monitor/update-market-data', authMiddleware, async (req, res) => {
  try {
    const { symbol, data } = req.body;

    if (!symbol || !data) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数'
      });
    }

    strategyMonitor.updateMarketData(symbol, data);

    res.json({
      success: true,
      message: '市场数据已更新'
    });

  } catch (error) {
    console.error('更新市场数据失败:', error);
    res.status(500).json({
      success: false,
      message: '更新失败: ' + error.message
    });
  }
});

/**
 * POST /api/strategies/validate-python —— 校验 Python 策略语法
 *
 * 将用户输入的 Python 代码通过子进程发送给本地 Python 解释器，
 * 使用 compile() 做语法检查，返回错误行号和错误信息。
 * 设置 5 秒超时防止恶意代码阻塞。需要登录认证。
 *
 * 对应论文：第4.3节（策略适配层 — Python 语法校验）
 */
router.post('/validate-python', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.trim()) {
      return res.json({ success: true, errors: [] });
    }

    const { spawn } = require('child_process');
    const { safeKill } = require('../tools/platformUtils');
    const { findPython } = require('../utils/pythonPath');
    const pythonPath = findPython();

    const checkScript = `
import sys, json
code = sys.stdin.read()
try:
    compile(code, '<strategy>', 'exec')
    print(json.dumps({"valid": True, "errors": []}))
except SyntaxError as e:
    err = {
        "line": e.lineno or 0,
        "message": str(e.msg) if e.msg else str(e),
        "code": e.text.rstrip() if e.text else ""
    }
    print(json.dumps({"valid": False, "errors": [err]}))
except Exception as e:
    print(json.dumps({"valid": False, "errors": [{"line": 0, "message": str(e), "code": ""}]}))
`;

    const proc = spawn(pythonPath, ['-c', checkScript], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });

    proc.on('error', (err) => {
      res.json({ success: true, valid: false, errors: [{ line: 0, message: `Python unavailable: ${err.message}`, code: '' }] });
    });

    let output = '';
    let stderr = '';
    let _idleTimer = null;
    const _resetIdle = () => {
      if (_idleTimer) clearTimeout(_idleTimer);
      _idleTimer = setTimeout(() => { try { safeKill(proc); } catch {} }, 5000);
    };
    _resetIdle();
    proc.stdout.on('data', (d) => { output += d.toString('utf8'); _resetIdle(); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); _resetIdle(); });

    proc.stdin.write(code);
    proc.stdin.end();

    proc.on('close', () => {
      if (_idleTimer) clearTimeout(_idleTimer);
      try {
        const result = JSON.parse(output);
        res.json({ success: true, valid: result.valid, errors: result.errors || [] });
      } catch (e) {
        res.json({ success: true, valid: false, errors: [{ line: 0, message: stderr || 'Python validation unavailable', code: '' }] });
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
