'use strict';

const test = require('node:test');
const assert = require('node:assert');

const guard = require('../src/services/errorEnumerationGuard');

// 干净环境:默认开。
delete process.env.KHY_ERROR_ENUMERATION;

const SAMPLE_LOG = [
  '请诊断并修复以下日志中的错误:',
  '[2026-06-26 10:00:01] TypeError: Cannot read properties of undefined (reading "id") at src/services/userService.js:42',
  '[2026-06-26 10:00:02] Error: connect ECONNREFUSED 127.0.0.1:5432 (database)',
  '[2026-06-26 10:00:03] MODULE_NOT_FOUND: Cannot find module "../utils/legacyHelper"',
  '[2026-06-26 10:00:04] 请求失败 status code 404 GET /api/orders',
  '[2026-06-26 10:00:05] 普通信息:服务已启动监听端口 8080',
].join('\n');

test('extractErrorSignals: 多错误日志抽出多条带锚点的去重信号', () => {
  const signals = guard.extractErrorSignals(SAMPLE_LOG);
  assert.ok(signals.length >= 4, `应至少抽到 4 条错误信号,实得 ${signals.length}`);
  const allKeys = signals.flatMap((s) => s.keys);
  assert.ok(allKeys.includes('typeerror'));
  assert.ok(allKeys.includes('econnrefused'));
  assert.ok(allKeys.includes('module_not_found'));
  assert.ok(allKeys.includes('404'));
  // 普通信息行不应成为信号。
  assert.ok(!signals.some((s) => /已启动监听端口/.test(s.label)));
});

test('extractErrorSignals: 文件引用作为锚点(全名+基名)', () => {
  const signals = guard.extractErrorSignals('Error at src/services/userService.js:42 failed');
  const keys = signals.flatMap((s) => s.keys);
  assert.ok(keys.some((k) => k.includes('userservice.js')));
});

test('extractErrorSignals: 同一错误去重', () => {
  const dup = 'TypeError: boom\nTypeError: boom\nTypeError: boom';
  const signals = guard.extractErrorSignals(dup);
  assert.strictEqual(signals.length, 1);
});

test('零假阳性: 普通散文/版本号/日期/纯行号不产强信号', () => {
  const benign = [
    '这是一个正常的项目说明文档。',
    '当前版本 1.2.3,发布于 2024-01-01。',
    '安装步骤见 README,端口默认 8080。',
    '第 42 行调用了 main 函数。',
  ].join('\n');
  const signals = guard.extractErrorSignals(benign);
  assert.strictEqual(signals.length, 0, `良性文本不应产生信号,实得 ${JSON.stringify(signals)}`);
});

test('assessDiagnoseFixTask: ≥2 错误 + 修复意图 → 触发', () => {
  const a = guard.assessDiagnoseFixTask({ text: SAMPLE_LOG });
  assert.strictEqual(a.isDiagnoseFix, true);
  assert.ok(a.count >= 4);
  assert.strictEqual(a.hasFixIntent, true);
});

test('assessDiagnoseFixTask: 单个错误不触发(避免对普通提问介入)', () => {
  const a = guard.assessDiagnoseFixTask({ text: '帮我看看这个 TypeError 怎么回事' });
  assert.strictEqual(a.isDiagnoseFix, false);
});

test('assessDiagnoseFixTask: ≥3 错误即使无显式修复词也触发(日志本身即诊断任务)', () => {
  const log = 'TypeError: a\nReferenceError: b\nENOENT: c missing';
  const a = guard.assessDiagnoseFixTask({ text: log });
  assert.strictEqual(a.isDiagnoseFix, true);
});

test('buildEnumerationDirective: 含三步走 + 自检 JSON 模板', () => {
  const a = guard.assessDiagnoseFixTask({ text: SAMPLE_LOG });
  const d = guard.buildEnumerationDirective(a);
  assert.ok(d.includes('第一步'));
  assert.ok(d.includes('第二步'));
  assert.ok(d.includes('第三步'));
  assert.ok(d.includes('self_check'));
  assert.ok(d.includes('coverage_complete'));
  assert.ok(d.startsWith('[SYSTEM:'));
});

test('buildEnumerationDirective: 非诊断任务 → 空串', () => {
  assert.strictEqual(guard.buildEnumerationDirective({ isDiagnoseFix: false }), '');
});

test('routeErrorEnumeration: 诊断任务产指令', () => {
  const r = guard.routeErrorEnumeration({ text: SAMPLE_LOG });
  assert.ok(r.directive.includes('枚举模式'));
  assert.ok(r.count >= 4);
});

test('routeErrorEnumeration: hasMedia → 不介入', () => {
  const r = guard.routeErrorEnumeration({ text: SAMPLE_LOG, hasMedia: true });
  assert.strictEqual(r.directive, '');
});

test('routeErrorEnumeration: 门控关闭 → 空(字节回退)', () => {
  process.env.KHY_ERROR_ENUMERATION = 'off';
  try {
    const r = guard.routeErrorEnumeration({ text: SAMPLE_LOG });
    assert.strictEqual(r.directive, '');
  } finally {
    delete process.env.KHY_ERROR_ENUMERATION;
  }
});

test('assessErrorCoverage: 漏掉一个错误 → shouldNudge 且 missing 含它', () => {
  const signals = guard.extractErrorSignals(SAMPLE_LOG);
  // 回复只提到 TypeError 与 ECONNREFUSED,漏了 MODULE_NOT_FOUND 与 404。
  const reply = '我修复了 TypeError(userService.js 加了空值判断),也处理了 ECONNREFUSED(数据库重连)。';
  const cov = guard.assessErrorCoverage({ reply, signals });
  assert.strictEqual(cov.shouldNudge, true);
  assert.strictEqual(cov.coverageComplete, false);
  const missingKeys = cov.missing.flatMap((m) => m.keys);
  assert.ok(missingKeys.includes('module_not_found'));
  assert.ok(missingKeys.includes('404'));
});

test('assessErrorCoverage: 全部覆盖 → 不追问', () => {
  const signals = guard.extractErrorSignals(SAMPLE_LOG);
  const reply = '修复清单:TypeError 已修(userService.js);ECONNREFUSED 数据库重连已加;'
    + 'MODULE_NOT_FOUND 的 legacyHelper 路径已修正;404 的 /api/orders 路由已补全。';
  const cov = guard.assessErrorCoverage({ reply, signals });
  assert.strictEqual(cov.shouldNudge, false);
  assert.strictEqual(cov.coverageComplete, true);
});

test('assessErrorCoverage: extraCoveredText(已改文件/工具入参)算作已接住', () => {
  const signals = guard.extractErrorSignals('Error at src/foo/barService.js:10 failed: TypeError');
  const cov = guard.assessErrorCoverage({
    reply: '已处理。',
    signals,
    extraCoveredText: 'Edit src/foo/barService.js TypeError',
  });
  assert.strictEqual(cov.shouldNudge, false);
});

test('assessErrorCoverage: 回复像反问 → 不追问', () => {
  const signals = guard.extractErrorSignals(SAMPLE_LOG);
  const cov = guard.assessErrorCoverage({ reply: '你是想让我先修数据库连接还是先修路由?', signals });
  assert.strictEqual(cov.shouldNudge, false);
});

test('assessErrorCoverage: 空回复 → 不追问', () => {
  const signals = guard.extractErrorSignals(SAMPLE_LOG);
  assert.strictEqual(guard.assessErrorCoverage({ reply: '', signals }).shouldNudge, false);
});

test('assessErrorCoverage: 仅无锚点信号 → 不据此追问(零假阳性)', () => {
  // 「操作失败」无可区分锚点 → keys 空 → 不可回核。
  const signals = guard.extractErrorSignals('操作失败\n又一次失败了');
  const cov = guard.assessErrorCoverage({ reply: '我看了一下,没发现问题。', signals });
  assert.strictEqual(cov.shouldNudge, false);
});

test('buildErrorCoverageNudge: 列出缺口,空输入 → 空串', () => {
  assert.strictEqual(guard.buildErrorCoverageNudge([]), '');
  const msg = guard.buildErrorCoverageNudge([{ label: 'MODULE_NOT_FOUND legacyHelper', keys: ['module_not_found'] }]);
  assert.ok(msg.includes('覆盖回核'));
  assert.ok(msg.includes('MODULE_NOT_FOUND'));
});

test('绝不抛: 畸形输入安全返回', () => {
  assert.doesNotThrow(() => guard.extractErrorSignals(null));
  assert.doesNotThrow(() => guard.extractErrorSignals(12345));
  assert.doesNotThrow(() => guard.extractErrorSignals({ a: 1 }));
  assert.doesNotThrow(() => guard.routeErrorEnumeration(null));
  assert.doesNotThrow(() => guard.routeErrorEnumeration({ text: null }));
  assert.doesNotThrow(() => guard.assessErrorCoverage(null));
  assert.doesNotThrow(() => guard.assessErrorCoverage({ reply: 123, signals: 'nope' }));
  assert.doesNotThrow(() => guard.buildEnumerationDirective(null));
  assert.doesNotThrow(() => guard.buildErrorCoverageNudge(null));
  assert.deepStrictEqual(guard.extractErrorSignals(null), []);
});
