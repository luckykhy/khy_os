'use strict';
/**
 * aiFailureAttribution.test.js �?Agent 失败「归因说人话 + 可追溯」交付（DESIGN-ARCH-028
 * 的传输层收口）。覆盖三件事�?
 *   1) GET �?monitor/attribution 详情接口：缺 requestId�?00；无审计事件�?00 空时间线
 *      （非错误）；有事件→200 透传 traceAudit role 投影结果，且按调用�?role 取数�?
 *   2) WS 失败结构化：classify 把空回复 / 抛错映射�?E0x，发出与 SSE 注入器同形的
 *      结构�?error 事件（带 error_code / requestId / 人话 reason）�?
 *   3) StreamFailSafeInjector 把本�?requestId 盖到 error 事件上（追溯回连键）�?
 */
const server = require('../../src/services/aiManagementServer');
const { handleAttributionDetail, _wsSendStructuredFailure, _genChatRequestId } = server.__test__;
const traceAudit = require('../../src/services/traceAuditService');
const { StreamFailSafeInjector } = require('../../src/services/failsafe');
// ── Minimal req/res doubles ───────────────────────────────────────────────────
function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) {
      if (payload !== undefined && this.body === null) {
        try { this.body = JSON.parse(String(payload)); } catch { this.body = String(payload); }
      }
    },
  };
}
function makeReq(headers = {}) {
  return { method: 'GET', headers, socket: { remoteAddress: '127.0.0.1' }, on() {} };
}
function makeSearch(params) {
  const map = new Map(Object.entries(params));
  return { get: (k) => (map.has(k) ? map.get(k) : null) };
}
// sendJson writes via res.end(JSON.stringify(...)); capture whichever path is used.
function capturedJson(res) {
  return res.body;
}
// ── 1) attribution endpoint ───────────────────────────────────────────────────
// ── 2) WS structured failure ──────────────────────────────────────────────────
function makeWsSession() {
  const sent = [];
  const WebSocket = require('ws');
  return {
    sent,
    id: 'sess-1',
    ws: { readyState: WebSocket.OPEN, send: (s) => sent.push(JSON.parse(s)) },
  };
}
// ── 3) requestId stamped on the SSE failsafe error event ──────────────────────
// ── requestId generator sanity ────────────────────────────────────────────────

describe('Ai Failure Attribution', () => {
  test('attribution: missing requestId �?400 without touching trace store', async () => {
      const res = makeRes();
      await handleAttributionDetail(makeReq(), res, makeSearch({}));
      expect(res.statusCode).toBe(400);
      expect(capturedJson(res).ok).toBe(false);
      expect(capturedJson(res).reason).toBe('missing_request_id');
      assert.deepEqual(capturedJson(res).timeline, []);
  });

  test('attribution: unauthenticated �?401, never leaks a timeline', async () => {
      // No AI_MGMT_SKIP_AUTH, no token, no env token �?authenticate fails closed.
      const prevSkip = process.env.AI_MGMT_SKIP_AUTH;
      const prevToken = process.env.AI_MGMT_AUTH_TOKEN;
      delete process.env.AI_MGMT_SKIP_AUTH;
      process.env.AI_MGMT_AUTH_TOKEN = 'unit-test-token';
      try {
        const res = makeRes();
        await handleAttributionDetail(makeReq({}), res, makeSearch({ requestId: 'req_x' }));
        expect(res.statusCode).toBe(401);
        expect(capturedJson(res).ok).toBe(false);
        assert.deepEqual(capturedJson(res).timeline, []);
      } finally {
        if (prevSkip === undefined) delete process.env.AI_MGMT_SKIP_AUTH; else process.env.AI_MGMT_SKIP_AUTH = prevSkip;
        if (prevToken === undefined) delete process.env.AI_MGMT_AUTH_TOKEN; else process.env.AI_MGMT_AUTH_TOKEN = prevToken;
      }
  });

  test('attribution: forwards caller role and returns the trace summary on success', async () => {
      const prevSkip = process.env.AI_MGMT_SKIP_AUTH;
      const prevEnv = process.env.NODE_ENV;
      process.env.AI_MGMT_SKIP_AUTH = 'true';
      process.env.NODE_ENV = 'test';
      const orig = traceAudit.getRequestTraceSummary;
      let seenArgs = null;
      traceAudit.getRequestTraceSummary = (opts) => {
        seenArgs = opts;
        return {
          ok: true,
          requestId: opts.requestId,
          summary: '交付链路可能断裂',
          delivery: { ok: true, status: 'incomplete', brokenStage: 'tool_execution' },
          timeline: [
            { stage: 'model_request', type: 'llm.request', timestamp: 1, source: 'ai-chat' },
            { stage: 'tool_call', type: 'agent.tool.call', timestamp: 2, source: 'tool-loop' },
          ],
        };
      };
      try {
        const res = makeRes();
        await handleAttributionDetail(makeReq({}), res, makeSearch({ requestId: 'req_abc' }));
        expect(res.statusCode).toBe(200);
        expect(seenArgs.requestId).toBe('req_abc');
        expect(seenArgs.role).toBe('admin'); // skip-auth grants admin
        const out = capturedJson(res);
        expect(out.ok).toBe(true);
        expect(out.delivery.brokenStage).toBe('tool_execution');
        expect(out.timeline.length).toBe(2);
      } finally {
        traceAudit.getRequestTraceSummary = orig;
        if (prevSkip === undefined) delete process.env.AI_MGMT_SKIP_AUTH; else process.env.AI_MGMT_SKIP_AUTH = prevSkip;
        process.env.NODE_ENV = prevEnv;
      }
  });

  test('attribution: no audit events �?200 with an empty timeline (not an error)', async () => {
      const prevSkip = process.env.AI_MGMT_SKIP_AUTH;
      const prevEnv = process.env.NODE_ENV;
      process.env.AI_MGMT_SKIP_AUTH = 'true';
      process.env.NODE_ENV = 'test';
      const orig = traceAudit.getRequestTraceSummary;
      traceAudit.getRequestTraceSummary = () => ({ ok: false, reason: 'no_events', summary: '当前会话尚无审计事件' });
      try {
        const res = makeRes();
        await handleAttributionDetail(makeReq({}), res, makeSearch({ requestId: 'req_missing' }));
        expect(res.statusCode).toBe(200);
        const out = capturedJson(res);
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('no_events');
        assert.deepEqual(out.timeline, []);
      } finally {
        traceAudit.getRequestTraceSummary = orig;
        if (prevSkip === undefined) delete process.env.AI_MGMT_SKIP_AUTH; else process.env.AI_MGMT_SKIP_AUTH = prevSkip;
        process.env.NODE_ENV = prevEnv;
      }
  });

  test('WS failure: a thrown error becomes a structured E0x error event with requestId', async () => {
      const session = makeWsSession();
      const ok = _wsSendStructuredFailure(session, new Error('boom'), { kind: 'llm', model: 'gpt-x' }, 'req_ws_1');
      expect(ok).toBe(true);
      expect(session.sent.length).toBe(1);
      const ev = session.sent[0];
      expect(ev.type).toBe('error');
      expect(ev.error_code).toMatch(/^E0\d$/);
      expect(ev.requestId).toBe('req_ws_1');
      expect(typeof ev.reason).toBe('string');
      expect(ev.reason.length > 0).toBeTruthy();
      expect(ev.message).toMatch(/^\[E0\d\] /); // back-compat message carries the reason
      expect(typeof ev.category).toBe('string');
  });

  test('WS failure: empty-reply descriptor classifies to a model-silence code (E01/E02)', async () => {
      const session = makeWsSession();
      const ok = _wsSendStructuredFailure(
        session,
        { errorType: 'empty_reply', model: 'm', finish_reason: 'stop' },
        { kind: 'llm', model: 'm' },
        'req_ws_2',
      );
      expect(ok).toBe(true);
      const ev = session.sent[0];
      expect(ev.error_code).toMatch(/^E0[12]$/);
      expect(ev.requestId).toBe('req_ws_2');
  });

  test('StreamFailSafeInjector stamps context.requestId onto the error event', async () => {
      const events = [];
      const inj = new StreamFailSafeInjector({
        send: (e) => events.push(e),
        context: { model: 'm', endpoint: 'ai-gateway', requestId: 'req_sse_9' },
        track: false,
      });
      const failure = inj.fail({ errorType: 'empty_reply' }, { kind: 'llm' });
      expect(failure).toBeTruthy();
      const errEvent = events.find((e) => e.type === 'error');
      expect(errEvent).toBeTruthy();
      expect(errEvent.requestId).toBe('req_sse_9');
      expect(errEvent.error_code).toMatch(/^E0\d$/);
  });

  test('_genChatRequestId returns unique req_-prefixed ids', async () => {
      const a = _genChatRequestId();
      const b = _genChatRequestId();
      expect(a).toMatch(/^req_/);
      expect(b).toMatch(/^req_/);
      assert.notEqual(a, b);
  });

});

