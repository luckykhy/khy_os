import { describe, it, expect } from 'vitest';
import { describeFailure } from './describeFailure';

function httpError(status, body = {}) {
  return { response: { status, data: body } };
}

describe('describeFailure', () => {
  it('maps 429 to the rate-limit sentence with a fix', () => {
    expect(describeFailure(httpError(429))).toContain('限流 (429)');
    expect(describeFailure(httpError(429))).toContain('15 分钟');
  });

  it('maps 403 and keeps the backend code in parentheses', () => {
    const out = describeFailure(httpError(403, { code: 'PERMISSION_DENIED' }));
    expect(out).toContain('403');
    expect(out).toContain('PERMISSION_DENIED');
    expect(out).toContain('管理员');
  });

  it('maps 401 to re-login guidance', () => {
    expect(describeFailure(httpError(401))).toContain('401');
    expect(describeFailure(httpError(401))).toContain('重新登录');
  });

  it('maps 400 to the server message plus the caller fallback', () => {
    const out = describeFailure(httpError(400, { message: '请填写所有必填字段' }), '补齐字段后再提交');
    expect(out).toContain('请填写所有必填字段');
    expect(out).toContain('400');
    expect(out).toContain('补齐字段后再提交');
  });

  it('falls back to the generic 400 message when the server sent nothing', () => {
    const out = describeFailure(httpError(400), '检查输入');
    expect(out).toContain('输入不合法');
    expect(out).toContain('检查输入');
  });

  it('maps 5xx to an upstream sentence carrying the code', () => {
    const out = describeFailure(httpError(503));
    expect(out).toContain('上游异常 (503)');
    expect(out).toContain('khy doctor');
  });

  it('treats a network-like error message as a connection failure', () => {
    expect(describeFailure({ message: '网络连接异常：无法访问 /api/x' })).toContain('网络连接失败');
    expect(describeFailure({ message: 'ECONNREFUSED 127.0.0.1:3000' })).toContain('网络连接失败');
  });

  it('surfaces the server message for an unclassified status', () => {
    const out = describeFailure(httpError(409, { message: '订单已取消，不可再操作' }));
    expect(out).toContain('订单已取消');
  });

  it('never returns an empty string', () => {
    expect(describeFailure(undefined)).not.toBe('');
    expect(describeFailure(null)).not.toBe('');
    expect(describeFailure({})).not.toBe('');
    expect(describeFailure(httpError(204))).not.toBe('');
  });

  it('every message carries an actionable clause', () => {
    // The contract is {问题}：{识别码}，{修复}. At minimum each answer must be
    // longer than a bare status, i.e. it tells the user what to do.
    for (const status of [400, 401, 403, 404, 409, 429, 500, 502, 503]) {
      const out = describeFailure(httpError(status, { code: 'X_CODE' }), '做点什么');
      expect(out.length, `status ${status}`).toBeGreaterThan(12);
      expect(out).toContain('：');
    }
  });
});
