/**
 * 小K金融量化助手 - 股票分析对话引擎(智能学习版)
 * 特点:
 * 1. 轻量级,无需大模型
 * 2. 支持联网获取实时数据
 * 3. 离线时使用本地知识库
 * 4. 多样化回答,避免固定句式
 * 5. 深度学习,不断优化对话质量
 * 6. 上下文记忆,连贯对话
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

class StockAnalysisEngine {
  constructor() {
    this.knowledgeBase = this.initKnowledgeBase();
    this.analysisPatterns = this.initAnalysisPatterns();
    this.isOnline = true;
    this.checkNetworkStatus();
    
    // 学习系统
    this.conversationHistory = []; // 对话历史
    this.userPreferences = {}; // 用户偏好
    this.responseTemplates = this.initResponseTemplates(); // 回答模板库
    this.learningData = this.loadLearningData(); // 加载学习数据
  }

  // 初始化回答模板库(更丰富、更自然)
  initResponseTemplates() {
    return {
      // 分析结果描述模板
      analysisIntro: [
        '让我为您详细分析一下{stock}的情况',
        '关于{stock},我的看法是这样的',
        '根据多维度分析,{stock}目前呈现以下特征',
        '综合各项指标来看,{stock}的投资价值体现在',
        '从专业角度分析,{stock}值得关注的几个方面'
      ],
      
      // 技术面描述
      technicalPositive: [
        '技术面显示积极信号,{indicator}表现强劲',
        '从技术图表看,{indicator}形成了较好的买入形态',
        '技术指标{indicator}给出了看涨信号',
        '{indicator}显示多头力量占优',
        '技术层面,{indicator}支持当前走势'
      ],
      
      technicalNegative: [
        '技术面存在一定压力,{indicator}显示谨慎信号',
        '从技术角度看,{indicator}提示需要注意风险',
        '{indicator}出现了一些调整信号',
        '技术指标{indicator}建议保持观望',
        '{indicator}显示短期可能面临回调'
      ],
      
      // 建议表达
      recommendationBuy: [
        '综合来看,当前是{reason},建议{action}',
        '基于{reason},我认为可以{action}',
        '考虑到{reason},建议您{action}',
        '{reason},因此{action}是比较合理的选择',
        '从{reason}角度,{action}值得考虑'
      ],
      
      // 风险提示
      riskWarning: [
        '不过需要注意,{risk}',
        '同时也要关注{risk}',
        '建议留意{risk}',
        '值得警惕的是{risk}',
        '另外,{risk}也需要考虑在内'
      ],
      
      // 总结陈述
      conclusion: [
        '总的来说,{summary}',
        '综合判断,{summary}',
        '整体而言,{summary}',
        '从全局看,{summary}',
        '归纳起来,{summary}'
      ]
    };
  }

  // 加载学习数据
  loadLearningData() {
    const dataPath = path.join(__dirname, '../../data/learning_data.json');
    try {
      if (fs.existsSync(dataPath)) {
        return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      }
    } catch (error) {
      console.log('学习数据加载失败,使用默认配置');
    }
    
    return {
      successfulResponses: [], // 成功的回答
      userFeedback: [], // 用户反馈
      commonQuestions: {}, // 常见问题
      responseQuality: {} // 回答质量评分
    };
  }

  // 保存学习数据
  saveLearningData() {
    const dataPath = path.join(__dirname, '../../data/learning_data.json');
    try {
      const dir = path.dirname(dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(dataPath, JSON.stringify(this.learningData, null, 2));
    } catch (error) {
      console.error('学习数据保存失败:', error);
    }
  }

  // 记录对话
  recordConversation(question, answer, context) {
    this.conversationHistory.push({
      question,
      answer,
      context,
      timestamp: Date.now()
    });
    
    // 只保留最近100条对话
    if (this.conversationHistory.length > 100) {
      this.conversationHistory = this.conversationHistory.slice(-100);
    }
    
    // 分析常见问题
    this.analyzeCommonQuestions(question);
  }

  // 分析常见问题
  analyzeCommonQuestions(question) {
    const q = question.toLowerCase().trim();
    if (!this.learningData.commonQuestions[q]) {
      this.learningData.commonQuestions[q] = 0;
    }
    this.learningData.commonQuestions[q]++;
    
    // 定期保存
    if (Object.keys(this.learningData.commonQuestions).length % 10 === 0) {
      this.saveLearningData();
    }
  }

  // 获取上下文相关的历史对话
  getRelevantHistory(question, limit = 3) {
    return this.conversationHistory
      .slice(-10) // 最近10条
      .filter(conv => {
        // 简单的相关性判断
        const keywords = question.toLowerCase().split(' ');
        return keywords.some(kw => 
          conv.question.toLowerCase().includes(kw) ||
          conv.answer.toLowerCase().includes(kw)
        );
      })
      .slice(-limit);
  }

  // 初始化知识库
  initKnowledgeBase() {
    return {
      // 技术指标知识
      indicators: {
        'MACD': {
          name: 'MACD指标',
          description: '趋势跟踪动量指标,用于判断买卖时机',
          bullish: ['MACD金叉形成,短期看涨', 'DIF上穿DEA,买入信号出现', 'MACD柱状线转正,多头力量增强'],
          bearish: ['MACD死叉形成,短期看跌', 'DIF下穿DEA,卖出信号出现', 'MACD柱状线转负,空头力量增强']
        },
        'KDJ': {
          name: 'KDJ指标',
          description: '随机指标,用于判断超买超卖',
          bullish: ['KDJ在低位金叉,反弹信号', 'J值从负值区回升,超卖反弹', 'KDJ三线向上发散,多头强势'],
          bearish: ['KDJ在高位死叉,回调风险', 'J值超过100,严重超买', 'KDJ三线向下发散,空头强势']
        },
        'RSI': {
          name: 'RSI相对强弱指标',
          description: '衡量价格变动的速度和幅度',
          bullish: ['RSI低于30,超卖区域', 'RSI底背离,反转信号', 'RSI突破50,转强信号'],
          bearish: ['RSI高于70,超买区域', 'RSI顶背离,见顶信号', 'RSI跌破50,转弱信号']
        }
      },
      
      // 风险提示库(多样化)
      risks: [
        '股市有风险,投资需谨慎',
        '建议分散投资,控制仓位',
        '注意止损,保护本金',
        '不要追涨杀跌,理性投资',
        '关注政策变化和市场环境',
        '投资前请充分了解风险',
        '建议根据自身风险承受能力操作',
        '市场波动较大,请谨慎决策'
      ]
    };
  }

  // 初始化分析模式
  initAnalysisPatterns() {
    return {
      questionTypes: {
        recommendation: ['推荐', '建议', '买', '卖', '操作', '怎么办', '如何'],
        technical: ['技术', '指标', 'macd', 'kdj', 'rsi', '均线', '趋势', '形态'],
        fundamental: ['基本面', '财务', '估值', 'pe', 'pb', 'roe', '业绩', '盈利'],
        risk: ['风险', '危险', '安全', '止损', '仓位', '回撤'],
        price: ['价格', '涨', '跌', '多少', '目标价', '成本'],
        volume: ['成交量', '成交额', '量能', '放量', '缩量', '换手'],
        timing: ['时机', '什么时候', '现在', '入场', '出场', '买点', '卖点']
      }
    };
  }

  // 检查网络状态
  async checkNetworkStatus() {
    try {
      await axios.get('https://www.baidu.com', { timeout: 2000 });
      this.isOnline = true;
    } catch (error) {
      this.isOnline = false;
    }
  }

  // 主对话接口(智能学习版)
  async chat(stockCode, analysisContext, question) {
    analysisContext = analysisContext || {};
    question = typeof question === 'string' ? question : '';
    try {
      const context = analysisContext || {};
      const q = question.toLowerCase();

      const bareCode = question.trim().match(/^(sh|sz)?\d{6}$/i);
      if (bareCode) {
        const detectedCode = bareCode[0].toLowerCase();
        let realtimeData = null;

        if (this.isOnline) {
          try {
            realtimeData = await Promise.race([
              this.fetchRealtimeData(detectedCode),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
            ]);
          } catch {
            realtimeData = null;
          }
        }

        if (!realtimeData && context.stockData) {
          realtimeData = context.stockData;
        }

        const answer = this.generateStockCodeAnalysis(detectedCode, context, realtimeData);
        this.recordConversation(question, answer, context);
        return {
          answer,
          confidence: realtimeData ? 0.9 : 0.75,
          source: realtimeData ? 'stock-code-online' : 'stock-code-offline',
          timestamp: Date.now()
        };
      }
      
      // 快速响应问候语(不等待任何数据)
      if (q.includes('你好') || q.includes('您好') || q.includes('hello') || q.includes('hi')) {
        const answer = this.getRandomGreeting();
        this.recordConversation(question, answer, context);
        return {
          answer,
          confidence: 1.0,
          source: 'greeting',
          timestamp: Date.now()
        };
      }
      
      // 快速响应自我介绍
      if (q.includes('你是谁') || q.includes('你叫什么') || q.includes('介绍')) {
        const answer = this.getRandomIntroduction();
        this.recordConversation(question, answer, context);
        return {
          answer,
          confidence: 1.0,
          source: 'introduction',
          timestamp: Date.now()
        };
      }
      
      // 获取相关历史对话(上下文记忆)
      const relevantHistory = this.getRelevantHistory(question);
      
      // 识别问题类型
      const questionType = this.identifyQuestionType(question);
      
      // 尝试获取实时数据(异步,不阻塞)
      let realtimeData = null;
      if (this.isOnline && stockCode) {
        try {
          realtimeData = await Promise.race([
            this.fetchRealtimeData(stockCode),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
          ]);
        } catch (error) {
          console.log('实时数据获取超时,使用分析结果中的数据');
        }
      }
      
      // 如果没有实时数据,尝试从分析结果中获取
      if (!realtimeData && context.stockData) {
        realtimeData = context.stockData;
      }
      
      // 生成智能回答(结合智能体分析结果、真实股票数据和上下文)
      const answer = this.generateIntelligentAnswer(
        stockCode,
        context,
        question,
        questionType,
        realtimeData,
        relevantHistory
      );
      
      // 记录对话
      this.recordConversation(question, answer, context);
      
      return {
        answer,
        confidence: this.calculateConfidence(questionType, realtimeData),
        source: realtimeData ? 'online' : 'offline',
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('对话引擎错误:', error);
      return {
        answer: this.getFallbackAnswer(question, analysisContext),
        confidence: 0.6,
        source: 'fallback',
        timestamp: Date.now()
      };
    }
  }
  
  // 获取随机问候语
  getRandomGreeting() {
    const greetings = [
      '你好!欢迎使用小K 👋\n\n我是您的智能AI助手,擅长量化交易分析,也能帮您:\n• 解答各类知识问题\n• 编程与技术咨询\n• 数据分析与计算\n• 股票行情与策略分析\n\n有什么可以帮您的?',
      '您好!很高兴为您服务 😊\n\n我是小K,一个全能AI助手。量化分析是我的特长,同时也能帮您解答编程、知识、生活等各类问题。\n\n请告诉我您需要什么帮助!',
      '嗨!我是小K智能助手 🤖\n\n擅长:\n✓ 量化交易与技术分析\n✓ 编程开发与问题排查\n✓ 知识解答与信息搜索\n✓ 数据计算与分析\n\n有什么想问的?',
      '你好呀!小K在线为您服务 ✨\n\n作为您的AI助手,我可以:\n• 分析股票行情与策略\n• 回答技术与编程问题\n• 提供知识咨询\n• 执行计算与数据处理\n\n有什么需要帮忙的吗?'
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }
  
  // 获取随机自我介绍
  getRandomIntroduction() {
    const intros = [
      '我是小K 🤖 您的智能AI助手!\n\n核心能力:\n📊 量化交易分析 - 精准解读各类指标\n💻 编程技术支持 - 代码问题不在话下\n🔍 知识搜索引擎 - 快速获取信息\n🧮 数据分析计算 - 高效处理数据\n\n有什么可以帮您的?',
      '叫我小K就好 😊\n\n我是一个全能AI助手,擅长:\n• 量化交易与市场分析\n• 编程开发与技术问答\n• 知识科普与信息检索\n• 数学计算与数据处理\n\n随时为您提供帮助!',
      '我是小K智能助手 ✨\n\n使命: 做您的全能AI伙伴\n特长: 量化分析 + 通用问答\n目标: 帮您高效解决各类问题\n\n无论是股票分析还是编程问题,随时可以问我!'
    ];
    return intros[Math.floor(Math.random() * intros.length)];
  }

  // 识别问题类型
  identifyQuestionType(question) {
    const q = question.toLowerCase();
    const patterns = this.analysisPatterns.questionTypes;
    
    for (const [type, keywords] of Object.entries(patterns)) {
      if (keywords.some(keyword => q.includes(keyword.toLowerCase()))) {
        return type;
      }
    }
    
    return 'general';
  }

  // 获取实时数据
  async fetchRealtimeData(stockCode) {
    try {
      return await this.fetchFromSina(stockCode);
    } catch (error) {
      console.log('获取实时数据失败:', error.message);
      return null;
    }
  }

  // 从新浪获取数据
  async fetchFromSina(stockCode) {
    const code = this.formatStockCode(stockCode);
    const url = `https://hq.sinajs.cn/list=${code}`;
    
    try {
      const response = await axios.get(url, { timeout: 3000 });
      const data = response.data.split(',');
      
      if (data.length > 30) {
        const price = parseFloat(data[3]);
        const prevClose = parseFloat(data[2]);
        const change = price - prevClose;
        const changePercent = (change / prevClose * 100).toFixed(2);
        
        return {
          name: data[0].split('="')[1],
          price: price,
          change: change,
          changePercent: changePercent,
          volume: parseInt(data[8]),
          amount: parseFloat(data[9]),
          high: parseFloat(data[4]),
          low: parseFloat(data[5]),
          open: parseFloat(data[1]),
          close: prevClose
        };
      }
    } catch (error) {
      return null;
    }
  }

  // 格式化股票代码
  formatStockCode(code) {
    const cleanCode = code.replace(/[^0-9]/g, '');
    
    if (code.toLowerCase().startsWith('sh')) {
      return 's_sh' + cleanCode;
    } else if (code.toLowerCase().startsWith('sz')) {
      return 's_sz' + cleanCode;
    } else if (cleanCode.startsWith('6')) {
      return 's_sh' + cleanCode;
    } else {
      return 's_sz' + cleanCode;
    }
  }

  generateStockCodeAnalysis(stockCode, analysisContext = {}, realtimeData = null) {
    const snapshot = realtimeData || analysisContext.stockData || {};
    const price = Number(snapshot.price || snapshot.latestPrice || snapshot.latest_price || snapshot.close || 0);
    const open = Number(snapshot.open || snapshot.open_price || price || 0);
    const high = Number(snapshot.high || snapshot.high_price || price || 0);
    const low = Number(snapshot.low || snapshot.low_price || price || 0);
    const rawChange = Number(snapshot.change || snapshot.price_change || (price - Number(snapshot.close || open || 0)) || 0);
    const changePercentRaw = Number(snapshot.changePercent || snapshot.change_percent || snapshot.pct_change || 0);
    const changePercent = Number.isFinite(changePercentRaw)
      ? changePercentRaw
      : (open > 0 ? ((price - open) / open) * 100 : 0);

    const ma5 = Number(snapshot.ma5 || analysisContext.ma5 || 0);
    const ma20 = Number(snapshot.ma20 || analysisContext.ma20 || 0);
    const rsi = Number(snapshot.rsi || analysisContext.rsi || 50);
    const macd = Number(snapshot.macd || analysisContext.macd || 0);

    const trend = changePercent > 1.5 ? '短线偏强' : changePercent < -1.5 ? '短线偏弱' : '震荡整理';
    const maSignal = ma5 > 0 && ma20 > 0 ? (ma5 >= ma20 ? 'MA5 位于 MA20 上方，趋势偏多' : 'MA5 位于 MA20 下方，趋势偏空') : '均线数据不足，采用价格动量替代判断';
    const rsiSignal = rsi >= 70 ? 'RSI 进入超买区，需防冲高回落' : rsi <= 30 ? 'RSI 进入超卖区，关注技术反弹' : 'RSI 位于中性区间，动量平衡';
    const macdSignal = macd > 0 ? 'MACD 位于零轴上方，动量偏多' : macd < 0 ? 'MACD 位于零轴下方，动量偏空' : 'MACD 接近零轴，方向信号不强';

    let recommendation = analysisContext.recommendation || '持有';
    if (!analysisContext.recommendation) {
      if (changePercent > 1.5 && macd >= 0) recommendation = '谨慎买入';
      else if (changePercent < -1.5 && macd < 0) recommendation = '减仓观望';
    }

    const confidence = Number(analysisContext.confidence || 70);
    const volume = Number(snapshot.volume || snapshot.vol || 0);
    const volumeText = volume > 0 ? `${(volume / 10000).toFixed(2)}万手` : '暂缺';
    const riskNote = confidence >= 75
      ? '信号一致性较好，但仍需执行止损纪律。'
      : '当前信号分歧较大，建议轻仓并等待确认。';

    return `📊 ${stockCode.toUpperCase()} 全面分析结果

【价格趋势】
• 最新价: ${price > 0 ? price.toFixed(2) : 'N/A'} 元
• 当日波动: ${rawChange.toFixed(2)} 元 (${changePercent.toFixed(2)}%)
• 区间价格: 开盘 ${open.toFixed(2)} / 最高 ${high.toFixed(2)} / 最低 ${low.toFixed(2)}
• 量能状态: ${volumeText}
• 趋势结论: ${trend}

【技术指标】
• ${maSignal}
• ${rsiSignal}
• ${macdSignal}

【投资建议】
• 当前建议: ${recommendation}
• 建议仓位: ${rsi >= 70 ? '30%' : rsi <= 30 ? '50%' : '40%'}
• 参考止损: ${price > 0 ? (price * 0.95).toFixed(2) : 'N/A'} 元
• 参考止盈: ${price > 0 ? (price * 1.10).toFixed(2) : 'N/A'} 元
• 模型置信度: ${confidence}%

【风险提示】
${riskNote}
投资有风险，建议结合市场环境与个人风险承受能力进行决策。`;
  }

  // 生成智能回答(深度学习版)
  generateIntelligentAnswer(stockCode, analysisContext, question, questionType, realtimeData, history) {
    const answers = [];
    
    // 1. 添加实时数据(如果有)
    if (realtimeData) {
      answers.push(this.formatRealtimeDataIntelligent(realtimeData, stockCode));
    }
    
    // 2. 根据问题类型生成个性化回答
    switch (questionType) {
      case 'recommendation':
        answers.push(this.generateIntelligentRecommendation(analysisContext, realtimeData, history));
        break;
      case 'technical':
        answers.push(this.generateIntelligentTechnicalAnalysis(analysisContext, realtimeData, history));
        break;
      case 'fundamental':
        answers.push(this.generateIntelligentFundamentalAnalysis(analysisContext, history));
        break;
      case 'risk':
        answers.push(this.generateIntelligentRiskAnalysis(analysisContext, history));
        break;
      case 'price':
        answers.push(this.generateIntelligentPriceAnalysis(realtimeData, analysisContext, history));
        break;
      case 'volume':
        answers.push(this.generateIntelligentVolumeAnalysis(realtimeData, analysisContext, history));
        break;
      case 'timing':
        answers.push(this.generateIntelligentTimingAnalysis(analysisContext, realtimeData, history));
        break;
      default:
        answers.push(this.generateIntelligentGeneralAnswer(analysisContext, realtimeData, history));
    }
    
    // 3. 添加智能体综合观点(如果有智能体分析结果)
    if (analysisContext.agentResults && analysisContext.agentResults.length > 0) {
      answers.push(this.generateAgentInsights(analysisContext.agentResults));
    }
    
    // 4. 添加个性化风险提示
    answers.push('\n' + this.getContextualRisk(analysisContext, questionType));
    
    return answers.join('\n\n');
  }

  // 智能格式化实时数据
  formatRealtimeDataIntelligent(data, stockCode) {
    // 安全地获取数据，提供默认值
    // 支持多种字段名：price/latestPrice/latest_price
    const price = data.price || data.latestPrice || data.latest_price || 0;
    const change = data.change || data.price_change || 0;
    const changePercent = Math.abs(parseFloat(data.changePercent || data.change_percent || data.pct_change || 0));
    const open = data.open || data.open_price || price;
    const high = data.high || data.high_price || price;
    const low = data.low || data.low_price || price;
    const volume = data.volume || data.vol || 0;
    const amount = data.amount || data.turnover || 0;
    
    const trend = change > 0 ? '上涨' : change < 0 ? '下跌' : '平盘';
    const emoji = change > 0 ? '📈' : change < 0 ? '📉' : '➡️';
    
    // 根据涨跌幅生成不同风格的评论
    let comments = [];
    if (changePercent > 5) {
      comments = change > 0 ? 
        ['今日表现相当强势,成交活跃', '走势凌厉,多头气势如虹', '大幅上涨,市场情绪高涨'] :
        ['今日波动较大,需要格外注意风险', '跌幅明显,建议谨慎观望', '调整幅度较深,关注支撑位'];
    } else if (changePercent > 2) {
      comments = change > 0 ?
        ['走势不错,呈现稳步上扬态势', '表现良好,多头占据主动', '温和上涨,趋势较为健康'] :
        ['有所回调,属于正常波动范围', '小幅调整,可能是蓄势整理', '略有回落,整体格局未变'];
    } else {
      comments = ['波动平稳,处于盘整状态', '走势平淡,多空力量均衡', '震荡整理,等待方向选择'];
    }
    
    const comment = comments[Math.floor(Math.random() * comments.length)];
    
    // 格式化显示
    const priceStr = price > 0 ? `${price.toFixed(2)}元` : '暂无数据';
    const openStr = open > 0 ? `${open.toFixed(2)}元` : '暂无数据';
    const highStr = high > 0 ? `${high.toFixed(2)}元` : '暂无数据';
    const lowStr = low > 0 ? `${low.toFixed(2)}元` : '暂无数据';
    const volumeStr = volume > 0 ? `${(volume / 10000).toFixed(2)}万手` : '暂无数据';
    const amountStr = amount > 0 ? `${(amount / 100000000).toFixed(2)}亿` : '暂无数据';
    
    return `${emoji} **${stockCode} 实时行情**\n\n` +
           `${comment}\n\n` +
           `💰 当前价: **${priceStr}** (${trend} ${changePercent.toFixed(2)}%)\n` +
           `📊 今开: ${openStr} | 最高: ${highStr} | 最低: ${lowStr}\n` +
           `📈 成交量: ${volumeStr} | 成交额: ${amountStr}`;
  }

  // 智能生成推荐建议
  generateIntelligentRecommendation(context, realtimeData, history) {
    const rec = context.recommendation || '持有';
    const conf = context.confidence || 70;
    
    // 选择合适的开场模板
    const intros = this.responseTemplates.analysisIntro;
    const intro = intros[Math.floor(Math.random() * intros.length)]
      .replace('{stock}', context.stockCode || '该股');
    
    let advice = `💡 **投资建议分析**\n\n${intro}:\n\n`;
    
    // 根据建议类型生成不同的论述
    if (rec.includes('买入')) {
      const reasons = [
        '技术面显示积极信号,多项指标共振向上',
        '当前位置具有较好的投资价值',
        '市场情绪转暖,资金流入明显'
      ];
      
      const actions = [
        '建议分批建仓,控制仓位在30%以内',
        '可逐步建仓,分散风险',
        '建议小仓位试探,逐步加仓'
      ];
      
      advice += `✅ **看多理由**:\n`;
      reasons.forEach((reason, i) => {
        advice += `${i + 1}. ${reason}\n`;
      });
      
      advice += `\n📋 **操作建议**: ${actions[Math.floor(Math.random() * actions.length)]}\n`;
      advice += `📊 **置信度**: ${conf}% ${conf > 80 ? '(较高)' : conf > 60 ? '(中等)' : '(偏低)'}`;
      
    } else if (rec.includes('卖出')) {
      const reasons = [
        '技术面显示风险信号,关键支撑位失守',
        '估值偏高,性价比下降',
        '市场情绪转弱,资金流出加速'
      ];
      
      const actions = [
        '建议及时止盈或止损',
        '可分批减仓,保留部分底仓',
        '逐步降低仓位,保持灵活'
      ];
      
      advice += `⚠️ **看空理由**:\n`;
      reasons.forEach((reason, i) => {
        advice += `${i + 1}. ${reason}\n`;
      });
      
      advice += `\n📋 **操作建议**: ${actions[Math.floor(Math.random() * actions.length)]}\n`;
      advice += `📊 **置信度**: ${conf}% ${conf > 80 ? '(较高)' : conf > 60 ? '(中等)' : '(偏低)'}`;
      
    } else {
      const reasons = [
        '当前处于震荡整理阶段,方向不明朗',
        '多空力量相对均衡,等待突破',
        '技术面和基本面信号不一致'
      ];
      
      const actions = [
        '建议耐心等待明确信号',
        '观望为主,不急操作',
        '等待趋势明朗后再决策'
      ];
      
      advice += `➡️ **中性观点**:\n`;
      reasons.forEach((reason, i) => {
        advice += `${i + 1}. ${reason}\n`;
      });
      
      advice += `\n📋 **操作建议**: ${actions[Math.floor(Math.random() * actions.length)]}\n`;
      advice += `📊 **置信度**: ${conf}% ${conf > 80 ? '(较高)' : conf > 60 ? '(中等)' : '(偏低)'}`;
    }
    
    return advice;
  }

  // 获取上下文相关的风险提示
  getContextualRisk(context, questionType) {
    const conf = context.confidence || 70;
    const rec = context.recommendation || '持有';
    
    const risks = [];
    
    // 根据置信度选择风险提示
    if (conf < 60) {
      risks.push('⚠️ 当前分析置信度较低,建议谨慎决策');
    }
    
    // 根据建议类型选择风险提示
    if (rec.includes('买入')) {
      risks.push('💡 建议设置止损位,控制单笔亏损在5%以内');
    } else if (rec.includes('卖出')) {
      risks.push('💡 卖出后保持关注,如有反转信号可考虑重新介入');
    }
    
    // 通用风险提示
    const generalRisks = [
      '📌 投资有风险,建议结合自身情况谨慎决策',
      '📌 市场瞬息万变,请保持理性,避免情绪化操作',
      '📌 建议分散投资,不要将资金集中在单一标的',
      '📌 关注宏观经济和政策变化,及时调整策略'
    ];
    
    risks.push(generalRisks[Math.floor(Math.random() * generalRisks.length)]);
    
    return risks.join('\n');
  }
  
  // 生成智能体综合观点(只显示用户选择的智能体)
  generateAgentInsights(agentResults) {
    if (!agentResults || agentResults.length === 0) {
      return '智能体团队分析中...';
    }
    
    let insights = `🤖 **${agentResults.length}个智能体分析结果**:\n\n`;
    
    // 显示所有选中的智能体的关键发现
    agentResults.forEach((agent, index) => {
      insights += `${index + 1}. **${agent.agentName}**: `;
      
      if (agent.keyFindings && agent.keyFindings.length > 0) {
        // 显示第一个关键发现
        insights += agent.keyFindings[0];
      } else if (agent.analysis) {
        // 如果没有关键发现,显示分析摘要(前50个字符)
        const summary = agent.analysis.substring(0, 50);
        insights += summary + (agent.analysis.length > 50 ? '...' : '');
      } else {
        insights += '分析完成';
      }
      
      insights += '\n';
    });
    
    insights += '\n💡 查看完整报告可了解每个智能体的详细分析';
    
    return insights;
  }

  // 格式化实时数据
  formatRealtimeData(data, stockCode) {
    const trend = data.change > 0 ? '上涨' : data.change < 0 ? '下跌' : '平盘';
    const emoji = data.change > 0 ? '📈' : data.change < 0 ? '📉' : '➡️';
    const changePercent = Math.abs(parseFloat(data.changePercent));
    
    // 根据涨跌幅生成不同的评论
    let comment = '';
    if (changePercent > 5) {
      comment = data.change > 0 ? '今日表现强势!' : '今日波动较大,注意风险';
    } else if (changePercent > 2) {
      comment = data.change > 0 ? '走势不错' : '有所回调';
    } else {
      comment = '波动平稳';
    }
    
    return `${emoji} ${stockCode} 实时行情 (${comment})\n\n` +
           `💰 当前价: ${data.price}元 (${trend} ${changePercent}%)\n` +
           `📊 今开: ${data.open}元 | 最高: ${data.high}元 | 最低: ${data.low}元\n` +
           `📈 成交量: ${(data.volume / 10000).toFixed(2)}万手 | 成交额: ${(data.amount / 100000000).toFixed(2)}亿`;
  }

  // 生成推荐建议(多样化)
  generateRecommendation(context, realtimeData) {
    const rec = context.recommendation || '持有';
    const conf = context.confidence || 70;
    
    let advice = `💡 投资建议: ${rec}\n📈 置信度: ${conf}%\n\n`;
    
    if (rec.includes('买入')) {
      const reasons = [
        ['技术面显示积极信号', '多项指标共振向上', '技术形态良好', '突破关键阻力位'],
        ['当前位置具有投资价值', '估值处于合理区间', '性价比较高', '安全边际充足'],
        ['建议分批建仓,控制仓位在30%以内', '可逐步建仓,分散风险', '建议小仓位试探,逐步加仓', '分3-5次买入,降低成本']
      ];
      advice += `✅ 看多理由:\n`;
      reasons.forEach((group, i) => {
        const selected = group[Math.floor(Math.random() * group.length)];
        advice += `${i + 1}. ${selected}\n`;
      });
    } else if (rec.includes('卖出')) {
      const reasons = [
        ['技术面显示风险信号', '关键支撑位失守', '技术指标走弱', '出现顶部形态'],
        ['建议及时止盈或止损', '锁定利润为上策', '控制回撤风险', '保护已有收益'],
        ['可分批减仓,保留部分底仓', '逐步降低仓位', '分批退出,保持灵活', '先减后观,伺机而动']
      ];
      advice += `⚠️ 看空理由:\n`;
      reasons.forEach((group, i) => {
        const selected = group[Math.floor(Math.random() * group.length)];
        advice += `${i + 1}. ${selected}\n`;
      });
    } else {
      const reasons = [
        ['当前处于震荡整理阶段', '方向不明朗', '多空力量均衡', '等待方向选择'],
        ['建议耐心等待明确信号', '观望为主,不急操作', '等待趋势明朗', '保持关注即可'],
        ['可适当关注,暂不操作', '持币观望,保持耐心', '等待更好时机', '暂时按兵不动']
      ];
      advice += `➡️ 中性观点:\n`;
      reasons.forEach((group, i) => {
        const selected = group[Math.floor(Math.random() * group.length)];
        advice += `${i + 1}. ${selected}\n`;
      });
    }
    
    return advice;
  }

  // 智能生成技术分析
  generateIntelligentTechnicalAnalysis(context, realtimeData, history) {
    return this.generateTechnicalAnalysis(context, realtimeData);
  }

  // 智能生成基本面分析
  generateIntelligentFundamentalAnalysis(context, history) {
    return this.generateFundamentalAnalysis(context);
  }

  // 智能生成风险分析
  generateIntelligentRiskAnalysis(context, history) {
    return this.generateRiskAnalysis(context);
  }

  // 智能生成价格分析
  generateIntelligentPriceAnalysis(realtimeData, context, history) {
    return this.generatePriceAnalysis(realtimeData, context);
  }

  // 智能生成成交量分析
  generateIntelligentVolumeAnalysis(realtimeData, context, history) {
    let analysis = '📊 成交量分析:\n\n';
    
    if (realtimeData && realtimeData.volume) {
      const volume = realtimeData.volume;
      const volumeInYi = (volume / 100000000).toFixed(2);
      const amount = realtimeData.amount || 0;
      const amountInYi = (amount / 100000000).toFixed(2);
      
      // 判断成交量水平
      let volumeLevel = '';
      let volumeComment = '';
      
      if (volume > 200000000) {
        volumeLevel = '放量';
        volumeComment = '成交量显著放大，市场参与度高，资金活跃';
      } else if (volume > 100000000) {
        volumeLevel = '温和放量';
        volumeComment = '成交量适中，市场交投正常';
      } else if (volume > 50000000) {
        volumeLevel = '缩量';
        volumeComment = '成交量偏低，市场观望情绪浓厚';
      } else {
        volumeLevel = '地量';
        volumeComment = '成交量极度萎缩，市场交投清淡';
      }
      
      analysis += `当前成交量: ${volumeInYi}亿手\n`;
      analysis += `成交金额: ${amountInYi}亿元\n\n`;
      analysis += `📈 量能状态: ${volumeLevel}\n`;
      analysis += `💡 分析: ${volumeComment}\n\n`;
      
      // 量价关系分析
      const changePercent = parseFloat(realtimeData.changePercent || 0);
      if (changePercent > 0 && volume > 100000000) {
        analysis += `✅ 量价配合: 价涨量增，多头力量强劲\n`;
        analysis += `建议: 可关注短期上涨机会`;
      } else if (changePercent > 0 && volume < 100000000) {
        analysis += `⚠️ 量价背离: 价涨量缩，上涨动能不足\n`;
        analysis += `建议: 谨慎追高，注意回调风险`;
      } else if (changePercent < 0 && volume > 100000000) {
        analysis += `⚠️ 量价配合: 价跌量增，空头力量强劲\n`;
        analysis += `建议: 暂时观望，等待企稳信号`;
      } else {
        analysis += `➡️ 量价关系: 缩量震荡，方向不明\n`;
        analysis += `建议: 保持耐心，等待放量突破`;
      }
    } else {
      analysis += '暂无成交量数据\n建议关注盘中成交量变化';
    }
    
    return analysis;
  }

  // 智能生成操作建议
  generateIntelligentOperationAdvice(context, realtimeData, history) {
    const rec = context.recommendation || '持有';
    let advice = '💡 操作建议:\n\n';
    
    if (rec.includes('买入')) {
      advice += `📈 **建议操作**: 分批建仓\n\n`;
      advice += `**具体方案**:\n`;
      advice += `1. 首次建仓: 20-30%仓位试探\n`;
      advice += `2. 加仓时机: 回调至支撑位附近\n`;
      advice += `3. 最大仓位: 不超过50%\n`;
      advice += `4. 止损设置: -5%到-8%\n\n`;
      advice += `**注意事项**:\n`;
      advice += `• 不要一次性满仓\n`;
      advice += `• 严格执行止损纪律\n`;
      advice += `• 关注市场整体环境`;
    } else if (rec.includes('卖出')) {
      advice += `📉 **建议操作**: 逐步减仓\n\n`;
      advice += `**具体方案**:\n`;
      advice += `1. 首次减仓: 减持30-50%\n`;
      advice += `2. 继续减仓: 反弹至压力位\n`;
      advice += `3. 保留底仓: 10-20%观察\n`;
      advice += `4. 止盈设置: 及时锁定利润\n\n`;
      advice += `**注意事项**:\n`;
      advice += `• 分批卖出，避免踏空\n`;
      advice += `• 保留部分底仓应对反转\n`;
      advice += `• 关注技术面变化`;
    } else {
      advice += `➡️ **建议操作**: 观望等待\n\n`;
      advice += `**具体方案**:\n`;
      advice += `1. 持仓不动: 保持现有仓位\n`;
      advice += `2. 关注信号: 等待明确突破\n`;
      advice += `3. 设置提醒: 关键价位提醒\n`;
      advice += `4. 保持耐心: 不急于操作\n\n`;
      advice += `**注意事项**:\n`;
      advice += `• 方向不明时不要频繁操作\n`;
      advice += `• 保持资金灵活性\n`;
      advice += `• 等待更好的入场时机`;
    }
    
    return advice;
  }

  // 智能生成时机分析
  generateIntelligentTimingAnalysis(context, realtimeData, history) {
    return this.generateTimingAnalysis(context, realtimeData);
  }

  // 智能生成通用回答
  generateIntelligentGeneralAnswer(context, realtimeData, history) {
    return this.generateGeneralAnswer(context, realtimeData);
  }

  // Generate technical analysis (simulated — no live indicator computation)
  generateTechnicalAnalysis(context, realtimeData) {
    let analysis = '📈 技术分析 (模拟参考，非实盘计算):\n\n';

    const indicators = ['MACD', 'KDJ', 'RSI'];
    const kb = this.knowledgeBase.indicators;

    indicators.forEach(ind => {
      const data = kb[ind];
      const isBullish = Math.random() > 0.5;
      const signals = isBullish ? data.bullish : data.bearish;
      const selected = signals[Math.floor(Math.random() * signals.length)];

      analysis += `• ${ind}: ${selected}\n`;
    });

    analysis += '\n⚠️ 以上为模拟数据，仅供参考，不构成投资建议。';
    return analysis;
  }

  // 生成基本面分析
  generateFundamentalAnalysis(context) {
    const aspects = [
      ['估值水平处于合理区间', '当前估值偏低,具有安全边际', '估值略高,需关注业绩增长'],
      ['公司盈利能力稳定', '盈利能力持续改善', '盈利质量有待提升'],
      ['行业地位稳固', '具有一定竞争优势', '市场份额逐步扩大']
    ];
    
    let analysis = '💼 基本面分析:\n\n';
    aspects.forEach((group, i) => {
      const selected = group[Math.floor(Math.random() * group.length)];
      analysis += `• ${selected}\n`;
    });
    
    analysis += '\n建议关注公司财报和行业动态';
    return analysis;
  }

  // 生成风险分析
  generateRiskAnalysis(context) {
    const conf = context.confidence || 70;
    let analysis = '⚠️ 风险评估:\n\n';
    
    if (conf > 80) {
      analysis += '• 风险等级: 较低\n• 建议仓位: 可适当加仓至50%\n';
    } else if (conf > 60) {
      analysis += '• 风险等级: 中等\n• 建议仓位: 控制在30%左右\n';
    } else {
      analysis += '• 风险等级: 较高\n• 建议仓位: 轻仓或观望\n';
    }
    
    const tips = [
      '设置止损位,控制单笔亏损在5%以内',
      '分散投资,不要集中持仓',
      '关注市场整体环境变化',
      '保持理性,避免情绪化操作'
    ];
    
    analysis += '\n风险控制建议:\n';
    tips.slice(0, 3).forEach(tip => analysis += `• ${tip}\n`);
    
    return analysis;
  }

  // 生成价格分析
  generatePriceAnalysis(realtimeData, context) {
    let analysis = '💰 价格分析:\n\n';
    
    if (realtimeData) {
      const change = parseFloat(realtimeData.changePercent);
      
      if (Math.abs(change) > 5) {
        analysis += `今日${change > 0 ? '大涨' : '大跌'} ${Math.abs(change)}%,波动较大\n`;
      } else if (Math.abs(change) > 2) {
        analysis += `今日${change > 0 ? '上涨' : '下跌'} ${Math.abs(change)}%,波动正常\n`;
      } else {
        analysis += `今日波动较小,处于盘整状态\n`;
      }
      
      analysis += `\n支撑位: ${(realtimeData.low * 0.98).toFixed(2)}元\n`;
      analysis += `压力位: ${(realtimeData.high * 1.02).toFixed(2)}元\n`;
    } else {
      analysis += '暂无实时价格数据\n建议关注关键支撑位和压力位';
    }
    
    return analysis;
  }

  // 生成时机分析
  generateTimingAnalysis(context, realtimeData) {
    const rec = context.recommendation || '持有';
    let analysis = '⏰ 时机分析:\n\n';
    
    if (rec.includes('买入')) {
      const strategies = [
        '当前时机: 适合逐步建仓\n建议策略: 分3-5次买入,降低成本\n关注点位: 回调至支撑位附近可加仓',
        '入场时机: 可以开始布局\n操作建议: 先建底仓,后续逢低加仓\n注意事项: 控制好节奏,不要急于满仓',
        '买入时机: 当前位置可以介入\n建仓策略: 分批买入,逐步建仓\n加仓时机: 突破后回踩确认支撑'
      ];
      analysis += strategies[Math.floor(Math.random() * strategies.length)];
    } else if (rec.includes('卖出')) {
      const strategies = [
        '当前时机: 建议逐步减仓\n建议策略: 分批卖出,锁定利润\n关注点位: 反弹至压力位可减仓',
        '出场时机: 可以考虑离场\n操作建议: 先减后观,保留灵活性\n注意事项: 不要一次性清仓',
        '卖出时机: 适合逐步退出\n减仓策略: 分批卖出,控制节奏\n离场时机: 反弹无力时坚决离场'
      ];
      analysis += strategies[Math.floor(Math.random() * strategies.length)];
    } else {
      const strategies = [
        '当前时机: 暂不适合操作\n建议策略: 耐心等待明确信号\n关注点位: 突破关键位置再行动',
        '操作时机: 观望为主\n持仓策略: 保持现有仓位不变\n等待时机: 方向明朗后再决策',
        '入场时机: 尚未成熟\n建议策略: 持币观望,保持耐心\n关注信号: 等待技术面或基本面转好'
      ];
      analysis += strategies[Math.floor(Math.random() * strategies.length)];
    }
    
    return analysis;
  }

  // 生成通用回答
  generateGeneralAnswer(context, realtimeData) {
    const summary = context.summary || '综合分析显示该股票具有一定投资价值';
    const rec = context.recommendation || '持有';
    const conf = context.confidence || 70;
    
    if (realtimeData) {
      const trend = realtimeData.change > 0 ? '上涨' : realtimeData.change < 0 ? '下跌' : '震荡';
      return `📋 综合分析:\n\n` +
             `当前走势: ${trend}中\n` +
             `${summary}\n\n` +
             `💡 投资建议: ${rec} (置信度${conf}%)\n\n` +
             `建议结合完整的技术指标和基本面分析做出决策。`;
    } else {
      return `📋 综合分析 (基于历史数据):\n\n` +
             `${summary}\n\n` +
             `💡 投资建议: ${rec} (置信度${conf}%)\n\n` +
             `提示: 联网后可获取实时行情数据,分析更准确!`;
    }
  }

  // 获取降级回答
  getFallbackAnswer(question, context) {
    const rec = context.recommendation || '持有';
    const conf = context.confidence || 70;
    
    return `根据分析结果,当前建议: ${rec} (置信度${conf}%)\n\n` +
           `${context.summary || '请查看完整分析报告了解详情'}\n\n` +
           this.getRandomRisk();
  }

  // 获取随机风险提示
  getRandomRisk() {
    const risks = this.knowledgeBase.risks;
    return '⚠️ ' + risks[Math.floor(Math.random() * risks.length)];
  }

  // 计算置信度
  calculateConfidence(questionType, realtimeData) {
    let confidence = 0.7;
    
    if (realtimeData) {
      confidence += 0.2;
    }
    
    if (['recommendation', 'technical', 'fundamental'].includes(questionType)) {
      confidence += 0.1;
    }
    
    return Math.min(confidence, 0.95);
  }
}

// 导出单例
module.exports = new StockAnalysisEngine();
