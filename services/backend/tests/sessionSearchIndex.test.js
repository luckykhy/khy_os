'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const searchIndex = require('../src/services/sessionSearchIndex');

describe('sessionSearchIndex', () => {
  beforeAll(() => {
    // Ensure clean state
    searchIndex._resetForTest();
  });

  afterAll(() => {
    searchIndex._resetForTest();
    // Cleanup temp db files
    const dbPath = searchIndex._dbPath();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ok */ }
  });

  beforeEach(() => {
    searchIndex._resetForTest();
    // Delete DB file for test isolation
    const dbPath = searchIndex._dbPath();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ok */ }
  });

  // ── init ──

  test('init() creates database and tables', () => {
    searchIndex.init();
    expect(searchIndex.isAvailable()).toBe(true);
  });

  test('init() is idempotent', () => {
    searchIndex.init();
    searchIndex.init(); // should not throw
    expect(searchIndex.isAvailable()).toBe(true);
  });

  // ── indexSession ──

  test('indexSession() indexes messages', () => {
    searchIndex.init();

    searchIndex.indexSession('test-sess-1', {
      title: 'Test Session',
      model: 'claude-3',
      messages: [
        { role: 'user', content: 'How do I implement quicksort?' },
        { role: 'assistant', content: 'Here is a quicksort implementation in Python...' },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const stats = searchIndex.getStats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalMessages).toBe(2);
  });

  test('indexSession() handles empty messages', () => {
    searchIndex.init();

    searchIndex.indexSession('test-empty', {
      title: 'Empty',
      messages: [],
    });

    const stats = searchIndex.getStats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalMessages).toBe(0);
  });

  test('indexSession() appends new messages on re-index', () => {
    searchIndex.init();

    searchIndex.indexSession('test-append', {
      title: 'Append Test',
      messages: [
        { role: 'user', content: 'First message' },
      ],
    });

    searchIndex.indexSession('test-append', {
      title: 'Append Test',
      messages: [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Second message' },
      ],
    });

    const stats = searchIndex.getStats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalMessages).toBe(2); // Not 3
  });

  // ── searchMessages ──

  test('searchMessages() returns ranked results', () => {
    searchIndex.init();

    searchIndex.indexSession('search-test', {
      title: 'Search Demo',
      messages: [
        { role: 'user', content: 'Tell me about machine learning algorithms' },
        { role: 'assistant', content: 'Machine learning includes supervised and unsupervised learning' },
        { role: 'user', content: 'What about deep learning?' },
      ],
    });

    const results = searchIndex.searchMessages('machine learning');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sessionId).toBe('search-test');
    expect(results[0]).toHaveProperty('content');
    expect(results[0]).toHaveProperty('role');
    expect(results[0]).toHaveProperty('rank');
  });

  test('searchMessages() returns empty for no matches', () => {
    searchIndex.init();

    searchIndex.indexSession('no-match', {
      title: 'No Match',
      messages: [{ role: 'user', content: 'hello world' }],
    });

    const results = searchIndex.searchMessages('zzzznonexistentterm');
    expect(results.length).toBe(0);
  });

  test('searchMessages() respects limit', () => {
    searchIndex.init();

    const messages = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `Test query number ${i} about algorithms` });
    }
    searchIndex.indexSession('limit-test', { title: 'Limit', messages });

    const results = searchIndex.searchMessages('algorithms', { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  test('searchMessages() with empty query returns empty', () => {
    searchIndex.init();
    expect(searchIndex.searchMessages('')).toEqual([]);
    expect(searchIndex.searchMessages(null)).toEqual([]);
  });

  // ── Chinese text search ──

  test('searchMessages() works with Chinese text', () => {
    searchIndex.init();

    searchIndex.indexSession('chinese-test', {
      title: '中文测试',
      messages: [
        { role: 'user', content: '如何实现量化交易策略' },
        { role: 'assistant', content: '量化交易策略可以使用均线交叉等技术指标' },
      ],
    });

    const results = searchIndex.searchMessages('量化交易');
    expect(results.length).toBeGreaterThan(0);
  });

  // ── removeSessionIndex ──

  test('removeSessionIndex() deletes session and messages', () => {
    searchIndex.init();

    searchIndex.indexSession('to-remove', {
      title: 'Remove Me',
      messages: [
        { role: 'user', content: 'This will be deleted' },
      ],
    });

    expect(searchIndex.getStats().totalSessions).toBe(1);

    searchIndex.removeSessionIndex('to-remove');

    expect(searchIndex.getStats().totalSessions).toBe(0);
    expect(searchIndex.getStats().totalMessages).toBe(0);
  });

  // ── getStats ──

  test('getStats() returns correct counts', () => {
    searchIndex.init();

    searchIndex.indexSession('stats-1', {
      messages: [{ role: 'user', content: 'msg1' }, { role: 'assistant', content: 'msg2' }],
    });
    searchIndex.indexSession('stats-2', {
      messages: [{ role: 'user', content: 'msg3' }],
    });

    const stats = searchIndex.getStats();
    expect(stats.totalSessions).toBe(2);
    expect(stats.totalMessages).toBe(3);
    expect(stats.available).toBe(true);
  });

  test('getStats() returns unavailable when not initialized', () => {
    // Fresh reset, no init
    const stats = searchIndex.getStats();
    expect(stats.available).toBe(false);
    expect(stats.totalSessions).toBe(0);
  });

  // ── Graceful degradation ──

  test('all functions are safe to call when unavailable', () => {
    // No init, module is unavailable
    expect(() => searchIndex.indexSession('x', { messages: [] })).not.toThrow();
    expect(() => searchIndex.searchMessages('test')).not.toThrow();
    expect(() => searchIndex.removeSessionIndex('x')).not.toThrow();
    expect(searchIndex.searchMessages('test')).toEqual([]);
  });
});
