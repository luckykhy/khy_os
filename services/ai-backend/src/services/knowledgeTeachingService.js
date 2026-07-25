/**
 * Knowledge Teaching Service — Contextual quant knowledge delivery.
 *
 * Delivers quantitative finance knowledge tips during usage:
 * - Beginner → Intermediate → Advanced progression
 * - Contextual matching (relevant to what user is doing)
 * - Throttled delivery (not every interaction, every 3-5 turns)
 * - Progress persisted in ~/.khyquant/growth/knowledge.json
 */

const path = require('path');

// Lazy require to avoid circular dependency at startup
let growthService = null;
function getGrowthService() {
  if (!growthService) growthService = require('./growthService');
  return growthService;
}

// ─── Knowledge Database ─────────────────────────────────────────────────────

const KNOWLEDGE_DB = {
  technical_indicators: {
    beginner: [
      { id: 'ma_basics', title: '均线基础', content: '移动平均线（MA）是最基础的技术指标。短期均线上穿长期均线称为"金叉"，是买入信号；反之为"死叉"，是卖出信号。常用组合有 MA5/MA10/MA20。', keywords: ['均线', 'MA', '移动平均', '金叉', '死叉'] },
      { id: 'kline_basics', title: 'K线基础', content: 'K线由开盘价、最高价、最低价、收盘价四个价格组成。阳线表示收盘价高于开盘价（上涨），阴线相反。长上影线表示上方抛压重，长下影线表示下方支撑强。', keywords: ['K线', '阳线', '阴线', '影线', '蜡烛图'] },
      { id: 'volume_basics', title: '成交量入门', content: '成交量是价格之外最重要的指标。量价配合是判断趋势的关键：上涨放量说明多头力量强，下跌缩量说明空头力量弱。"天量天价"往往是见顶信号。', keywords: ['成交量', '量价', '放量', '缩量', '天量'] },
      { id: 'support_resistance', title: '支撑与阻力', content: '支撑位是价格下跌时可能止跌的位置，阻力位是上涨时可能受阻的位置。前期高低点、整数关口、均线都可以形成支撑/阻力。突破后支撑变阻力，阻力变支撑。', keywords: ['支撑', '阻力', '突破', '关口'] },
      { id: 'macd_intro', title: 'MACD入门', content: 'MACD 由 DIF（快线）、DEA（慢线）和柱状图组成。DIF 上穿 DEA 为金叉（买），下穿为死叉（卖）。零轴上方为多头市场，下方为空头市场。背离信号（价格新高但MACD不创新高）是重要的反转预警。', keywords: ['MACD', 'DIF', 'DEA', '背离', '零轴'] },
    ],
    intermediate: [
      { id: 'rsi_usage', title: 'RSI 实战运用', content: 'RSI（相对强弱指标）范围 0-100。>70 为超买区，<30 为超卖区。但在强势趋势中 RSI 可能长期处于超买/超卖区，此时应关注背离而非绝对值。RSI 在 50 附近的交叉也有参考意义。', keywords: ['RSI', '超买', '超卖', '强弱指标'] },
      { id: 'bollinger_bands', title: '布林带策略', content: '布林带由中轨（MA20）± 2倍标准差构成。价格触及上轨时超买，触及下轨时超卖。带宽收窄（"布林带收口"）预示即将出现大行情。突破上轨后回踩中轨是加仓机会。', keywords: ['布林带', 'BOLL', '标准差', '收口', '上轨', '下轨'] },
      { id: 'fibonacci', title: '斐波那契回撤', content: '斐波那契回撤位（23.6%、38.2%、50%、61.8%）是重要的支撑/阻力位。上涨趋势中回调到 38.2%-50% 区间是较好的买入机会。61.8% 是最后防线，跌破则趋势可能反转。', keywords: ['斐波那契', '回撤', '黄金分割', '0.618'] },
      { id: 'divergence', title: '顶底背离交易', content: '当价格创新高但指标（MACD/RSI）未创新高，为顶背离，预示见顶。价格创新低但指标未创新低，为底背离，预示见底。二次背离比一次背离更可靠。背离不是立即反转，需要等待确认信号。', keywords: ['背离', '顶背离', '底背离', '确认'] },
      { id: 'multi_timeframe', title: '多周期共振', content: '在大周期确定趋势方向，在小周期寻找入场点。如周线上涨趋势中，在日线回调结束时买入。多个周期信号一致时（共振），交易的成功率最高。', keywords: ['多周期', '共振', '周线', '日线', '时间框架'] },
    ],
    advanced: [
      { id: 'order_flow', title: '订单流分析', content: '订单流（Order Flow）通过分析逐笔成交数据揭示主力意图。大单连续买入表示机构建仓；盘口挂单撤单频繁表示主力试盘。Level-2 数据中的委托队列变化可以预判短期方向。', keywords: ['订单流', '逐笔', '主力', 'Level-2', '委托'] },
      { id: 'volatility_surface', title: '波动率曲面', content: '期权的隐含波动率不是常数，随行权价和到期时间形成三维曲面。"波动率微笑"反映市场对尾部风险的定价。波动率曲面的变化蕴含套利机会和市场情绪信息。', keywords: ['波动率', '隐含波动率', '期权', '微笑', '曲面'] },
      { id: 'mean_reversion_stat', title: '统计套利与均值回归', content: '配对交易通过找到协整关系的股票对，在价差偏离时做多低估、做空高估。关键是协整检验（ADF检验）和动态对冲比率计算。需要注意协整关系可能随时间失效。', keywords: ['配对交易', '协整', '均值回归', '统计套利', 'ADF'] },
      { id: 'market_microstructure', title: '市场微观结构', content: '买卖价差反映流动性成本，越小流动性越好。做市商通过提供流动性赚取价差。高频交易利用微观结构信息（队列位置、延迟差异）获取alpha。理解微观结构有助于降低交易成本。', keywords: ['微观结构', '买卖价差', '流动性', '做市商', '高频'] },
    ],
  },

  risk_management: {
    beginner: [
      { id: 'stop_loss_basics', title: '止损的重要性', content: '止损是量化交易的第一原则。每笔交易前必须设定止损位。常用方法：固定比例止损（如亏损2%离场）、技术位止损（跌破支撑位）。永远不要"死扛"，小亏是为了保住大部分本金。', keywords: ['止损', '风险', '亏损', '离场'] },
      { id: 'position_sizing_intro', title: '仓位管理入门', content: '单笔交易风险不超过总资金的 1-2% 是黄金法则。如果止损距离是 5%，那么仓位应控制在总资金的 20-40%。分批建仓比一次性满仓更安全。', keywords: ['仓位', '资金管理', '分批', '满仓'] },
      { id: 'diversification', title: '分散投资', content: '不把鸡蛋放在一个篮子里。建议持有 5-15 只不同行业的股票。相关性低的组合能有效降低波动。但过度分散（>30只）会稀释收益且难以管理。', keywords: ['分散', '组合', '相关性', '行业'] },
    ],
    intermediate: [
      { id: 'kelly_criterion', title: '凯利公式', content: 'f = (bp - q) / b，其中 b=赔率，p=胜率，q=败率。凯利公式给出数学上最优的仓位比例。实践中通常使用半凯利（f/2）以降低波动。前提是准确估计胜率和赔率。', keywords: ['凯利', 'Kelly', '最优仓位', '胜率', '赔率'] },
      { id: 'max_drawdown', title: '最大回撤控制', content: '最大回撤是策略从最高点到最低点的最大跌幅。优秀策略回撤应 < 20%。回撤超过 50% 需要 100% 收益才能回本。设定回撤上限（如 15%），触及即降低仓位或暂停交易。', keywords: ['回撤', '最大回撤', 'drawdown', '净值曲线'] },
      { id: 'var_cvar', title: 'VaR 与 CVaR', content: 'VaR（在险价值）：在给定置信度下的最大可能损失。如 95% VaR = 5 万，意味着95%的概率日亏损不超过 5 万。CVaR（条件VaR）衡量超过 VaR 时的平均损失，对尾部风险更敏感。', keywords: ['VaR', 'CVaR', '在险价值', '置信度', '尾部风险'] },
    ],
    advanced: [
      { id: 'risk_parity', title: '风险平价策略', content: '传统60/40组合中，90%的风险来自股票。风险平价按风险贡献而非金额分配权重，使每类资产的风险贡献相等。需要用杠杆提升低风险资产的收益。桥水的全天候策略是典型代表。', keywords: ['风险平价', '全天候', '桥水', '风险贡献', '杠杆'] },
      { id: 'tail_risk_hedging', title: '尾部风险对冲', content: '黑天鹅事件造成的损失远超正态分布预测。对冲方法：买入虚值看跌期权（成本低，保护大）、配置负相关资产（黄金/国债）、动态调整 beta 暴露。对冲有成本，需要在保护和拖累间平衡。', keywords: ['尾部风险', '黑天鹅', '对冲', '看跌期权'] },
    ],
  },

  position_sizing: {
    beginner: [
      { id: 'fixed_ratio', title: '固定比例法', content: '每笔交易投入固定比例的总资金（如 10%）。简单易执行，但未考虑每笔交易的风险大小。适合初学者建立仓位管理习惯。', keywords: ['固定比例', '仓位', '资金分配'] },
      { id: 'pyramid_building', title: '金字塔加仓', content: '首次建仓最大（如 50%），盈利后逐步加仓但每次减少（30%→20%）。确保平均成本优于当前价。绝不在亏损时加仓（"倒金字塔"是大忌）。', keywords: ['金字塔', '加仓', '建仓', '平均成本'] },
    ],
    intermediate: [
      { id: 'atr_sizing', title: 'ATR 仓位法', content: '用 ATR（平均真实波幅）确定仓位。仓位 = 风险金额 / (N × ATR)，其中 N 是止损的 ATR 倍数。波动大的品种自动减少仓位，波动小的增加仓位，实现风险标准化。', keywords: ['ATR', '波幅', '风险标准化', '海龟'] },
      { id: 'correlation_sizing', title: '相关性调仓', content: '持有多只股票时，高相关性等于集中持仓。若两只股票相关性 0.8，持有等于 1.8 倍单只仓位的风险。应根据组合相关矩阵调整各标的权重。', keywords: ['相关性', '矩阵', '组合', '权重'] },
    ],
    advanced: [
      { id: 'optimal_f', title: '最优 f 值', content: 'Ralph Vince 的最优 f 通过历史交易记录计算最大化几何增长率的仓位比例。与凯利公式不同，它不需要假设收益分布，直接从实际交易数据计算。缺点是对样本敏感，需要足够多的历史交易。', keywords: ['最优f', 'Vince', '几何增长率'] },
    ],
  },

  market_microstructure: {
    beginner: [
      { id: 'bid_ask_spread', title: '买卖价差', content: '买一价和卖一价之间的差距就是买卖价差（spread）。价差越小，交易成本越低，流动性越好。A股主板个股价差通常为 1 个最小变动单位（0.01元）。', keywords: ['买卖价差', 'spread', '流动性', '盘口'] },
      { id: 'trading_sessions', title: 'A股交易时间', content: 'A股交易时间：9:15-9:25 集合竞价，9:30-11:30 上午连续竞价，13:00-15:00 下午连续竞价。集合竞价阶段的成交量和价格变化反映隔夜消息的市场反应。', keywords: ['交易时间', '集合竞价', '连续竞价', '开盘'] },
    ],
    intermediate: [
      { id: 'market_impact', title: '市场冲击成本', content: '大单交易会推动价格向不利方向移动，这就是冲击成本。100万以下通常冲击可忽略，1000万级别需要分时段执行（TWAP/VWAP）。冲击成本是策略回测中最容易被低估的因素。', keywords: ['冲击成本', 'TWAP', 'VWAP', '大单', '滑点'] },
      { id: 'liquidity_analysis', title: '流动性分析', content: '流动性指标：日均成交额（>5000万为较好）、换手率、买卖价差、市场深度。流动性差的股票：进出困难、滑点大、容易被操纵。量化策略应优先选择流动性好的标的。', keywords: ['流动性', '成交额', '换手率', '深度'] },
    ],
    advanced: [
      { id: 'latency_arbitrage', title: '延迟套利', content: '利用不同交易所/通道的延迟差异获取利润。A股中表现为跨市场ETF套利（ETF价格与成分股净值的偏差）。需要极低延迟的系统架构（FPGA/内核旁路）和精确的风控。', keywords: ['延迟', '套利', 'ETF', 'FPGA', '高频'] },
    ],
  },

  quant_fundamentals: {
    beginner: [
      { id: 'what_is_quant', title: '什么是量化交易', content: '量化交易是用数学模型和程序代码代替人工判断来做投资决策。优势：纪律性强（无情绪干扰）、速度快、可回测验证。劣势：模型可能失效、过拟合风险、黑天鹅事件应对差。', keywords: ['量化', '程序化', '模型', '自动交易'] },
      { id: 'backtest_basics', title: '回测基础', content: '回测是用历史数据验证策略的过程。关键指标：年化收益率、最大回撤、夏普比率（>1 较好，>2 优秀）。注意避免：未来数据偷窥、过度拟合、忽略交易成本。回测好不代表实盘好。', keywords: ['回测', '夏普比率', '年化收益', '过拟合'] },
      { id: 'sharpe_ratio', title: '夏普比率', content: '夏普比率 = (策略收益 - 无风险收益) / 策略波动率。衡量每承担一单位风险获得多少超额收益。> 1 可接受，> 2 优秀，> 3 极少见。注意它假设收益正态分布，对尾部风险不敏感。', keywords: ['夏普', 'Sharpe', '风险调整', '波动率'] },
    ],
    intermediate: [
      { id: 'alpha_beta', title: 'Alpha 与 Beta', content: 'Beta 是策略相对于市场的系统性风险暴露。Alpha 是扣除 Beta 后的超额收益（真正的选股/择时能力）。量化的目标是在控制 Beta 的前提下获取稳定的 Alpha。多空对冲策略 Beta ≈ 0。', keywords: ['Alpha', 'Beta', '超额收益', '对冲', '系统性风险'] },
      { id: 'factor_investing', title: '因子投资', content: '因子是驱动股票收益的共同特征。经典因子：价值（低PE/PB）、动量（近期涨幅大）、质量（高ROE）、规模（小市值）、低波动。多因子模型组合多个因子提高稳定性。', keywords: ['因子', '多因子', '价值', '动量', '质量'] },
      { id: 'overfitting', title: '过拟合防范', content: '过拟合是策略过度适应历史数据，实盘效果大幅衰减。防范方法：样本外测试、交叉验证、限制参数数量、确保每个参数有经济学意义、足够长的回测周期（>5年）。参数数量 / 交易次数 < 1/10。', keywords: ['过拟合', '样本外', '交叉验证', '参数'] },
    ],
    advanced: [
      { id: 'machine_learning_quant', title: 'ML量化策略', content: '机器学习在量化中的应用：特征工程（从原始数据提取预测变量）、模型选择（GBDT/LSTM/Transformer）、超参数调优。关键挑战：金融数据信噪比极低、非平稳性、制度转变。Ensemble 方法和在线学习是方向。', keywords: ['机器学习', 'ML', 'LSTM', 'Transformer', '特征工程'] },
      { id: 'execution_algo', title: '算法执行', content: '将大单拆分为小单以降低冲击成本的算法。TWAP（时间加权）：等时间间隔下单。VWAP（成交量加权）：跟随市场成交量节奏。IS（Implementation Shortfall）：平衡冲击成本与时间风险。', keywords: ['算法执行', 'TWAP', 'VWAP', '拆单', '执行算法'] },
    ],
  },
};

// ─── Level Thresholds ───────────────────────────────────────────────────────

const LEVEL_THRESHOLDS = {
  beginner: { min: 0, max: 50 },
  intermediate: { min: 51, max: 200 },
  advanced: { min: 201, max: Infinity },
};

const TIP_INTERVAL_MIN = 3;  // Minimum interactions between tips
const TIP_INTERVAL_MAX = 5;  // Maximum interactions between tips

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Get a contextual knowledge tip based on user input and AI response.
 * Returns null if not time for a tip or no relevant tip found.
 */
function getContextualTip(userMessage, aiResponse) {
  try {
    const knowledge = getGrowthService().loadComponent('knowledge.json');

    // Check if it's time for a tip
    knowledge.interactionsSinceLastTip = (knowledge.interactionsSinceLastTip || 0) + 1;

    if (!_shouldDeliverTip(knowledge)) {
      getGrowthService().saveComponent('knowledge.json', knowledge);
      return null;
    }

    // Find relevant tip
    const tip = _findRelevantTip(userMessage, aiResponse, knowledge);
    if (!tip) {
      getGrowthService().saveComponent('knowledge.json', knowledge);
      return null;
    }

    // Mark as delivered
    knowledge.interactionsSinceLastTip = 0;
    knowledge.lastTipTimestamp = new Date().toISOString();
    knowledge.tipDeliveryCount = (knowledge.tipDeliveryCount || 0) + 1;

    // Award XP
    knowledge.xp = (knowledge.xp || 0) + 2;

    // Level up check
    if (knowledge.level === 'beginner' && knowledge.xp >= LEVEL_THRESHOLDS.intermediate.min) {
      knowledge.level = 'intermediate';
    } else if (knowledge.level === 'intermediate' && knowledge.xp >= LEVEL_THRESHOLDS.advanced.min) {
      knowledge.level = 'advanced';
    }

    getGrowthService().saveComponent('knowledge.json', knowledge);

    return {
      id: tip.id,
      title: tip.title,
      content: tip.content,
      category: _getCategoryDisplayName(tip._category),
      level: _getLevelDisplayName(knowledge.level),
    };
  } catch {
    return null;
  }
}

/**
 * Record that user has learned a specific topic.
 */
function recordLearning(topicId) {
  try {
    const knowledge = getGrowthService().loadComponent('knowledge.json');
    if (!knowledge.completedTopics) knowledge.completedTopics = [];
    if (!knowledge.completedTopics.includes(topicId)) {
      knowledge.completedTopics.push(topicId);
      knowledge.xp = (knowledge.xp || 0) + 5; // Bonus XP for completing a topic

      // Update topic progress
      for (const [category, levels] of Object.entries(KNOWLEDGE_DB)) {
        for (const tips of Object.values(levels)) {
          if (tips.some(t => t.id === topicId)) {
            if (knowledge.topicProgress[category]) {
              knowledge.topicProgress[category].learned++;
            }
          }
        }
      }

      // Level check
      if (knowledge.level === 'beginner' && knowledge.xp >= LEVEL_THRESHOLDS.intermediate.min) {
        knowledge.level = 'intermediate';
      } else if (knowledge.level === 'intermediate' && knowledge.xp >= LEVEL_THRESHOLDS.advanced.min) {
        knowledge.level = 'advanced';
      }

      getGrowthService().saveComponent('knowledge.json', knowledge);
    }
  } catch { /* best effort */ }
}

/**
 * Get current learning progress.
 */
function getLevelProgress() {
  try {
    const knowledge = getGrowthService().loadComponent('knowledge.json');
    const level = knowledge.level || 'beginner';
    const xp = knowledge.xp || 0;
    const threshold = level === 'beginner' ? 50 : level === 'intermediate' ? 200 : Infinity;
    const progress = level === 'advanced' ? 100 : Math.round((xp / threshold) * 100);

    return {
      level,
      levelName: _getLevelDisplayName(level),
      xp,
      xpToNext: Math.max(0, threshold - xp),
      progress,
      completedTopics: (knowledge.completedTopics || []).length,
      totalTopics: _getTotalTopicCount(),
      topicProgress: knowledge.topicProgress || {},
    };
  } catch {
    return { level: 'beginner', levelName: '初级', xp: 0, xpToNext: 50, progress: 0, completedTopics: 0, totalTopics: 0 };
  }
}

/**
 * Get recommended topics based on current level.
 */
function getRecommendedTopics(count = 5) {
  try {
    const knowledge = getGrowthService().loadComponent('knowledge.json');
    const level = knowledge.level || 'beginner';
    const completed = new Set(knowledge.completedTopics || []);
    const recommendations = [];

    for (const [category, levels] of Object.entries(KNOWLEDGE_DB)) {
      const levelTips = levels[level] || [];
      for (const tip of levelTips) {
        if (!completed.has(tip.id)) {
          recommendations.push({ ...tip, category: _getCategoryDisplayName(category) });
        }
      }
    }

    // Shuffle and return top N
    return recommendations.sort(() => Math.random() - 0.5).slice(0, count);
  } catch {
    return [];
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function _shouldDeliverTip(knowledge) {
  const sinceLastTip = knowledge.interactionsSinceLastTip || 0;
  if (sinceLastTip < TIP_INTERVAL_MIN) return false;
  if (sinceLastTip >= TIP_INTERVAL_MAX) return true;
  // Random chance between min and max
  return Math.random() < 0.4;
}

function _findRelevantTip(userMessage, aiResponse, knowledge) {
  const level = knowledge.level || 'beginner';
  const completed = new Set(knowledge.completedTopics || []);
  const combined = `${userMessage || ''} ${aiResponse || ''}`.toLowerCase();

  // Score each available tip by keyword relevance
  const candidates = [];

  for (const [category, levels] of Object.entries(KNOWLEDGE_DB)) {
    const levelTips = levels[level] || [];
    for (const tip of levelTips) {
      if (completed.has(tip.id)) continue;

      let score = 0;
      for (const keyword of tip.keywords) {
        if (combined.includes(keyword.toLowerCase())) {
          score += 10;
        }
      }
      // Small random factor to avoid always showing same tip
      score += Math.random() * 3;

      candidates.push({ ...tip, _category: category, score });
    }
  }

  if (candidates.length === 0) return null;

  // Sort by relevance score
  candidates.sort((a, b) => b.score - a.score);

  // Return top candidate (with some randomness for variety)
  const topN = candidates.slice(0, Math.min(3, candidates.length));
  return topN[Math.floor(Math.random() * topN.length)];
}

function _getCategoryDisplayName(category) {
  const names = {
    technical_indicators: '技术指标',
    risk_management: '风险管理',
    position_sizing: '仓位管理',
    market_microstructure: '市场微观结构',
    quant_fundamentals: '量化基础',
  };
  return names[category] || category;
}

function _getLevelDisplayName(level) {
  const names = { beginner: '初级', intermediate: '中级', advanced: '高级' };
  return names[level] || level;
}

function _getTotalTopicCount() {
  let count = 0;
  for (const levels of Object.values(KNOWLEDGE_DB)) {
    for (const tips of Object.values(levels)) {
      count += tips.length;
    }
  }
  // Also count user-learned entries
  try {
    const userKB = _loadUserKnowledgeBase();
    count += userKB.length;
  } catch { /* ignore */ }
  return count;
}

// ─── Dynamic Knowledge Growth ───────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const USER_KB_FILE = path.join(os.homedir(), '.khyquant', 'growth', 'user_knowledge_base.json');
const SECURITY_LOG = path.join(os.homedir(), '.khyquant', 'security.log');

function _logSyncError(action, error) {
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), type: 'kb_sync', action, error: String(error) }) + '\n';
    fs.appendFileSync(SECURITY_LOG, entry);
  } catch { /* ignore */ }
}

/**
 * Extract and store new knowledge from AI conversation.
 * Called after AI responds — scans for educational content patterns.
 */
function extractKnowledge(userMessage, aiResponse) {
  if (!aiResponse || aiResponse.length < 50) return null;

  // Detect educational patterns in AI response
  const educationalPatterns = [
    /(?:是指|指的是|意思是|定义为|简称).{10,100}/,
    /(?:公式|计算方法|算法)[：:]\s*.{10,100}/,
    /(?:优点|缺点|优势|劣势|适用于|不适用于).{10,80}/,
    /(?:注意|要点|关键|核心|原则)[：:].{10,100}/,
    /(?:\d+[、.]\s*).{5,60}(?:\n(?:\d+[、.]\s*).{5,60}){2,}/,  // numbered list (3+ items)
  ];

  let extracted = null;

  for (const pattern of educationalPatterns) {
    const match = aiResponse.match(pattern);
    if (match) {
      extracted = match[0].trim();
      break;
    }
  }

  if (!extracted) return null;

  // Determine topic from context
  const topic = _inferTopic(userMessage + ' ' + aiResponse);
  if (!topic) return null;

  // Create knowledge entry
  const entry = {
    id: `user_${Date.now().toString(36)}`,
    title: _generateTitle(userMessage),
    content: extracted.slice(0, 200),
    keywords: _extractKeywords(userMessage + ' ' + extracted),
    source: 'conversation',
    category: topic,
    learnedAt: new Date().toISOString(),
    level: 'intermediate', // default; user-learned content is usually intermediate+
  };

  // Save to user knowledge base
  const userKB = _loadUserKnowledgeBase();

  // Avoid duplicates (similar title or content)
  const isDuplicate = userKB.some(existing =>
    existing.title === entry.title ||
    _similarity(existing.content, entry.content) > 0.7
  );

  if (!isDuplicate) {
    userKB.push(entry);
    // Keep max 200 entries
    if (userKB.length > 200) userKB.shift();
    _saveUserKnowledgeBase(userKB);

    // Award XP for passive learning
    try {
      const knowledge = getGrowthService().loadComponent('knowledge.json');
      knowledge.xp = (knowledge.xp || 0) + 1;
      getGrowthService().saveComponent('knowledge.json', knowledge);
    } catch { /* ignore */ }

    return entry;
  }

  return null;
}

/**
 * Get knowledge entries from user's learned base (for display/search).
 */
function getUserKnowledgeBase(category = null) {
  const userKB = _loadUserKnowledgeBase();
  if (category) return userKB.filter(e => e.category === category);
  return userKB;
}

/**
 * Search the full knowledge base (builtin + user-learned).
 */
function searchKnowledge(query) {
  const results = [];
  const lower = query.toLowerCase();

  // Search builtin
  for (const [category, levels] of Object.entries(KNOWLEDGE_DB)) {
    for (const [level, tips] of Object.entries(levels)) {
      for (const tip of tips) {
        const match = tip.keywords.some(kw => lower.includes(kw.toLowerCase())) ||
                     tip.title.toLowerCase().includes(lower) ||
                     tip.content.toLowerCase().includes(lower);
        if (match) {
          results.push({ ...tip, category: _getCategoryDisplayName(category), level, source: 'builtin' });
        }
      }
    }
  }

  // Search user KB
  const userKB = _loadUserKnowledgeBase();
  for (const entry of userKB) {
    const match = (entry.keywords || []).some(kw => lower.includes(kw.toLowerCase())) ||
                 (entry.title || '').toLowerCase().includes(lower) ||
                 (entry.content || '').toLowerCase().includes(lower);
    if (match) {
      results.push({ ...entry, source: 'learned' });
    }
  }

  return results;
}

/**
 * Get knowledge base statistics.
 */
function getKnowledgeStats() {
  let builtinCount = 0;
  for (const levels of Object.values(KNOWLEDGE_DB)) {
    for (const tips of Object.values(levels)) {
      builtinCount += tips.length;
    }
  }
  const userKB = _loadUserKnowledgeBase();
  const categories = {};
  for (const entry of userKB) {
    categories[entry.category] = (categories[entry.category] || 0) + 1;
  }

  return {
    builtinCount,
    learnedCount: userKB.length,
    totalCount: builtinCount + userKB.length,
    learnedCategories: categories,
    oldestLearned: userKB[0]?.learnedAt || null,
    newestLearned: userKB[userKB.length - 1]?.learnedAt || null,
  };
}

// ─── User KB persistence helpers ────────────────────────────────────────────

function _loadUserKnowledgeBase() {
  try {
    if (fs.existsSync(USER_KB_FILE)) {
      return JSON.parse(fs.readFileSync(USER_KB_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function _saveUserKnowledgeBase(data) {
  try {
    const dir = path.dirname(USER_KB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USER_KB_FILE, JSON.stringify(data, null, 2));
  } catch { /* ignore */ }
}

function _inferTopic(text) {
  const lower = text.toLowerCase();
  const TOPIC_HINTS = {
    technical_indicators: ['均线', 'ma', 'rsi', 'macd', 'kdj', '指标', 'k线', '布林', '量价'],
    risk_management: ['风险', '止损', '回撤', '仓位', 'var', '对冲', '夏普'],
    position_sizing: ['仓位', '加仓', '资金管理', '凯利', '分配'],
    market_microstructure: ['流动性', '价差', '冲击', '高频', '订单'],
    quant_fundamentals: ['量化', '因子', '回测', '过拟合', '策略', 'alpha', 'beta'],
  };

  for (const [topic, keywords] of Object.entries(TOPIC_HINTS)) {
    if (keywords.some(kw => lower.includes(kw))) return topic;
  }
  return 'quant_fundamentals'; // default
}

function _generateTitle(userMessage) {
  // Take the first meaningful phrase from user message
  const clean = (userMessage || '').replace(/[？?！!。，,]/g, '').trim();
  if (clean.length <= 20) return clean || '对话知识';
  return clean.slice(0, 20) + '...';
}

function _extractKeywords(text) {
  // Simple keyword extraction: find Chinese/English terms 2-6 chars
  const words = text.match(/[\u4e00-\u9fa5]{2,6}|[A-Za-z]{2,10}/g) || [];
  // Remove common words and deduplicate
  const STOP_WORDS = new Set(['什么', '怎么', '如何', '为什么', '是的', '可以', '能够', '或者', '以及', '这个', '那个', '的', '了', '在']);
  const unique = [...new Set(words.filter(w => !STOP_WORDS.has(w)))];
  return unique.slice(0, 8);
}

function _similarity(a, b) {
  // Simple Jaccard similarity on character bigrams
  if (!a || !b) return 0;
  const bigramsA = new Set();
  const bigramsB = new Set();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));
  const intersection = [...bigramsA].filter(x => bigramsB.has(x)).length;
  const union = new Set([...bigramsA, ...bigramsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── GitHub Knowledge Sync ──────────────────────────────────────────────────

const { execSync } = require('child_process');

const KB_SYNC_CONFIG_FILE = path.join(os.homedir(), '.khyquant', 'kb_sync.json');

/**
 * Configure Git platform repository for knowledge base sync.
 * Supports: GitHub, Gitee, GitLab.
 * @param {object} opts - { repo, platform, token, isPublic, branch }
 *   repo: "owner/repo" or full URL
 *   platform: 'github' | 'gitee' | 'gitlab' (auto-detected from URL)
 *   token: PAT (optional if using gh/glab CLI auth)
 *   isPublic: true = contribute to community KB, false = private backup
 *   branch: default "main"
 */
function configureKBSync(opts) {
  // Auto-detect platform from repo URL
  let platform = opts.platform || 'github';
  const repo = opts.repo || '';
  if (repo.includes('gitee.com')) platform = 'gitee';
  else if (repo.includes('gitlab.com') || repo.includes('gitlab')) platform = 'gitlab';
  else if (repo.includes('github.com')) platform = 'github';

  // Normalize repo to "owner/repo" format
  const repoSlug = repo
    .replace(/https?:\/\/(github|gitee|gitlab)\.com\//, '')
    .replace(/\.git$/, '');

  const config = {
    repo: repoSlug,
    platform,
    token: opts.token || null,
    isPublic: opts.isPublic !== false,
    branch: opts.branch || 'main',
    lastSync: null,
    autoSync: opts.autoSync !== false, // auto-push on every 10 new entries
    syncThreshold: opts.syncThreshold || 10,
    configuredAt: new Date().toISOString(),
  };

  const dir = path.dirname(KB_SYNC_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(KB_SYNC_CONFIG_FILE, JSON.stringify(config, null, 2));

  return config;
}

/**
 * Get current KB sync configuration.
 */
function getKBSyncConfig() {
  try {
    if (fs.existsSync(KB_SYNC_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(KB_SYNC_CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Push knowledge base to configured Git platform (GitHub/Gitee/GitLab).
 * Creates/updates a JSON file in the repo with the user's contributed knowledge.
 */
function syncKBToGitHub(opts = {}) {
  const config = getKBSyncConfig();
  if (!config || !config.repo) {
    return { success: false, error: '未配置同步仓库。使用 knowledge sync config <repo> 配置' };
  }

  const userKB = _loadUserKnowledgeBase();
  if (userKB.length === 0) {
    return { success: false, error: '知识库为空，暂无内容可同步' };
  }

  // Prepare contribution data
  const deviceId = `${os.platform()}-${os.hostname()}`.replace(/[^a-zA-Z0-9-]/g, '_');
  const contribution = {
    deviceId,
    syncedAt: new Date().toISOString(),
    entryCount: userKB.length,
    entries: config.isPublic
      ? userKB.map(e => ({ id: e.id, title: e.title, content: e.content, category: e.category, keywords: e.keywords }))
      : userKB, // Private repos get full data
  };

  const filename = config.isPublic
    ? `contributions/${deviceId}.json`
    : `backup/knowledge_${new Date().toISOString().slice(0, 10)}.json`;

  const platform = config.platform || 'github';
  const repoSlug = config.repo;

  try {
    // Platform-specific API push
    const result = _pushToPlatform(platform, repoSlug, filename, contribution, config);
    if (result.success) {
      config.lastSync = new Date().toISOString();
      config._lastSyncCount = userKB.length;
      fs.writeFileSync(KB_SYNC_CONFIG_FILE, JSON.stringify(config, null, 2));
    }
    return result;
  } catch (err) {
    // Fallback: try git clone/push directly
    _logSyncError('push_primary_failed', err.message);
    return _tryGitFallback(config, contribution, filename, err);
  }
}

/**
 * Platform-specific push implementation.
 */
function _pushToPlatform(platform, repoSlug, filename, contribution, config) {
  const content = Buffer.from(JSON.stringify(contribution, null, 2)).toString('base64');
  const message = `[KHY-Quant] Sync knowledge base (${contribution.entryCount} entries)`;

  switch (platform) {
    case 'github': {
      // Use gh CLI
      try { execSync('gh --version', { stdio: 'pipe' }); } catch {
        return { success: false, error: '需要安装 gh CLI: https://cli.github.com/' };
      }

      // Check existing file SHA
      let sha = null;
      try {
        sha = execSync(
          `gh api repos/${repoSlug}/contents/${filename} --jq '.sha'`,
          { stdio: 'pipe', encoding: 'utf-8' }
        ).trim();
      } catch { /* file doesn't exist */ }

      const body = { message, content, branch: config.branch };
      if (sha) body.sha = sha;

      execSync(
        `echo '${JSON.stringify(body).replace(/'/g, "'\\''")}' | gh api repos/${repoSlug}/contents/${filename} -X PUT --input -`,
        { stdio: 'pipe', shell: '/bin/bash' }
      );

      return { success: true, platform: 'github', repo: repoSlug, filename };
    }

    case 'gitee': {
      // Gitee API (compatible REST API, uses token directly)
      const token = config.token;
      if (!token) {
        return { success: false, error: 'Gitee 需要配置 token。使用 knowledge sync config <repo> --token <token> --platform gitee' };
      }

      const apiUrl = `https://gitee.com/api/v5/repos/${repoSlug}/contents/${filename}`;
      const body = JSON.stringify({ access_token: token, message, content, branch: config.branch });

      try {
        // Try PUT (create or update)
        execSync(
          `curl -s -X PUT "${apiUrl}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}' -o /dev/null -w "%{http_code}"`,
          { stdio: 'pipe', encoding: 'utf-8', shell: '/bin/bash' }
        );
        return { success: true, platform: 'gitee', repo: repoSlug, filename };
      } catch {
        // Try POST (create new)
        execSync(
          `curl -s -X POST "${apiUrl}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}' -o /dev/null`,
          { stdio: 'pipe', shell: '/bin/bash' }
        );
        return { success: true, platform: 'gitee', repo: repoSlug, filename };
      }
    }

    case 'gitlab': {
      // GitLab API (uses glab CLI or direct API)
      const token = config.token;
      const projectId = encodeURIComponent(repoSlug);
      const encodedPath = encodeURIComponent(filename);

      if (token) {
        // Direct API
        const apiUrl = `https://gitlab.com/api/v4/projects/${projectId}/repository/files/${encodedPath}`;
        const body = JSON.stringify({ branch: config.branch, content: JSON.stringify(contribution, null, 2), commit_message: message });

        try {
          const statusCode = execSync(
            `curl -s -o /dev/null -w "%{http_code}" -X PUT "${apiUrl}" -H "PRIVATE-TOKEN: ${token}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}' `,
            { stdio: 'pipe', encoding: 'utf-8', shell: '/bin/bash' }
          ).trim();

          if (statusCode === '404') {
            // File doesn't exist, create it
            execSync(
              `curl -s -X POST "${apiUrl}" -H "PRIVATE-TOKEN: ${token}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}' `,
              { stdio: 'pipe', shell: '/bin/bash' }
            );
          }
          return { success: true, platform: 'gitlab', repo: repoSlug, filename };
        } catch (e) {
          return { success: false, error: `GitLab API 失败: ${e.message}` };
        }
      }

      // Try glab CLI
      try {
        execSync('glab --version', { stdio: 'pipe' });
        // glab doesn't have content API, fall through to git fallback
      } catch { /* no glab */ }

      return { success: false, error: 'GitLab 需要配置 token 或安装 glab CLI' };
    }

    default:
      return { success: false, error: `不支持的平台: ${platform}` };
  }
}

/**
 * Pull community knowledge from a public repo (GitHub/Gitee/GitLab).
 * Merges contributed knowledge into the local user KB.
 */
function pullCommunityKnowledge(repoSlug, platform) {
  const config = getKBSyncConfig();
  const repo = repoSlug || config?.repo || 'KHY-Quant/knowledge-base';
  const plat = platform || config?.platform || 'github';

  try {
    let files = [];

    switch (plat) {
      case 'github': {
        const output = execSync(
          `gh api repos/${repo}/contents/contributions --jq '.[].name'`,
          { stdio: 'pipe', encoding: 'utf-8' }
        ).trim();
        files = output ? output.split('\n').filter(f => f.endsWith('.json')) : [];
        break;
      }
      case 'gitee': {
        const token = config?.token || '';
        const tokenParam = token ? `?access_token=${token}` : '';
        const output = execSync(
          `curl -s "https://gitee.com/api/v5/repos/${repo}/contents/contributions${tokenParam}" | node -e "const d=require('fs').readFileSync(0,'utf-8');const j=JSON.parse(d);j.forEach(f=>console.log(f.name))"`,
          { stdio: 'pipe', encoding: 'utf-8', shell: '/bin/bash' }
        ).trim();
        files = output ? output.split('\n').filter(f => f.endsWith('.json')) : [];
        break;
      }
      case 'gitlab': {
        const projectId = encodeURIComponent(repo);
        const token = config?.token || '';
        const header = token ? `-H "PRIVATE-TOKEN: ${token}"` : '';
        const output = execSync(
          `curl -s ${header} "https://gitlab.com/api/v4/projects/${projectId}/repository/tree?path=contributions" | node -e "const d=require('fs').readFileSync(0,'utf-8');const j=JSON.parse(d);j.forEach(f=>console.log(f.name))"`,
          { stdio: 'pipe', encoding: 'utf-8', shell: '/bin/bash' }
        ).trim();
        files = output ? output.split('\n').filter(f => f.endsWith('.json')) : [];
        break;
      }
    }

    if (files.length === 0) return { success: false, error: '社区知识库为空' };

    let merged = 0;
    const userKB = _loadUserKnowledgeBase();
    const existingIds = new Set(userKB.map(e => e.id));

    for (const file of files.slice(0, 10)) {
      try {
        let content;
        switch (plat) {
          case 'github':
            content = execSync(
              `gh api repos/${repo}/contents/contributions/${file} --jq '.content' | base64 -d`,
              { stdio: 'pipe', encoding: 'utf-8', shell: '/bin/bash' }
            );
            break;
          case 'gitee': {
            const token = config?.token || '';
            const tokenParam = token ? `?access_token=${token}` : '';
            const raw = execSync(
              `curl -s "https://gitee.com/api/v5/repos/${repo}/contents/contributions/${file}${tokenParam}" | node -e "const d=require('fs').readFileSync(0,'utf-8');console.log(Buffer.from(JSON.parse(d).content,'base64').toString())"`,
              { stdio: 'pipe', encoding: 'utf-8', shell: '/bin/bash' }
            );
            content = raw;
            break;
          }
          case 'gitlab': {
            const projectId = encodeURIComponent(repo);
            const filePath = encodeURIComponent(`contributions/${file}`);
            const token = config?.token || '';
            const header = token ? `-H "PRIVATE-TOKEN: ${token}"` : '';
            content = execSync(
              `curl -s ${header} "https://gitlab.com/api/v4/projects/${projectId}/repository/files/${filePath}/raw?ref=${config?.branch || 'main'}"`,
              { stdio: 'pipe', encoding: 'utf-8', shell: '/bin/bash' }
            );
            break;
          }
        }

        const contribution = JSON.parse(content);
        for (const entry of (contribution.entries || [])) {
          if (!existingIds.has(entry.id) && !_isDuplicateContent(entry, userKB)) {
            entry.source = 'community';
            entry.contributedBy = contribution.deviceId;
            userKB.push(entry);
            existingIds.add(entry.id);
            merged++;
          }
        }
      } catch { /* skip individual file errors */ }
    }

    if (merged > 0) {
      _saveUserKnowledgeBase(userKB);
    }

    return { success: true, merged, totalNow: userKB.length, contributors: files.length, platform: plat };
  } catch (err) {
    _logSyncError('pull_failed', err.message);
    return { success: false, error: `拉取社区知识失败: ${err.message}` };
  }
}

/**
 * Check if auto-sync threshold is reached.
 * Called after each knowledge extraction.
 */
function checkAutoSync() {
  const config = getKBSyncConfig();
  if (!config || !config.autoSync) return;

  const userKB = _loadUserKnowledgeBase();
  const lastSyncCount = config._lastSyncCount || 0;
  const newEntries = userKB.length - lastSyncCount;

  if (newEntries >= config.syncThreshold) {
    // Trigger background sync
    try {
      const result = syncKBToGitHub();
      if (result.success) {
        config._lastSyncCount = userKB.length;
        fs.writeFileSync(KB_SYNC_CONFIG_FILE, JSON.stringify(config, null, 2));
      }
    } catch { /* non-blocking */ }
  }
}

function _isDuplicateContent(entry, existingKB) {
  return existingKB.some(existing =>
    _similarity(existing.content, entry.content) > 0.7
  );
}

function _tryGitFallback(config, contribution, filename, originalErr) {
  // If user has the repo cloned locally, try git add/commit/push
  const localPath = path.join(os.homedir(), '.khyquant', 'kb-repo');

  try {
    if (!fs.existsSync(localPath)) {
      // Clone the repo (sanitize repo slug to prevent injection)
      const safeRepo = config.repo.replace(/[^a-zA-Z0-9._\-\/]/g, '');
      execSync(`git clone https://github.com/${safeRepo}.git "${localPath}"`, { stdio: 'pipe' });
    }

    // Write the file
    const filePath = path.join(localPath, filename);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(contribution, null, 2));

    // Git add, commit, push
    execSync(`cd "${localPath}" && git add . && git commit -m "[KHY-Quant] Sync KB" && git push`, { stdio: 'pipe' });

    config.lastSync = new Date().toISOString();
    fs.writeFileSync(KB_SYNC_CONFIG_FILE, JSON.stringify(config, null, 2));

    return { success: true, method: 'git', repo: config.repo, filename };
  } catch (gitErr) {
    return {
      success: false,
      error: `同步失败。gh CLI: ${originalErr.message}; git: ${gitErr.message}`,
      hint: '请确保已安装 gh CLI 并登录: gh auth login',
    };
  }
}

module.exports = {
  getContextualTip,
  recordLearning,
  getLevelProgress,
  getRecommendedTopics,
  extractKnowledge,
  getUserKnowledgeBase,
  searchKnowledge,
  getKnowledgeStats,
  // GitHub/Gitee/GitLab sync
  configureKBSync,
  getKBSyncConfig,
  syncKBToGitHub,
  pullCommunityKnowledge,
  checkAutoSync,
  KNOWLEDGE_DB,
};
