'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const ec = require('../src/services/toolErrorCodes');

function withEnv(val, fn) {
  const prev = process.env.KHY_TOOL_ERROR_CODES;
  if (val === undefined) delete process.env.KHY_TOOL_ERROR_CODES;
  else process.env.KHY_TOOL_ERROR_CODES = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_ERROR_CODES;
    else process.env.KHY_TOOL_ERROR_CODES = prev;
  }
}

test('classify:配置缺失类', () => {
  assert.equal(ec.classify('NO_BACKEND'), ec.ERROR_CLASS.CONFIG_MISSING);
  assert.equal(ec.classify('no_backend'), ec.ERROR_CLASS.CONFIG_MISSING);
  assert.equal(ec.classify('CONFIG_MISSING'), ec.ERROR_CLASS.CONFIG_MISSING);
});

test('classify:服务不可用类(含超时/生成失败/下载失败)', () => {
  for (const c of ['BACKEND_ERROR', 'TIMEOUT', 'GENERATION_FAILED', 'DOWNLOAD_FAILED', 'network_error']) {
    assert.equal(ec.classify(c), ec.ERROR_CLASS.SERVICE_UNAVAILABLE, `${c} 应归服务不可用`);
  }
});

test('classify:入参/不支持/依赖缺失', () => {
  assert.equal(ec.classify('BAD_PARAM'), ec.ERROR_CLASS.BAD_PARAM);
  assert.equal(ec.classify('BAD_INPUT_IMAGE'), ec.ERROR_CLASS.BAD_PARAM);
  assert.equal(ec.classify('EDIT_UNSUPPORTED'), ec.ERROR_CLASS.UNSUPPORTED);
  assert.equal(ec.classify('MISSING_DEPENDENCY'), ec.ERROR_CLASS.MISSING_DEPENDENCY);
});

test('classify:无 code 有 depId → 依赖缺失', () => {
  assert.equal(ec.classify(undefined, { depId: 'cheerio' }), ec.ERROR_CLASS.MISSING_DEPENDENCY);
  assert.equal(ec.classify('', { depId: 'playwright' }), ec.ERROR_CLASS.MISSING_DEPENDENCY);
});

test('classify:未知 code 且无 depId → UNKNOWN(零假阳性)', () => {
  assert.equal(ec.classify('SOMETHING_WEIRD'), ec.ERROR_CLASS.UNKNOWN);
  assert.equal(ec.classify(undefined), ec.ERROR_CLASS.UNKNOWN);
  assert.equal(ec.classify(null), ec.ERROR_CLASS.UNKNOWN);
});

test('isRetryable:仅服务不可用类可重试', () => {
  assert.equal(ec.isRetryable(ec.ERROR_CLASS.SERVICE_UNAVAILABLE), true);
  assert.equal(ec.isRetryable('TIMEOUT'), true);
  assert.equal(ec.isRetryable(ec.ERROR_CLASS.CONFIG_MISSING), false);
  assert.equal(ec.isRetryable('NO_BACKEND'), false);
  assert.equal(ec.isRetryable('BAD_PARAM'), false);
  assert.equal(ec.isRetryable('UNKNOWN'), false);
});

test('enrich:叠加 errorClass + retryable,不改原字段', () => {
  withEnv('on', () => {
    const r = { success: false, code: 'NO_BACKEND', error: 'x', content: 'x', meta: {} };
    const out = ec.enrich(r);
    assert.equal(out.errorClass, ec.ERROR_CLASS.CONFIG_MISSING);
    assert.equal(out.retryable, false);
    assert.equal(out.code, 'NO_BACKEND', '原 code 不变');
    assert.equal(out.error, 'x');
    assert.notStrictEqual(out, r, '应浅克隆');
  });
});

test('enrich:服务不可用 → retryable=true', () => {
  withEnv('on', () => {
    const out = ec.enrich({ success: false, code: 'BACKEND_ERROR' });
    assert.equal(out.errorClass, ec.ERROR_CLASS.SERVICE_UNAVAILABLE);
    assert.equal(out.retryable, true);
  });
});

test('enrich:depId 无 code → 依赖缺失', () => {
  withEnv('on', () => {
    const out = ec.enrich({ success: false, error: 'search failed', depId: 'cheerio' });
    assert.equal(out.errorClass, ec.ERROR_CLASS.MISSING_DEPENDENCY);
  });
});

test('enrich:成功结果原样返回(不介入)', () => {
  withEnv('on', () => {
    const r = { success: true, content: 'ok' };
    assert.strictEqual(ec.enrich(r), r);
  });
});

test('enrich:已有 errorClass 不覆盖', () => {
  withEnv('on', () => {
    const r = { success: false, code: 'NO_BACKEND', errorClass: 'CUSTOM' };
    assert.strictEqual(ec.enrich(r), r);
  });
});

test('门控关闭即原样返回(任一关词)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    withEnv(off, () => {
      const r = { success: false, code: 'NO_BACKEND' };
      assert.strictEqual(ec.enrich(r), r, `KHY_TOOL_ERROR_CODES=${off} 应不介入`);
    });
  }
});

test('默认(未设)即开', () => {
  withEnv(undefined, () => {
    assert.equal(ec._enabled(), true);
    const out = ec.enrich({ success: false, code: 'TIMEOUT' });
    assert.equal(out.errorClass, ec.ERROR_CLASS.SERVICE_UNAVAILABLE);
  });
});

test('fail-soft:畸形入参绝不抛', () => {
  withEnv('on', () => {
    assert.strictEqual(ec.enrich(null), null);
    assert.strictEqual(ec.enrich(undefined), undefined);
    assert.equal(ec.enrich(42), 42);
    assert.doesNotThrow(() => ec.classify({}));
  });
});
