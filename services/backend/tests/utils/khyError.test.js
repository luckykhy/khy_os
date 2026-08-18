'use strict';

/**
 * khyError.js 契约测试 —— 错误四件套 {code, message, hint, recoverable, retryable}。
 *
 * 这层存在的理由：压缩链路 / 审计写入的失败此前被塞进裸 catch，用户只看到
 * 一句「失败」，既不知道能不能重试，也不知道下一步该做什么。四件套把「可恢复」
 * 与「可重试」拆成两个独立事实 —— 一个 413 超预算是 recoverable 但不 retryable，
 * 一个网络抖动两者都是 true，混为一谈就没法自动决策。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  khyError,
  isKhyError,
  toKhyError,
  formatKhyError,
  CODES,
  _internals,
} = require('../../src/utils/khyError');

test('khyError 返回真正的 Error，四件套字段齐全', () => {
  const e = khyError('MODULE_NOT_FOUND', '找不到模块 contextCompressor');
  assert.ok(e instanceof Error, '必须是真 Error，否则 throw 后丢栈');
  assert.strictEqual(e.code, 'MODULE_NOT_FOUND');
  assert.strictEqual(e.message, '找不到模块 contextCompressor');
  assert.strictEqual(e.hint, '检查依赖安装或路径配置');
  assert.strictEqual(e.recoverable, true);
  assert.strictEqual(e.retryable, false);
  assert.strictEqual(e.isKhyError, true);
  assert.ok(e.stack && e.stack.includes('khyError.test'), '栈必须指向调用点');
});

test('每个注册码都同时给出 hint / recoverable / retryable，没有半成品条目', () => {
  const codes = Object.keys(CODES);
    assert.ok(codes.length >= 10, `注册码过少: ${codes.length}`);
  for (const code of codes) {
    const spec = CODES[code];
    assert.ok(
      typeof spec.hint === 'string' && spec.hint.length > 0,
      `${code} 缺 hint —— 只报错不给下一步等于没报`
    );
    assert.strictEqual(typeof spec.recoverable, 'boolean', `${code}.recoverable 必须是布尔`);
    assert.strictEqual(typeof spec.retryable, 'boolean', `${code}.retryable 必须是布尔`);
  }
  assert.ok(Object.isFrozen(CODES), 'CODES 必须冻结，防止运行时被改写');
  for (const required of ['MODULE_NOT_FOUND', 'UNKNOWN']) {
    assert.ok(codes.includes(required), `缺必需码 ${required}`);
  }
});

test('recoverable 与 retryable 是两个独立事实，不得同步变化', () => {
  // 若两者永远相等，这个字段就是冗余的 —— 用真实条目证明它们会分叉。
  const budget = CODES.CONTEXT_BUDGET_EXCEEDED;
  assert.strictEqual(budget.recoverable, true, '已硬截断，会话可继续');
  assert.strictEqual(budget.retryable, false, '重发同一请求还是会超预算');

  const net = CODES.NETWORK_UNREACHABLE;
  assert.strictEqual(net.recoverable, true);
  assert.strictEqual(net.retryable, true);
});

test('未注册的 code 保留原值但套用 UNKNOWN 的兜底语义', () => {
  // 故意不把未知 code 改写成 UNKNOWN：调用方可能用了尚未登记的领域码，
  // 改写等于把定位信息丢掉。缺的只是 hint/recoverable/retryable，那些用兜底。
  const e = khyError('NO_SUCH_CODE_XYZ', '奇怪的失败');
  assert.strictEqual(e.code, 'NO_SUCH_CODE_XYZ', '原始 code 不得被吞掉');
  assert.strictEqual(e.hint, CODES.UNKNOWN.hint);
  assert.strictEqual(e.recoverable, CODES.UNKNOWN.recoverable);
  assert.strictEqual(e.retryable, CODES.UNKNOWN.retryable);
  assert.strictEqual(e.message, '奇怪的失败', '原始 message 不得被吞掉');

  // 但空/非字符串 code 是调用错误，没有信息可保留 ⇒ 归入 UNKNOWN。
  assert.strictEqual(khyError('', 'x').code, 'UNKNOWN');
  assert.strictEqual(khyError(null, 'x').code, 'UNKNOWN');
  assert.strictEqual(khyError(42, 'x').code, 'UNKNOWN');
});

test('extra 可覆盖 hint 并挂载 cause / details', () => {
  const cause = new Error('底层 ENOSPC');
  const e = khyError('IO_FAILED', '审计写入失败', {
    hint: '磁盘已满，先清理 ~/.khyquant',
    cause,
    details: { bytes: 10485760, path: 'audit.jsonl' },
  });
  assert.strictEqual(e.hint, '磁盘已满，先清理 ~/.khyquant');
  assert.strictEqual(e.cause, cause);
  assert.deepStrictEqual(e.details, { bytes: 10485760, path: 'audit.jsonl' });
});

test('isKhyError 只认自家错误，不误判普通 Error', () => {
  assert.strictEqual(isKhyError(khyError('TIMEOUT', 'x')), true);
  assert.strictEqual(isKhyError(new Error('x')), false);
  assert.strictEqual(isKhyError(null), false);
  assert.strictEqual(isKhyError(undefined), false);
  assert.strictEqual(isKhyError('TIMEOUT'), false);
  assert.strictEqual(isKhyError({ isKhyError: true }), false, 'code 缺失时不算');
});

test('toKhyError 幂等：已是 khyError 时原样返回', () => {
  const e = khyError('TIMEOUT', '等待 12s 无响应');
  assert.strictEqual(toKhyError(e), e, '不得重复包装，否则 hint 会被 fallback 覆盖');
});

test('toKhyError 按 errno 归类，归类不了才用 fallbackCode', () => {
  const cases = [
    ['EACCES', 'PERMISSION_DENIED'],
    ['EPERM', 'PERMISSION_DENIED'],
    ['ENOENT', 'IO_FAILED'],
    ['EEXIST', 'IO_FAILED'],
    ['ENOTDIR', 'IO_FAILED'],
    ['ENOSPC', 'IO_FAILED'],
    ['ETIMEDOUT', 'TIMEOUT'],
    ['ABORT_ERR', 'TIMEOUT'],
    ['ECONNREFUSED', 'NETWORK_UNREACHABLE'],
    ['ENOTFOUND', 'NETWORK_UNREACHABLE'],
    ['EHOSTUNREACH', 'NETWORK_UNREACHABLE'],
    ['MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'],
  ];
  for (const [errno, expected] of cases) {
    const raw = new Error(`boom ${errno}`);
    raw.code = errno;
    assert.strictEqual(
      toKhyError(raw, 'CONTEXT_COMPRESS_FAILED').code,
      expected,
      `${errno} 应归类为 ${expected}`
    );
  }
});

test('无从判断的错误使用调用方给的 fallbackCode，默认 UNKNOWN', () => {
  assert.strictEqual(toKhyError(new Error('boom')).code, 'UNKNOWN');
  assert.strictEqual(
    toKhyError(new Error('boom'), 'CONTEXT_SUMMARY_FAILED').code,
    'CONTEXT_SUMMARY_FAILED'
  );
  // message 里出现 errno 字样但 err.code 缺失时不得靠猜 —— 猜错比不猜更糟。
  assert.strictEqual(toKhyError(new Error('模型不可达。ECONNREFUSED')).code, 'UNKNOWN');
});

test('toKhyError 接受字符串 / null / 非 Error 而不炸', () => {
  assert.strictEqual(toKhyError('炸了').message, '炸了');
  assert.strictEqual(toKhyError(null).code, 'UNKNOWN');
  assert.ok(toKhyError(undefined).message.length > 0, 'message 不得为空串');
  assert.strictEqual(toKhyError({ message: '对象错误' }).message, '对象错误');
});

test('formatKhyError 把 message 与 hint 合成一行可直接打印的文案', () => {
  const line = formatKhyError(khyError('CONTEXT_COMPRESS_FAILED', '摘要链路失败'));
  assert.match(line, /^摘要链路失败/);
  assert.match(line, /提示：/);
  assert.ok(!line.includes('\n'), '必须是单行，终端渲染不做多行拼接');
  // 普通 Error 也能格式化（先经 toKhyError 归一）。
  assert.match(formatKhyError(new Error('裸错误')), /裸错误/);
});

test('_guessCode 对 null / 无 code 的输入返回空，不冒充分类结果', () => {
  assert.ok(!_internals._guessCode(null));
  assert.ok(!_internals._guessCode(new Error('no errno here')));
});

test('压缩链路四个专用码都存在且语义可用', () => {
  for (const code of [
    'CONTEXT_COMPRESS_SKIPPED',
    'CONTEXT_SUMMARY_FAILED',
    'CONTEXT_COMPRESS_FAILED',
    'CONTEXT_BUDGET_EXCEEDED',
  ]) {
    const e = khyError(code, '测试');
    assert.strictEqual(e.code, code, `${code} 未注册，压缩链路会退化成 UNKNOWN`);
    assert.ok(e.hint.length > 0);
  }
});

test('khyError 是纯叶子，不引入任何 require（不得参与循环依赖）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'utils', 'khyError.js'),
    'utf-8'
  );
  const requires = src.match(/require\(/g) || [];
  assert.strictEqual(requires.length, 0, `khyError 必须零依赖，实际出现 ${requires.length} 处 require`);
});
