'use strict';

/**
 * offlineHttpStatusNl — HTTP 状态码「自然语言追问形」识别单测（node:test，确定性）。
 *
 * 目标契约:「自然语言要能驱动一切 —— 无网络无模型(Tier A)也应可以」。此前
 * 「404 是什么」「500是什么错误」「403什么意思」三种**最自然**的追问写法被
 * offlineKnowledge.detect 的 _HTTP_STATUS_RE 全部漏掉(无 http/状态码 前缀、无
 * 状态码/错误码 后缀、非纯裸 3 位锚定)→ 落到兜底菜单而不答状态码含义。
 *
 * 本测试锁定:
 *   - detect 命中 NL 追问形(404/500/403 等),且只在码落 _HTTP_STATUS 表内才路由;
 *   - 绝不把「365 是什么」这类非状态码的 3 位数误判(表外 → null);
 *   - 长数误命中防护:「1404 是什么」「4040 是什么」不路由(非独立 3 位);
 *   - 既有写法(http 500 / 500 状态码 / 裸 404)行为不变;
 *   - 门控 KHY_HTTP_STATUS_NL=off → NL 形字节回退为 null(与历史一致),既有写法不受影响;
 *   - execute 对 NL plan 仍能从 input 抽出码并给出中文释义。
 */

const test = require('node:test');
const assert = require('node:assert');

const ok = require('../../src/services/offlineKnowledge');

test('detect: NL 追问形命中 http_status（404 是什么 / 500是什么错误 / 403什么意思）', () => {
  assert.strictEqual(ok.detect('404 是什么')?.type, 'http_status');
  assert.strictEqual(ok.detect('500是什么错误')?.type, 'http_status');
  assert.strictEqual(ok.detect('403什么意思')?.type, 'http_status');
  assert.strictEqual(ok.detect('502 是什么状态')?.type, 'http_status');
  assert.strictEqual(ok.detect('429代表什么')?.type, 'http_status');
});

test('detect: 表外 3 位数绝不误判（365 是什么 → 非 http_status）', () => {
  // 365 不在 _HTTP_STATUS 表 → NL 分支二次校验失败 → 落到下游既有分支或 null。
  const r = ok.detect('365 是什么');
  assert.ok(!r || r.type !== 'http_status', `365 不应路由为 http_status (得到 ${JSON.stringify(r)})`);
  // 999 同理（非标准码且不在表）
  const r2 = ok.detect('999 是什么意思');
  assert.ok(!r2 || r2.type !== 'http_status');
});

test('detect: 长数误命中防护（1404 / 4040 不是独立 3 位 → 不路由）', () => {
  const r1 = ok.detect('1404 是什么');
  assert.ok(!r1 || r1.type !== 'http_status', '1404 不应误命中');
  const r2 = ok.detect('4040 是什么');
  assert.ok(!r2 || r2.type !== 'http_status', '4040 不应误命中');
});

test('detect: 既有写法行为不变（http 500 / 500 状态码 / 裸 404）', () => {
  assert.strictEqual(ok.detect('http 500')?.type, 'http_status');
  assert.strictEqual(ok.detect('500 状态码')?.type, 'http_status');
  assert.strictEqual(ok.detect('404')?.type, 'http_status');
});

test('门控 KHY_HTTP_STATUS_NL=off → NL 形字节回退 null;既有写法不受影响', () => {
  const offEnv = { KHY_HTTP_STATUS_NL: 'off' };
  // NL 形在门控关时回退(404/状态码后缀都没有 → 既有 RE 不命中 → null)
  assert.strictEqual(ok.detect('404 是什么', offEnv), null);
  assert.strictEqual(ok.detect('500是什么错误', offEnv), null);
  assert.strictEqual(ok.detect('403什么意思', offEnv), null);
  // 但既有写法不依赖该门控,仍命中
  assert.strictEqual(ok.detect('http 500', offEnv)?.type, 'http_status');
  assert.strictEqual(ok.detect('404', offEnv)?.type, 'http_status');
  // '0' 同样视为关
  assert.strictEqual(ok.detect('404 是什么', { KHY_HTTP_STATUS_NL: '0' }), null);
  // 默认(未注入 env)→ 开
  assert.strictEqual(ok.detect('404 是什么')?.type, 'http_status');
  // 注入但未设该键 → 开
  assert.strictEqual(ok.detect('404 是什么', { SOME_OTHER: '1' })?.type, 'http_status');
});

test('execute: NL plan 仍能抽码给中文释义', () => {
  const plan = ok.detect('404 是什么');
  const out = ok.execute(plan);
  assert.match(out, /HTTP 404/);
  assert.match(out, /Not Found|未找到/);

  const plan2 = ok.detect('500是什么错误');
  const out2 = ok.execute(plan2);
  assert.match(out2, /HTTP 500/);
});
