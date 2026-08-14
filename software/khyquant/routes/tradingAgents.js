/**
 * 多智能体交易分析 REST API —— 六个 AI 分析师协同决策
 *
 * 架构角色：属于多智能体协同层（对应论文第4.5节）
 *   前端发起分析请求 → 本路由协调六个智能体 → 汇总结果返回前端
 *
 * 六个分析师智能体：
 *   market_analyst      市场分析师    Random Forest（随机森林）
 *   technical_analyst   技术分析师    XGBoost（梯度提升树）
 *   fundamental_analyst 基本面分析师  LightGBM（轻量梯度提升）
 *   news_analyst        新闻分析师    Naive Bayes（朴素贝叶斯）
 *   risk_analyst        风险分析师    Logistic Regression（逻辑回归）
 *   strategy_analyst    策略分析师    Deep Neural Network（深度神经网络）
 *
 * 设计模式：
 *   - 多智能体模式：每个智能体独立分析，元学习器汇总决策
 *   - 超时保护：所有外部调用都有 timeoutAfter 兜底
 *   - 缓存策略：股票数据5分钟、ML分析10分钟、状态1分钟
 *
 * 对应论文：第4.5节（多智能体协同层），图11
 */
const express = require('express');
const router = express.Router();
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const tradingAgentsService = require('../services/tradingAgentsService');
const LLMService = require('../services/llmService');
const freeStockDataService = require('../services/freeStockDataService');
const enhancedMockDataService = require('../services/enhancedMockDataService');
const mlAgentService = require('../services/mlAgentService');
const cache = require('../services/cacheService');
const logger = require('../utils/logger');

// 缓存时间配置（秒）
const CACHE_TTL = {
  stockData: 5 * 60,      // 股票数据：5分钟
  mlAnalysis: 10 * 60,    // ML分析结果：10分钟
  mlStatus: 60,           // ML状态：1分钟
};

/**
 * 超时保护工具函数 —— 配合 Promise.race 使用
 * 当外部调用（股票数据、ML推理等）超过指定毫秒数后自动拒绝，防止请求无限挂起
 * 设计模式：超时熔断（Circuit Breaker 的简化版）
 */
function timeoutAfter(ms, message = '请求超时') {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

// 六个分析师智能体的唯一标识 —— 对应论文表22中的智能体定义
const REQUIRED_AGENT_IDS = [
  'market_analyst',
  'technical_analyst',
  'fundamental_analyst',
  'news_analyst',
  'risk_analyst',
  'strategy_analyst'
];

// 智能体中文名称映射 —— 用于前端展示
const REQUIRED_AGENT_NAMES = {
  market_analyst: '市场分析师',
  technical_analyst: '技术分析师',
  fundamental_analyst: '基本面分析师',
  news_analyst: '新闻分析师',
  risk_analyst: '风险分析师',
  strategy_analyst: '策略分析师'
};

// 智能体对应的机器学习算法 —— 每个智能体使用不同算法实现多样性
const REQUIRED_AGENT_ALGORITHMS = {
  market_analyst: 'Random Forest',
  technical_analyst: 'XGBoost',
  fundamental_analyst: 'LightGBM',
  news_analyst: 'Naive Bayes',
  risk_analyst: 'Logistic Regression',
  strategy_analyst: 'Deep Neural Network'
};

/**
 * 确保六个智能体结果完整性 —— 补全缺失智能体的兜底数据
 *
 * 无论ML推理返回了几个智能体的结果，此函数都保证最终输出包含全部6个智能体，
 * 缺失的智能体会被标记为 fallback_missing 并填入默认值。
 * 同时计算所有有效预测的平均值，生成汇总建议（买入/卖出/持有）。
 *
 * 设计模式：空对象模式（Null Object Pattern）—— 缺失智能体返回结构完整的默认对象
 * 对应论文：第4.5节，多智能体结果汇总与元学习决策
 *
 * @param {Object} analysisData - ML推理返回的原始分析数据
 * @param {Object} stockData    - 当前股票的基础数据（用于填充股票代码等字段）
 * @returns {Object} 包含完整6个智能体结果的标准化数据
 */
function ensureDetailedAgentResults(analysisData = {}, stockData = {}) {
  const existing = Array.isArray(analysisData.agentResults) ? analysisData.agentResults : [];
  const map = new Map(existing.map(item => [item.agentId, item]));
  const missingAgents = [];

  const agentResults = REQUIRED_AGENT_IDS.map((agentId) => {
    const current = map.get(agentId) || {};
    const predictionValue = Number(current.prediction);
    const hasPrediction = Number.isFinite(predictionValue);

    if (!hasPrediction) {
      missingAgents.push(agentId);
    }

    const confidenceRaw = current.confidence ?? 0.7;
    const confidence = hasPrediction
      ? Math.min(Math.max(Number(confidenceRaw) || 0.7, 0), 1)
      : 0;

    return {
      agentId,
      agentName: current.agentName || REQUIRED_AGENT_NAMES[agentId],
      algorithm: REQUIRED_AGENT_ALGORITHMS[agentId],
      score: current.score || (confidence * 10).toFixed(1),
      analysis: hasPrediction
        ? (typeof current.analysis === 'string' && current.analysis.trim() ? current.analysis : '模型已返回预测值，但未提供详细分析文本。')
        : '该智能体未返回有效模型结果，请检查模型文件和推理日志。',
      keyFindings: Array.isArray(current.keyFindings) && current.keyFindings.length > 0
        ? current.keyFindings
        : (hasPrediction ? ['模型推理完成', '请结合风险控制执行', '建议人工复核关键点'] : ['模型结果缺失', '请检查模型训练状态', '建议稍后重试']),
      prediction: hasPrediction ? predictionValue : null,
      confidence,
      sourceStatus: current.sourceStatus || (hasPrediction ? 'trained_model' : 'fallback_missing'),
      modelFile: current.modelFile || null,
      modelVariant: current.modelVariant || null
    };
  });

  const validPredictionAgents = agentResults.filter(item => Number.isFinite(Number(item.prediction)));
  const avgPrediction = validPredictionAgents.length > 0
    ? validPredictionAgents.reduce((sum, item) => sum + Number(item.prediction), 0) / validPredictionAgents.length
    : 0.5;
  const avgConfidence = validPredictionAgents.length > 0
    ? validPredictionAgents.reduce((sum, item) => sum + (Number(item.confidence) || 0), 0) / validPredictionAgents.length
    : 0;

  const fallbackRecommendation = avgPrediction > 0.6 ? '买入' : avgPrediction < 0.4 ? '卖出' : '持有';
  const fallbackConfidence = Math.round(Math.min(Math.max(avgConfidence * 100, 0), 100));

  let normalizedConfidence = Number(analysisData.confidence);
  if (Number.isFinite(normalizedConfidence)) {
    normalizedConfidence = normalizedConfidence <= 1
      ? Math.round(Math.min(Math.max(normalizedConfidence * 100, 0), 100))
      : Math.round(Math.min(Math.max(normalizedConfidence, 0), 100));
  } else {
    normalizedConfidence = fallbackConfidence;
  }

  return {
    ...analysisData,
    stockCode: analysisData.stockCode || stockData.stock_code || stockData.symbol || 'UNKNOWN',
    recommendation: analysisData.recommendation || fallbackRecommendation,
    confidence: normalizedConfidence,
    agentResults,
    predictionSource: analysisData.predictionSource || {
      mode: missingAgents.length === 0 ? 'trained_model' : 'mixed',
      modeText: missingAgents.length === 0 ? '真实训练模型' : '模型结果不完整',
      hasFallback: missingAgents.length > 0,
      trainedAgentCount: agentResults.length - missingAgents.length,
      fallbackAgentCount: missingAgents.length,
      missingAgents,
      failedAgents: [],
      message: missingAgents.length === 0
        ? '本次结果全部来自真实训练模型'
        : `有 ${missingAgents.length} 个智能体未返回有效模型结果`
    }
  };
}

// ==================== 路由端点定义 ====================

/**
 * GET /status —— 获取LLM服务连接状态（需要登录）
 * 前端首页加载时调用，用于展示系统健康状态指示灯
 */
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const llmService = new LLMService();
    const status = llmService.getStatus();
    
    res.json({
      success: true,
      status: status,
      message: '系统状态获取成功'
    });
  } catch (error) {
    console.error('获取系统状态失败:', error);
    res.status(500).json({
      success: false,
      message: '获取系统状态失败',
      error: error.message
    });
  }
});

/**
 * POST /test-connection —— 测试API连接是否可用（需要管理员权限）
 * 管理后台手动测试LLM提供商的连通性
 */
router.post('/test-connection', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const llmService = new LLMService();
    const results = await llmService.testConnection();
    
    res.json({
      success: true,
      results: results,
      message: 'API连接测试完成'
    });
  } catch (error) {
    console.error('API连接测试失败:', error);
    res.status(500).json({
      success: false,
      message: 'API连接测试失败',
      error: error.message
    });
  }
});

/**
 * POST /test-agent —— 测试单个智能体的分析能力（需要管理员权限）
 * 开发调试用：指定 agentId 和 stockCode，观察该智能体的独立输出
 */
router.post('/test-agent', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { agentId, stockCode } = req.body;
    
    if (!agentId || !stockCode) {
      return res.status(400).json({
        success: false,
        message: '请提供agentId和stockCode参数'
      });
    }

    console.log(`🤖 测试智能体: ${agentId} 分析 ${stockCode}`);

    // 执行单个智能体分析
    const analysis = await tradingAgentsService.executeSingleAgent(agentId, stockCode);

    res.json({
      success: true,
      analysis: analysis.content || analysis.analysis || '分析完成',
      provider: analysis.provider || '增强版模拟分析',
      agentId: agentId,
      stockCode: stockCode,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('智能体测试失败:', error);
    res.status(500).json({
      success: false,
      message: '智能体测试失败',
      error: error.message
    });
  }
});

/**
 * POST /chat —— 自然语言聊天接口（需要登录）
 * 用户在前端聊天框输入问题，后端自动选择合适的智能体回答
 */
router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, context = {} } = req.body;
    
    if (!message) {
      return res.status(400).json({
        success: false,
        message: '请提供消息内容'
      });
    }

    console.log(`💬 聊天请求: ${message}`);

    // 智能分析用户问题并选择合适的智能体
    const analysisResult = await tradingAgentsService.processChatMessage(message, context);

    res.json({
      success: true,
      response: analysisResult.response,
      provider: analysisResult.provider || '多重免费LLM服务',
      agentUsed: analysisResult.agentUsed,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('聊天处理失败:', error);
    res.status(500).json({
      success: false,
      message: '聊天处理失败',
      error: error.message
    });
  }
});

/**
 * GET /test-llm —— 测试LLM服务连接（需要管理员权限）
 * 验证在线LLM提供商是否正常响应
 */
router.get('/test-llm', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const llmService = new LLMService();
    const result = await llmService.testConnection();
    
    res.json({
      success: true,
      data: result,
      message: 'LLM连接测试完成'
    });
  } catch (error) {
    console.error('LLM连接测试失败:', error);
    res.status(500).json({
      success: false,
      message: 'LLM连接测试失败',
      error: error.message
    });
  }
});

/**
 * GET /llm-status —— 获取LLM服务详细状态（需要登录）
 * 返回各LLM提供商的可用性、模型名称等信息
 */
router.get('/llm-status', authMiddleware, async (req, res) => {
  try {
    const llmService = new LLMService();
    const status = llmService.getStatus();
    
    res.json({
      success: true,
      data: status,
      message: 'LLM状态获取成功'
    });
  } catch (error) {
    console.error('获取LLM状态失败:', error);
    res.status(500).json({
      success: false,
      message: '获取LLM状态失败',
      error: error.message
    });
  }
});

/**
 * POST /analyze —— 核心端点：多智能体协同分析（对应论文第4.5节）
 *
 * 处理流程（三级降级策略）：
 *   1. 优先使用本地ML模型（6个智能体各自推理）
 *   2. ML失败时降级到在线LLM（消耗Token）
 *   3. LLM也失败时返回兜底结果（规则引擎）
 *
 * 缓存策略：ML分析结果缓存10分钟，股票数据缓存5分钟
 * 设计模式：降级策略模式（Degradation Strategy）
 */
router.post('/analyze', authMiddleware, async (req, res) => {
  try {
    const { symbol, context = {}, useML = true, forceLLM = false } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: '请指定股票代码'
      });
    }

    logger.info('TradingAgents analyze request', { symbol, useML, forceLLM });
    console.log('[analyze] 收到请求:', { symbol, useML, forceLLM, useMLType: typeof useML });

    let mlFailure = null;

    // 优先使用ML模型（除非用户强制使用LLM）
    const shouldUseML = useML !== false && !forceLLM;
    logger.info('analyze shouldUseML check', { shouldUseML, useML, forceLLM, symbol });
    if (shouldUseML) {
      try {
        // 🔴 检查 ML 分析缓存
        const enabledAgents = context.enabledAgents || null;
        const cacheKey = 'ml:analysis:' + symbol + ':' + (enabledAgents ? enabledAgents.sort().join(',') : 'all');
        const cached = await cache.get(cacheKey);
        if (cached) {
          logger.info('TradingAgents cache hit', { symbol });
          const normalizedCachedData = ensureDetailedAgentResults(cached.data || {}, { stock_code: symbol });
          return res.json({
            ...cached,
            data: normalizedCachedData,
            agentCount: normalizedCachedData.agentResults.length,
            fromCache: true,
            predictionSource: normalizedCachedData.predictionSource || {
              mode: 'unknown',
              modeText: '未知来源',
              hasFallback: true,
              trainedAgentCount: 0,
              fallbackAgentCount: 0
            }
          });
        }

        // 🔴 检查股票数据缓存
        let stockData;
        const stockCacheKey = 'stock:data:' + symbol;
        const cachedStock = await cache.get(stockCacheKey);
        if (cachedStock) {
          logger.info('TradingAgents stock cache hit', { symbol });
          stockData = cachedStock;
        } else {
          // 尝试获取真实数据，失败则降级为模拟数据
          try {
            const realDataPromise = freeStockDataService.getStockData(symbol);
            const timeoutPromise = timeoutAfter(
              parseInt(process.env.TRADING_AGENT_STOCK_TIMEOUT_MS || '15000', 10),
              '获取股票数据超时'
            );
            stockData = await Promise.race([realDataPromise, timeoutPromise]);
            console.log('[ML] 真实股票数据获取成功:', symbol);
          } catch (stockErr) {
            console.log('[ML降级] 真实数据获取失败，使用模拟数据:', stockErr.message);
            const mockRows = enhancedMockDataService.generateEnhancedKLineData({ symbol, period: 'daily', limit: 300 });
            stockData = { symbol, name: symbol, kline: mockRows, source: 'enhanced_mock', isMock: true };
          }
          await cache.set(stockCacheKey, stockData, CACHE_TTL.stockData);
        }

        // 添加股票代码到数据中
        stockData.stock_code = symbol;
        
        // 使用ML模型预测
        const mlPredictions = await Promise.race([
          mlAgentService.predictAll(stockData, enabledAgents),
          timeoutAfter(parseInt(process.env.TRADING_AGENT_ML_TIMEOUT_MS || '20000', 10), 'ML分析超时')
        ]);
        
        // 格式化预测结果并强制补全 6 个详细智能体结果
        const formattedResult = mlAgentService.formatPredictions(mlPredictions, symbol, stockData);
        const completedResult = ensureDetailedAgentResults(formattedResult, stockData);

        const agentCount = completedResult.agentResults.length;
        logger.info('TradingAgents ML completed', { symbol, agentCount });
        
        const response = {
          success: true,
          data: completedResult,
          message: `ML智能体分析完成 (${agentCount}个智能体)`,
          isMLPowered: true,
          mode: 'local-ml',
          tokenUsed: false,
          agentCount: agentCount,
          predictionSource: completedResult.predictionSource || {
            mode: 'trained_model',
            modeText: '真实训练模型',
            hasFallback: false,
            trainedAgentCount: agentCount,
            fallbackAgentCount: 0
          }
        };

        // 🔴 缓存 ML 分析结果
        await cache.set(cacheKey, response, CACHE_TTL.mlAnalysis);

        return res.json(response);
        
      } catch (mlError) {
        mlFailure = {
          code: mlError?.code || 'ML_ANALYSIS_FAILED',
          message: mlError?.message || '本地模型分析失败'
        };
        logger.warn('ML analysis failed, fallback to LLM', {
          symbol,
          error: mlFailure.message,
          code: mlFailure.code
        });
      }
    }

    // 执行多智能体分析（LLM模式 - 需要Token）
    logger.warn('Using LLM fallback mode for TradingAgents', { symbol });
    const analysis = await Promise.race([
      tradingAgentsService.executeMultiAgentAnalysis(symbol, {
        ...context,
        userId: req.user?.id || 'test_user',
        userRole: req.user?.role || 'user'
      }),
      timeoutAfter(parseInt(process.env.TRADING_AGENT_ANALYZE_TIMEOUT_MS || '30000', 10), '智能体分析超时')
    ]);

    res.json({
      success: true,
      data: analysis,
      message: 'TradingAgents分析完成 (在线LLM)',
      isMLPowered: false,
      mode: 'online-llm',
      tokenUsed: true,
      mlFailure: mlFailure || undefined,
      predictionSource: {
        mode: 'fallback_llm',
        modeText: '在线LLM兜底',
        hasFallback: true,
        trainedAgentCount: 0,
        fallbackAgentCount: 1,
        errorCode: mlFailure?.code || null,
        fallbackReason: mlFailure?.message || null,
        message: mlFailure?.message
          ? `本次未使用本地训练模型，原因：${mlFailure.message}`
          : '本次未使用本地训练模型，已切换在线LLM'
      }
    });

  } catch (error) {
    logger.error('TradingAgents analyze failed', { error: error.message, stack: error.stack });
    // Never leave frontend hanging: always return fallback result.
    const fallback = tradingAgentsService.getFallbackAnalysis
      ? tradingAgentsService.getFallbackAnalysis(req.body?.symbol || 'UNKNOWN')
      : {
          symbol: req.body?.symbol || 'UNKNOWN',
          finalDecision: { action: 'HOLD', confidence: 0.4, reasoning: '系统繁忙，已返回兜底结果' },
          status: 'fallback'
        };

    res.status(200).json({
      success: true,
      data: fallback,
      message: '分析服务繁忙，已返回兜底结果',
      isFallback: true,
      predictionSource: {
        mode: 'fallback_rule',
        modeText: '系统兜底结果',
        hasFallback: true,
        trainedAgentCount: 0,
        fallbackAgentCount: 1,
        message: '模型服务不可用，已返回兜底分析'
      }
    });
  }
});

/**
 * GET /quick-advice/:symbol —— 快速建议接口（需要登录）
 * 简化版分析：只返回买入/卖出/持有建议和置信度，适合首页快速展示
 */
router.get('/quick-advice/:symbol', authMiddleware, async (req, res) => {
  try {
    const { symbol } = req.params;

    // 快速分析（简化流程）
    const quickAnalysis = await tradingAgentsService.executeMultiAgentAnalysis(symbol, {
      mode: 'quick',
      userId: req.user.id
    });

    // 提取关键信息
    const advice = {
      symbol,
      action: quickAnalysis.finalDecision?.recommendation?.action || 'HOLD',
      confidence: quickAnalysis.confidence || 0.5,
      reasoning: quickAnalysis.reasoning?.recommendation || '正在分析中...',
      timestamp: quickAnalysis.timestamp,
      agents: {
        fundamental: quickAnalysis.analysisResults?.fundamental?.recommendation || 'HOLD',
        technical: quickAnalysis.analysisResults?.technical?.recommendation || 'HOLD',
        sentiment: quickAnalysis.analysisResults?.sentiment?.recommendation || 'HOLD'
      }
    };

    res.json({
      success: true,
      data: advice
    });

  } catch (error) {
    console.error('快速建议获取失败:', error);
    res.status(500).json({
      success: false,
      message: '获取建议失败',
      error: error.message
    });
  }
});

/**
 * GET /agents/status —— 获取所有智能体的在线状态（需要登录）
 * 前端智能体面板展示每个分析师的运行状态和专长领域
 */
router.get('/agents/status', authMiddleware, async (req, res) => {
  try {
    const status = {
      agents: [
        { name: '基本面分析师', status: 'active', specialty: '财务分析' },
        { name: '技术分析师', status: 'active', specialty: '图表分析' },
        { name: '情绪分析师', status: 'active', specialty: '市场情绪' },
        { name: '新闻分析师', status: 'active', specialty: '新闻解读' },
        { name: '多头研究员', status: 'active', specialty: '看涨分析' },
        { name: '空头研究员', status: 'active', specialty: '风险识别' },
        { name: '交易员', status: 'active', specialty: '决策执行' },
        { name: '风险管理员', status: 'active', specialty: '风险控制' }
      ],
      totalAgents: 8,
      activeAgents: 8,
      lastUpdate: new Date().toISOString()
    };

    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    console.error('获取智能体状态失败:', error);
    res.status(500).json({
      success: false,
      message: '获取状态失败',
      error: error.message
    });
  }
});

/**
 * GET /history —— 获取用户的分析历史记录（需要登录）
 * 展示用户过往的智能体分析请求和结果
 */
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    // 模拟历史记录（实际项目中应该从数据库获取）
    const history = Array.from({ length: parseInt(limit) }, (_, i) => ({
      id: i + 1,
      symbol: ['sh000300', 'sh600000', 'sz000001'][i % 3],
      action: ['BUY', 'SELL', 'HOLD'][i % 3],
      confidence: Math.random() * 0.4 + 0.5,
      timestamp: new Date(Date.now() - i * 3600000).toISOString(),
      result: Math.random() > 0.5 ? 'success' : 'pending'
    }));

    res.json({
      success: true,
      data: history
    });

  } catch (error) {
    console.error('获取分析历史失败:', error);
    res.status(500).json({
      success: false,
      message: '获取历史失败',
      error: error.message
    });
  }
});

/**
 * GET /stock-data/:symbol —— 获取股票K线数据（需要登录）
 * 先查缓存 → 缓存未命中则调用 AKShare → AKShare 失败则降级为模拟数据
 * 确保前端图表永远不会空白
 */
router.get('/stock-data/:symbol', authMiddleware, async (req, res) => {
  try {
    const { symbol } = req.params;
    
    if (!symbol) {
      return res.status(400).json({ success: false, message: '股票代码不能为空' });
    }

    // 🔴 检查缓存
    const cacheKey = 'stock:data:' + symbol;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, message: '获取股票数据成功', fromCache: true });
    }

    console.log(`获取股票数据: ${symbol}`);
    const data = await freeStockDataService.getStockData(symbol);
    await cache.set(cacheKey, data, CACHE_TTL.stockData);
    
    res.json({ success: true, data, message: '获取股票数据成功' });

  } catch (error) {
    console.error('AKShare stock data failed, falling back to mock:', error.message);
    // Fallback: generate enhanced mock data so the chart is never blank
    try {
      const { symbol } = req.params;
      const mockRows = enhancedMockDataService.generateEnhancedKLineData({
        symbol,
        period: 'daily',
        limit: 1000
      });
      const mockData = {
        kline: mockRows,
        source: 'enhanced_mock',
        name: symbol,
        isMock: true
      };
      // Cache mock data too
      const cacheKey = 'stock:data:' + symbol;
      await cache.set(cacheKey, mockData, CACHE_TTL.stockData).catch(() => {});
      res.json({ success: true, data: mockData, message: 'Using mock data (real source unavailable)', isMock: true });
    } catch (mockError) {
      console.error('Mock data also failed:', mockError);
      res.status(500).json({ success: false, message: 'Failed to get stock data', error: error.message });
    }
  }
});

/**
 * POST /test-ml —— 测试ML模型推理能力（需要管理员权限）
 * 开发调试用：检查模型文件是否存在，执行一次完整的推理流程
 */
router.post('/test-ml', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { symbol = 'sh000300' } = req.body;
    
    console.log(`🧪 测试ML模型: ${symbol}`);
    
    // 检查模型是否存在
    const modelStatus = mlAgentService.checkModelsExist();
    
    // 获取股票数据
    const stockData = await freeStockDataService.getStockData(symbol);
    stockData.stock_code = symbol;
    
    // 使用ML模型预测
    const predictions = await mlAgentService.predictAll(stockData);
    
    // 格式化结果
    const formattedResult = mlAgentService.formatPredictions(predictions, symbol);
    
    res.json({
      success: true,
      modelStatus: modelStatus,
      predictions: predictions,
      formattedResult: formattedResult,
      predictionSource: formattedResult?.predictionSource || null,
      message: 'ML模型测试完成'
    });
    
  } catch (error) {
    console.error('ML模型测试失败:', error);
    res.status(500).json({
      success: false,
      message: 'ML模型测试失败',
      error: error.message
    });
  }
});

/**
 * GET /ml-status —— 获取ML模型整体状态（需要登录）
 * 返回每个智能体的模型文件是否存在、已训练数量、已启用数量等
 * 前端管理面板用此接口展示模型健康度
 */
router.get('/ml-status', authMiddleware, async (req, res) => {
  try {
    // 🔴 检查缓存
    const cacheKey = 'ml:status';
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ ...cached, fromCache: true });
    }

    const modelStatus = mlAgentService.checkModelsExist();
    const modelManifest = mlAgentService.getModelManifest();
    const agentConfig = mlAgentService.getAgentConfig();
    const enabledAgents = mlAgentService.getEnabledAgents();
    
    const totalModels = Object.keys(modelStatus).length;
    const trainedModels = Object.values(modelStatus).filter(exists => exists).length;
    const enabledCount = enabledAgents.length;
    
    const response = {
      success: true,
      data: {
        modelStatus: modelStatus,
        modelManifest,
        agentConfig: agentConfig,
        enabledAgents: enabledAgents,
        totalModels: totalModels,
        trainedModels: trainedModels,
        enabledCount: enabledCount,
        isReady: trainedModels > 0 && enabledCount > 0,
        message: trainedModels > 0 
          ? `${trainedModels}/${totalModels} 个模型已训练，${enabledCount} 个智能体已启用` 
          : '未找到训练好的模型'
      }
    };

    await cache.set(cacheKey, response, CACHE_TTL.mlStatus);
    res.json(response);
    
  } catch (error) {
    console.error('获取ML状态失败:', error);
    res.status(500).json({
      success: false,
      message: '获取ML状态失败',
      error: error.message
    });
  }
});

/**
 * GET /models/files —— 获取模型文件清单详情（需要管理员权限）
 * 列出每个智能体对应的 .pkl 模型文件路径、大小、最后修改时间等
 */
router.get('/models/files', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const modelManifest = mlAgentService.getModelManifest();
    res.json({
      success: true,
      data: {
        modelManifest
      }
    });
  } catch (error) {
    console.error('获取模型文件详情失败:', error);
    res.status(500).json({
      success: false,
      message: '获取模型文件详情失败',
      error: error.message
    });
  }
});

/**
 * POST /models/refresh —— 刷新/导入模型文件（需要管理员权限）
 * 可指定外部目录导入新模型，刷新后自动清除相关缓存
 */
router.post('/models/refresh', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const {
      sourceDir = null,
      preferDistilled = true
    } = req.body || {};

    const result = mlAgentService.refreshModelFiles({
      sourceDir,
      preferDistilled
    });

    // 清理缓存，确保立刻使用新模型
    await cache.clearByPrefix('ml:analysis:');
    await cache.del('ml:status');

    res.json({
      success: true,
      data: result,
      message: '模型文件已刷新'
    });
  } catch (error) {
    console.error('刷新模型文件失败:', error);
    res.status(400).json({
      success: false,
      message: '刷新模型文件失败',
      error: error.message
    });
  }
});

/**
 * GET /cache-stats —— 获取缓存命中率等统计信息（需要登录）
 */
router.get('/cache-stats', authMiddleware, async (req, res) => {
  try {
    const stats = await cache.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, message: '获取缓存统计失败', error: error.message });
  }
});

/**
 * DELETE /cache/:symbol —— 清除指定股票的缓存（需要登录）
 * 当用户怀疑数据过时时手动刷新
 */
router.delete('/cache/:symbol', authMiddleware, async (req, res) => {
  try {
    const { symbol } = req.params;
    await cache.del('stock:data:' + symbol);
    await cache.clearByPrefix('ml:analysis:' + symbol);
    console.log(`🗑️ 已清除缓存: ${symbol}`);
    res.json({ success: true, message: `已清除 ${symbol} 的缓存` });
  } catch (error) {
    res.status(500).json({ success: false, message: '清除缓存失败', error: error.message });
  }
});

/**
 * DELETE /cache —— 清除所有缓存（需要管理员权限）
 * 系统维护时一键清除全部股票数据和ML分析缓存
 */
router.delete('/cache', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await cache.clearByPrefix('stock:data:');
    await cache.clearByPrefix('ml:analysis:');
    await cache.del('ml:status');
    console.log('🗑️ 已清除所有缓存');
    res.json({ success: true, message: '已清除所有缓存' });
  } catch (error) {
    res.status(500).json({ success: false, message: '清除缓存失败', error: error.message });
  }
});

/**
 * POST /ml-agents/config —— 设置智能体启用/禁用状态（需要管理员权限）
 * 支持单个设置（agentName + enabled）或批量设置（config 对象）
 */
router.post('/ml-agents/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { agentName, enabled, config } = req.body;
    
    let results;
    
    if (config) {
      // 批量设置
      results = mlAgentService.setAgentsConfig(config);
      console.log('📝 批量更新智能体配置:', config);
    } else if (agentName !== undefined && enabled !== undefined) {
      // 单个设置
      const success = mlAgentService.setAgentEnabled(agentName, enabled);
      results = { [agentName]: success };
      console.log(`📝 ${enabled ? '启用' : '禁用'} 智能体: ${agentName}`);
    } else {
      return res.status(400).json({
        success: false,
        message: '请提供 agentName 和 enabled，或者提供 config 对象'
      });
    }
    
    const enabledAgents = mlAgentService.getEnabledAgents();
    
    res.json({
      success: true,
      data: {
        results: results,
        enabledAgents: enabledAgents,
        enabledCount: enabledAgents.length
      },
      message: '智能体配置已更新'
    });
    
  } catch (error) {
    console.error('设置智能体配置失败:', error);
    res.status(500).json({
      success: false,
      message: '设置智能体配置失败',
      error: error.message
    });
  }
});

/**
 * GET /ml-agents/config —— 获取智能体配置信息（需要登录）
 * 返回每个智能体的启用状态和已启用数量
 */
router.get('/ml-agents/config', authMiddleware, async (req, res) => {
  try {
    const agentConfig = mlAgentService.getAgentConfig();
    const enabledAgents = mlAgentService.getEnabledAgents();
    
    res.json({
      success: true,
      data: {
        agentConfig: agentConfig,
        enabledAgents: enabledAgents,
        enabledCount: enabledAgents.length
      }
    });
    
  } catch (error) {
    console.error('获取智能体配置失败:', error);
    res.status(500).json({
      success: false,
      message: '获取智能体配置失败',
      error: error.message
    });
  }
});

/**
 * POST /retrain —— 触发模型重新训练（需要管理员权限）
 * 支持参数：days（训练数据天数）、forceCollect（强制重新采集）、
 * distillationRounds（知识蒸馏轮数）、skipDistill（跳过蒸馏）
 * 训练启动后自动清除旧缓存
 */
router.post('/retrain', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { days = 365, forceCollect = false, distillationRounds = 3, skipDistill = false } = req.body;

    console.log(`🔄 Triggering model retraining: days=${days}, forceCollect=${forceCollect}`);

    const result = mlAgentService.retrain({ days, forceCollect, distillationRounds, skipDistill });

    if (!result.success) {
      return res.status(409).json(result);
    }

    // Clear ML cache so new models are used
    await cache.clearByPrefix('ml:analysis:');
    await cache.del('ml:status');

    res.json({
      success: true,
      data: result.job,
      message: 'Model retraining started'
    });
  } catch (error) {
    console.error('Retrain trigger failed:', error);
    res.status(500).json({ success: false, message: 'Failed to start retraining', error: error.message });
  }
});

/**
 * GET /retrain-status —— 查询模型重训练进度（需要登录）
 * 返回当前训练任务的状态（进行中/已完成/失败）
 */
router.get('/retrain-status', authMiddleware, async (req, res) => {
  try {
    const status = mlAgentService.getRetrainStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get retrain status', error: error.message });
  }
});

module.exports = router;
