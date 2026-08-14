/**
 * TradingAgents Multi-Agent Service (多智能体协同层核心)
 *
 * Implements the multi-agent collaboration framework described in
 * thesis Chapter 4.4.  Six analyst roles (Market, Technical,
 * Fundamental, News, Risk, Strategy) plus Bull/Bear researchers
 * and a Trader executor.  Uses weighted fusion for consensus.
 *
 * Design patterns: Observer + Template Method.
 * See thesis Figure 7 (agent class diagram) and Table 14 (6 roles).
 */
const MultiFreeService = require('./llmService');
const agentDisplay = require('./agentDisplay');

// ── Agent 显示规范（DESIGN-ARCH-016）接入层 ──────────────────────────────────
// 仅替换日志/进度/状态上报代码，绝不改动评分、Prompt 或工具执行结果等核心逻辑。
//
// _dev：取一个开发者结构化日志器。若上游运行已持有 display，则 child() 复用同一
//   trace_id（贯穿所有 step，§1.2）；否则起一个独立的结构化日志器（仍脱敏+摘要）。
function _dev(agent, display) {
  return display ? display.child(agent) : agentDisplay.create({ agent });
}
// _logError：结构化错误日志（§1 / R4 / R7），替代 console.error(裸 error 对象)。
//   detail 由 log() 统一脱敏 + 摘要 ≤100 字符，绝不全量打印堆栈或密钥。
function _logError(agent, action, error, display) {
  _dev(agent, display).log('error', {
    action,
    detail: error && (error.stack || error.message) ? (error.stack || error.message) : String(error),
    status: 'error',
  });
}

class TradingAgentsService {
  constructor() {
    this.llmService = new MultiFreeService();
    this.agents = {
      fundamental: new FundamentalAnalyst(this.llmService),
      technical: new TechnicalAnalyst(this.llmService),
      sentiment: new SentimentAnalyst(this.llmService),
      news: new NewsAnalyst(this.llmService),
      bullResearcher: new BullResearcher(this.llmService),
      bearResearcher: new BearResearcher(this.llmService),
      trader: new TraderAgent(this.llmService),
      riskManager: new RiskManager(this.llmService)
    };
  }

  /**
   * 处理聊天消息
   */
  async processChatMessage(message, context = {}) {
    const d = agentDisplay.create({ agent: 'chat' });
    try {
      d.log('start', { action: 'chat.process', detail: message });

      // 智能分析用户意图
      const intent = this.analyzeUserIntent(message);

      // 根据意图选择合适的处理方式
      if (intent.type === 'stock_analysis') {
        return await this.handleStockAnalysis(message, intent);
      } else if (intent.type === 'market_question') {
        return await this.handleMarketQuestion(message, intent);
      } else if (intent.type === 'general_chat') {
        return await this.handleGeneralChat(message, intent);
      } else {
        return await this.handleDefaultResponse(message);
      }

    } catch (error) {
      _logError('chat', 'chat.process', error, d);
      return {
        response: '抱歉，我暂时无法理解你的问题。你可以问我关于股票分析、市场趋势等投资相关的问题。',
        provider: '系统回复',
        agentUsed: 'system'
      };
    }
  }

  /**
   * 分析用户意图
   */
  analyzeUserIntent(message) {
    const msg = message.toLowerCase();
    
    // 检测股票代码
    const stockMatch = message.match(/(\d{6}|[a-zA-Z]{2}\d{6})/);
    
    // 股票分析意图
    if (stockMatch || msg.includes('分析') || msg.includes('股票') || msg.includes('买') || msg.includes('卖')) {
      return {
        type: 'stock_analysis',
        stockCode: stockMatch ? stockMatch[1] : '000001',
        analysisType: this.detectAnalysisType(msg)
      };
    }
    
    // 市场问题意图
    if (msg.includes('市场') || msg.includes('趋势') || msg.includes('行情') || msg.includes('投资')) {
      return {
        type: 'market_question',
        topic: this.detectMarketTopic(msg)
      };
    }
    
    // 一般聊天意图
    return {
      type: 'general_chat',
      category: 'general'
    };
  }

  /**
   * 检测分析类型
   */
  detectAnalysisType(message) {
    if (message.includes('基本面') || message.includes('财务')) return 'fundamentals';
    if (message.includes('技术') || message.includes('图表')) return 'market';
    if (message.includes('新闻') || message.includes('消息')) return 'news';
    if (message.includes('情绪') || message.includes('社交')) return 'social';
    if (message.includes('风险')) return 'risk';
    if (message.includes('策略')) return 'strategy';
    return 'market'; // 默认技术分析
  }

  /**
   * 检测市场话题
   */
  detectMarketTopic(message) {
    if (message.includes('牛市') || message.includes('熊市')) return 'market_trend';
    if (message.includes('政策') || message.includes('利率')) return 'policy';
    if (message.includes('板块') || message.includes('行业')) return 'sector';
    return 'general_market';
  }

  /**
   * 处理股票分析
   */
  async handleStockAnalysis(message, intent) {
    try {
      const { stockCode, analysisType } = intent;
      
      // 执行智能体分析
      const analysis = await this.executeSingleAgent(analysisType, stockCode);
      
      const response = `基于你的问题"${message}"，我为你提供以下${this.getAnalysisTypeName(analysisType)}：\n\n${analysis.analysis}`;
      
      return {
        response,
        provider: analysis.provider,
        agentUsed: analysisType,
        stockCode
      };
    } catch (error) {
      _logError('chat', 'chat.stockAnalysis', error);
      return this.handleDefaultResponse(message);
    }
  }

  /**
   * 处理市场问题
   */
  async handleMarketQuestion(message, intent) {
    try {
      // 使用市场分析师回答市场问题
      const prompt = `作为专业的市场分析师，请回答以下问题：${message}

请提供专业、客观的分析和建议，用中文回答。`;

      const analysis = await this.llmService.analyze({
        prompt,
        agentId: 'market',
        stockCode: 'market',
        temperature: 0.4,
        maxTokens: 1000
      });

      return {
        response: analysis,
        provider: '市场分析师',
        agentUsed: 'market_analyst'
      };
    } catch (error) {
      _logError('chat', 'chat.marketQuestion', error);
      return this.getMarketFallbackResponse(message, intent);
    }
  }

  /**
   * 处理一般聊天
   */
  async handleGeneralChat(message, intent) {
    try {
      const prompt = `作为khy OS量化交易系统的AI助手，请回答用户的问题：${message}

请提供有用的投资和交易相关建议，保持专业和友好的语调，用中文回答。`;

      const analysis = await this.llmService.analyze({
        prompt,
        agentId: 'strategy',
        stockCode: 'general',
        temperature: 0.6,
        maxTokens: 800
      });

      return {
        response: analysis,
        provider: 'AI助手',
        agentUsed: 'general_assistant'
      };
    } catch (error) {
      _logError('chat', 'chat.generalChat', error);
      return this.getGeneralFallbackResponse(message);
    }
  }

  /**
   * 默认回复处理
   */
  async handleDefaultResponse(message) {
    const responses = [
      '我是khy OS的AI助手（小K），可以帮你进行量化交易分析，也能回答编程、技术、知识等各类问题。',
      '你可以问我关于股票分析、策略回测，也可以聊编程、数学、科技等任何话题。',
      '试试看：输入股票代码获取行情，或者直接问我任何你感兴趣的问题。'
    ];
    
    return {
      response: responses.join('\n\n'),
      provider: '系统助手',
      agentUsed: 'system'
    };
  }

  /**
   * 获取分析类型名称
   */
  getAnalysisTypeName(analysisType) {
    const names = {
      'market': '技术分析',
      'fundamentals': '基本面分析',
      'news': '新闻分析',
      'social': '情绪分析',
      'risk': '风险分析',
      'strategy': '策略分析'
    };
    return names[analysisType] || '综合分析';
  }

  /**
   * 市场问题备用回复
   */
  getMarketFallbackResponse(message, intent) {
    const responses = {
      'market_trend': '当前市场处于震荡调整阶段，建议关注政策面变化和资金流向，保持谨慎乐观的态度。',
      'policy': '政策面对市场影响较大，建议关注央行货币政策、财政政策等重要信号。',
      'sector': '不同板块轮动是市场常态，建议分散投资，关注业绩确定性较高的优质个股。',
      'general_market': '市场有风险，投资需谨慎。建议做好风险控制，理性投资。'
    };
    
    return {
      response: responses[intent.topic] || responses['general_market'],
      provider: '市场分析师（备用）',
      agentUsed: 'market_fallback'
    };
  }

  /**
   * 一般聊天备用回复
   */
  getGeneralFallbackResponse(message) {
    return {
      response: '抱歉，我暂时无法获取到相关信息。你可以换个方式提问，或者试试其他问题，我会尽力为你解答。',
      provider: 'AI助手（备用）',
      agentUsed: 'general_fallback'
    };
  }

  /**
   * 执行单个智能体分析
   */
  async executeSingleAgent(agentId, stockCode) {
    const d = agentDisplay.create({ agent: 'single' });
    try {
      d.log('start', { action: 'analyze.single', detail: `${agentId} -> ${stockCode}` });

      // 映射agentId到实际的智能体
      const agentMap = {
        'market': 'technical',
        'fundamentals': 'fundamental', 
        'news': 'news',
        'social': 'sentiment',
        'risk': 'riskManager',
        'strategy': 'trader'
      };
      
      const actualAgentId = agentMap[agentId] || agentId;
      const agent = this.agents[actualAgentId];
      
      if (!agent) {
        throw new Error(`未找到智能体: ${agentId}`);
      }
      
      // 执行分析
      let result;
      if (typeof agent.analyze === 'function') {
        result = await agent.analyze(stockCode, {});
      } else if (typeof agent.assess === 'function') {
        // 风险管理员需要交易决策作为输入
        const mockDecision = { action: 'HOLD', confidence: 0.5, positionSize: 10 };
        result = await agent.assess(mockDecision, stockCode);
      } else {
        throw new Error(`智能体 ${agentId} 不支持单独分析`);
      }
      
      return {
        agentId,
        stockCode,
        analysis: result.analysis || '分析完成',
        content: result.analysis || '分析完成',
        provider: '多重免费LLM服务',
        timestamp: new Date().toISOString(),
        ...result
      };
      
    } catch (error) {
      _logError('single', 'analyze.single', error, d);

      // 返回备用分析
      return {
        agentId,
        stockCode,
        analysis: this.getFallbackSingleAnalysis(agentId, stockCode),
        content: this.getFallbackSingleAnalysis(agentId, stockCode),
        provider: '增强版模拟分析',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 获取单个智能体的备用分析
   */
  getFallbackSingleAnalysis(agentId, stockCode) {
    const analysisMap = {
      'market': `${stockCode} Technical Analysis Report

1. Trend Assessment:
The stock is currently in a consolidation phase. Moving average convergence suggests the market is waiting for a directional catalyst. MA5 and MA20 are approaching a potential crossover point, which historically signals a trend reversal.

2. Volume Analysis:
Recent trading volume has been below the 20-day average, indicating reduced market participation. This low-volume consolidation often precedes a significant price move. Watch for a volume breakout above 1.5x the average to confirm direction.

3. Indicator Signals:
RSI is hovering around the 50 level (neutral zone), neither overbought nor oversold. MACD histogram is flattening near the zero line, suggesting weakening momentum in the current trend. Bollinger Bands are narrowing, a classic squeeze pattern.

4. Support and Resistance:
Key support levels are established at recent swing lows. Resistance overhead from previous consolidation zones. A break above resistance with volume confirmation would signal bullish continuation.

5. Trading Recommendation:
Hold current positions. Set alerts for breakout above resistance or breakdown below support. Risk/reward favors waiting for confirmation rather than anticipating direction.`,

      'fundamentals': `${stockCode} Fundamental Analysis Report

1. Valuation Metrics:
Current PE ratio is within the industry average range. PB ratio suggests the stock is fairly valued relative to book value. Enterprise value to EBITDA indicates reasonable valuation compared to sector peers.

2. Financial Health:
The company maintains a healthy balance sheet with manageable debt-to-equity ratio. Current ratio above 1.5 indicates adequate short-term liquidity. Free cash flow generation remains positive, supporting dividend sustainability and capital expenditure plans.

3. Growth Prospects:
Revenue growth trajectory shows steady improvement over the past four quarters. Gross margin expansion indicates pricing power and operational efficiency gains. R&D investment as a percentage of revenue suggests commitment to future innovation.

4. Competitive Position:
The company holds a meaningful market share in its primary segments. Brand recognition and distribution network create moderate barriers to entry. Ongoing industry consolidation could benefit larger incumbents.

5. Investment Conclusion:
Fundamentals support a HOLD rating. The stock offers reasonable value at current levels with a balanced risk/reward profile. Monitor upcoming earnings releases and management guidance for catalysts.`,

      'news': `${stockCode} News & Sentiment Analysis Report

1. Recent News Summary:
The news environment for this stock has been relatively quiet in recent sessions. No material announcements, regulatory actions, or significant management changes have been reported. Industry-level news has been mixed with some positive policy signals.

2. Sector News Impact:
The broader industry sector has seen moderate news flow. Regulatory developments are generally neutral to slightly positive. No major disruptions or competitive threats identified from recent news sources.

3. Market Sentiment Indicators:
Social media sentiment tracking shows neutral to slightly bullish discussion volume. Analyst coverage has maintained consensus ratings without major revisions. Institutional investor filings show stable positioning without dramatic changes.

4. Upcoming Catalysts:
Key dates to monitor include upcoming earnings announcements, industry conferences, and regulatory review timelines. Any macro policy shifts could create short-term volatility.

5. News-Based Recommendation:
The news environment is benign — no urgent action required. Continue monitoring for material developments that could shift the narrative. Low news volatility suggests the stock will trade on technicals in the near term.`,

      'social': `${stockCode} Market Sentiment Analysis Report

1. Overall Sentiment:
Market sentiment for this stock is currently neutral with a slight cautious bias. Retail investor forums show balanced discussion between bulls and bears. Institutional sentiment indicators suggest a wait-and-see approach.

2. Fear and Greed Assessment:
The market fear/greed index is in the neutral zone. Neither excessive optimism nor panic selling is observed. This equilibrium often precedes a directional move once a catalyst emerges.

3. Retail vs Institutional Behavior:
Retail investor participation has been moderate with no unusual buying or selling patterns. Institutional flows appear stable. Short interest remains at manageable levels, reducing the risk of a short squeeze event.

4. Social Media Tracking:
Discussion volume is below the 30-day average, suggesting reduced market attention. Sentiment polarity in online forums is mixed — approximately equal positive and negative commentary.

5. Sentiment-Based Recommendation:
With neutral market sentiment, the stock is unlikely to see sentiment-driven moves in the short term. This creates an opportunity for fundamental or technical factors to drive price action. Maintain current positions and watch for sentiment shifts.`,

      'risk': `${stockCode} Risk Assessment Report

1. Market Risk:
Systematic market risk is moderate. Current market volatility (VIX equivalent) is within normal ranges. Correlation to the broader market index remains positive, meaning broad market declines would affect this stock.

2. Liquidity Risk:
Daily trading volume is adequate for normal position sizing. Bid-ask spreads are within acceptable ranges. No concerns about position exit under normal market conditions, though extreme stress scenarios could widen spreads.

3. Company-Specific Risk:
Financial leverage is at manageable levels. No significant pending litigation or regulatory issues identified. Management stability and governance structure are rated satisfactory.

4. Risk Metrics:
Value at Risk (95% confidence): approximately 3-5% daily. Maximum historical drawdown from recent peak: moderate. Beta relative to market index suggests slightly above-average sensitivity to market moves.

5. Risk Management Recommendations:
Position sizing: limit single-stock exposure to 5% of portfolio maximum. Stop-loss: set at 5% below current price for new positions. Diversification: ensure adequate sector diversification to reduce concentration risk. Hedging: consider protective put options during earnings periods.`,

      'strategy': `${stockCode} Trading Strategy Report

1. Strategy Overview:
Based on comprehensive multi-factor analysis, the recommended strategy is a balanced approach combining trend-following and value considerations. Current market conditions favor a patient, disciplined execution plan.

2. Entry Strategy:
Phase in positions gradually using a 3-tranche approach (33% per tranche). First tranche at current levels if technical support holds. Second tranche on confirmation of trend direction. Third tranche on pullback to support or breakout confirmation.

3. Position Management:
Recommended position size: 3-5% of total portfolio value. Set hard stop-loss at 5% below average entry price. Trail stop to breakeven once position shows 3% unrealized gain. Consider scaling out at predetermined profit targets.

4. Exit Strategy:
Take partial profits (50%) at first resistance level. Move remaining stop to breakeven. Let remaining position ride with trailing stop. Full exit on technical breakdown below key support or fundamental deterioration.

5. Risk/Reward Assessment:
Estimated reward-to-risk ratio: approximately 2:1. Maximum acceptable drawdown: 5% of position value. Expected holding period: 2-4 weeks for swing trading; 3-6 months for position trading. Adjust strategy based on changing market conditions and new information.`
    };

    return analysisMap[agentId] || `${stockCode} analysis complete. The current market environment suggests maintaining existing positions while monitoring for new developments. Key factors to watch include upcoming earnings, sector rotation trends, and broader market direction signals.`;
  }

  /**
   * 执行多智能体分析
   */
  async executeMultiAgentAnalysis(symbol, context = {}) {
    // 一次多智能体运行 = 一个 trace_id，贯穿 4 个阶段（§1.2）。
    const d = agentDisplay.create({ agent: 'trading' });
    try {
      d.log('start', { action: 'analyze.multiAgent', detail: `symbol=${symbol}` });
      d.progress(`正在分析 ${symbol}…`);

      // 获取真实股票数据
      const stockData = await this.getStockData(symbol);
      d.log('tool', { action: 'getStockData', status: stockData ? 'ok' : 'fallback', detail: stockData ? 'hit' : 'miss' });

      // 阶段1: 根据用户选择的智能体进行分析
      d.progress('正在汇总各分析师意见…');
      const analysisResults = await this.runAnalystTeam(symbol, { ...context, display: d }, stockData);
      d.log('result', { action: 'analystTeam', detail: `agents=${(analysisResults.activeAgents || []).join(',')}` });

      // 阶段2: 研究团队辩论(可选)
      d.progress('正在进行多空研判…');
      const researchResults = await this.runResearchTeam(analysisResults, symbol);
      d.log('result', { action: 'researchTeam' });

      // 阶段3: 交易员决策
      d.progress('正在形成交易决策…');
      const tradeDecision = await this.runTraderDecision(researchResults, symbol);
      d.log('result', { action: 'traderDecision', detail: tradeDecision && tradeDecision.action });

      // 阶段4: 风险管理评估
      d.progress('正在评估风险…');
      const finalDecision = await this.runRiskAssessment(tradeDecision, symbol);
      d.log('result', { action: 'riskAssessment' });

      const result = {
        symbol,
        timestamp: new Date().toISOString(),
        analysisResults,
        researchResults,
        tradeDecision,
        finalDecision,
        confidence: this.calculateConfidence(finalDecision),
        reasoning: this.generateReasoning(finalDecision),
        stockData // 返回股票数据供前端使用
      };
      d.done(`${symbol} 分析完成`);
      return result;

    } catch (error) {
      // 用户层降级为人话 + 已采取的兜底；开发者层记 phase:error（R7）。
      d.error('分析未能完成，已返回保守的观望建议', error, '已切换备用分析');
      return this.getFallbackAnalysis(symbol);
    }
  }

  /**
   * 获取真实股票数据
   */
  async getStockData(symbol) {
    try {
      const freeStockDataService = require('./freeStockDataService');
      const data = await freeStockDataService.getStockData(symbol);
      return data;
    } catch (error) {
      _logError('trading', 'getStockData', error);
      return null;
    }
  }

  /**
   * 分析师团队并行分析 - 根据用户选择的智能体
   */
  async runAnalystTeam(symbol, context, stockData) {
    const activeAgents = context.activeAgents || ['market', 'fundamentals', 'risk', 'news'];
    _dev('trading', context.display).log('tool', { action: 'analystTeam.activate', detail: activeAgents.join(',') });
    
    const tasks = [];
    const results = {};
    
    // 根据用户选择的智能体执行分析
    if (activeAgents.includes('fundamentals')) {
      tasks.push(
        this.agents.fundamental.analyze(symbol, { ...context, stockData })
          .then(result => { results.fundamental = result; })
          .catch(() => { results.fundamental = this.agents.fundamental.getFallbackAnalysis(symbol, stockData); })
      );
    }
    
    if (activeAgents.includes('market')) {
      tasks.push(
        this.agents.technical.analyze(symbol, { ...context, stockData })
          .then(result => { results.technical = result; })
          .catch(() => { results.technical = this.agents.technical.getFallbackAnalysis(symbol, stockData); })
      );
    }
    
    if (activeAgents.includes('social')) {
      tasks.push(
        this.agents.sentiment.analyze(symbol, { ...context, stockData })
          .then(result => { results.sentiment = result; })
          .catch(() => { results.sentiment = this.agents.sentiment.getFallbackAnalysis(symbol, stockData); })
      );
    }
    
    if (activeAgents.includes('news')) {
      tasks.push(
        this.agents.news.analyze(symbol, { ...context, stockData })
          .then(result => { results.news = result; })
          .catch(() => { results.news = this.agents.news.getFallbackAnalysis(symbol, stockData); })
      );
    }

    // 等待所有选中的智能体完成分析
    await Promise.all(tasks);
    
    return {
      ...results,
      timestamp: new Date().toISOString(),
      activeAgents: activeAgents
    };
  }

  /**
   * 研究团队辩论
   */
  async runResearchTeam(analysisResults, symbol) {
    // 多头研究员观点
    const bullView = await this.agents.bullResearcher.research(analysisResults, symbol);
    
    // 空头研究员观点
    const bearView = await this.agents.bearResearcher.research(analysisResults, symbol);
    
    // 辩论过程
    const debate = await this.conductDebate(bullView, bearView, symbol);
    
    return {
      bullView,
      bearView,
      debate,
      consensus: this.findConsensus(bullView, bearView, debate)
    };
  }

  /**
   * 交易员决策
   */
  async runTraderDecision(researchResults, symbol) {
    return await this.agents.trader.makeDecision(researchResults, symbol);
  }

  /**
   * 风险管理评估
   */
  async runRiskAssessment(tradeDecision, symbol) {
    return await this.agents.riskManager.assess(tradeDecision, symbol);
  }

  /**
   * 进行辩论
   */
  async conductDebate(bullView, bearView, symbol) {
    const debateRounds = [];
    
    // 第一轮：多头论点
    debateRounds.push({
      round: 1,
      speaker: 'bull',
      argument: bullView.mainArgument,
      evidence: bullView.evidence
    });
    
    // 第二轮：空头反驳
    debateRounds.push({
      round: 2,
      speaker: 'bear',
      argument: bearView.mainArgument,
      evidence: bearView.evidence,
      rebuttal: bearView.rebuttalToBull
    });
    
    // 第三轮：多头再反驳
    const bullRebuttal = await this.agents.bullResearcher.rebuttal(bearView, symbol);
    debateRounds.push({
      round: 3,
      speaker: 'bull',
      argument: bullRebuttal.argument,
      evidence: bullRebuttal.evidence
    });
    
    return {
      rounds: debateRounds,
      summary: this.summarizeDebate(debateRounds)
    };
  }

  /**
   * 总结辩论过程
   */
  summarizeDebate(debateRounds) {
    const bullPoints = debateRounds.filter(round => round.speaker === 'bull').length;
    const bearPoints = debateRounds.filter(round => round.speaker === 'bear').length;
    
    return {
      totalRounds: debateRounds.length,
      bullArguments: bullPoints,
      bearArguments: bearPoints,
      keyDebatePoints: debateRounds.map(round => round.argument),
      conclusion: bullPoints > bearPoints ? '多头观点更有说服力' : 
                 bearPoints > bullPoints ? '空头观点更有说服力' : '多空观点势均力敌'
    };
  }

  /**
   * 寻找共识
   */
  findConsensus(bullView, bearView, debate) {
    const bullConfidence = bullView.confidence || 0.5;
    const bearConfidence = bearView.confidence || 0.5;
    const confidenceDiff = Math.abs(bullConfidence - bearConfidence);
    
    if (confidenceDiff < 0.2) {
      return {
        type: 'neutral',
        message: '多空观点分歧较大，建议观望',
        confidence: 0.5
      };
    } else if (bullConfidence > bearConfidence) {
      return {
        type: 'bullish',
        message: '多头观点占优势',
        confidence: bullConfidence
      };
    } else {
      return {
        type: 'bearish',
        message: '空头观点占优势',
        confidence: bearConfidence
      };
    }
  }

  /**
   * 计算置信度
   */
  calculateConfidence(finalDecision) {
    const factors = [
      finalDecision.technicalScore || 0,
      finalDecision.fundamentalScore || 0,
      finalDecision.sentimentScore || 0,
      finalDecision.riskScore || 0
    ];
    
    const average = factors.reduce((sum, score) => sum + score, 0) / factors.length;
    return Math.min(Math.max(average, 0), 1);
  }

  /**
   * 生成推理过程
   */
  generateReasoning(finalDecision) {
    return {
      keyFactors: finalDecision.keyFactors || [],
      risks: finalDecision.risks || [],
      opportunities: finalDecision.opportunities || [],
      recommendation: finalDecision.recommendation || 'HOLD'
    };
  }

  /**
   * 获取备用分析（当主分析失败时）
   */
  getFallbackAnalysis(symbol) {
    return {
      symbol,
      timestamp: new Date().toISOString(),
      finalDecision: {
        action: 'HOLD',
        confidence: 0.5,
        reasoning: '系统正在学习中，建议保持观望'
      },
      status: 'fallback'
    };
  }
}

/**
 * 基本面分析师
 */
class FundamentalAnalyst {
  constructor(llmService) {
    this.llmService = llmService;
  }

  async analyze(symbol, context) {
    try {
      const stockData = context.stockData;
      
      // 构建包含真实数据的提示词
      let dataContext = '';
      if (stockData && stockData.price) {
        dataContext = `\n\n当前股票实时数据:
- 股票代码: ${symbol}
- 当前价格: ${stockData.price}元
- 涨跌幅: ${stockData.changePercent}%
- 成交量: ${stockData.volume}手
- 成交额: ${(stockData.amount / 100000000).toFixed(2)}亿元
- 今日最高: ${stockData.high}元
- 今日最低: ${stockData.low}元
- 开盘价: ${stockData.open}元`;
      }
      
      const prompt = `作为专业的基本面分析师，请分析股票${symbol}的投资价值：
${dataContext}

请从以下角度进行分析：
1. 财务指标评估（PE、PB、ROE、营收增长等）
2. 盈利能力分析
3. 负债情况和现金流
4. 行业地位和竞争优势
5. 估值水平评估

${stockData ? '请结合上述实时数据进行具体分析。' : ''}请提供具体的分析结论和投资建议，用中文回答。`;

      const analysis = await this.llmService.analyze({
        prompt,
        agentId: 'fundamentals',
        stockCode: symbol,
        temperature: 0.3,
        maxTokens: 1500
      });

      // 基于分析内容和真实数据计算分数
      const score = this.calculateScoreFromAnalysis(analysis, stockData);
      
      return {
        agent: 'fundamental',
        score,
        analysis: stockData ? 
          `基于${symbol}的实时数据分析:\n当前价格${stockData.price}元，${stockData.changePercent > 0 ? '上涨' : '下跌'}${Math.abs(stockData.changePercent)}%\n\n${analysis}` :
          analysis,
        factors: ['PE比率', '营收增长', '债务水平', '行业前景'],
        recommendation: score > 0.6 ? 'BUY' : score < 0.4 ? 'SELL' : 'HOLD',
        stockData: stockData // 返回股票数据供前端使用
      };
    } catch (error) {
      _logError('fundamental', 'analyze.fundamental', error, context.display);
      return this.getFallbackAnalysis(symbol, context.stockData);
    }
  }

  calculateScoreFromAnalysis(analysis, stockData) {
    // 简单的关键词评分逻辑
    const positiveKeywords = ['强劲', '健康', '增长', '优秀', '良好', '积极', '买入'];
    const negativeKeywords = ['疲弱', '下降', '风险', '担忧', '卖出', '谨慎'];
    
    let score = 0.5; // 基础分数
    
    // 基于分析内容评分
    positiveKeywords.forEach(keyword => {
      if (analysis.includes(keyword)) score += 0.05;
    });
    
    negativeKeywords.forEach(keyword => {
      if (analysis.includes(keyword)) score -= 0.05;
    });
    
    // 基于真实数据调整评分
    if (stockData && stockData.changePercent) {
      const change = parseFloat(stockData.changePercent);
      if (change > 5) score += 0.1;
      else if (change > 2) score += 0.05;
      else if (change < -5) score -= 0.1;
      else if (change < -2) score -= 0.05;
    }
    
    return Math.max(0.1, Math.min(0.9, score));
  }

  getFallbackAnalysis(symbol, stockData) {
    const score = Math.random() * 0.4 + 0.3;
    return {
      agent: 'fundamental',
      score,
      analysis: this.generateFundamentalAnalysis(symbol, score, stockData),
      factors: ['PE比率', '营收增长', '债务水平', '行业前景'],
      recommendation: score > 0.6 ? 'BUY' : score < 0.4 ? 'SELL' : 'HOLD',
      stockData: stockData
    };
  }

  generateFundamentalAnalysis(symbol, score, stockData) {
    let analysis = '';
    
    if (stockData && stockData.price) {
      analysis += `${symbol}当前价格${stockData.price}元，`;
      if (stockData.changePercent > 0) {
        analysis += `今日上涨${stockData.changePercent}%。`;
      } else if (stockData.changePercent < 0) {
        analysis += `今日下跌${Math.abs(stockData.changePercent)}%。`;
      } else {
        analysis += `今日平盘。`;
      }
      analysis += '\n\n';
    }
    
    if (score > 0.6) {
      analysis += `基本面分析显示${symbol}财务指标健康，盈利能力稳定，具有长期投资价值。建议关注公司业绩增长和行业发展趋势。`;
    } else if (score < 0.4) {
      analysis += `基本面分析显示${symbol}存在一定风险，需要谨慎对待。建议关注公司财务状况和行业竞争态势。`;
    } else {
      analysis += `基本面分析显示${symbol}整体表现中性，建议持续观察公司基本面变化和市场环境。`;
    }
    
    return analysis;
  }
}

/**
 * 技术分析师
 */
class TechnicalAnalyst {
  constructor(llmService) {
    this.llmService = llmService;
  }

  async analyze(symbol, context) {
    try {
      const stockData = context.stockData;
      
      // 构建包含真实数据的提示词
      let dataContext = '';
      if (stockData && stockData.price) {
        const priceChange = stockData.changePercent > 0 ? '上涨' : stockData.changePercent < 0 ? '下跌' : '平盘';
        dataContext = `\n\n当前股票实时技术数据:
- 股票代码: ${symbol}
- 当前价格: ${stockData.price}元 (${priceChange} ${Math.abs(stockData.changePercent)}%)
- 今日最高: ${stockData.high}元
- 今日最低: ${stockData.low}元
- 开盘价: ${stockData.open}元
- 昨收价: ${stockData.close}元
- 成交量: ${(stockData.volume / 10000).toFixed(2)}万手
- 成交额: ${(stockData.amount / 100000000).toFixed(2)}亿元
- 振幅: ${((stockData.high - stockData.low) / stockData.close * 100).toFixed(2)}%`;
      }
      
      const prompt = `作为专业的技术分析师，请分析股票${symbol}的技术面：
${dataContext}

请从以下角度进行分析：
1. 移动平均线（MA5、MA10、MA20、MA60）趋势
2. RSI指标和MACD指标分析
3. 成交量变化和价量关系
4. 支撑位和阻力位识别
5. 技术形态和趋势判断

${stockData ? '请结合上述实时技术数据进行具体分析，特别关注价格走势、成交量变化和技术指标信号。' : ''}请提供具体的技术分析结论和操作建议，用中文回答。`;

      const analysis = await this.llmService.analyze({
        prompt,
        agentId: 'market',
        stockCode: symbol,
        temperature: 0.3,
        maxTokens: 1500
      });

      const score = this.calculateScoreFromAnalysis(analysis, stockData);
      
      return {
        agent: 'technical',
        score,
        analysis: stockData ? 
          `基于${symbol}的实时技术数据分析:\n当前价格${stockData.price}元，${stockData.changePercent > 0 ? '上涨' : '下跌'}${Math.abs(stockData.changePercent)}%，成交量${(stockData.volume / 10000).toFixed(2)}万手\n\n${analysis}` :
          analysis,
        indicators: ['MA均线', 'RSI指标', 'MACD', '成交量'],
        signals: this.generateSignals(score, stockData),
        recommendation: score > 0.6 ? 'BUY' : score < 0.4 ? 'SELL' : 'HOLD',
        stockData: stockData
      };
    } catch (error) {
      _logError('technical', 'analyze.technical', error, context.display);
      return this.getFallbackAnalysis(symbol, context.stockData);
    }
  }

  calculateScoreFromAnalysis(analysis, stockData) {
    const positiveKeywords = ['突破', '金叉', '上涨', '多头', '买入', '强势'];
    const negativeKeywords = ['跌破', '死叉', '下跌', '空头', '卖出', '弱势'];
    
    let score = 0.5;
    
    // 基于分析内容评分
    positiveKeywords.forEach(keyword => {
      if (analysis.includes(keyword)) score += 0.05;
    });
    
    negativeKeywords.forEach(keyword => {
      if (analysis.includes(keyword)) score -= 0.05;
    });
    
    // 基于真实数据调整评分
    if (stockData) {
      const change = parseFloat(stockData.changePercent);
      const amplitude = ((stockData.high - stockData.low) / stockData.close * 100);
      
      // 涨跌幅影响
      if (change > 3) score += 0.15;
      else if (change > 1) score += 0.08;
      else if (change < -3) score -= 0.15;
      else if (change < -1) score -= 0.08;
      
      // 振幅影响(高振幅可能意味着活跃度)
      if (amplitude > 5) score += 0.05;
      
      // 价格位置(相对于今日高低点)
      const pricePosition = (stockData.price - stockData.low) / (stockData.high - stockData.low);
      if (pricePosition > 0.8) score += 0.05; // 接近最高点
      else if (pricePosition < 0.2) score -= 0.05; // 接近最低点
    }
    
    return Math.max(0.1, Math.min(0.9, score));
  }

  generateSignals(score, stockData) {
    const signals = [];
    
    if (stockData) {
      const change = parseFloat(stockData.changePercent);
      
      if (change > 3) {
        signals.push('强势上涨信号');
      } else if (change > 1) {
        signals.push('温和上涨信号');
      } else if (change < -3) {
        signals.push('强势下跌信号');
      } else if (change < -1) {
        signals.push('温和下跌信号');
      } else {
        signals.push('震荡整理信号');
      }
      
      // 成交量信号
      if (stockData.volume > 0) {
        signals.push('成交活跃');
      }
    }
    
    if (score > 0.7) {
      signals.push('技术面看多');
    } else if (score < 0.3) {
      signals.push('技术面看空');
    } else {
      signals.push('技术面中性');
    }
    
    return signals;
  }

  getFallbackAnalysis(symbol, stockData) {
    const score = Math.random() * 0.4 + 0.3;
    return {
      agent: 'technical',
      score,
      analysis: this.generateTechnicalAnalysis(symbol, score, stockData),
      indicators: ['MA均线', 'RSI指标', 'MACD', '成交量'],
      signals: this.generateSignals(score, stockData),
      recommendation: score > 0.6 ? 'BUY' : score < 0.4 ? 'SELL' : 'HOLD',
      stockData: stockData
    };
  }

  generateTechnicalAnalysis(symbol, score, stockData) {
    let analysis = '';
    
    if (stockData && stockData.price) {
      analysis += `${symbol}技术面分析:\n`;
      analysis += `当前价格${stockData.price}元，`;
      
      if (stockData.changePercent > 0) {
        analysis += `今日上涨${stockData.changePercent}%，`;
      } else if (stockData.changePercent < 0) {
        analysis += `今日下跌${Math.abs(stockData.changePercent)}%，`;
      } else {
        analysis += `今日平盘，`;
      }
      
      analysis += `成交量${(stockData.volume / 10000).toFixed(2)}万手。\n\n`;
    }
    
    if (score > 0.6) {
      analysis += `技术指标显示${symbol}处于强势状态，多项指标发出看涨信号。建议关注突破后的回踩确认机会。`;
    } else if (score < 0.4) {
      analysis += `技术指标显示${symbol}处于弱势状态，多项指标发出看跌信号。建议谨慎操作，注意风险控制。`;
    } else {
      analysis += `技术指标显示${symbol}处于震荡整理状态，方向尚不明朗。建议等待明确信号后再做决策。`;
    }
    
    return analysis;
  }
}

/**
 * 情绪分析师
 */
class SentimentAnalyst {
  constructor(llmService) {
    this.llmService = llmService;
  }

  async analyze(symbol, context) {
    try {
      const stockData = context.stockData;
      
      let dataContext = '';
      if (stockData && stockData.price) {
        const trend = stockData.changePercent > 0 ? '上涨' : stockData.changePercent < 0 ? '下跌' : '平盘';
        dataContext = `\n\n当前市场数据:
- 股票代码: ${symbol}
- 价格走势: ${trend} ${Math.abs(stockData.changePercent)}%
- 成交量: ${(stockData.volume / 10000).toFixed(2)}万手 (${stockData.volume > 100000 ? '活跃' : '一般'})
- 成交额: ${(stockData.amount / 100000000).toFixed(2)}亿元`;
      }
      
      const prompt = `作为专业的市场情绪分析师，请分析股票${symbol}的市场情绪：
${dataContext}

请从以下角度进行分析：
1. 社交媒体讨论热度和情绪倾向
2. 投资者信心指数变化
3. 市场恐慌/贪婪指数
4. 机构投资者情绪
5. 散户投资者行为分析

${stockData ? '请结合上述市场数据分析投资者情绪变化。' : ''}请提供具体的情绪分析结论和市场预期，用中文回答。`;

      const analysis = await this.llmService.analyze({
        prompt,
        agentId: 'social',
        stockCode: symbol,
        temperature: 0.4,
        maxTokens: 1500
      });

      const score = this.calculateScoreFromAnalysis(analysis, stockData);
      
      return {
        agent: 'sentiment',
        score,
        analysis: stockData ?
          `基于${symbol}的市场表现分析:\n今日${stockData.changePercent > 0 ? '上涨' : '下跌'}${Math.abs(stockData.changePercent)}%，成交${(stockData.volume / 10000).toFixed(2)}万手\n\n${analysis}` :
          analysis,
        sources: ['社交媒体', '新闻情绪', '投资者情绪'],
        mood: score > 0.6 ? '乐观' : score < 0.4 ? '悲观' : '中性',
        recommendation: score > 0.6 ? 'BUY' : score < 0.4 ? 'SELL' : 'HOLD',
        stockData: stockData
      };
    } catch (error) {
      _logError('sentiment', 'analyze.sentiment', error, context.display);
      return this.getFallbackAnalysis(symbol, context.stockData);
    }
  }

  calculateScoreFromAnalysis(analysis, stockData) {
    const positiveKeywords = ['乐观', '信心', '积极', '看好', '热情', '买入'];
    const negativeKeywords = ['悲观', '担忧', '恐慌', '看空', '谨慎', '卖出'];
    
    let score = 0.5;
    
    positiveKeywords.forEach(keyword => {
      if (analysis.includes(keyword)) score += 0.05;
    });
    
    negativeKeywords.forEach(keyword => {
      if (analysis.includes(keyword)) score -= 0.05;
    });
    
    // 基于真实数据调整
    if (stockData) {
      const change = parseFloat(stockData.changePercent);
      // 成交量活跃度影响情绪
      if (stockData.volume > 100000 && change > 0) score += 0.1;
      else if (stockData.volume > 100000 && change < 0) score -= 0.1;
    }
    
    return Math.max(0.1, Math.min(0.9, score));
  }

  getFallbackAnalysis(symbol, stockData) {
    const score = Math.random() * 0.4 + 0.3;
    return {
      agent: 'sentiment',
      score,
      analysis: this.generateSentimentAnalysis(symbol, score, stockData),
      sources: ['社交媒体', '新闻情绪', '投资者情绪'],
      mood: score > 0.6 ? '乐观' : score < 0.4 ? '悲观' : '中性',
      recommendation: score > 0.6 ? 'BUY' : score < 0.4 ? 'SELL' : 'HOLD',
      stockData: stockData
    };
  }

  generateSentimentAnalysis(symbol, score, stockData) {
    let analysis = '';
    
    if (stockData && stockData.price) {
      analysis += `${symbol}市场情绪分析:\n`;
      analysis += `今日${stockData.changePercent > 0 ? '上涨' : '下跌'}${Math.abs(stockData.changePercent)}%，`;
      analysis += `成交量${(stockData.volume / 10000).toFixed(2)}万手。\n\n`;
    }
    
    if (score > 0.6) {
      analysis += `市场情绪高涨，投资者信心充足。社交媒体讨论热度较高，整体看多情绪浓厚。`;
    } else if (score < 0.4) {
      analysis += `市场情绪低迷，投资者信心不足。观望情绪较重，谨慎态度明显。`;
    } else {
      analysis += `市场情绪中性，投资者观望情绪浓厚。多空分歧较大，等待方向明朗。`;
    }
    
    return analysis;
  }
}

/**
 * 新闻分析师
 */
class NewsAnalyst {
  constructor(llmService) {
    this.llmService = llmService;
  }

  async analyze(symbol, context) {
    try {
      const stockData = context.stockData;
      const finlightApiKey = context.finlightApiKey || '';

      // Fetch real news from Finlight.me if API key is available
      let realNewsContext = '';
      let realNewsArticles = [];
      if (finlightApiKey) {
        try {
          const finlightService = require('./finlightNewsService');
          const query = finlightService.buildQueryFromSymbol(symbol);
          realNewsArticles = await finlightService.fetchNews(query, finlightApiKey, { limit: 8 });
          if (realNewsArticles.length > 0) {
            realNewsContext = `\n\n===== 以下是来自 Finlight.me 的真实金融新闻 =====\n${finlightService.summarizeForPrompt(realNewsArticles)}\n===== 真实新闻结束 =====\n\n请基于以上真实新闻进行分析，不要编造新闻。`;
          }
        } catch (newsErr) {
          _dev('news', context.display).log('error', { action: 'finlight.fetch', status: 'fallback', detail: newsErr && newsErr.message });
        }
      }

      let dataContext = '';
      if (stockData && stockData.price) {
        dataContext = `\n\n当前股价表现:
- 股票代码: ${symbol}
- 当前价格: ${stockData.price}元
- 今日涨跌: ${stockData.changePercent > 0 ? '+' : ''}${stockData.changePercent}%
- 市场反应: ${Math.abs(stockData.changePercent) > 3 ? '强烈' : Math.abs(stockData.changePercent) > 1 ? '明显' : '平淡'}`;
      }

      const prompt = `作为专业的新闻分析师，请分析股票${symbol}的新闻面影响：
${dataContext}${realNewsContext}

请从以下角度进行分析：
1. 近期重要新闻事件和公告
2. 行业政策变化和影响
3. 公司经营动态和业绩预期
4. 市场传言和消息面分析
5. 新闻对股价的潜在影响

${stockData ? '请结合当前股价表现分析新闻面的影响程度。' : ''}${realNewsArticles.length > 0 ? '请重点结合上述真实新闻进行分析。' : ''}请提供具体的新闻分析结论和影响评估，用中文回答。`;

      const analysis = await this.llmService.analyze({
        prompt,
        agentId: 'news',
        stockCode: symbol,
        temperature: 0.3,
        maxTokens: 1500
      });

      const score = this.calculateScoreFromAnalysis(analysis, stockData);

      // Build real news events from Finlight articles if available
      const events = realNewsArticles.length > 0
        ? realNewsArticles.slice(0, 4).map(a => ({
            event: a.title,
            impact: (a.sentiment === 'positive' || (a.sentimentScore != null && a.sentimentScore > 0.6)) ? '正面'
              : (a.sentiment === 'negative' || (a.sentimentScore != null && a.sentimentScore < 0.4)) ? '负面' : '中性',
            importance: '高',
            source: a.source || '',
            url: a.url || '',
          }))
        : this.generateNewsEvents(symbol, score, stockData);

      return {
        agent: 'news',
        score,
        analysis: stockData ?
          `基于${symbol}的新闻面分析:\n当前价格${stockData.price}元，今日${stockData.changePercent > 0 ? '上涨' : '下跌'}${Math.abs(stockData.changePercent)}%\n\n${analysis}` :
          analysis,
        events,
        impact: score > 0.6 ? '正面' : score < 0.4 ? '负面' : '中性',
        recommendation: score > 0.6 ? 'BUY' : score < 0.4 ? 'SELL' : 'HOLD',
        stockData: stockData,
        newsSource: realNewsArticles.length > 0 ? 'finlight' : 'llm_general',
        newsCount: realNewsArticles.length,
      };
    } catch (error) {
      _logError('news', 'analyze.news', error, context.display);
      return this.getFallbackAnalysis(symbol, context.stockData);
    }
  }

  calculateScoreFromAnalysis(analysis, stockData) {
    const positiveKeywords = ['利好', '增长', '合作', '突破', '成功', '提升'];
    const negativeKeywords = ['利空', '下降', '风险', '问题', '亏损', '下调'];
    
    let score = 0.5;
    
    positiveKeywords.forEach(keyword => {
      if (analysis.includes(keyword)) score += 0.05;
    });
    
    negativeKeywords.forEach(keyword => {
      if (analysis.includes(keyword)) score -= 0.05;
    });
    
    // 基于股价反应调整
    if (stockData) {
      const change = parseFloat(stockData.changePercent);
      if (change > 5) score += 0.15; // 大涨可能有重大利好
      else if (change < -5) score -= 0.15; // 大跌可能有重大利空
    }
    
    return Math.max(0.1, Math.min(0.9, score));
  }

  getFallbackAnalysis(symbol, stockData) {
    const score = Math.random() * 0.4 + 0.3;
    return {
      agent: 'news',
      score,
      analysis: this.generateNewsAnalysis(symbol, score, stockData),
      events: this.generateNewsEvents(symbol, score, stockData),
      impact: score > 0.6 ? '正面' : score < 0.4 ? '负面' : '中性',
      recommendation: score > 0.6 ? 'BUY' : score < 0.4 ? 'SELL' : 'HOLD',
      stockData: stockData
    };
  }

  generateNewsAnalysis(symbol, score, stockData) {
    let analysis = '';
    
    if (stockData && stockData.price) {
      analysis += `${symbol}新闻面分析:\n`;
      analysis += `当前价格${stockData.price}元，`;
      
      if (Math.abs(stockData.changePercent) > 3) {
        analysis += `今日${stockData.changePercent > 0 ? '大涨' : '大跌'}${Math.abs(stockData.changePercent)}%，市场反应强烈。\n\n`;
      } else {
        analysis += `今日${stockData.changePercent > 0 ? '上涨' : '下跌'}${Math.abs(stockData.changePercent)}%。\n\n`;
      }
    }
    
    if (score > 0.6) {
      analysis += `近期利好消息频出，市场预期向好。公司基本面改善，行业政策支持，整体新闻面偏正面。`;
    } else if (score < 0.4) {
      analysis += `面临负面新闻冲击，短期承压。需关注风险因素和不确定性，谨慎对待。`;
    } else {
      analysis += `新闻面相对平静，无重大利好利空。市场处于消息真空期，等待新的催化剂。`;
    }
    
    return analysis;
  }

  generateNewsEvents(symbol, score, stockData) {
    const events = [
      '业绩预告发布',
      '行业政策变化',
      '管理层变动',
      '合作协议签署'
    ];
    
    return events.map(event => ({
      event,
      impact: score > 0.5 ? '正面' : '负面',
      importance: Math.random() > 0.5 ? '高' : '中'
    }));
  }
}

/**
 * 多头研究员
 */
class BullResearcher {
  constructor(llmService) {
    this.llmService = llmService;
  }

  async research(analysisResults, symbol) {
    try {
      const prompt = `作为多头研究员，请基于以下分析结果为股票${symbol}提供看多观点：

基本面分析：${analysisResults.fundamental?.analysis || '暂无'}
技术面分析：${analysisResults.technical?.analysis || '暂无'}
情绪分析：${analysisResults.sentiment?.analysis || '暂无'}
新闻分析：${analysisResults.news?.analysis || '暂无'}

请从多头角度分析：
1. 找出所有积极因素和投资机会
2. 提供看多的核心论据
3. 设定合理的目标价位
4. 分析上涨的催化剂

请用中文回答，保持乐观但理性的分析态度。`;

      const analysis = await this.llmService.analyze({
        prompt,
        agentId: 'strategy',
        stockCode: symbol,
        temperature: 0.4,
        maxTokens: 1500
      });

      const positiveFactors = this.extractPositiveFactors(analysisResults);
      
      return {
        agent: 'bull_researcher',
        mainArgument: `${symbol}具有明显的投资机会`,
        analysis,
        evidence: positiveFactors,
        targetPrice: this.calculateTargetPrice(symbol, 'bull'),
        timeHorizon: '3-6个月',
        confidence: 0.7
      };
    } catch (error) {
      _logError('bull_researcher', 'research.bull', error);
      return this.getFallbackResearch(analysisResults, symbol);
    }
  }

  getFallbackResearch(analysisResults, symbol) {
    const positiveFactors = this.extractPositiveFactors(analysisResults);
    
    return {
      agent: 'bull_researcher',
      mainArgument: `${symbol}具有明显的投资机会`,
      evidence: positiveFactors,
      targetPrice: this.calculateTargetPrice(symbol, 'bull'),
      timeHorizon: '3-6个月',
      confidence: 0.7
    };
  }

  async rebuttal(bearView, symbol) {
    try {
      const prompt = `作为多头研究员，请反驳以下空头观点：

空头观点：${bearView.mainArgument}
空头证据：${bearView.evidence?.join(', ') || ''}

请提供有力的反驳论据，强调${symbol}的投资价值和上涨潜力。用中文回答。`;

      const rebuttalAnalysis = await this.llmService.analyze({
        prompt,
        agentId: 'strategy',
        stockCode: symbol,
        temperature: 0.5,
        maxTokens: 1000
      });

      return {
        argument: rebuttalAnalysis,
        evidence: ['基本面改善趋势', '技术面突破信号', '政策支持预期']
      };
    } catch (error) {
      return {
        argument: `空头观点过于悲观，忽略了${symbol}的长期价值`,
        evidence: ['基本面改善趋势', '技术面突破信号', '政策支持预期']
      };
    }
  }

  extractPositiveFactors(analysisResults) {
    const factors = [];
    
    if (analysisResults.fundamental?.score > 0.5) {
      factors.push('基本面强劲');
    }
    if (analysisResults.technical?.score > 0.5) {
      factors.push('技术面向好');
    }
    if (analysisResults.sentiment?.score > 0.5) {
      factors.push('市场情绪积极');
    }
    
    return factors.length > 0 ? factors : ['市场存在超跌反弹机会'];
  }

  calculateTargetPrice(symbol, bias) {
    const priceMap = { '300': 4660, '000001': 3350, '399001': 10800, '600519': 1680, '000858': 148 };
    const clean = symbol.replace(/^(sh|sz)/i, '');
    const basePrice = priceMap[clean] || Object.entries(priceMap).find(([k]) => symbol.includes(k))?.[1] || 10;
    return bias === 'bull' ? basePrice * 1.15 : basePrice * 0.85;
  }
}

/**
 * 空头研究员
 */
class BearResearcher {
  constructor(llmService) {
    this.llmService = llmService;
  }

  async research(analysisResults, symbol) {
    try {
      const prompt = `作为空头研究员，请基于以下分析结果为股票${symbol}提供看空观点：

基本面分析：${analysisResults.fundamental?.analysis || '暂无'}
技术面分析：${analysisResults.technical?.analysis || '暂无'}
情绪分析：${analysisResults.sentiment?.analysis || '暂无'}
新闻分析：${analysisResults.news?.analysis || '暂无'}

请从空头角度分析：
1. 识别所有风险因素和负面信号
2. 提供看空的核心论据
3. 分析下跌的风险点
4. 评估潜在的催化剂

请用中文回答，保持谨慎但客观的分析态度。`;

      const analysis = await this.llmService.analyze({
        prompt,
        agentId: 'risk',
        stockCode: symbol,
        temperature: 0.4,
        maxTokens: 1500
      });

      const negativeFactors = this.extractNegativeFactors(analysisResults);
      
      return {
        agent: 'bear_researcher',
        mainArgument: `${symbol}存在明显的下行风险`,
        analysis,
        evidence: negativeFactors,
        targetPrice: this.calculateTargetPrice(symbol, 'bear'),
        timeHorizon: '1-3个月',
        confidence: 0.6,
        rebuttalToBull: '多头过于乐观，忽略了潜在风险'
      };
    } catch (error) {
      _logError('bear_researcher', 'research.bear', error);
      return this.getFallbackResearch(analysisResults, symbol);
    }
  }

  getFallbackResearch(analysisResults, symbol) {
    const negativeFactors = this.extractNegativeFactors(analysisResults);
    
    return {
      agent: 'bear_researcher',
      mainArgument: `${symbol}存在明显的下行风险`,
      evidence: negativeFactors,
      targetPrice: this.calculateTargetPrice(symbol, 'bear'),
      timeHorizon: '1-3个月',
      confidence: 0.6,
      rebuttalToBull: '多头过于乐观，忽略了潜在风险'
    };
  }

  extractNegativeFactors(analysisResults) {
    const factors = [];
    
    if (analysisResults.fundamental?.score < 0.5) {
      factors.push('基本面疲弱');
    }
    if (analysisResults.technical?.score < 0.5) {
      factors.push('技术面走弱');
    }
    if (analysisResults.sentiment?.score < 0.5) {
      factors.push('市场情绪低迷');
    }
    
    return factors.length > 0 ? factors : ['市场整体风险偏好下降'];
  }

  calculateTargetPrice(symbol, bias) {
    const priceMap = { '300': 4660, '000001': 3350, '399001': 10800, '600519': 1680, '000858': 148 };
    const clean = symbol.replace(/^(sh|sz)/i, '');
    const basePrice = priceMap[clean] || Object.entries(priceMap).find(([k]) => symbol.includes(k))?.[1] || 10;
    return bias === 'bull' ? basePrice * 1.15 : basePrice * 0.85;
  }
}

/**
 * 交易员
 */
class TraderAgent {
  constructor(llmService) {
    this.llmService = llmService;
  }

  async makeDecision(researchResults, symbol) {
    try {
      const { bullView, bearView, consensus } = researchResults;
      
      const prompt = `作为专业交易员，请基于以下研究结果为股票${symbol}制定交易策略：

多头观点：${bullView.mainArgument}
多头证据：${bullView.evidence?.join(', ') || ''}
多头目标价：${bullView.targetPrice}

空头观点：${bearView.mainArgument}
空头证据：${bearView.evidence?.join(', ') || ''}
空头目标价：${bearView.targetPrice}

请提供：
1. 明确的交易决策（买入/卖出/持有）
2. 仓位管理建议
3. 止损和止盈设置
4. 交易理由和风险提示

请用中文回答，提供具体可执行的交易建议。`;

      const analysis = await this.llmService.analyze({
        prompt,
        agentId: 'strategy',
        stockCode: symbol,
        temperature: 0.3,
        maxTokens: 1500
      });

      // 综合多空观点做出决策
      const bullScore = bullView.confidence || 0.5;
      const bearScore = bearView.confidence || 0.5;
      const netScore = bullScore - bearScore;
      
      let action = 'HOLD';
      let confidence = 0.5;
      
      if (netScore > 0.2) {
        action = 'BUY';
        confidence = Math.min(bullScore, 0.9);
      } else if (netScore < -0.2) {
        action = 'SELL';
        confidence = Math.min(bearScore, 0.9);
      }
      
      return {
        agent: 'trader',
        action,
        confidence,
        analysis,
        reasoning: this.generateTradeReasoning(action, bullView, bearView),
        positionSize: this.calculatePositionSize(confidence),
        stopLoss: this.calculateStopLoss(action),
        takeProfit: this.calculateTakeProfit(action)
      };
    } catch (error) {
      _logError('trader', 'trade.decision', error);
      return this.getFallbackDecision(researchResults, symbol);
    }
  }

  getFallbackDecision(researchResults, symbol) {
    const { bullView, bearView } = researchResults;
    const bullScore = bullView.confidence || 0.5;
    const bearScore = bearView.confidence || 0.5;
    const netScore = bullScore - bearScore;
    
    let action = 'HOLD';
    let confidence = 0.5;
    
    if (netScore > 0.2) {
      action = 'BUY';
      confidence = Math.min(bullScore, 0.9);
    } else if (netScore < -0.2) {
      action = 'SELL';
      confidence = Math.min(bearScore, 0.9);
    }
    
    return {
      agent: 'trader',
      action,
      confidence,
      reasoning: this.generateTradeReasoning(action, bullView, bearView),
      positionSize: this.calculatePositionSize(confidence),
      stopLoss: this.calculateStopLoss(action),
      takeProfit: this.calculateTakeProfit(action)
    };
  }

  generateTradeReasoning(action, bullView, bearView) {
    switch (action) {
      case 'BUY':
        return `多头观点更有说服力：${bullView.mainArgument}`;
      case 'SELL':
        return `空头观点更有说服力：${bearView.mainArgument}`;
      default:
        return '多空观点分歧较大，建议观望等待更明确信号';
    }
  }

  calculatePositionSize(confidence) {
    return Math.round(confidence * 100); // 百分比
  }

  calculateStopLoss(action) {
    return action === 'BUY' ? -5 : action === 'SELL' ? 5 : 0; // 百分比
  }

  calculateTakeProfit(action) {
    return action === 'BUY' ? 10 : action === 'SELL' ? -10 : 0; // 百分比
  }
}

/**
 * 风险管理员
 */
class RiskManager {
  constructor(llmService) {
    this.llmService = llmService;
  }

  async assess(tradeDecision, symbol) {
    try {
      const prompt = `作为风险管理专家，请评估股票${symbol}的交易风险：

交易决策：${tradeDecision.action}
置信度：${tradeDecision.confidence}
仓位建议：${tradeDecision.positionSize}%
交易理由：${tradeDecision.reasoning}

请从以下角度进行风险评估：
1. 市场风险和系统性风险
2. 个股特定风险
3. 流动性风险
4. 仓位管理风险
5. 风险控制建议

请提供具体的风险评估和管理建议，用中文回答。`;

      const analysis = await this.llmService.analyze({
        prompt,
        agentId: 'risk',
        stockCode: symbol,
        temperature: 0.2,
        maxTokens: 1500
      });

      const riskScore = this.calculateRiskScore(tradeDecision);
      const riskLevel = this.getRiskLevel(riskScore);
      
      // 风险调整
      const adjustedDecision = this.adjustForRisk(tradeDecision, riskScore);
      
      return {
        agent: 'risk_manager',
        originalDecision: tradeDecision,
        riskScore,
        riskLevel,
        analysis,
        adjustedDecision,
        riskFactors: this.identifyRiskFactors(symbol),
        recommendation: this.getFinalRecommendation(adjustedDecision, riskLevel)
      };
    } catch (error) {
      _logError('risk_manager', 'risk.assess', error);
      return this.getFallbackAssessment(tradeDecision, symbol);
    }
  }

  getFallbackAssessment(tradeDecision, symbol) {
    const riskScore = this.calculateRiskScore(tradeDecision);
    const riskLevel = this.getRiskLevel(riskScore);
    const adjustedDecision = this.adjustForRisk(tradeDecision, riskScore);
    
    return {
      agent: 'risk_manager',
      originalDecision: tradeDecision,
      riskScore,
      riskLevel,
      adjustedDecision,
      riskFactors: this.identifyRiskFactors(symbol),
      recommendation: this.getFinalRecommendation(adjustedDecision, riskLevel)
    };
  }

  calculateRiskScore(tradeDecision) {
    // 基于置信度和市场条件计算风险分数
    const baseRisk = 1 - (tradeDecision.confidence || 0.5);
    const actionRisk = tradeDecision.action === 'HOLD' ? 0.2 : 0.5;
    
    return Math.min(baseRisk + actionRisk, 1);
  }

  getRiskLevel(riskScore) {
    if (riskScore > 0.7) return '高风险';
    if (riskScore > 0.4) return '中风险';
    return '低风险';
  }

  adjustForRisk(tradeDecision, riskScore) {
    const adjusted = { ...tradeDecision };
    
    // 高风险时降低仓位
    if (riskScore > 0.7) {
      adjusted.positionSize = Math.round(adjusted.positionSize * 0.5);
    } else if (riskScore > 0.4) {
      adjusted.positionSize = Math.round(adjusted.positionSize * 0.7);
    }
    
    return adjusted;
  }

  identifyRiskFactors(symbol) {
    return [
      '市场波动性',
      '流动性风险',
      '基本面不确定性',
      '技术面信号冲突'
    ];
  }

  getFinalRecommendation(adjustedDecision, riskLevel) {
    return {
      action: adjustedDecision.action,
      confidence: adjustedDecision.confidence,
      positionSize: adjustedDecision.positionSize,
      riskLevel,
      advice: this.generateAdvice(adjustedDecision, riskLevel)
    };
  }

  generateAdvice(decision, riskLevel) {
    const riskWarning = riskLevel === '高风险' ? '⚠️ 高风险操作，请谨慎！' : '';
    return `${decision.reasoning} ${riskWarning}`;
  }
}

module.exports = new TradingAgentsService();
