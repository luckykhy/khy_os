'use strict';

const test = require('node:test');
const assert = require('node:assert');

const SUT = '../src/services/permissionOptionOrder';

function fresh() {
  delete require.cache[require.resolve(SUT)];
  return require(SUT);
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const L1 = () => [
  { key: 'once', label: '允许本次' },
  { key: 'session', label: '本会话内同类免审' },
  { key: 'deny', label: '拒绝' },
];

// L2: 拒绝在首位(既有安全护栏)。
const L2 = () => [
  { key: 'deny', label: '拒绝' },
  { key: 'confirm', label: '确认执行此高危操作', danger: true },
];

test('isDenyOption: 认 deny/reject/cancel(key 或 value),其余非拒绝', () => {
  const m = fresh();
  assert.equal(m.isDenyOption({ key: 'deny' }), true);
  assert.equal(m.isDenyOption({ key: 'DENY' }), true);
  assert.equal(m.isDenyOption({ key: 'reject' }), true);
  assert.equal(m.isDenyOption({ key: 'cancel' }), true);
  assert.equal(m.isDenyOption({ value: 'deny-all' }), true); // 经典对话框用 value
  assert.equal(m.isDenyOption({ key: 'once' }), false);
  assert.equal(m.isDenyOption({ key: 'confirm' }), false);
  assert.equal(m.isDenyOption(null), false);
  assert.equal(m.isDenyOption('deny'), false); // 非对象
});

test('L1 本就允许优先 → 原数组同引用(字节回退)', () => {
  const m = fresh();
  const opts = L1();
  const out = m.orderOptions(opts);
  assert.strictEqual(out, opts, '已是允许优先,应返回同引用');
  assert.equal(out[0].key, 'once');
});

test('允许优先:拒绝项被下沉到末尾,允许/中性项保持原相对顺序', () => {
  const m = fresh();
  const opts = [
    { key: 'deny', label: '拒绝' },
    { key: 'once', label: '允许本次' },
    { key: 'session', label: '免审' },
  ];
  const out = m.orderOptions(opts);
  assert.deepEqual(out.map((o) => o.key), ['once', 'session', 'deny']);
});

test('L2 高危默认允许优先(知情决定,默认开)→ 确认执行置首、拒绝沉底', () => {
  withEnv({ KHY_PERMISSION_ALLOW_FIRST_HIGHRISK: undefined }, () => {
    const m = fresh();
    const out = m.orderOptions(L2(), { highRisk: true });
    assert.deepEqual(out.map((o) => o.key), ['confirm', 'deny']);
    assert.equal(out[0].key, 'confirm');
  });
});

test('L2 高危显式回退(KHY_PERMISSION_ALLOW_FIRST_HIGHRISK=off)→ 不重排,拒绝首位(同引用)', () => {
  withEnv({ KHY_PERMISSION_ALLOW_FIRST_HIGHRISK: 'off' }, () => {
    const m = fresh();
    const opts = L2();
    const out = m.orderOptions(opts, { highRisk: true });
    assert.strictEqual(out, opts);
    assert.equal(out[0].key, 'deny');
  });
});

test('L2 高危含第三项 session → 允许优先后 [confirm, session, deny]', () => {
  withEnv({ KHY_PERMISSION_ALLOW_FIRST_HIGHRISK: undefined }, () => {
    const m = fresh();
    const opts = [
      { key: 'deny', label: '拒绝' },
      { key: 'confirm', label: '确认执行', danger: true },
      { key: 'session', label: '本会话总是允许', danger: true },
    ];
    const out = m.orderOptions(opts, { highRisk: true });
    assert.deepEqual(out.map((o) => o.key), ['confirm', 'session', 'deny']);
  });
});

test('_highRiskOptIn: 默认开,仅 0/false/off/no 关', () => {
  withEnv({ KHY_PERMISSION_ALLOW_FIRST_HIGHRISK: undefined }, () => assert.equal(fresh()._highRiskOptIn(), true));
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    withEnv({ KHY_PERMISSION_ALLOW_FIRST_HIGHRISK: v }, () => assert.equal(fresh()._highRiskOptIn(), false));
  }
  for (const v of ['1', 'true', 'on', 'yes', '']) {
    withEnv({ KHY_PERMISSION_ALLOW_FIRST_HIGHRISK: v }, () => assert.equal(fresh()._highRiskOptIn(), true));
  }
});

test('门控关(KHY_PERMISSION_ALLOW_FIRST=off)→ 原数组同引用,不重排', () => {
  withEnv({ KHY_PERMISSION_ALLOW_FIRST: 'off' }, () => {
    const m = fresh();
    const opts = [
      { key: 'deny', label: '拒绝' },
      { key: 'once', label: '允许本次' },
    ];
    const out = m.orderOptions(opts);
    assert.strictEqual(out, opts);
    assert.equal(out[0].key, 'deny');
  });
});

test('无拒绝项 / 长度 < 2 / 非数组 → 原样返回', () => {
  const m = fresh();
  const noDeny = [{ key: 'once' }, { key: 'session' }];
  assert.strictEqual(m.orderOptions(noDeny), noDeny);
  const one = [{ key: 'deny' }];
  assert.strictEqual(m.orderOptions(one), one);
  assert.strictEqual(m.orderOptions(null), null);
  assert.strictEqual(m.orderOptions('x'), 'x');
});

test('稳定分区:多个允许项相对顺序不变', () => {
  const m = fresh();
  const opts = [
    { key: 'a', label: 'A' },
    { key: 'deny', label: '拒绝' },
    { key: 'b', label: 'B' },
    { key: 'c', label: 'C' },
  ];
  const out = m.orderOptions(opts);
  assert.deepEqual(out.map((o) => o.key), ['a', 'b', 'c', 'deny']);
});

test('_enabled: 默认开,仅 0/false/off/no 关', () => {
  withEnv({ KHY_PERMISSION_ALLOW_FIRST: undefined }, () => assert.equal(fresh()._enabled(), true));
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    withEnv({ KHY_PERMISSION_ALLOW_FIRST: v }, () => assert.equal(fresh()._enabled(), false));
  }
  for (const v of ['1', 'true', 'on', 'yes', '']) {
    withEnv({ KHY_PERMISSION_ALLOW_FIRST: v }, () => assert.equal(fresh()._enabled(), true));
  }
});
