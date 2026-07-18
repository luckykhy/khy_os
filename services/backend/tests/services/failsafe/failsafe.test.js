'use strict';

/**
 * failsafe.test.js — 零静默失败与精准归因验收测试（DESIGN-ARCH-028）。
 *
 * 全程零网络、零真实进程、零真实文件系统。覆盖：
 *   - errorCodes 单一真源（E01–E08 + 必填字段 + 脱敏标记 + 兜底回落）
 *   - ErrorClassifier：八类信号各归正确码 + 必填字段填充 + attribution_complete
 *   - 脱敏铁律：E02/E07 detail/fields 不泄露内部细节（系统 Prompt / 审批 reasons）
 *   - SafeResponseWrapper：空 LLM→E01、工具崩溃→E04、权限拦截→E07、guard 永不空 return
 *   - StreamFailSafeInjector：流意外结束注入 E04、进程级清扫补写、幂等终结、部分内容标记
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const failsafe = require('../../../src/services/failsafe');
const { classify, classifyCode, getErrorCode, listCodes, isKnownCode, FALLBACK_CODE,
  SafeResponseWrapper, StreamFailSafeInjector } = failsafe;

// ── 错误字典单一真源 ─────────────────────────────────────────────────

describe('errorCodes — E01–E08 单一真源', () => {
  test('八码齐备且各有必填字段/分类/建议', () => {
    const codes = listCodes();
    assert.deepEqual(codes, ['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08']);
    for (const c of codes) {
      const def = getErrorCode(c);
      assert.equal(def.code, c);
      assert.ok(def.category && def.reason && def.suggestion, `${c} 文案齐备`);
      assert.ok(Array.isArray(def.requiredFields) && def.requiredFields.length > 0, `${c} 有必填字段`);
    }
  });

  test('E02/E07 标记为 sensitive，其余不脱敏', () => {
    assert.equal(getErrorCode('E02').sensitive, true);
    assert.equal(getErrorCode('E07').sensitive, true);
    for (const c of ['E01', 'E03', 'E04', 'E05', 'E06', 'E08']) {
      assert.equal(getErrorCode(c).sensitive, false, `${c} 非脱敏`);
    }
  });

  test('未知码 fail-safe 回落兜底码（绝不返回空）', () => {
    assert.equal(getErrorCode('E99').code, FALLBACK_CODE);
    assert.equal(isKnownCode('E99'), false);
    assert.equal(isKnownCode('E04'), true);
  });
});

// ── ErrorClassifier 八类归因 ─────────────────────────────────────────

describe('classifier — 原始信号 → E01–E08', () => {
  test('E01 模型空响应', () => {
    const r = classify({ errorType: 'empty_reply', model: 'gpt-x', prompt_tokens: 1200 }, { kind: 'llm' });
    assert.equal(r.error_code, 'E01');
    assert.equal(r.status, 'failed');
    assert.equal(r.fields.model, 'gpt-x');
    assert.equal(r.fields.prompt_tokens, 1200);
    assert.equal(r.attribution_complete, true);
    assert.equal(r.retryable, true);
  });

  test('E01 适配器 empty errorType（健康通道空回复）也归 E01', () => {
    // 'empty' is the gateway/adapter classification for an HTTP-200 reply with
    // no model text — must attribute to E01 (resumable) just like 'empty_reply'.
    const r = classify({ errorType: 'empty', model: 'relay-x' }, { kind: 'llm' });
    assert.equal(r.error_code, 'E01');
    assert.equal(r.retryable, true);
  });

  test('E02 内容安全停止（finish_reason）', () => {
    const r = classify({ finish_reason: 'content_filter', model: 'claude-x' });
    assert.equal(r.error_code, 'E02');
    assert.equal(r.sensitive, true);
    assert.equal(r.fields.finish_reason, 'content_filter');
  });

  test('E02 伪成功拒绝（errorType:pseudo_refusal）— 工具已取回数据却套话拒绝', () => {
    const r = classify(
      { errorType: 'pseudo_refusal', finish_reason: 'refusal', model: 'qwen-x' },
      { kind: 'llm', model: 'qwen-x' }
    );
    assert.equal(r.error_code, 'E02');
    assert.equal(r.status, 'failed');
    assert.equal(r.sensitive, true);
  });

  test('E02 显式 errorType:refusal 也归内容管控', () => {
    const r = classify({ errorType: 'refusal', model: 'm' });
    assert.equal(r.error_code, 'E02');
    assert.equal(r.sensitive, true);
  });

  test('E03 上下文溢出（errorClassifier kind）', () => {
    const r = classify(new Error('prompt is too long: maximum context length exceeded'),
      { model: 'm', ctxLimit: 8192, requiredTokens: 9000 });
    assert.equal(r.error_code, 'E03');
    assert.equal(r.fields.ctx_limit, 8192);
    assert.equal(r.fields.required_tokens, 9000);
    assert.equal(r.retryable, false);
  });

  test('E04 工具崩溃（普通 Error / EXECUTION_ERROR）', () => {
    const r = classify(new Error('Browser closed unexpectedly'), { toolName: 'WebBrowser' });
    assert.equal(r.error_code, 'E04');
    assert.equal(r.fields.tool_name, 'WebBrowser');
    assert.ok(r.fields.raw_error_stack.includes('Browser closed'));
  });

  test('E05 依赖缺失（MISSING_DEPENDENCY / depId）', () => {
    const sr = { success: false, error: { code: 'MISSING_DEPENDENCY', message: 'pip install torch' }, depId: 'torch' };
    const r = classify(sr, { toolName: 'imageOcr' });
    assert.equal(r.error_code, 'E05');
    assert.equal(r.fields.missing_dep, 'torch');
    assert.equal(r.fields.tool_name, 'imageOcr');
  });

  test('E06 网络熔断（timeout / network）', () => {
    const r = classify(new Error('request timed out'), { endpoint: 'https://api', timeoutMs: 30000, retryCount: 3 });
    assert.equal(r.error_code, 'E06');
    assert.equal(r.fields.endpoint, 'https://api');
    assert.equal(r.fields.timeout_ms, 30000);
    assert.equal(r.fields.retry_count, 3);
    assert.equal(r.retryable, true);
  });

  test('E07 权限拦截（审批网关裁决）', () => {
    const verdict = { allow: false, decision: 'deny', level: 2, reasons: ['内部规则X命中'], tripped: true };
    const r = classify(verdict, { toolName: 'Bash' });
    assert.equal(r.error_code, 'E07');
    assert.equal(r.sensitive, true);
    assert.equal(r.fields.tool_name, 'Bash');
    assert.equal(r.fields.approval_level, 2);
  });

  test('E07 ToolError PERMISSION_DENIED 也归权限', () => {
    assert.equal(classifyCode({ success: false, error: { code: 'PERMISSION_DENIED' } }), 'E07');
  });

  test('E08 格式校验失败', () => {
    const r = classify({ errorType: 'schema', expected_schema: '{a:number}', raw_output: 'not json {{' },
      { kind: 'schema' });
    assert.equal(r.error_code, 'E08');
    assert.equal(r.fields.expected_schema, '{a:number}');
    assert.ok(r.fields.raw_output_snippet.includes('not json'));
  });

  test('已归因结构幂等（E0x 原样沿用）', () => {
    const once = classify(new Error('timeout'), { endpoint: 'x' });
    const twice = classify(once);
    assert.equal(twice.error_code, once.error_code);
  });

  test('无法归类 → 兜底 E04，绝不返回空/未知', () => {
    const r = classify(undefined);
    assert.equal(r.error_code, FALLBACK_CODE);
    assert.equal(r.status, 'failed');
    assert.ok(r.reason && r.reason !== '未知错误');
  });

  test('归因不完整时标记 attribution_complete=false 但仍可用', () => {
    const r = classify({ errorType: 'empty_reply' }, { kind: 'llm' });
    assert.equal(r.error_code, 'E01');
    assert.equal(r.attribution_complete, false);
    assert.equal(r.fields.model, 'unknown');
  });
});

// ── 脱敏铁律 ─────────────────────────────────────────────────────────

describe('脱敏 — E02/E07 不泄露内部细节', () => {
  test('E02 detail 不含命中策略 / 原始文本', () => {
    const r = classify(new Error('refusal: system prompt said BLOCK keyword XYZZY'), { model: 'm' });
    assert.equal(r.error_code, 'E02');
    assert.ok(!r.detail.includes('XYZZY'), 'detail 不得含敏感关键词');
    assert.ok(!r.detail.toLowerCase().includes('system prompt'), 'detail 不得提系统 Prompt');
    assert.ok(!JSON.stringify(r.fields).includes('XYZZY'), 'fields 不得含敏感关键词');
  });

  test('E07 detail/fields 不含原始审批 reasons', () => {
    const verdict = { allow: false, decision: 'deny', level: 3, reasons: ['SECRET_RULE_42 命中删库红线'], tripped: true };
    const r = classify(verdict, { toolName: 'Bash' });
    assert.equal(r.error_code, 'E07');
    assert.ok(!r.detail.includes('SECRET_RULE_42'));
    assert.ok(!JSON.stringify(r.fields).includes('SECRET_RULE_42'), 'fields 不落原始 reasons');
    assert.equal(r.fields.deny_reason, '[已触发系统管控策略]');
    // 但仍给出可操作的粗粒度信息（工具名 + 级别）
    assert.equal(r.fields.tool_name, 'Bash');
    assert.equal(r.fields.approval_level, 3);
  });
});

// ── SafeResponseWrapper ──────────────────────────────────────────────

describe('SafeResponseWrapper — 零静默失败拦截', () => {
  test('guard 捕获异常 → 结构化错误，绝不空 return', async () => {
    const w = new SafeResponseWrapper({ kind: 'tool', toolName: 'WebBrowser' });
    const r = await w.guard(async () => { throw new Error('Browser closed unexpectedly'); });
    assert.equal(r.ok, false);
    assert.equal(r.failure.error_code, 'E04');
    assert.equal(r.value.error_code, 'E04');
    assert.notEqual(r.value, undefined);
  });

  test('guard 空 LLM 内容 → E01', async () => {
    const w = new SafeResponseWrapper({ kind: 'llm', model: 'm' });
    const r = await w.guard(async () => ({ content: '   ', toolCalls: [] }));
    assert.equal(r.ok, false);
    assert.equal(r.failure.error_code, 'E01');
  });

  test('guard LLM 有工具调用即非空 → 放行', async () => {
    const w = new SafeResponseWrapper({ kind: 'llm' });
    const r = await w.guard(async () => ({ content: '', toolCalls: [{ name: 'Bash' }] }));
    assert.equal(r.ok, true);
    assert.equal(r.failure, null);
  });

  test('guard 工具返回 null → E04（不当作成功空结果）', async () => {
    const w = new SafeResponseWrapper({ kind: 'tool', toolName: 'X' });
    const r = await w.guard(async () => null);
    assert.equal(r.ok, false);
    assert.equal(r.failure.error_code, 'E04');
  });

  test('guard 工具软失败（权限）→ E07', async () => {
    const w = new SafeResponseWrapper({ kind: 'tool', toolName: 'Bash' });
    const r = await w.guard(async () => ({ allow: false, decision: 'deny', level: 2, reasons: ['x'], tripped: true }));
    assert.equal(r.ok, false);
    assert.equal(r.failure.error_code, 'E07');
  });

  test('validateLLM 同步校验器：安全停止 → E02', () => {
    const w = new SafeResponseWrapper({ model: 'm' });
    const f = w.validateLLM({ content: 'partial', finish_reason: 'content_filter' });
    assert.equal(f.error_code, 'E02');
  });

  test('validateTool 合格结果 → null', () => {
    const w = new SafeResponseWrapper();
    assert.equal(w.validateTool({ success: true, output: 'ok' }), null);
  });

  test('_safeCall 失败抛出携带 .failure 的错误（继承用法）', async () => {
    class Foo extends SafeResponseWrapper {
      run() { return this._safeCall(async () => { throw new Error('boom timeout'); }, { endpoint: 'e' }); }
    }
    await assert.rejects(() => new Foo().run(), (e) => {
      assert.ok(e.failure && e.failure.error_code);
      assert.equal(e.error_code, e.failure.error_code);
      return true;
    });
  });
});

// ── StreamFailSafeInjector ───────────────────────────────────────────

describe('StreamFailSafeInjector — 兜底协议不可绕过', () => {
  beforeEach(() => StreamFailSafeInjector._clearActive());

  function sink() {
    const events = [];
    return { events, send: (e) => events.push(e) };
  }

  test('正常 markDone 后 finalize 为 no-op（不双写）', () => {
    const s = sink();
    const inj = new StreamFailSafeInjector({ send: s.send });
    inj.emit({ type: 'chunk', content: 'hello' });
    inj.markDone();
    const r = inj.finalize();
    assert.equal(r, null);
    assert.ok(!s.events.some((e) => e.type === 'error'));
  });

  test('流意外结束 → 强制注入 E04 兜底', () => {
    const s = sink();
    const inj = new StreamFailSafeInjector({ send: s.send });
    inj.emit({ type: 'chunk', content: 'partial output' });
    inj.finalize(); // 未 markDone
    const err = s.events.find((e) => e.type === 'error');
    assert.ok(err, '必须注入 error 事件');
    assert.equal(err.error_code, 'E04');
    assert.equal(err.fallback, true);
    assert.equal(err.partial, true, '部分内容已输出 → partial=true');
    assert.ok(err.detail && err.reason);
  });

  test('fail 主动归因：空响应 → E01', () => {
    const s = sink();
    const inj = new StreamFailSafeInjector({ send: s.send });
    inj.fail({ errorType: 'empty_reply', model: 'm' }, { kind: 'llm' });
    const err = s.events.find((e) => e.type === 'error');
    assert.equal(err.error_code, 'E01');
    assert.notEqual(err.message, 'AI 未返回有效回复');
  });

  test('fail 幂等：终结后再 fail 不重复注入', () => {
    const s = sink();
    const inj = new StreamFailSafeInjector({ send: s.send });
    inj.fail(new Error('timeout'), { endpoint: 'e' });
    const again = inj.fail(new Error('another'));
    assert.equal(again, null);
    assert.equal(s.events.filter((e) => e.type === 'error').length, 1);
  });

  test('res.end 在注入后被调用', () => {
    let ended = false;
    const s = sink();
    const inj = new StreamFailSafeInjector({ send: s.send, res: { end: () => { ended = true; } } });
    inj.finalize();
    assert.equal(ended, true);
  });

  test('进程级清扫 sweepActive：补写所有在册未终结注入器（E06）', () => {
    const a = sink(); const b = sink();
    const ia = new StreamFailSafeInjector({ send: a.send });
    const ib = new StreamFailSafeInjector({ send: b.send });
    assert.equal(StreamFailSafeInjector._activeCount(), 2);
    failsafe.sweepActive({ error_code: 'E06', message: 'process received SIGTERM', endpoint: 'process' });
    assert.equal(a.events.find((e) => e.type === 'error').error_code, 'E06');
    assert.equal(b.events.find((e) => e.type === 'error').error_code, 'E06');
    assert.equal(StreamFailSafeInjector._activeCount(), 0, '清扫后全部出册');
    void ia; void ib;
  });

  test('markDone 出册，不再被进程清扫波及', () => {
    const s = sink();
    const inj = new StreamFailSafeInjector({ send: s.send });
    inj.markDone();
    assert.equal(StreamFailSafeInjector._activeCount(), 0);
    failsafe.sweepActive({ error_code: 'E06' });
    assert.ok(!s.events.some((e) => e.type === 'error'));
  });
});
