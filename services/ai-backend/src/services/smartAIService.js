/**
 * 智能AI服务 - 小K对话核心
 * 支持在线AI、本地模型和智能规则三种模式
 */

class SmartAIService {
  constructor() {
    this.systemPrompt = `你是小K，一个专业的金融量化分析助手。

你的职责：
1. 基于智能体团队的分析结果，回答用户关于股票投资的问题
2. 提供专业、客观、负责任的投资建议
3. 解释技术指标、基本面数据和市场趋势
4. 评估投资风险并给出风险控制建议

回答风格：
- 专业但易懂，避免过度专业术语
- 客观中立，不做绝对性判断
- 提供数据支持，引用分析结果
- 强调风险提示
- 回答简洁明了，重点突出

重要原则：
- 投资有风险，决策需谨慎
- 不保证收益，不承诺回报
- 建议仅供参考，不构成投资建议
- 始终提醒用户理性投资`
  }

  /**
   * 生成智能回答
   * @param {string} question - 用户问题
   * @param {object} analysisContext - 分析上下文
   * @param {object} tokens - AI Token配置
   * @param {array} conversationHistory - 对话历史
   * @returns {Promise<object>} 回答结果
   */
  async generateAnswer(question, analysisContext, tokens = null, conversationHistory = []) {
    try {
      // 优先使用在线AI
      if (tokens && this.hasValidToken(tokens)) {
        console.log('📡 使用在线AI模式')
        return await this.useOnlineAI(question, analysisContext, tokens, conversationHistory)
      }

      // 降级到智能规则引擎
      console.log('🤖 使用智能规则引擎')
      return this.useSmartRules(question, analysisContext)

    } catch (error) {
      console.error('AI服务错误:', error)
      // 最终降级
      return this.useFallback(question, analysisContext)
    }
  }

  /**
   * 在线AI模式
   */
  async useOnlineAI(question, analysisContext, tokens, conversationHistory) {
    // 构建用户Prompt
    const userPrompt = this.buildUserPrompt(question, analysisContext)

    // 尝试多个AI提供商
    const providers = this.getAvailableProviders(tokens)

    for (const provider of providers) {
      try {
        const answer = await this.callAIProvider(provider, userPrompt, conversationHistory)
        return {
          success: true,
          answer,
          model: provider.model,
          provider: provider.name,
          mode: 'online'
        }
      } catch (error) {
        console.warn(`${provider.name} 调用失败:`, error.message)
        continue
      }
    }

    throw new Error('所有AI提供商均不可用')
  }

  /**
   * 智能规则引擎
   */
  useSmartRules(question, analysisContext) {
    const q = question.toLowerCase()

    // 意图识别
    const intent = this.detectIntent(q)

    // 根据意图生成回答
    let answer = ''
    switch (intent) {
      case 'recommendation':
        answer = this.generateRecommendationAnswer(analysisContext)
        break
      case 'risk':
        answer = this.generateRiskAnswer(analysisContext)
        break
      case 'technical':
        answer = this.generateTechnicalAnswer(analysisContext)
        break
      case 'fundamental':
        answer = this.generateFundamentalAnswer(analysisContext)
        break
      case 'strategy':
        answer = this.generateStrategyAnswer(analysisContext)
        break
      case 'timing':
        answer = this.generateTimingAnswer(analysisContext)
        break
      case 'comparison':
        answer = this.generateComparisonAnswer(analysisContext)
        break
      default:
        answer = this.generateGeneralAnswer(question, analysisContext)
    }

    return {
      success: true,
      answer,
      model: '智能规则引擎',
      provider: '本地',
      mode: 'rules'
    }
  }

  /**
   * 兜底模式
   */
  useFallback(question, analysisContext) {
    return {
      success: true,
      answer: `感谢您的提问。基于对 ${analysisContext.stockCode} 的分析，我们的建议是"${analysisContext.recommendation}"，置信度为 ${analysisContext.confidence}%。\n\n${analysisContext.summary}\n\n如需了解更多详情，请查看各智能体的详细分析报告。\n\n💡 提示：配置AI Token可获得更智能的对话体验。`,
      model: '基础模式',
      provider: '本地',
      mode: 'fallback'
    }
  }

  /**
   * 意图识别
   */
  detectIntent(question) {
    const patterns = {
      recommendation: /推荐|建议|买|卖|持有|操作|怎么办|如何|应该/,
      risk: /风险|危险|安全|波动|亏损|风控|止损/,
      technical: /技术|指标|趋势|K线|均线|MACD|RSI|KDJ|布林|成交量/,
      fundamental: /基本面|财务|估值|市盈率|净资产|ROE|营收|利润|业绩/,
      strategy: /策略|仓位|止损|止盈|入场|出场|加仓|减仓/,
      timing: /时机|什么时候|现在|合适|时间点|买点|卖点/,
      comparison: /对比|比较|相比|和.*比|哪个好|选择/
    }

    for (const [intent, pattern] of Object.entries(patterns)) {
      if (pattern.test(question)) {
        return intent
      }
    }

    return 'general'
  }

  /**
   * 生成投资建议回答
   */
  generateRecommendationAnswer(analysis) {
    const { stockCode, recommendation, confidence, agentResults } = analysis

    // 找到关键智能体的意见
    const marketAgent = agentResults.find(a => a.agentId === 'market')
    const fundAgent = agentResults.find(a => a.agentId === 'fundamentals')
    const riskAgent = agentResults.find(a => a.agentId === 'risk')

    let answer = `📊 关于 ${stockCode} 的投资建议：\n\n`
    answer += `🎯 综合建议：${recommendation}（置信度 ${confidence}%）\n\n`
    answer += `📈 分析依据：\n`

    if (marketAgent) {
      answer += `• 技术面：${marketAgent.analysis.substring(0, 50)}...\n`
    }
    if (fundAgent) {
      answer += `• 基本面：${fundAgent.analysis.substring(0, 50)}...\n`
    }
    if (riskAgent) {
      answer += `• 风险评估：${riskAgent.analysis.substring(0, 50)}...\n`
    }

    answer += `\n💡 操作建议：\n`
    if (recommendation.includes('买入')) {
      answer += `• 建议分批建仓，不要一次性买入\n`
      answer += `• 控制仓位在30-50%\n`
      answer += `• 设置止损位，控制风险\n`
    } else if (recommendation.includes('持有')) {
      answer += `• 继续持有，观察市场变化\n`
      answer += `• 关注重要支撑位和阻力位\n`
      answer += `• 根据市场情况适时调整\n`
    } else if (recommendation.includes('卖出')) {
      answer += `• 建议分批减仓\n`
      answer += `• 保留部分仓位观察\n`
      answer += `• 及时止盈，落袋为安\n`
    }

    answer += `\n⚠️ 风险提示：投资有风险，决策需谨慎。以上建议仅供参考，不构成投资建议。`

    return answer
  }

  /**
   * 生成风险评估回答
   */
  generateRiskAnswer(analysis) {
    const { stockCode, confidence, agentResults } = analysis

    const riskAgent = agentResults.find(a => a.agentId === 'risk')
    const marketAgent = agentResults.find(a => a.agentId === 'market')

    let answer = `⚠️ ${stockCode} 风险评估：\n\n`

    if (riskAgent) {
      answer += `🔍 风险分析师评估：\n${riskAgent.analysis}\n\n`
      if (riskAgent.keyFindings && riskAgent.keyFindings.length > 0) {
        answer += `关键风险点：\n`
        riskAgent.keyFindings.forEach(finding => {
          answer += `• ${finding}\n`
        })
        answer += `\n`
      }
    }

    // 根据置信度评估风险等级
    let riskLevel = '中等'
    if (confidence >= 80) {
      riskLevel = '较低'
    } else if (confidence < 60) {
      riskLevel = '较高'
    }

    answer += `📊 综合风险等级：${riskLevel}\n\n`
    answer += `💡 风险控制建议：\n`
    answer += `• 设置止损位：建议在 -8% 到 -10%\n`
    answer += `• 仓位控制：不超过总资金的 ${confidence >= 70 ? '50%' : '30%'}\n`
    answer += `• 分散投资：不要把所有资金投入单一标的\n`
    answer += `• 定期复盘：每周检查一次持仓情况\n\n`
    answer += `⚠️ 记住：任何投资都存在风险，请根据自身风险承受能力做出决策。`

    return answer
  }

  /**
   * 生成技术分析回答
   */
  generateTechnicalAnswer(analysis) {
    const { stockCode, agentResults } = analysis

    const marketAgent = agentResults.find(a => a.agentId === 'market')

    let answer = `📈 ${stockCode} 技术分析：\n\n`

    if (marketAgent) {
      answer += `${marketAgent.analysis}\n\n`
      if (marketAgent.keyFindings && marketAgent.keyFindings.length > 0) {
        answer += `关键技术信号：\n`
        marketAgent.keyFindings.forEach(finding => {
          answer += `• ${finding}\n`
        })
        answer += `\n`
      }
    } else {
      answer += `技术分析师未参与本次分析。建议重新分析时选择"市场分析师"智能体。\n\n`
    }

    answer += `💡 技术面解读：\n`
    answer += `• 趋势判断：观察K线形态和均线系统\n`
    answer += `• 支撑阻力：关注关键价格位\n`
    answer += `• 成交量：量价配合情况\n`
    answer += `• 技术指标：MACD、RSI、KDJ等信号\n\n`
    answer += `📊 建议：技术分析需结合基本面和市场情绪综合判断。`

    return answer
  }

  /**
   * 生成基本面分析回答
   */
  generateFundamentalAnswer(analysis) {
    const { stockCode, agentResults } = analysis

    const fundAgent = agentResults.find(a => a.agentId === 'fundamentals')

    let answer = `📊 ${stockCode} 基本面分析：\n\n`

    if (fundAgent) {
      answer += `${fundAgent.analysis}\n\n`
      if (fundAgent.keyFindings && fundAgent.keyFindings.length > 0) {
        answer += `关键财务指标：\n`
        fundAgent.keyFindings.forEach(finding => {
          answer += `• ${finding}\n`
        })
        answer += `\n`
      }
    } else {
      answer += `基本面分析师未参与本次分析。建议重新分析时选择"基本面分析师"智能体。\n\n`
    }

    answer += `💡 基本面关注点：\n`
    answer += `• 财务健康：资产负债率、现金流\n`
    answer += `• 盈利能力：ROE、净利润增长率\n`
    answer += `• 估值水平：市盈率、市净率\n`
    answer += `• 行业地位：市场份额、竞争优势\n\n`
    answer += `📈 建议：基本面分析适合中长期投资决策。`

    return answer
  }

  /**
   * 生成策略建议回答
   */
  generateStrategyAnswer(analysis) {
    const { stockCode, recommendation, confidence } = analysis

    let answer = `🎯 ${stockCode} 操作策略：\n\n`

    if (recommendation.includes('买入')) {
      answer += `📈 建仓策略：\n`
      answer += `• 分批买入：分3-4次建仓，降低成本\n`
      answer += `• 仓位控制：首次建仓20-30%，根据走势加仓\n`
      answer += `• 买入时机：回调到支撑位附近\n`
      answer += `• 止损设置：跌破支撑位-8%止损\n\n`
    } else if (recommendation.includes('持有')) {
      answer += `🔄 持仓策略：\n`
      answer += `• 继续持有，观察市场变化\n`
      answer += `• 设置移动止盈：保护已有利润\n`
      answer += `• 关注关键位：突破阻力位可加仓\n`
      answer += `• 跌破支撑位考虑减仓\n\n`
    } else if (recommendation.includes('卖出')) {
      answer += `📉 减仓策略：\n`
      answer += `• 分批卖出：避免一次性清仓\n`
      answer += `• 保留观察仓：留10-20%观察后续\n`
      answer += `• 止盈位：达到目标价位及时止盈\n`
      answer += `• 反弹卖出：等待反弹到阻力位\n\n`
    }

    answer += `💡 通用策略原则：\n`
    answer += `• 严格执行止损，保护本金\n`
    answer += `• 不要追涨杀跌，保持理性\n`
    answer += `• 定期复盘，总结经验\n`
    answer += `• 控制情绪，避免冲动交易\n\n`
    answer += `⚠️ 策略需根据实际情况灵活调整，不可机械执行。`

    return answer
  }

  /**
   * 生成时机判断回答
   */
  generateTimingAnswer(analysis) {
    const { stockCode, recommendation, confidence } = analysis

    let answer = `⏰ ${stockCode} 时机判断：\n\n`
    answer += `当前建议：${recommendation}（置信度 ${confidence}%）\n\n`

    if (recommendation.includes('买入')) {
      if (confidence >= 75) {
        answer += `✅ 时机评估：较好的买入时机\n\n`
        answer += `理由：\n`
        answer += `• 多个智能体给出积极信号\n`
        answer += `• 技术面和基本面配合良好\n`
        answer += `• 风险可控，上涨概率较大\n\n`
        answer += `建议：可以考虑分批建仓\n`
      } else {
        answer += `⚠️ 时机评估：可以买入，但需谨慎\n\n`
        answer += `理由：\n`
        answer += `• 存在一定不确定性\n`
        answer += `• 建议等待更明确的信号\n`
        answer += `• 或者小仓位试探性买入\n\n`
        answer += `建议：控制仓位，观察后续走势\n`
      }
    } else if (recommendation.includes('持有')) {
      answer += `🔄 时机评估：暂时观望为宜\n\n`
      answer += `理由：\n`
      answer += `• 当前没有明确的买卖信号\n`
      answer += `• 市场处于震荡或调整阶段\n`
      answer += `• 等待更好的时机\n\n`
      answer += `建议：持有观望，关注关键位突破\n`
    } else {
      answer += `⚠️ 时机评估：建议考虑减仓\n\n`
      answer += `理由：\n`
      answer += `• 风险信号增加\n`
      answer += `• 上涨动能减弱\n`
      answer += `• 及时止盈或止损\n\n`
      answer += `建议：分批减仓，保护利润\n`
    }

    answer += `\n💡 时机把握要点：\n`
    answer += `• 不要试图抓住最低点和最高点\n`
    answer += `• 关注趋势，顺势而为\n`
    answer += `• 耐心等待，不要急于操作\n`

    return answer
  }

  /**
   * 生成对比分析回答
   */
  generateComparisonAnswer(analysis) {
    const { stockCode, agentResults } = analysis

    let answer = `📊 ${stockCode} 对比分析：\n\n`
    answer += `当前我只分析了 ${stockCode} 这一只标的。如需对比分析，请：\n\n`
    answer += `1. 分别分析多只股票\n`
    answer += `2. 对比各项指标：\n`
    answer += `   • 技术面评分\n`
    answer += `   • 基本面评分\n`
    answer += `   • 风险等级\n`
    answer += `   • 投资建议\n\n`
    answer += `💡 对比维度建议：\n`
    answer += `• 同行业对比：选择同行业龙头股\n`
    answer += `• 估值对比：市盈率、市净率\n`
    answer += `• 成长性对比：营收和利润增长率\n`
    answer += `• 风险对比：波动率、beta系数\n\n`
    answer += `📈 您可以重新分析其他股票，然后进行对比。`

    return answer
  }

  /**
   * 生成通用回答
   */
  generateGeneralAnswer(question, analysis) {
    const { stockCode, recommendation, confidence, summary, agentResults } = analysis

    let answer = `关于 ${stockCode} 的分析：\n\n`
    answer += `${summary}\n\n`
    answer += `📊 投资建议：${recommendation}（置信度 ${confidence}%）\n\n`

    if (agentResults && agentResults.length > 0) {
      answer += `参与分析的智能体：\n`
      agentResults.forEach(agent => {
        answer += `• ${agent.agentName}（评分 ${agent.score}/10）\n`
      })
      answer += `\n`
    }

    answer += `💡 您可以询问：\n`
    answer += `• "这只股票风险大吗？"\n`
    answer += `• "技术指标怎么样？"\n`
    answer += `• "现在适合买入吗？"\n`
    answer += `• "应该如何操作？"\n\n`
    answer += `我会基于分析结果为您详细解答。`

    return answer
  }

  /**
   * 构建用户Prompt
   */
  buildUserPrompt(question, analysisContext) {
    const { stockCode, recommendation, confidence, agentResults, stockData } = analysisContext

    let prompt = `股票代码：${stockCode}\n`
    prompt += `投资建议：${recommendation}\n`
    prompt += `置信度：${confidence}%\n\n`

    if (stockData) {
      prompt += `实时数据：\n`
      prompt += `• 最新价：${stockData.latestPrice || '未知'}\n`
      prompt += `• 涨跌幅：${stockData.changePercent || '未知'}%\n\n`
    }

    prompt += `智能体分析结果：\n`
    agentResults.forEach(agent => {
      prompt += `\n【${agent.agentName}】（评分 ${agent.score}/10）\n`
      prompt += `${agent.analysis}\n`
      if (agent.keyFindings && agent.keyFindings.length > 0) {
        prompt += `关键发现：${agent.keyFindings.join('、')}\n`
      }
    })

    prompt += `\n用户问题：${question}\n\n`
    prompt += `请基于以上分析结果，用专业但易懂的语言回答用户的问题。回答要简洁明了，重点突出，并提供具体的操作建议。`

    return prompt
  }

  /**
   * 调用AI提供商
   */
  async callAIProvider(provider, userPrompt, conversationHistory) {
    // 这里实现具体的AI API调用
    // 支持OpenAI、Claude、Gemini等
    throw new Error('AI提供商调用未实现')
  }

  /**
   * 获取可用的AI提供商
   */
  getAvailableProviders(tokens) {
    const providers = []

    if (tokens.openai) {
      providers.push({ name: 'OpenAI', model: 'gpt-4-turbo', token: tokens.openai })
    }
    if (tokens.anthropic) {
      providers.push({ name: 'Claude', model: 'claude-3-sonnet', token: tokens.anthropic })
    }
    if (tokens.google) {
      providers.push({ name: 'Gemini', model: 'gemini-pro', token: tokens.google })
    }
    if (tokens.baidu) {
      providers.push({ name: '文心一言', model: 'ernie-bot-4', token: tokens.baidu })
    }

    return providers
  }

  /**
   * 检查是否有有效Token
   */
  hasValidToken(tokens) {
    return tokens && Object.values(tokens).some(token => token && token.trim().length > 0)
  }
}

module.exports = new SmartAIService()
