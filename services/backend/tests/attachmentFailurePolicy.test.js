'use strict';

const test = require('node:test');
const assert = require('node:assert');

const afp = require('../src/services/gateway/attachmentFailurePolicy');

const ON = {}; // KHY_ATTACHMENT_FAILURE_POLICY unset → enabled
const OFF = { KHY_ATTACHMENT_FAILURE_POLICY: 'off' };

// ── 门控 ─────────────────────────────────────────────────────────────────────

test('isEnabled: 默认开(未设)', () => {
  assert.strictEqual(afp.isEnabled({}), true);
  assert.strictEqual(afp.isEnabled(undefined), true);
});

test('isEnabled: 仅显式 0/false/off/no 关闭', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    assert.strictEqual(afp.isEnabled({ KHY_ATTACHMENT_FAILURE_POLICY: v }), false, `v=${v}`);
  }
  for (const v of ['1', 'true', 'on', 'yes', '']) {
    assert.strictEqual(afp.isEnabled({ KHY_ATTACHMENT_FAILURE_POLICY: v }), true, `v=${v}`);
  }
});

// ── isPayloadScopedFailure:载荷级失败判定(熔断器分级的唯一判据)────────────────

test('带附件 + bad_request → true(载荷级,不该毒化通道)', () => {
  assert.strictEqual(afp.isPayloadScopedFailure({
    hasAttachment: true, errorType: 'bad_request', error: 'HTTP 400', env: ON,
  }), true);
});

test('带附件 + model_not_found → true', () => {
  assert.strictEqual(afp.isPayloadScopedFailure({
    hasAttachment: true, errorType: 'model_not_found', error: 'no such model', env: ON,
  }), true);
});

test('带附件 + 文本里只有 404 字样(无结构化 errorType)→ true(复用文本兜底正则)', () => {
  assert.strictEqual(afp.isPayloadScopedFailure({
    hasAttachment: true, errorType: 'unknown',
    error: 'Request failed with status code 404', env: ON,
  }), true);
});

test('不带附件(纯文本请求)→ false(纯文本 400 仍按原熔断路径)', () => {
  assert.strictEqual(afp.isPayloadScopedFailure({
    hasAttachment: false, errorType: 'bad_request', error: 'HTTP 400', env: ON,
  }), false);
});

test('带附件 + 瞬时类(网络/超时/限流)→ false(那是真通道问题,该计入熔断)', () => {
  assert.strictEqual(afp.isPayloadScopedFailure({
    hasAttachment: true, errorType: 'network', error: 'fetch failed', env: ON,
  }), false);
  assert.strictEqual(afp.isPayloadScopedFailure({
    hasAttachment: true, errorType: 'timeout', error: 'idle timeout', env: ON,
  }), false);
  assert.strictEqual(afp.isPayloadScopedFailure({
    hasAttachment: true, errorType: 'rate_limit', error: '429', env: ON,
  }), false);
});

test('门控关 → 恒 false(circuitEligible 与今天逐字节相同)', () => {
  assert.strictEqual(afp.isPayloadScopedFailure({
    hasAttachment: true, errorType: 'bad_request', error: 'HTTP 400', env: OFF,
  }), false);
});

test('isPayloadScopedFailure: 畸形输入不抛、返回 false', () => {
  assert.doesNotThrow(() => afp.isPayloadScopedFailure());
  assert.doesNotThrow(() => afp.isPayloadScopedFailure({ env: ON }));
  assert.strictEqual(afp.isPayloadScopedFailure({ env: ON }), false);
});

// ── buildUnreadableAttachmentMessage:大方承认 + 确定性方案 ────────────────────

test('文档场景:含承认标记 + 三条编号方案 + 文档目标格式 + 不影响后续承诺', () => {
  const s = afp.buildUnreadableAttachmentMessage({ kinds: ['document'], exts: ['xlsx'], env: ON });
  assert.ok(s.includes(afp.UNREADABLE_MARKER), '含承认标记');
  assert.match(s, /文档/);
  assert.match(s, /\.xlsx/);
  assert.match(s, /PDF \/ TXT/);
  assert.match(s, /①/);
  assert.match(s, /②/);
  assert.match(s, /③/);
  assert.match(s, /khy gateway model/);
  assert.match(s, /不会影响后续请求/);
  assert.match(s, /不会编造/);
});

test('图片场景:类型名=图片,目标=PNG / JPG', () => {
  const s = afp.buildUnreadableAttachmentMessage({ kinds: ['image'], exts: ['heic'], env: ON });
  assert.match(s, /图片/);
  assert.match(s, /PNG \/ JPG/);
  assert.match(s, /\.heic/);
});

test('多 kind:图片+文档 都点名,目标格式各一次', () => {
  const s = afp.buildUnreadableAttachmentMessage({ kinds: ['image', 'document'], env: ON });
  assert.match(s, /图片/);
  assert.match(s, /文档/);
});

test('无 kinds/exts → 泛化措辞(不崩、不留空)', () => {
  const s = afp.buildUnreadableAttachmentMessage({ env: ON });
  assert.ok(s.includes(afp.UNREADABLE_MARKER));
  assert.match(s, /这个文件/);
  assert.match(s, /我能读取的常见格式/);
});

test('非法扩展名被过滤(防注入/脏输入)', () => {
  const s = afp.buildUnreadableAttachmentMessage({
    kinds: ['file'], exts: ['exe ; rm -rf', '../etc', 'TXT', 'pdf'], env: ON,
  });
  assert.doesNotMatch(s, /rm -rf/);
  assert.doesNotMatch(s, /etc/);
  // 合法的被保留并归一小写
  assert.match(s, /\.txt/);
  assert.match(s, /\.pdf/);
});

test('门控关 → 返回 null(不改动原内容)', () => {
  assert.strictEqual(afp.buildUnreadableAttachmentMessage({ kinds: ['document'], env: OFF }), null);
});

test('buildUnreadableAttachmentMessage: 畸形输入不抛', () => {
  assert.doesNotThrow(() => afp.buildUnreadableAttachmentMessage());
  assert.doesNotThrow(() => afp.buildUnreadableAttachmentMessage({ kinds: 'nope', exts: 123, env: ON }));
});

test('UNREADABLE_MARKER 已导出且为非空字符串', () => {
  assert.strictEqual(typeof afp.UNREADABLE_MARKER, 'string');
  assert.ok(afp.UNREADABLE_MARKER.length > 0);
});
