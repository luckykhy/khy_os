'use strict';

// firstResponseAckVoice — 首响应静默窗口守护(纯叶子 + DI 计时器调度器)单测。
// 覆盖:门控(default-on / CANON off / 注册表路径)、延迟阈值 clamp、句子轮换 + elapsed 后缀、
//       DI 假计时器调度器(arm/markChunk/disarm 时序、幂等、绝不抛)。
// node --test 运行(勿加 jest 前缀)。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/cli/firstResponseAckVoice');
const {
  isEnabled,
  isSelectionEnabled,
  firstResponseAckDelayMs,
  computeFirstResponseAck,
  createFirstResponseAckScheduler,
  _ACK_LINES,
  _SELECTION_ACK_LINES,
  _DEFAULT_DELAY_MS,
  _MIN_DELAY_MS,
  _MAX_DELAY_MS,
} = leaf;

// ── 门控 isEnabled ─────────────────────────────────────────────────────────
test('isEnabled: 默认开(env 未设)', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(isEnabled(undefined), true);
});

test('isEnabled: CANON 4 词关', () => {
  for (const w of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.equal(isEnabled({ KHY_FIRST_RESPONSE_ACK: w }), false, `word=${w}`);
  }
});

test('isEnabled: 非 off 词视作开', () => {
  assert.equal(isEnabled({ KHY_FIRST_RESPONSE_ACK: 'true' }), true);
  assert.equal(isEnabled({ KHY_FIRST_RESPONSE_ACK: '1' }), true);
  assert.equal(isEnabled({ KHY_FIRST_RESPONSE_ACK: 'yes' }), true);
});

test('isEnabled: 注册表路径(KHY_FLAG_REGISTRY=true)也认 off', () => {
  const on = { KHY_FLAG_REGISTRY: 'true', KHY_FIRST_RESPONSE_ACK: 'true' };
  const off = { KHY_FLAG_REGISTRY: 'true', KHY_FIRST_RESPONSE_ACK: 'false' };
  assert.equal(isEnabled(on), true);
  assert.equal(isEnabled(off), false);
});

// ── 延迟阈值 firstResponseAckDelayMs ───────────────────────────────────────
test('firstResponseAckDelayMs: 默认 1200', () => {
  assert.equal(firstResponseAckDelayMs({}), _DEFAULT_DELAY_MS);
  assert.equal(_DEFAULT_DELAY_MS, 1200);
});

test('firstResponseAckDelayMs: 合法值原样', () => {
  assert.equal(firstResponseAckDelayMs({ KHY_FIRST_RESPONSE_ACK_MS: '3000' }), 3000);
});

test('firstResponseAckDelayMs: 低于下限 clamp 到 200', () => {
  assert.equal(firstResponseAckDelayMs({ KHY_FIRST_RESPONSE_ACK_MS: '50' }), _MIN_DELAY_MS);
  assert.equal(_MIN_DELAY_MS, 200);
});

test('firstResponseAckDelayMs: 高于上限 clamp 到 60000', () => {
  assert.equal(firstResponseAckDelayMs({ KHY_FIRST_RESPONSE_ACK_MS: '999999' }), _MAX_DELAY_MS);
  assert.equal(_MAX_DELAY_MS, 60000);
});

test('firstResponseAckDelayMs: 畸形 → 默认 1200', () => {
  assert.equal(firstResponseAckDelayMs({ KHY_FIRST_RESPONSE_ACK_MS: 'abc' }), _DEFAULT_DELAY_MS);
  assert.equal(firstResponseAckDelayMs({ KHY_FIRST_RESPONSE_ACK_MS: '' }), _DEFAULT_DELAY_MS);
  assert.equal(firstResponseAckDelayMs(undefined), _DEFAULT_DELAY_MS);
});

// ── 句子产出 computeFirstResponseAck ───────────────────────────────────────
test('computeFirstResponseAck: 门控关 → 空串', () => {
  assert.equal(computeFirstResponseAck({ turnIndex: 0, elapsedMs: 5000, env: { KHY_FIRST_RESPONSE_ACK: '0' } }), '');
});

test('computeFirstResponseAck: 门开 → 非空短句(按 turnIndex 轮换)', () => {
  const a = computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: {} });
  const b = computeFirstResponseAck({ turnIndex: 1, elapsedMs: 0, env: {} });
  assert.ok(a.length > 0);
  assert.ok(b.length > 0);
  assert.notEqual(a, b, '相邻 turnIndex 应取不同句');
  assert.equal(a, _ACK_LINES[0]);
  assert.equal(b, _ACK_LINES[1]);
});

test('computeFirstResponseAck: 满一轮回头', () => {
  const n = _ACK_LINES.length;
  assert.equal(
    computeFirstResponseAck({ turnIndex: n, elapsedMs: 0, env: {} }),
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: {} }),
  );
});

test('computeFirstResponseAck: elapsed ≥ 1000ms 附「已等待约 Ns」', () => {
  const line = computeFirstResponseAck({ turnIndex: 0, elapsedMs: 2200, env: {} });
  assert.ok(line.includes('已等待约 2s'), `got: ${line}`);
});

test('computeFirstResponseAck: elapsed < 1000ms 不附后缀', () => {
  const line = computeFirstResponseAck({ turnIndex: 0, elapsedMs: 400, env: {} });
  assert.ok(!line.includes('已等待约'), `got: ${line}`);
  assert.equal(line, _ACK_LINES[0]);
});

test('computeFirstResponseAck: turnIndex 非法 → 钉为 0', () => {
  assert.equal(computeFirstResponseAck({ turnIndex: -3, elapsedMs: 0, env: {} }), _ACK_LINES[0]);
  assert.equal(computeFirstResponseAck({ turnIndex: 1.5, elapsedMs: 0, env: {} }), _ACK_LINES[0]);
  assert.equal(computeFirstResponseAck({ turnIndex: 'x', elapsedMs: 0, env: {} }), _ACK_LINES[0]);
});

test('computeFirstResponseAck: 畸形入参绝不抛', () => {
  // undefined/null opts:env 回退 process.env,只保证不抛(返回值随宿主 env,不断言具体)
  assert.doesNotThrow(() => computeFirstResponseAck(undefined));
  assert.doesNotThrow(() => computeFirstResponseAck(null));
  // 门控关 env → 空串(确定性)
  assert.equal(computeFirstResponseAck({ env: { KHY_FIRST_RESPONSE_ACK: '0' } }), '');
  // 显式空 env → 默认开 → 首句(确定性)
  assert.equal(computeFirstResponseAck({ env: {} }), _ACK_LINES[0]);
});

test('_ACK_LINES: ≥2 条且各不相同', () => {
  assert.ok(Array.isArray(_ACK_LINES));
  assert.ok(_ACK_LINES.length >= 2);
  assert.equal(new Set(_ACK_LINES).size, _ACK_LINES.length, '句子应互异');
});

// ── DI 假计时器调度器 ──────────────────────────────────────────────────────
// 构造一个可控假计时器:捕获被调度的回调与延迟,手动触发/取消。
function makeFakeDeps(startNow) {
  const state = {
    scheduled: null,   // { fn, ms, token }
    clearedToken: null,
    emitted: [],
    now: startNow,
    tokenSeq: 0,
  };
  const deps = {
    setTimeout: (fn, ms) => {
      const token = ++state.tokenSeq;
      state.scheduled = { fn, ms, token };
      return token;
    },
    clearTimeout: (t) => { state.clearedToken = t; },
    emit: (line) => { state.emitted.push(line); },
    now: () => state.now,
  };
  return { state, deps };
}

test('调度器: 门控关 → arm 返回 false,不调度、不 emit', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 0, env: { KHY_FIRST_RESPONSE_ACK: '0' }, deps });
  assert.equal(s.arm(), false);
  assert.equal(s.armed, false);
  assert.equal(state.scheduled, null);
  assert.equal(state.emitted.length, 0);
});

test('调度器: 缺 emit → arm 返回 false', () => {
  const s = createFirstResponseAckScheduler({
    turnIndex: 0,
    env: {},
    deps: { setTimeout: () => 1, clearTimeout: () => {}, now: () => 0 },
  });
  assert.equal(s.arm(), false);
});

test('调度器: 计时器到点(无 chunk)→ emit 一句含 elapsed', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 0, env: {}, deps });
  assert.equal(s.arm(), true);
  assert.equal(s.armed, true);
  assert.equal(state.scheduled.ms, 1200, '默认延迟 1200ms');
  // 模拟时间流逝到点后触发
  state.now = 1000 + 2200;
  state.scheduled.fn();
  assert.equal(state.emitted.length, 1);
  assert.ok(state.emitted[0].includes('已等待约 2s'), `got: ${state.emitted[0]}`);
  assert.equal(s.fired, true);
});

test('调度器: 首 chunk 先到(markChunk)→ 取消计时器,不 emit', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 0, env: {}, deps });
  s.arm();
  const token = state.scheduled.token;
  s.markChunk();
  assert.equal(state.clearedToken, token, '应 clearTimeout 那个 token');
  // 即便回调仍被残余触发,也因 _done 守卫不 emit
  state.scheduled.fn();
  assert.equal(state.emitted.length, 0);
  assert.equal(s.fired, false);
});

test('调度器: disarm(finally)→ 取消,不 emit', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 0, env: {}, deps });
  s.arm();
  const token = state.scheduled.token;
  s.disarm();
  assert.equal(state.clearedToken, token);
  state.scheduled.fn();
  assert.equal(state.emitted.length, 0);
});

test('调度器: 二次 arm 返回 false(每回合至多一次)', () => {
  const { deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 0, env: {}, deps });
  assert.equal(s.arm(), true);
  assert.equal(s.arm(), false);
});

test('调度器: markChunk / disarm 幂等,先 disarm 后 arm 仍 no-op', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 0, env: {}, deps });
  s.markChunk();
  s.markChunk(); // 幂等,不抛
  assert.equal(s.arm(), false, 'done 后 arm no-op');
  assert.equal(state.scheduled, null);
});

test('调度器: emit 回调抛错 → 调度器不抛', () => {
  const { state } = makeFakeDeps(1000);
  const deps = {
    setTimeout: (fn) => { state.scheduled = { fn, token: 1 }; return 1; },
    clearTimeout: () => {},
    emit: () => { throw new Error('boom'); },
    now: () => state.now,
  };
  const s = createFirstResponseAckScheduler({ turnIndex: 0, env: {}, deps });
  s.arm();
  assert.doesNotThrow(() => state.scheduled.fn());
  assert.equal(s.fired, true); // 已标记 fired,即便 emit 抛错
});

test('调度器: turnIndex 轮换决定 emit 的句子', () => {
  const { state, deps } = makeFakeDeps(0);
  const s = createFirstResponseAckScheduler({ turnIndex: 1, env: {}, deps });
  s.arm();
  state.now = 0; // elapsed 0 → 无后缀
  state.scheduled.fn();
  assert.equal(state.emitted[0], _ACK_LINES[1]);
});

// ── selection 变体(中途选项已选 → 模型据此恢复的静默窗口) ─────────────────
test('isSelectionEnabled: 默认开(父门 + 子门皆默认开)', () => {
  assert.equal(isSelectionEnabled({}), true);
  assert.equal(isSelectionEnabled(undefined), true);
});

test('isSelectionEnabled: 子门 CANON 4 词关', () => {
  for (const w of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.equal(isSelectionEnabled({ KHY_FIRST_RESPONSE_ACK_SELECTION: w }), false, `word=${w}`);
  }
});

test('isSelectionEnabled: 父门关 → 子门再开也关', () => {
  assert.equal(isSelectionEnabled({ KHY_FIRST_RESPONSE_ACK: '0' }), false);
  assert.equal(isSelectionEnabled({ KHY_FIRST_RESPONSE_ACK: '0', KHY_FIRST_RESPONSE_ACK_SELECTION: 'true' }), false);
});

test('isSelectionEnabled: 注册表路径也认子门 off', () => {
  const on = { KHY_FLAG_REGISTRY: 'true', KHY_FIRST_RESPONSE_ACK_SELECTION: 'true' };
  const off = { KHY_FLAG_REGISTRY: 'true', KHY_FIRST_RESPONSE_ACK_SELECTION: 'false' };
  assert.equal(isSelectionEnabled(on), true);
  assert.equal(isSelectionEnabled(off), false);
});

test('_SELECTION_ACK_LINES: ≥2 条且各不相同,且与 _ACK_LINES 不重叠', () => {
  assert.ok(Array.isArray(_SELECTION_ACK_LINES));
  assert.ok(_SELECTION_ACK_LINES.length >= 2);
  assert.equal(new Set(_SELECTION_ACK_LINES).size, _SELECTION_ACK_LINES.length, '句子应互异');
  const overlap = _SELECTION_ACK_LINES.filter(l => _ACK_LINES.includes(l));
  assert.equal(overlap.length, 0, 'selection 句不应与 submit 句雷同');
});

test('computeFirstResponseAck: variant=selection 走 _SELECTION_ACK_LINES(按 turnIndex 轮换)', () => {
  const a = computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: {}, variant: 'selection' });
  const b = computeFirstResponseAck({ turnIndex: 1, elapsedMs: 0, env: {}, variant: 'selection' });
  assert.equal(a, _SELECTION_ACK_LINES[0]);
  assert.equal(b, _SELECTION_ACK_LINES[1]);
  assert.notEqual(a, b);
});

test('computeFirstResponseAck: variant=selection 子门关 → 空串', () => {
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 5000, env: { KHY_FIRST_RESPONSE_ACK_SELECTION: '0' }, variant: 'selection' }),
    '',
  );
});

test('computeFirstResponseAck: variant=selection 父门关 → 空串', () => {
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: { KHY_FIRST_RESPONSE_ACK: '0' }, variant: 'selection' }),
    '',
  );
});

test('computeFirstResponseAck: variant 缺省/submit 逐字节走 _ACK_LINES(不受 selection 子门影响)', () => {
  // selection 子门关不该影响 submit 变体
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: { KHY_FIRST_RESPONSE_ACK_SELECTION: '0' } }),
    _ACK_LINES[0],
  );
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: {}, variant: 'submit' }),
    _ACK_LINES[0],
  );
  // 未知 variant 视作 submit
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: {}, variant: 'bogus' }),
    _ACK_LINES[0],
  );
});

test('computeFirstResponseAck: variant=selection 且 elapsed≥1000 附后缀', () => {
  const line = computeFirstResponseAck({ turnIndex: 0, elapsedMs: 3100, env: {}, variant: 'selection' });
  assert.ok(line.startsWith(_SELECTION_ACK_LINES[0]));
  assert.ok(line.includes('已等待约 3s'), `got: ${line}`);
});

test('调度器: variant=selection 到点 → emit selection 句', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 1, env: {}, deps, variant: 'selection' });
  assert.equal(s.arm(), true);
  state.now = 1000; // elapsed 0
  state.scheduled.fn();
  assert.equal(state.emitted.length, 1);
  assert.equal(state.emitted[0], _SELECTION_ACK_LINES[1]);
});

test('调度器: variant=selection 子门关 → arm 返回 false,不调度', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({
    turnIndex: 0,
    env: { KHY_FIRST_RESPONSE_ACK_SELECTION: '0' },
    deps,
    variant: 'selection',
  });
  assert.equal(s.arm(), false);
  assert.equal(state.scheduled, null);
  assert.equal(state.emitted.length, 0);
});

test('调度器: variant=selection 父门关 → arm 返回 false', () => {
  const { deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({
    turnIndex: 0,
    env: { KHY_FIRST_RESPONSE_ACK: '0' },
    deps,
    variant: 'selection',
  });
  assert.equal(s.arm(), false);
});

test('调度器: variant=selection 首 chunk 先到 markChunk → 取消,不 emit', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 0, env: {}, deps, variant: 'selection' });
  s.arm();
  const token = state.scheduled.token;
  s.markChunk();
  assert.equal(state.clearedToken, token);
  state.scheduled.fn();
  assert.equal(state.emitted.length, 0);
  assert.equal(s.fired, false);
});

// ── resume 变体(工具返回 → 模型据此续跑的静默窗口·工具循环迭代之间) ─────────────
const { isResumeEnabled, _RESUME_ACK_LINES } = leaf;

test('isResumeEnabled: 默认开(父门 + 子门皆默认开)', () => {
  assert.equal(isResumeEnabled({}), true);
  assert.equal(isResumeEnabled(undefined), true);
});

test('isResumeEnabled: 子门 CANON 4 词关', () => {
  for (const w of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.equal(isResumeEnabled({ KHY_FIRST_RESPONSE_ACK_RESUME: w }), false, `word=${w}`);
  }
});

test('isResumeEnabled: 父门关 → 子门再开也关', () => {
  assert.equal(isResumeEnabled({ KHY_FIRST_RESPONSE_ACK: '0' }), false);
  assert.equal(isResumeEnabled({ KHY_FIRST_RESPONSE_ACK: '0', KHY_FIRST_RESPONSE_ACK_RESUME: 'true' }), false);
});

test('isResumeEnabled: 注册表路径也认子门 off', () => {
  const on = { KHY_FLAG_REGISTRY: 'true', KHY_FIRST_RESPONSE_ACK_RESUME: 'true' };
  const off = { KHY_FLAG_REGISTRY: 'true', KHY_FIRST_RESPONSE_ACK_RESUME: 'false' };
  assert.equal(isResumeEnabled(on), true);
  assert.equal(isResumeEnabled(off), false);
});

test('_RESUME_ACK_LINES: ≥2 条且各不相同,且与 _ACK_LINES / _SELECTION_ACK_LINES 均不重叠', () => {
  assert.ok(Array.isArray(_RESUME_ACK_LINES));
  assert.ok(_RESUME_ACK_LINES.length >= 2);
  assert.equal(new Set(_RESUME_ACK_LINES).size, _RESUME_ACK_LINES.length, '句子应互异');
  const overlapSubmit = _RESUME_ACK_LINES.filter(l => _ACK_LINES.includes(l));
  const overlapSel = _RESUME_ACK_LINES.filter(l => _SELECTION_ACK_LINES.includes(l));
  assert.equal(overlapSubmit.length, 0, 'resume 句不应与 submit 句雷同');
  assert.equal(overlapSel.length, 0, 'resume 句不应与 selection 句雷同');
});

test('computeFirstResponseAck: variant=resume 走 _RESUME_ACK_LINES(按 turnIndex 轮换)', () => {
  const a = computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: {}, variant: 'resume' });
  const b = computeFirstResponseAck({ turnIndex: 1, elapsedMs: 0, env: {}, variant: 'resume' });
  assert.equal(a, _RESUME_ACK_LINES[0]);
  assert.equal(b, _RESUME_ACK_LINES[1]);
  assert.notEqual(a, b);
});

test('computeFirstResponseAck: variant=resume 子门关 → 空串', () => {
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 5000, env: { KHY_FIRST_RESPONSE_ACK_RESUME: '0' }, variant: 'resume' }),
    '',
  );
});

test('computeFirstResponseAck: variant=resume 父门关 → 空串', () => {
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: { KHY_FIRST_RESPONSE_ACK: '0' }, variant: 'resume' }),
    '',
  );
});

test('computeFirstResponseAck: resume 子门关不影响 submit / selection 变体', () => {
  // resume 子门关不该影响 submit
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: { KHY_FIRST_RESPONSE_ACK_RESUME: '0' } }),
    _ACK_LINES[0],
  );
  // resume 子门关不该影响 selection
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: { KHY_FIRST_RESPONSE_ACK_RESUME: '0' }, variant: 'selection' }),
    _SELECTION_ACK_LINES[0],
  );
});

test('computeFirstResponseAck: variant=resume 且 elapsed≥1000 附后缀', () => {
  const line = computeFirstResponseAck({ turnIndex: 0, elapsedMs: 4100, env: {}, variant: 'resume' });
  assert.ok(line.startsWith(_RESUME_ACK_LINES[0]));
  assert.ok(line.includes('已等待约 4s'), `got: ${line}`);
});

test('调度器: variant=resume 到点 → emit resume 句', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 2, env: {}, deps, variant: 'resume' });
  assert.equal(s.arm(), true);
  state.now = 1000; // elapsed 0
  state.scheduled.fn();
  assert.equal(state.emitted.length, 1);
  assert.equal(state.emitted[0], _RESUME_ACK_LINES[2]);
});

test('调度器: variant=resume 子门关 → arm 返回 false,不调度', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({
    turnIndex: 0,
    env: { KHY_FIRST_RESPONSE_ACK_RESUME: '0' },
    deps,
    variant: 'resume',
  });
  assert.equal(s.arm(), false);
  assert.equal(state.scheduled, null);
  assert.equal(state.emitted.length, 0);
});

test('调度器: variant=resume 父门关 → arm 返回 false', () => {
  const { deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({
    turnIndex: 0,
    env: { KHY_FIRST_RESPONSE_ACK: '0' },
    deps,
    variant: 'resume',
  });
  assert.equal(s.arm(), false);
});

test('调度器: variant=resume 首 chunk 先到 markChunk → 取消,不 emit', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 0, env: {}, deps, variant: 'resume' });
  s.arm();
  const token = state.scheduled.token;
  s.markChunk();
  assert.equal(state.clearedToken, token);
  state.scheduled.fn();
  assert.equal(state.emitted.length, 0);
  assert.equal(s.fired, false);
});

// ── image 变体(非流式图片分析子流·await 期间静默窗口·无 onChunk / markChunk) ─────────
const { isImageEnabled, _IMAGE_ACK_LINES } = leaf;

test('isImageEnabled: 默认开(父门 + 子门皆默认开)', () => {
  assert.equal(isImageEnabled({}), true);
  assert.equal(isImageEnabled(undefined), true);
});

test('isImageEnabled: 子门 CANON 4 词关', () => {
  for (const w of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.equal(isImageEnabled({ KHY_FIRST_RESPONSE_ACK_IMAGE: w }), false, `word=${w}`);
  }
});

test('isImageEnabled: 父门关 → 子门再开也关', () => {
  assert.equal(isImageEnabled({ KHY_FIRST_RESPONSE_ACK: '0' }), false);
  assert.equal(isImageEnabled({ KHY_FIRST_RESPONSE_ACK: '0', KHY_FIRST_RESPONSE_ACK_IMAGE: 'true' }), false);
});

test('isImageEnabled: 注册表路径也认子门 off', () => {
  const on = { KHY_FLAG_REGISTRY: 'true', KHY_FIRST_RESPONSE_ACK_IMAGE: 'true' };
  const off = { KHY_FLAG_REGISTRY: 'true', KHY_FIRST_RESPONSE_ACK_IMAGE: 'false' };
  assert.equal(isImageEnabled(on), true);
  assert.equal(isImageEnabled(off), false);
});

test('_IMAGE_ACK_LINES: ≥2 条且各不相同,且与 submit / selection / resume 句均不重叠', () => {
  assert.ok(Array.isArray(_IMAGE_ACK_LINES));
  assert.ok(_IMAGE_ACK_LINES.length >= 2);
  assert.equal(new Set(_IMAGE_ACK_LINES).size, _IMAGE_ACK_LINES.length, '句子应互异');
  assert.equal(_IMAGE_ACK_LINES.filter(l => _ACK_LINES.includes(l)).length, 0, 'image 句不应与 submit 句雷同');
  assert.equal(_IMAGE_ACK_LINES.filter(l => _SELECTION_ACK_LINES.includes(l)).length, 0, 'image 句不应与 selection 句雷同');
  assert.equal(_IMAGE_ACK_LINES.filter(l => _RESUME_ACK_LINES.includes(l)).length, 0, 'image 句不应与 resume 句雷同');
});

test('computeFirstResponseAck: variant=image 走 _IMAGE_ACK_LINES(按 turnIndex 轮换)', () => {
  const a = computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: {}, variant: 'image' });
  const b = computeFirstResponseAck({ turnIndex: 1, elapsedMs: 0, env: {}, variant: 'image' });
  assert.equal(a, _IMAGE_ACK_LINES[0]);
  assert.equal(b, _IMAGE_ACK_LINES[1]);
  assert.notEqual(a, b);
});

test('computeFirstResponseAck: variant=image 子门关 → 空串', () => {
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 5000, env: { KHY_FIRST_RESPONSE_ACK_IMAGE: '0' }, variant: 'image' }),
    '',
  );
});

test('computeFirstResponseAck: variant=image 父门关 → 空串', () => {
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: { KHY_FIRST_RESPONSE_ACK: '0' }, variant: 'image' }),
    '',
  );
});

test('computeFirstResponseAck: image 子门关不影响 submit / selection / resume 变体', () => {
  const off = { KHY_FIRST_RESPONSE_ACK_IMAGE: '0' };
  assert.equal(computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: off }), _ACK_LINES[0]);
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: off, variant: 'selection' }),
    _SELECTION_ACK_LINES[0],
  );
  assert.equal(
    computeFirstResponseAck({ turnIndex: 0, elapsedMs: 0, env: off, variant: 'resume' }),
    _RESUME_ACK_LINES[0],
  );
});

test('computeFirstResponseAck: variant=image 且 elapsed≥1000 附后缀', () => {
  const line = computeFirstResponseAck({ turnIndex: 0, elapsedMs: 4100, env: {}, variant: 'image' });
  assert.ok(line.startsWith(_IMAGE_ACK_LINES[0]));
  assert.ok(line.includes('已等待约 4s'), `got: ${line}`);
});

test('调度器: variant=image 到点 → emit image 句', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 3, env: {}, deps, variant: 'image' });
  assert.equal(s.arm(), true);
  state.now = 1000; // elapsed 0
  state.scheduled.fn();
  assert.equal(state.emitted.length, 1);
  assert.equal(state.emitted[0], _IMAGE_ACK_LINES[3]);
});

test('调度器: variant=image 子门关 → arm 返回 false,不调度', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({
    turnIndex: 0,
    env: { KHY_FIRST_RESPONSE_ACK_IMAGE: '0' },
    deps,
    variant: 'image',
  });
  assert.equal(s.arm(), false);
  assert.equal(state.scheduled, null);
  assert.equal(state.emitted.length, 0);
});

test('调度器: variant=image 父门关 → arm 返回 false', () => {
  const { deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({
    turnIndex: 0,
    env: { KHY_FIRST_RESPONSE_ACK: '0' },
    deps,
    variant: 'image',
  });
  assert.equal(s.arm(), false);
});

// 图片子流是非流式 await(无 onChunk / markChunk),disarm 是唯一取消路径。
test('调度器: variant=image disarm(await 完成/异常兜底)先于到点 → 取消,不 emit', () => {
  const { state, deps } = makeFakeDeps(1000);
  const s = createFirstResponseAckScheduler({ turnIndex: 0, env: {}, deps, variant: 'image' });
  s.arm();
  const token = state.scheduled.token;
  s.disarm();
  assert.equal(state.clearedToken, token);
  state.scheduled.fn();
  assert.equal(state.emitted.length, 0);
  assert.equal(s.fired, false);
});
