'use strict';

describe('ragRetrievalService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('returns skipped result when RAG is disabled', () => {
    process.env.KHY_RAG_ENABLED = 'false';
    const rag = require('../../src/services/ragRetrievalService');
    const result = rag.buildRetrievalContext('RSI 指标怎么用');
    expect(result).toBeTruthy();
    expect(result.used).toBe(false);
    expect(result.meta.reason).toBe('skipped');
  });

  test('builds context from knowledge + session results', () => {
    process.env.KHY_RAG_ENABLED = 'true';
    process.env.KHY_RAG_TOPK = '5';
    process.env.KHY_RAG_KNOWLEDGE_TOPK = '3';
    process.env.KHY_RAG_SESSION_TOPK = '2';

    jest.doMock('../../src/services/knowledgeTeachingService', () => ({
      searchKnowledge: () => ([
        {
          title: 'RSI 实战运用',
          content: 'RSI > 70 常见于超买区，< 30 常见于超卖区。',
          keywords: ['RSI', '超买', '超卖'],
          category: '技术指标',
          level: 'intermediate',
          source: 'builtin',
        },
      ]),
    }));

    jest.doMock('../../src/services/sessionSearchIndex', () => ({
      init: () => {},
      isAvailable: () => true,
      searchMessages: () => ([
        {
          sessionId: 's1',
          title: '指标讨论',
          role: 'assistant',
          content: '上一轮回测里 RSI 在震荡区间更稳定。',
          timestamp: Date.now(),
          rank: -0.2,
        },
      ]),
    }));

    const rag = require('../../src/services/ragRetrievalService');
    const result = rag.buildRetrievalContext('RSI 回测怎么优化');

    expect(result.used).toBe(true);
    expect(result.context).toContain('检索增强上下文');
    expect(result.context).toContain('RSI 实战运用');
    expect(result.context).toContain('历史会话');
    expect(result.meta.selectedCount).toBeGreaterThanOrEqual(1);
    expect(result.meta.knowledgeHits).toBeGreaterThanOrEqual(1);
  });

  test('uses in-memory cache for repeated same query', () => {
    process.env.KHY_RAG_ENABLED = 'true';
    process.env.KHY_RAG_CACHE_TTL_MS = '600000';

    let searchCalls = 0;
    jest.doMock('../../src/services/knowledgeTeachingService', () => ({
      searchKnowledge: () => {
        searchCalls += 1;
        return [{
          title: '回测基础',
          content: '回测需考虑滑点与交易成本。',
          keywords: ['回测', '滑点'],
          category: '量化基础',
          level: 'beginner',
          source: 'builtin',
        }];
      },
    }));
    jest.doMock('../../src/services/sessionSearchIndex', () => ({
      init: () => {},
      isAvailable: () => false,
      searchMessages: () => [],
    }));

    const rag = require('../../src/services/ragRetrievalService');
    const first = rag.buildRetrievalContext('回测要注意什么');
    const second = rag.buildRetrievalContext('回测要注意什么');

    expect(first.used).toBe(true);
    expect(second.used).toBe(true);
    expect(second.meta.cacheHit).toBe(true);
    expect(searchCalls).toBe(1);
  });
});

