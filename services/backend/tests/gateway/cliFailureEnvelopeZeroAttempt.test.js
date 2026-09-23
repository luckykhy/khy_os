'use strict';

/**
 * cliFailureEnvelopeZeroAttempt.test.js — [DESIGN-ARCH-136] 的验收用例。
 *
 * 覆盖「零尝试 ≠ 回退被抑制」这条修正(A/B 两处病灶)与第 2 期所依赖的
 * `_diagnosticRank`(C)。对照组(Z-04/Z-05/Z-11)刻意留着 —— 只断言新码出现、
 * 不断言旧行为消失,否则会为了修一个误报而制造另一个。
 *
 * ⚠️ 本文件必须用 `require('node:test')` 写:
 *   - `services/backend/jest.config.js` 按该标记自动把它加入 testPathIgnorePatterns
 *     ⇒ jest 套件不会重复跑它(也不会因为两套 runner 冲突而红);
 *   - 而 `test:node`(`node --test` 扫 tests 全量 glob,CI 经 shell 展开后是 1288 个文件)
 *     会跑它 ⇒ **落地即须绿**。
 *   - 既有的 `tests/gateway/cliFailureEnvelope.test.js` 是 jest 风格(裸 describe),
 *     在 `node --test` 下本就是红的;因此**不往那个文件里追加**本组用例。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  buildCliFailureEnvelope,
  renderCliFailureEnvelope,
  _diagnosticRank,
  _resolveRouting,
} = require('../../src/services/gateway/cliFailureEnvelope');

const ENV_ON = {};

/** 零尝试:一条带 success===false 的记录都没有(数组空、字段缺失两种形态)。 */
const zeroAttempt = (overrides = {}) => ({
  success: false,
  errorType: 'unknown',
  preferredAdapter: 'api',
  attempts: [],
  ...overrides,
});

const failedAttempt = (overrides = {}) => ({
  adapterKey: 'api',
  success: false,
  statusCode: 0,
  errorType: 'process',
  error: 'process bridge died',
  ...overrides,
});

test('Z-01 无 attempts 字段 → NO_ATTEMPT 且不披露钉选抑制', () => {
  const e = buildCliFailureEnvelope({
    result: { success: false, errorType: 'unknown', preferredAdapter: 'api' },
    env: ENV_ON,
  });
  assert.strictEqual(e.enabled, true);
  assert.strictEqual(e.code, 'NO_ATTEMPT');
  assert.strictEqual(e.cause, null);
  assert.strictEqual(e.routing.mode, 'unresolved');
  assert.strictEqual(e.routing.attempted, false);
  assert.strictEqual(e.routing.pinned, false);
  assert.strictEqual(e.routing.fallbackSuppressed, false);
  assert.strictEqual(e.routing.preferred, 'api');
});

test('Z-02 attempts 为空数组 → 同 Z-01', () => {
  const e = buildCliFailureEnvelope({ result: zeroAttempt(), env: ENV_ON });
  assert.strictEqual(e.code, 'NO_ATTEMPT');
  assert.strictEqual(e.routing.mode, 'unresolved');
  assert.strictEqual(e.routing.attempted, false);
});

test('Z-03 记录缺 success 字段(形状污染)→ 同零尝试', () => {
  const e = buildCliFailureEnvelope({
    result: {
      success: false,
      errorType: 'process',
      preferredAdapter: 'api',
      attempts: [{ adapterKey: 'api', errorType: 'process', statusCode: 0, error: 'x' }],
    },
    env: ENV_ON,
  });
  assert.strictEqual(e.code, 'NO_ATTEMPT');
  assert.strictEqual(e.routing.attempted, false);
});

test('Z-04 对照组:有 success:false 记录 → 不落 NO_ATTEMPT,且仍报钉选抑制', () => {
  const e = buildCliFailureEnvelope({
    result: {
      success: false,
      errorType: 'process',
      preferredAdapter: 'api',
      attempts: [failedAttempt()],
    },
    env: ENV_ON,
  });
  assert.notStrictEqual(e.code, 'NO_ATTEMPT');
  assert.strictEqual(e.routing.mode, 'pinned-strict');
  assert.strictEqual(e.routing.attempted, true);
  assert.strictEqual(e.routing.pinned, true);
  assert.ok(e.cause, '有记录时必须给出主因通道');
});

test('Z-05 对照组:仅 virtualSkip 记录 → preferred-with-fallback(不声称钉选)', () => {
  const e = buildCliFailureEnvelope({
    result: {
      success: false,
      errorType: 'manual_fallback_skipped',
      preferredAdapter: 'api',
      attempts: [
        failedAttempt({
          adapterKey: 'clipboard',
          errorType: 'manual_fallback_skipped',
          error: 'skipped',
          virtualSkip: true,
        }),
      ],
    },
    env: ENV_ON,
  });
  assert.strictEqual(e.routing.mode, 'preferred-with-fallback');
  assert.strictEqual(e.routing.pinned, false);
});

test('Z-06 ★本 bug 的直接药:零尝试时渲染不得出现「路由: 钉选 strict」行', () => {
  for (const result of [
    { success: false, errorType: 'unknown', preferredAdapter: 'api' },
    zeroAttempt(),
    zeroAttempt({ errorType: 'process' }),
  ]) {
    const text = renderCliFailureEnvelope(buildCliFailureEnvelope({ result, env: ENV_ON }));
    assert.doesNotMatch(text, /路由: 钉选 strict/);
    assert.doesNotMatch(text, /本轮不回退/);
    assert.match(text, /本轮未尝试任何通道/);
    assert.match(text, /\[NO_ATTEMPT\]/);
  }
});

test('Z-06b 对照组:真有钉选失败时,钉选披露行必须仍在', () => {
  const text = renderCliFailureEnvelope(
    buildCliFailureEnvelope({
      result: {
        success: false,
        errorType: 'unavailable',
        preferredAdapter: 'windsurf',
        attempts: [
          failedAttempt({
            adapterKey: 'windsurf',
            errorType: 'unavailable',
            error: 'windsurf disabled by configuration',
          }),
        ],
      },
      env: ENV_ON,
    })
  );
  assert.match(text, /路由: 钉选 strict\(GATEWAY_PREFERRED_ADAPTER=windsurf\),本轮不回退/);
});

test('Z-07 零尝试但 errorType 已明说是 auth → 照实报 AUTH_FAILED,不被新码吞掉', () => {
  const e = buildCliFailureEnvelope({
    result: zeroAttempt({ errorType: 'auth' }),
    env: ENV_ON,
  });
  assert.strictEqual(e.code, 'AUTH_FAILED');
  assert.strictEqual(e.routing.attempted, false);
});

test('Z-08 无钉选(缺字段 / auto)+ 零尝试 → 仍报 NO_ATTEMPT', () => {
  // 两种「无钉选」形态都要覆盖:'auto' 是既有套件里用的写法(见
  // cliFailureEnvelope.test.js 的「无 attempts 且无信号」用例),
  // 缺字段是 result 形状不完整时的形态。二者都必须走到同一个码。
  const shapes = [
    { success: false, errorType: 'unknown', attempts: [] },
    { success: false, errorType: 'unknown', preferredAdapter: 'auto', attempts: [] },
  ];
  for (const result of shapes) {
    const e = buildCliFailureEnvelope({ result, env: ENV_ON });
    assert.strictEqual(e.code, 'NO_ATTEMPT');
    assert.strictEqual(e.routing.mode, 'auto');
    assert.strictEqual(e.routing.attempted, false);
    assert.strictEqual(e.routing.pinned, false);
  }
});

test('Z-09 NO_ATTEMPT 不进静态推广清单(有可执行 hint)', () => {
  const e = buildCliFailureEnvelope({ result: zeroAttempt(), env: ENV_ON });
  assert.ok(Array.isArray(e.hint) && e.hint.length >= 2, '必须给出可执行 hint');
  assert.strictEqual(e.showPromoPanel, false);
});

test('Z-10 _diagnosticRank:有 cause 者 > NO_ATTEMPT > NONE;不可比较者 -1', () => {
  const withCause = buildCliFailureEnvelope({
    result: {
      success: false,
      errorType: 'unavailable',
      preferredAdapter: 'windsurf',
      attempts: [
        failedAttempt({
          adapterKey: 'windsurf',
          errorType: 'unavailable',
          error: 'windsurf disabled by configuration',
        }),
      ],
    },
    env: ENV_ON,
  });
  const noAttempt = buildCliFailureEnvelope({ result: zeroAttempt(), env: ENV_ON });
  assert.ok(
    _diagnosticRank(withCause) > _diagnosticRank(noAttempt),
    '有主因通道的信封必须排在零尝试之前'
  );

  // NONE 分支只测纯函数语义:buildCliFailureEnvelope 一旦有 failed 记录就必然给出 cause,
  // 所以「code=NONE 且 cause=null」这个形状在真实产出里不可达 —— 但 _diagnosticRank
  // 是公开的纯函数,仍须对任意信封对象给出确定序,故直接构造等价形状。
  const noneShaped = { enabled: true, ok: false, code: 'NONE', cause: null };
  assert.ok(
    _diagnosticRank(noAttempt) > _diagnosticRank(noneShaped),
    '零尝试(可自证的事实)必须排在纯 NONE 之前'
  );

  assert.strictEqual(_diagnosticRank({ enabled: false }), -1);
  assert.strictEqual(_diagnosticRank(null), -1);
});

test('Z-11 回归:CHANNEL_ABSENT_PINNED 专项码不被新码抢占', () => {
  const e = buildCliFailureEnvelope({
    result: {
      success: false,
      errorType: 'unavailable',
      preferredAdapter: 'windsurf',
      attempts: [
        failedAttempt({
          adapterKey: 'windsurf',
          errorType: 'unavailable',
          error: 'windsurf disabled by configuration',
        }),
      ],
    },
    env: ENV_ON,
  });
  assert.strictEqual(e.code, 'CHANNEL_ABSENT_PINNED');
  assert.strictEqual(e.routing.mode, 'pinned-strict');
});

test('Z-12 纯叶子契约:畸形输入绝不抛', () => {
  for (const bad of [null, undefined, {}, 'x', 1, { attempts: 'not-array' }, { attempts: [null, 0] }]) {
    assert.doesNotThrow(() => _resolveRouting(bad));
    assert.doesNotThrow(() => buildCliFailureEnvelope({ result: bad, env: ENV_ON }));
    assert.doesNotThrow(() => _diagnosticRank(bad));
  }
  assert.strictEqual(renderCliFailureEnvelope(null), '');
  assert.strictEqual(_diagnosticRank({ enabled: true, ok: true }), -1);
});

// ── 第 2 期(aiChatCore 的回退重试「诊断择优」)────────────────────────────────

test('Z-13 择优判据:零尝试的重试结果必须排在「被钉通道未启用」之后', () => {
  // 这是 2026-09-23 TUI 那次的真实两组形状:首次可解钉,重试零证据。
  const firstShape = {
    success: false,
    errorType: 'unavailable',
    preferredAdapter: 'api',
    attempts: [
      failedAttempt({
        adapterKey: 'api',
        statusCode: 0,
        errorType: 'unavailable',
        error: 'api disabled by configuration',
      }),
    ],
  };
  const retryShape = {
    success: false,
    errorType: 'unknown',
    preferredAdapter: 'api',
    attempts: [],
  };
  const rankFirst = _diagnosticRank(buildCliFailureEnvelope({ result: firstShape, env: ENV_ON }));
  const rankRetry = _diagnosticRank(buildCliFailureEnvelope({ result: retryShape, env: ENV_ON }));
  assert.ok(rankRetry < rankFirst, '重试诊断更差 ⇒ 调用方应保留首次诊断');

  // 边界(刻意如此):排序**只分档** —— 有 cause(100) > NO_ATTEMPT(2) > 其它无 cause(1) > NONE(0)。
  // 不在码之间编造具体性(没有客观依据说 401 比 unavailable 更「具体」)。
  // ⇒ 两个都带 cause 的信封同档,不触发「保留」,维持改造前「照旧覆盖」的行为(最小惊讶)。
  const sameTier = {
    success: false,
    errorType: 'auth',
    preferredAdapter: 'api',
    attempts: [failedAttempt({ adapterKey: 'api', statusCode: 401, errorType: 'auth', error: 'bad key' })],
  };
  assert.strictEqual(
    _diagnosticRank(buildCliFailureEnvelope({ result: sameTier, env: ENV_ON })),
    rankFirst,
    '同档不得触发「保留首次」—— 只有真的更差才保留'
  );
});

test('Z-13b 接线守卫:aiChatCore 的回退分支必须真的做择优', () => {
  // 按源码文本断言 —— 本仓既有先例(clearResetsHistory.test.js 断言 App.js 源码)。
  // 只查「关键标识符存在 + 判定先于赋值」,不耦合缩进/换行,避免重构误伤。
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'cli', 'aiChatCore.js'),
    'utf8'
  );
  assert.match(src, /_diagnosticRank/, 'aiChatCore 必须引用择优排序');
  assert.match(src, /_preferFirstDiagnosis/, '每轮择优判定');

  const iFlag = src.indexOf('_preferFirstDiagnosis');
  const iAssign = src.indexOf('result = retryPass.result');
  assert.ok(iFlag > 0, '择优判定必须存在');
  assert.ok(iAssign > iFlag, '回退赋值必须位于择优判定之后(即落在 else 分支里)');
});
