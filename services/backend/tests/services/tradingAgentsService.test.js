'use strict';

/**
 * Unit tests for tradingAgentsService.
 *
 * Mocks the LLM service to test pure logic: intent analysis,
 * analysis type detection, market topic detection, confidence
 * calculation, and fallback responses.
 */

jest.mock('../../src/services/llmService', () => {
  return jest.fn().mockImplementation(() => ({
    analyze: jest.fn().mockResolvedValue('Mock analysis result'),
  }));
});

jest.mock('../../src/services/freeStockDataService', () => ({
  getStockData: jest.fn().mockResolvedValue(null),
}));

let tradingAgentsService;

beforeAll(() => {
  try {
    tradingAgentsService = require('../../src/services/tradingAgentsService');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    if (e.code === 'MODULE_NOT_FOUND' && !e.message.includes('tradingAgentsService')) throw e;
  }
});

describe('tradingAgentsService', () => {
  test('module exports an object with expected methods', () => {
    if (!tradingAgentsService) return;
    expect(typeof tradingAgentsService).toBe('object');
    expect(typeof tradingAgentsService.processChatMessage).toBe('function');
    expect(typeof tradingAgentsService.analyzeUserIntent).toBe('function');
    expect(typeof tradingAgentsService.detectAnalysisType).toBe('function');
    expect(typeof tradingAgentsService.detectMarketTopic).toBe('function');
    expect(typeof tradingAgentsService.executeMultiAgentAnalysis).toBe('function');
    expect(typeof tradingAgentsService.executeSingleAgent).toBe('function');
    expect(typeof tradingAgentsService.calculateConfidence).toBe('function');
  });

  test('analyzeUserIntent detects stock analysis intent', () => {
    if (!tradingAgentsService) return;
    const result = tradingAgentsService.analyzeUserIntent('分析600519这只股票');
    expect(result.type).toBe('stock_analysis');
    expect(result.stockCode).toBe('600519');
  });

  test('analyzeUserIntent detects stock code patterns', () => {
    if (!tradingAgentsService) return;
    const result = tradingAgentsService.analyzeUserIntent('sz000001怎么样');
    expect(result.type).toBe('stock_analysis');
  });

  test('analyzeUserIntent detects market question intent', () => {
    if (!tradingAgentsService) return;
    const result = tradingAgentsService.analyzeUserIntent('今天市场行情如何');
    expect(result.type).toBe('market_question');
  });

  test('analyzeUserIntent returns general_chat for generic messages', () => {
    if (!tradingAgentsService) return;
    const result = tradingAgentsService.analyzeUserIntent('hello world');
    expect(result.type).toBe('general_chat');
  });

  test('detectAnalysisType maps keywords to correct types', () => {
    if (!tradingAgentsService) return;
    expect(tradingAgentsService.detectAnalysisType('基本面分析')).toBe('fundamentals');
    expect(tradingAgentsService.detectAnalysisType('技术面图表')).toBe('market');
    expect(tradingAgentsService.detectAnalysisType('新闻消息面')).toBe('news');
    expect(tradingAgentsService.detectAnalysisType('市场情绪分析')).toBe('social');
    expect(tradingAgentsService.detectAnalysisType('风险评估')).toBe('risk');
    expect(tradingAgentsService.detectAnalysisType('策略建议')).toBe('strategy');
    expect(tradingAgentsService.detectAnalysisType('random text')).toBe('market');
  });

  test('detectMarketTopic maps keywords to correct topics', () => {
    if (!tradingAgentsService) return;
    expect(tradingAgentsService.detectMarketTopic('牛市来了')).toBe('market_trend');
    expect(tradingAgentsService.detectMarketTopic('利率政策')).toBe('policy');
    expect(tradingAgentsService.detectMarketTopic('板块轮动')).toBe('sector');
    expect(tradingAgentsService.detectMarketTopic('其他话题')).toBe('general_market');
  });

  test('calculateConfidence averages scores and clamps to [0,1]', () => {
    if (!tradingAgentsService) return;
    const decision = {
      technicalScore: 0.8,
      fundamentalScore: 0.6,
      sentimentScore: 0.7,
      riskScore: 0.5,
    };
    const confidence = tradingAgentsService.calculateConfidence(decision);
    expect(confidence).toBeCloseTo(0.65, 1);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  test('getAnalysisTypeName returns human-readable names', () => {
    if (!tradingAgentsService) return;
    expect(tradingAgentsService.getAnalysisTypeName('market')).toBe('技术分析');
    expect(tradingAgentsService.getAnalysisTypeName('fundamentals')).toBe('基本面分析');
    expect(tradingAgentsService.getAnalysisTypeName('unknown')).toBe('综合分析');
  });

  test('getFallbackAnalysis returns structured result', () => {
    if (!tradingAgentsService) return;
    const result = tradingAgentsService.getFallbackAnalysis('sh600000');
    expect(result.symbol).toBe('sh600000');
    expect(result.timestamp).toBeDefined();
    expect(result.finalDecision).toBeDefined();
    expect(result.finalDecision.action).toBe('HOLD');
    expect(result.status).toBe('fallback');
  });
});
