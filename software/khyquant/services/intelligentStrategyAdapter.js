/**
 * Intelligent Strategy Adapter (策略适配层核心)
 *
 * Implements the Adapter + Strategy design patterns described in
 * thesis Chapter 4.3. Performs four-step processing:
 *   1. Language detection (Python / JavaScript / TDX formulas)
 *   2. Strategy type classification (trend / momentum / arbitrage / ...)
 *   3. Complexity assessment (low / medium / high)
 *   4. Auto-configuration generation
 *
 * See thesis Figure 6 (adapter class diagram) and Code Block 5.
 */

class IntelligentStrategyAdapter {
  constructor() {
    // 策略类型检测规则
    this.strategyPatterns = {
      trend: {
        keywords: ['ma', 'ema', 'sma', 'moving', 'average', 'trend', 'crossover', '均线', '趋势', '金叉', '死叉'],
        indicators: ['ma5', 'ma10', 'ma20', 'ma30', 'ema', 'sma'],
        weight: 0
      },
      mean_reversion: {
        keywords: ['rsi', 'bollinger', 'bands', 'oversold', 'overbought', 'reversion', 'mean', '超买', '超卖', '布林', '回归'],
        indicators: ['rsi', 'bb', 'bollinger', 'stoch'],
        weight: 0
      },
      momentum: {
        keywords: ['macd', 'momentum', 'dif', 'dea', 'signal', 'histogram', 'divergence', '动量', '背离'],
        indicators: ['macd', 'momentum', 'roc'],
        weight: 0
      },
      arbitrage: {
        keywords: ['arbitrage', 'spread', 'pair', 'correlation', 'hedge', '套利', '对冲', '价差'],
        indicators: ['spread', 'correlation'],
        weight: 0
      },
      market_making: {
        keywords: ['market', 'making', 'bid', 'ask', 'spread', 'liquidity', '做市', '流动性', '买卖价差'],
        indicators: ['bid_ask', 'volume'],
        weight: 0
      }
    };

    // 编程语言检测规则
    this.languagePatterns = {
      javascript: {
        keywords: ['function', 'const', 'let', 'var', '=>', 'return', 'for', 'if'],
        syntax: [/function\s+\w+\s*\(/, /=>\s*{/, /const\s+\w+/, /let\s+\w+/, /var\s+\w+/],
        weight: 0
      },
      python: {
        keywords: ['def', 'import', 'numpy', 'pandas', 'talib', 'return', 'for', 'if', 'elif'],
        syntax: [/def\s+\w+\s*\(/, /import\s+\w+/, /from\s+\w+\s+import/, /np\./, /pd\./],
        weight: 0
      }
    };

    // 策略复杂度检测
    this.complexityIndicators = {
      simple: ['ma', 'sma', 'price', 'volume'],
      intermediate: ['rsi', 'macd', 'bollinger', 'stochastic'],
      advanced: ['kalman', 'neural', 'machine', 'learning', 'ai', 'lstm']
    };
  }

  /**
   * 智能分析策略代码并返回最佳配置
   * @param {string} code - 策略代码
   * @param {string} name - 策略名称
   * @param {string} description - 策略描述
   * @returns {Object} 智能分析结果
   */
  analyzeStrategy(code, name = '', description = '') {
    const analysis = {
      detectedLanguage: this.detectLanguage(code),
      detectedType: this.detectStrategyType(code, name, description),
      complexity: this.detectComplexity(code),
      confidence: 0,
      recommendations: [],
      autoConfig: {}
    };

    // 计算置信度
    analysis.confidence = this.calculateConfidence(analysis, code);

    // 生成推荐配置
    analysis.autoConfig = this.generateAutoConfig(analysis, code, name, description);

    // 生成建议
    analysis.recommendations = this.generateRecommendations(analysis);

    return analysis;
  }

  /**
   * 检测编程语言
   */
  detectLanguage(code) {
    const codeText = code.toLowerCase();
    
    // 重置权重
    Object.keys(this.languagePatterns).forEach(lang => {
      this.languagePatterns[lang].weight = 0;
    });

    // 关键词匹配
    Object.entries(this.languagePatterns).forEach(([lang, pattern]) => {
      pattern.keywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
        const matches = (codeText.match(regex) || []).length;
        pattern.weight += matches * 2;
      });

      // 语法模式匹配
      pattern.syntax.forEach(syntaxRegex => {
        const matches = (code.match(syntaxRegex) || []).length;
        pattern.weight += matches * 5;
      });
    });

    // 特殊检测规则
    if (code.includes('def ') && code.includes(':')) {
      this.languagePatterns.python.weight += 10;
    }
    if (code.includes('function') || code.includes('=>')) {
      this.languagePatterns.javascript.weight += 10;
    }

    // 返回权重最高的语言
    const detectedLang = Object.entries(this.languagePatterns)
      .sort(([,a], [,b]) => b.weight - a.weight)[0];

    return {
      language: detectedLang[0],
      confidence: Math.min(detectedLang[1].weight / 10, 1),
      weights: Object.fromEntries(
        Object.entries(this.languagePatterns).map(([lang, pattern]) => [lang, pattern.weight])
      )
    };
  }

  /**
   * 检测策略类型
   */
  detectStrategyType(code, name = '', description = '') {
    const fullText = (code + ' ' + name + ' ' + description).toLowerCase();
    
    // 重置权重
    Object.keys(this.strategyPatterns).forEach(type => {
      this.strategyPatterns[type].weight = 0;
    });

    // 关键词匹配
    Object.entries(this.strategyPatterns).forEach(([type, pattern]) => {
      pattern.keywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
        const matches = (fullText.match(regex) || []).length;
        pattern.weight += matches * 3;
      });

      // 指标匹配
      pattern.indicators.forEach(indicator => {
        const regex = new RegExp(`\\b${indicator}\\b`, 'gi');
        const matches = (fullText.match(regex) || []).length;
        pattern.weight += matches * 5;
      });
    });

    // 特殊检测规则
    this.applySpecialDetectionRules(code, fullText);

    // 返回权重最高的策略类型
    const detectedType = Object.entries(this.strategyPatterns)
      .sort(([,a], [,b]) => b.weight - a.weight)[0];

    return {
      type: detectedType[0],
      confidence: Math.min(detectedType[1].weight / 15, 1),
      weights: Object.fromEntries(
        Object.entries(this.strategyPatterns).map(([type, pattern]) => [type, pattern.weight])
      )
    };
  }

  /**
   * 应用特殊检测规则
   */
  applySpecialDetectionRules(code, fullText) {
    // MACD策略检测
    if (code.includes('macd') || code.includes('dif') || code.includes('dea')) {
      this.strategyPatterns.momentum.weight += 15;
    }

    // 双均线策略检测
    if ((code.includes('ma5') && code.includes('ma10')) || 
        (code.includes('shortma') && code.includes('longma'))) {
      this.strategyPatterns.trend.weight += 12;
    }

    // RSI策略检测
    if (code.includes('rsi') && (code.includes('70') || code.includes('30'))) {
      this.strategyPatterns.mean_reversion.weight += 12;
    }

    // 布林带策略检测
    if (code.includes('bollinger') || (code.includes('upper') && code.includes('lower'))) {
      this.strategyPatterns.mean_reversion.weight += 10;
    }

    // 套利策略检测
    if (code.includes('spread') || code.includes('pair') || fullText.includes('arbitrage')) {
      this.strategyPatterns.arbitrage.weight += 15;
    }

    // 做市策略检测
    if (code.includes('bid') && code.includes('ask')) {
      this.strategyPatterns.market_making.weight += 15;
    }
  }

  /**
   * 检测策略复杂度
   */
  detectComplexity(code) {
    const codeText = code.toLowerCase();
    let complexityScore = 0;

    // 简单指标
    this.complexityIndicators.simple.forEach(indicator => {
      if (codeText.includes(indicator)) complexityScore += 1;
    });

    // 中等指标
    this.complexityIndicators.intermediate.forEach(indicator => {
      if (codeText.includes(indicator)) complexityScore += 3;
    });

    // 高级指标
    this.complexityIndicators.advanced.forEach(indicator => {
      if (codeText.includes(indicator)) complexityScore += 8;
    });

    // 代码长度影响
    const codeLength = code.length;
    if (codeLength > 2000) complexityScore += 5;
    else if (codeLength > 1000) complexityScore += 3;
    else if (codeLength > 500) complexityScore += 1;

    // 函数数量影响
    const functionCount = (code.match(/function|def/g) || []).length;
    complexityScore += functionCount * 2;

    // 返回复杂度等级
    if (complexityScore <= 5) return 'simple';
    if (complexityScore <= 15) return 'intermediate';
    return 'advanced';
  }

  /**
   * 计算整体置信度
   */
  calculateConfidence(analysis, code) {
    let confidence = 0;
    
    // 语言检测置信度权重 40%
    confidence += analysis.detectedLanguage.confidence * 0.4;
    
    // 策略类型检测置信度权重 50%
    confidence += analysis.detectedType.confidence * 0.5;
    
    // 代码完整性权重 10%
    const codeCompleteness = Math.min(code.length / 500, 1);
    confidence += codeCompleteness * 0.1;

    return Math.min(confidence, 1);
  }

  /**
   * 生成自动配置
   */
  generateAutoConfig(analysis, code, name, description) {
    const config = {
      name: name || this.generateStrategyName(analysis),
      description: description || this.generateStrategyDescription(analysis),
      type: analysis.detectedType.type,
      language: analysis.detectedLanguage.language,
      parameters: this.extractParameters(code, analysis),
      isPublic: false,
      tags: this.generateTags(analysis, code)
    };

    return config;
  }

  /**
   * 生成策略名称
   */
  generateStrategyName(analysis) {
    const typeNames = {
      trend: '趋势跟踪策略',
      mean_reversion: '均值回归策略',
      momentum: '动量策略',
      arbitrage: '套利策略',
      market_making: '做市策略'
    };

    const langSuffix = analysis.detectedLanguage.language === 'python' ? ' (Python)' : ' (JavaScript)';
    return (typeNames[analysis.detectedType.type] || '自定义策略') + langSuffix;
  }

  /**
   * 生成策略描述
   */
  generateStrategyDescription(analysis) {
    const descriptions = {
      trend: '基于趋势指标的交易策略，通过识别价格趋势进行买卖决策',
      mean_reversion: '基于均值回归理论的策略，在价格偏离均值时进行反向交易',
      momentum: '基于动量指标的策略，捕捉价格动量变化进行交易',
      arbitrage: '利用价格差异进行套利的策略，追求低风险收益',
      market_making: '提供流动性的做市策略，通过买卖价差获得收益'
    };

    return descriptions[analysis.detectedType.type] || '智能检测的自定义交易策略';
  }

  /**
   * 提取策略参数
   */
  extractParameters(code, analysis) {
    const parameters = {};

    // 常见参数模式
    const paramPatterns = [
      { name: 'period', regex: /period\s*[=:]\s*(\d+)/i, default: 14 },
      { name: 'fastPeriod', regex: /fast[_\s]*period\s*[=:]\s*(\d+)/i, default: 12 },
      { name: 'slowPeriod', regex: /slow[_\s]*period\s*[=:]\s*(\d+)/i, default: 26 },
      { name: 'signalPeriod', regex: /signal[_\s]*period\s*[=:]\s*(\d+)/i, default: 9 },
      { name: 'shortPeriod', regex: /short[_\s]*period\s*[=:]\s*(\d+)/i, default: 5 },
      { name: 'longPeriod', regex: /long[_\s]*period\s*[=:]\s*(\d+)/i, default: 20 },
      { name: 'overbought', regex: /overbought\s*[=:]\s*(\d+)/i, default: 70 },
      { name: 'oversold', regex: /oversold\s*[=:]\s*(\d+)/i, default: 30 }
    ];

    paramPatterns.forEach(pattern => {
      const match = code.match(pattern.regex);
      if (match) {
        parameters[pattern.name] = parseInt(match[1]);
      } else if (analysis.detectedType.type === 'momentum' && pattern.name.includes('Period')) {
        parameters[pattern.name] = pattern.default;
      } else if (analysis.detectedType.type === 'trend' && (pattern.name === 'shortPeriod' || pattern.name === 'longPeriod')) {
        parameters[pattern.name] = pattern.default;
      } else if (analysis.detectedType.type === 'mean_reversion' && (pattern.name === 'overbought' || pattern.name === 'oversold')) {
        parameters[pattern.name] = pattern.default;
      }
    });

    return parameters;
  }

  /**
   * 生成标签
   */
  generateTags(analysis, code) {
    const tags = [];

    // 添加类型标签
    tags.push(analysis.detectedType.type);

    // 添加语言标签
    tags.push(analysis.detectedLanguage.language);

    // 添加复杂度标签
    tags.push(analysis.complexity);

    // 添加指标标签
    const indicators = ['macd', 'rsi', 'ma', 'ema', 'bollinger', 'stochastic'];
    indicators.forEach(indicator => {
      if (code.toLowerCase().includes(indicator)) {
        tags.push(indicator.toUpperCase());
      }
    });

    // 添加特性标签
    if (code.includes('金叉') || code.includes('死叉') || code.includes('crossover')) {
      tags.push('交叉信号');
    }
    if (code.includes('超买') || code.includes('超卖') || code.includes('overbought') || code.includes('oversold')) {
      tags.push('超买超卖');
    }

    return [...new Set(tags)]; // 去重
  }

  /**
   * 生成建议
   */
  generateRecommendations(analysis) {
    const recommendations = [];

    // 置信度建议
    if (analysis.confidence < 0.6) {
      recommendations.push({
        type: 'warning',
        message: '代码特征不够明显，建议添加更多注释或使用标准指标名称'
      });
    }

    // 语言建议
    if (analysis.detectedLanguage.confidence < 0.7) {
      recommendations.push({
        type: 'info',
        message: '无法确定编程语言，已默认选择JavaScript，如需Python请手动调整'
      });
    }

    // 策略类型建议
    if (analysis.detectedType.confidence < 0.5) {
      recommendations.push({
        type: 'info',
        message: '策略类型检测不确定，建议在代码中添加更明确的指标或注释'
      });
    }

    // 复杂度建议
    if (analysis.complexity === 'advanced') {
      recommendations.push({
        type: 'success',
        message: '检测到高级策略，建议进行充分的回测验证'
      });
    }

    return recommendations;
  }

  /**
   * 智能创建策略（主入口方法）
   */
  intelligentCreateStrategy(code, name = '', description = '') {
    const analysis = this.analyzeStrategy(code, name, description);
    
    return {
      analysis,
      strategy: {
        ...analysis.autoConfig,
        code: code,
        metadata: {
          autoGenerated: true,
          detectionConfidence: analysis.confidence,
          detectionResults: {
            language: analysis.detectedLanguage,
            type: analysis.detectedType,
            complexity: analysis.complexity
          }
        }
      }
    };
  }
}

module.exports = new IntelligentStrategyAdapter();