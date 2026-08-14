'use strict';

describe('traceAuditService requestId propagation', () => {
  let appendSpy;
  let originalEnv;
  let auditDir;

  beforeEach(() => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    originalEnv = { ...process.env };
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-trace-audit-'));
    process.env.KHY_TRACE_AUDIT_DIR = auditDir;
    jest.resetModules();
    jest.clearAllMocks();
    appendSpy = jest.spyOn(fs, 'appendFileSync');
  });

  afterEach(() => {
    const fs = require('fs');
    process.env = originalEnv;
    if (appendSpy) appendSpy.mockRestore();
    if (auditDir) {
      try {
        fs.rmSync(auditDir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('logEvent persists requestId alongside traceId', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    const event = traceAudit.logEvent('unit.test', { ok: true }, {
      sessionId: 'sess-1',
      traceId: 'trace-1',
      requestId: 'req-1',
      source: 'jest',
    });

    expect(event.traceId).toBe('trace-1');
    expect(event.requestId).toBe('req-1');
    expect(appendSpy).toHaveBeenCalled();
  });

  test('uses temp audit root by default in jest when no explicit audit dir is set', () => {
    delete process.env.KHY_TRACE_AUDIT_DIR;
    process.env.JEST_WORKER_ID = '7';
    jest.resetModules();

    const os = require('os');
    const path = require('path');
    const traceAudit = require('../../src/services/traceAuditService');

    expect(traceAudit.AUDIT_ROOT).toBe(path.join(os.tmpdir(), 'khy-audit-jest', 'worker-7'));
  });

  test('latest delivery summary detects missing final conclusion', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('llm.request', { ok: true }, {
      sessionId: 'sess-2',
      traceId: 'trace-2',
      requestId: 'req-2',
      source: 'jest',
    });
    traceAudit.logEvent('agent.tool.call', { toolName: 'editFile' }, {
      sessionId: 'sess-2',
      traceId: 'trace-2',
      requestId: 'req-2',
      source: 'jest',
    });
    traceAudit.logEvent('agent.tool.result', { success: true }, {
      sessionId: 'sess-2',
      traceId: 'trace-2',
      requestId: 'req-2',
      source: 'jest',
    });
    traceAudit.logEvent('llm.response', { success: true }, {
      sessionId: 'sess-2',
      traceId: 'trace-2',
      requestId: 'req-2',
      source: 'jest',
    });
    traceAudit.logEvent('agent.delivery.final', { hasConclusion: false, success: true }, {
      sessionId: 'sess-2',
      traceId: 'trace-2',
      requestId: 'req-2',
      source: 'jest',
    });

    const summary = traceAudit.getLatestDeliveryRequestSummary({ sessionId: 'sess-2' });
    expect(summary.ok).toBe(true);
    expect(summary.requestId).toBe('req-2');
    expect(summary.status).toBe('incomplete');
    expect(summary.brokenStage).toBe('final_conclusion');
    expect(summary.checks.deliveryFinal).toBe(true);
    expect(summary.checks.deliveryConclusion).toBe(false);
  });

  test('latest delivery summary marks delivery-only evidence as summary-only instead of broken', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('agent.delivery.final', { hasConclusion: false, success: true }, {
      sessionId: 'sess-delivery-only',
      traceId: 'trace-delivery-only',
      requestId: 'req-delivery-only',
      source: 'jest',
    });

    const summary = traceAudit.getLatestDeliveryRequestSummary({ sessionId: 'sess-delivery-only' });
    expect(summary.ok).toBe(true);
    expect(summary.requestId).toBe('req-delivery-only');
    expect(summary.status).toBe('summary_only');
    expect(summary.brokenStage).toBe(null);
    expect(summary.eventCount).toBe(1);
    expect(summary.checks.deliveryFinal).toBe(true);
    expect(summary.checks.deliveryConclusion).toBe(false);
    expect(summary.summary).toContain('仅记录到最终交付事件');
  });

  test('latest delivery summary treats standalone request/response as response-only instead of broken', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('llm.request', { ok: true }, {
      sessionId: 'sess-response-only',
      traceId: 'trace-response-only',
      requestId: 'req-response-only',
      source: 'ai-chat',
    });
    traceAudit.logEvent('llm.response', { success: true }, {
      sessionId: 'sess-response-only',
      traceId: 'trace-response-only',
      requestId: 'req-response-only',
      source: 'ai-chat',
    });

    const summary = traceAudit.getLatestDeliveryRequestSummary({ sessionId: 'sess-response-only' });
    expect(summary.ok).toBe(true);
    expect(summary.requestId).toBe('req-response-only');
    expect(summary.status).toBe('response_only');
    expect(summary.brokenStage).toBe(null);
    expect(summary.eventCount).toBe(2);
    expect(summary.checks).toMatchObject({
      modelRequest: true,
      modelResponse: true,
      deliveryFinal: false,
    });
    expect(summary.summary).toContain('独立 chat 路径未记录 agent.delivery.final');
  });

  test('latest language consistency summary detects English first chunk mismatch', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('agent.language.first_chunk', {
      adapter: 'codex',
      adapterName: 'Codex CLI',
      expectedLanguage: 'zh',
      detectedLanguage: 'en',
      matchesExpectation: false,
      riskyAdapter: true,
      textSample: 'I will inspect the repository first.',
      summary: '首段正文疑似英文，偏离 KHY 中文预期',
    }, {
      sessionId: 'sess-lang-1',
      traceId: 'trace-lang-1',
      requestId: 'req-lang-1',
      source: 'jest',
    });

    const summary = traceAudit.getLatestLanguageConsistencySummary({ sessionId: 'sess-lang-1' });
    expect(summary.ok).toBe(true);
    expect(summary.requestId).toBe('req-lang-1');
    expect(summary.status).toBe('mismatch');
    expect(summary.detectedLanguage).toBe('en');
    expect(summary.expectedLanguage).toBe('zh');
    expect(summary.source).toBe('first_chunk');
    expect(summary.summary).toContain('语言一致性异常');
  });

  test('latest language consistency summary supports explicit English expectation', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('agent.language.first_chunk', {
      adapter: 'codex',
      adapterName: 'Codex CLI',
      expectedLanguage: 'en',
      detectedLanguage: 'en',
      matchesExpectation: true,
      riskyAdapter: true,
      textSample: 'I will inspect the repository first.',
      summary: '首段正文符合 KHY 英文预期',
    }, {
      sessionId: 'sess-lang-en-1',
      traceId: 'trace-lang-en-1',
      requestId: 'req-lang-en-1',
      source: 'jest',
    });

    const summary = traceAudit.getLatestLanguageConsistencySummary({ sessionId: 'sess-lang-en-1' });
    expect(summary.ok).toBe(true);
    expect(summary.requestId).toBe('req-lang-en-1');
    expect(summary.status).toBe('aligned');
    expect(summary.detectedLanguage).toBe('en');
    expect(summary.expectedLanguage).toBe('en');
    expect(summary.source).toBe('first_chunk');
  });

  test('latest language consistency summary distinguishes pre-response stall from language drift', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('llm.request', { ok: true }, {
      sessionId: 'sess-lang-pending',
      traceId: 'trace-lang-pending',
      requestId: 'req-lang-pending',
      source: 'jest',
    });

    const summary = traceAudit.getLatestLanguageConsistencySummary({ sessionId: 'sess-lang-pending' });
    expect(summary.ok).toBe(false);
    expect(summary.reason).toBe('awaiting_model_output_for_request');
    expect(summary.blockedBy).toBe('pre_response_stall');
    expect(summary.requestId).toBe('req-lang-pending');
    expect(summary.requestState).toMatchObject({
      status: 'incomplete',
      brokenStage: 'before_tool_call',
      eventCount: 1,
      checks: {
        modelRequest: true,
        modelResponse: false,
      },
    });
    expect(summary.summary).toContain('停在模型响应前');
  });

  test('latest language consistency summary distinguishes missing language audit after response', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('llm.request', { ok: true }, {
      sessionId: 'sess-lang-gap',
      traceId: 'trace-lang-gap',
      requestId: 'req-lang-gap',
      source: 'jest',
    });
    traceAudit.logEvent('llm.response', { success: true }, {
      sessionId: 'sess-lang-gap',
      traceId: 'trace-lang-gap',
      requestId: 'req-lang-gap',
      source: 'jest',
    });

    const summary = traceAudit.getLatestLanguageConsistencySummary({ sessionId: 'sess-lang-gap' });
    expect(summary.ok).toBe(false);
    expect(summary.reason).toBe('language_audit_missing_after_response');
    expect(summary.blockedBy).toBe('language_audit_gap');
    expect(summary.requestId).toBe('req-lang-gap');
    expect(summary.requestState).toMatchObject({
      status: 'response_only',
      brokenStage: null,
      eventCount: 2,
      checks: {
        modelRequest: true,
        modelResponse: true,
      },
    });
    expect(summary.summary).toContain('已收到模型响应');
  });

  test('request trace summary joins delivery and language diagnostics by requestId', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('llm.request', { ok: true }, {
      sessionId: 'sess-trace-1',
      traceId: 'trace-trace-1',
      requestId: 'req-trace-1',
      source: 'jest',
    });
    traceAudit.logEvent('agent.tool.call', { toolName: 'editFile' }, {
      sessionId: 'sess-trace-1',
      traceId: 'trace-trace-1',
      requestId: 'req-trace-1',
      source: 'jest',
    });
    traceAudit.logEvent('agent.language.first_chunk', {
      adapter: 'codex',
      adapterName: 'Codex CLI',
      expectedLanguage: 'zh',
      detectedLanguage: 'en',
      matchesExpectation: false,
      riskyAdapter: true,
      textSample: 'I will inspect files first.',
      summary: '首段正文疑似英文，偏离 KHY 中文预期',
    }, {
      sessionId: 'sess-trace-1',
      traceId: 'trace-trace-1',
      requestId: 'req-trace-1',
      source: 'jest',
    });
    traceAudit.logEvent('llm.response', { success: true }, {
      sessionId: 'sess-trace-1',
      traceId: 'trace-trace-1',
      requestId: 'req-trace-1',
      source: 'jest',
    });
    traceAudit.logEvent('agent.delivery.final', { hasConclusion: false, success: true }, {
      sessionId: 'sess-trace-1',
      traceId: 'trace-trace-1',
      requestId: 'req-trace-1',
      source: 'jest',
    });

    const summary = traceAudit.getRequestTraceSummary({ requestId: 'req-trace-1', sessionId: 'sess-trace-1' });
    expect(summary.ok).toBe(true);
    expect(summary.requestId).toBe('req-trace-1');
    expect(summary.delivery).toBeTruthy();
    expect(summary.delivery.brokenStage).toBe('final_conclusion');
    expect(summary.language).toBeTruthy();
    expect(summary.language.status).toBe('mismatch');
    expect(summary.typeCounts['agent.language.first_chunk']).toBe(1);
    expect(summary.timeline.length).toBeGreaterThan(0);
  });

  test('request trace summary keeps pending language diagnostics for the same requestId', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('llm.request', { ok: true }, {
      sessionId: 'sess-trace-pending',
      traceId: 'trace-trace-pending',
      requestId: 'req-trace-pending',
      source: 'jest',
    });

    const summary = traceAudit.getRequestTraceSummary({
      requestId: 'req-trace-pending',
      sessionId: 'sess-trace-pending',
    });

    expect(summary.ok).toBe(true);
    expect(summary.requestId).toBe('req-trace-pending');
    expect(summary.language).toBeTruthy();
    expect(summary.language.reason).toBe('awaiting_model_output_for_request');
    expect(summary.summary).toContain('停在模型响应前');
  });

  test('request trace summary can resolve an explicit requestId from an older session', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('llm.request', { ok: true }, {
      sessionId: 'sess-trace-old',
      traceId: 'trace-trace-old',
      requestId: 'req-trace-old',
      source: 'jest',
    });
    traceAudit.logEvent('llm.response', { success: true }, {
      sessionId: 'sess-trace-old',
      traceId: 'trace-trace-old',
      requestId: 'req-trace-old',
      source: 'jest',
    });

    traceAudit.logEvent('llm.request', { ok: true }, {
      sessionId: 'sess-trace-new',
      traceId: 'trace-trace-new',
      requestId: 'req-trace-new',
      source: 'jest',
    });

    const summary = traceAudit.getRequestTraceSummary({ requestId: 'req-trace-old' });

    expect(summary.ok).toBe(true);
    expect(summary.sessionId).toBe('sess-trace-old');
    expect(summary.requestId).toBe('req-trace-old');
    expect(summary.totalEvents).toBe(2);
    expect(summary.summary).toContain('req-trace-old');
  });

  test('latest summaries fall back to most recent persisted session when current context is empty', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    if (appendSpy) appendSpy.mockRestore();
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-trace-audit-'));
    process.env.KHY_TRACE_AUDIT_DIR = auditDir;
    jest.resetModules();

    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('llm.request', { ok: true }, {
      sessionId: 'sess-fallback-new',
      traceId: 'trace-fallback-new',
      requestId: 'req-fallback-new',
      source: 'jest',
    });
    traceAudit.logEvent('llm.response', { success: true }, {
      sessionId: 'sess-fallback-new',
      traceId: 'trace-fallback-new',
      requestId: 'req-fallback-new',
      source: 'jest',
    });
    traceAudit.logEvent('agent.delivery.final', { hasConclusion: true, success: true }, {
      sessionId: 'sess-fallback-new',
      traceId: 'trace-fallback-new',
      requestId: 'req-fallback-new',
      source: 'jest',
    });
    traceAudit.logEvent('agent.language.first_chunk', {
      adapter: 'relay_api',
      adapterName: 'API 中转',
      expectedLanguage: 'zh',
      detectedLanguage: 'zh',
      matchesExpectation: true,
      riskyAdapter: true,
      textSample: '我先检查最近的请求。',
    }, {
      sessionId: 'sess-fallback-new',
      traceId: 'trace-fallback-new',
      requestId: 'req-fallback-new',
      source: 'jest',
    });

    const delivery = traceAudit.getLatestDeliveryRequestSummary();
    const language = traceAudit.getLatestLanguageConsistencySummary();

    expect(delivery.ok).toBe(true);
    expect(delivery.sessionId).toBe('sess-fallback-new');
    expect(delivery.requestId).toBe('req-fallback-new');
    expect(language.ok).toBe(true);
    expect(language.sessionId).toBe('sess-fallback-new');
    expect(language.requestId).toBe('req-fallback-new');
  });

  test('language summary can target a specific requestId within the same session', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    traceAudit.logEvent('agent.language.first_chunk', {
      adapter: 'codex',
      adapterName: 'Codex CLI',
      expectedLanguage: 'zh',
      detectedLanguage: 'en',
      matchesExpectation: false,
      riskyAdapter: true,
      textSample: 'I will inspect the older request first.',
    }, {
      sessionId: 'sess-lang-same',
      traceId: 'trace-lang-same',
      requestId: 'req-lang-old',
      source: 'jest',
    });
    traceAudit.logEvent('agent.language.first_chunk', {
      adapter: 'relay_api',
      adapterName: 'API 中转',
      expectedLanguage: 'zh',
      detectedLanguage: 'zh',
      matchesExpectation: true,
      riskyAdapter: true,
      textSample: '我先检查最新请求。',
    }, {
      sessionId: 'sess-lang-same',
      traceId: 'trace-lang-same',
      requestId: 'req-lang-new',
      source: 'jest',
    });

    const oldSummary = traceAudit.getLatestLanguageConsistencySummary({
      sessionId: 'sess-lang-same',
      requestId: 'req-lang-old',
    });
    const newSummary = traceAudit.getLatestLanguageConsistencySummary({
      sessionId: 'sess-lang-same',
      requestId: 'req-lang-new',
    });

    expect(oldSummary.ok).toBe(true);
    expect(oldSummary.requestId).toBe('req-lang-old');
    expect(oldSummary.status).toBe('mismatch');
    expect(oldSummary.detectedLanguage).toBe('en');
    expect(newSummary.ok).toBe(true);
    expect(newSummary.requestId).toBe('req-lang-new');
    expect(newSummary.status).toBe('aligned');
    expect(newSummary.detectedLanguage).toBe('zh');
  });
});
