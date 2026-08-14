'use strict';

const test = require('node:test');
const assert = require('node:assert');

const av = require('../src/services/answerVerifier');

const ON = {}; // KHY_ANSWER_VERIFIER unset → enabled
const OFF = { KHY_ANSWER_VERIFIER: 'off' };

// ── 门控 ─────────────────────────────────────────────────────────────────────

test('isEnabled: 默认开(未设)', () => {
  assert.strictEqual(av.isEnabled({}), true);
  assert.strictEqual(av.isEnabled(undefined), true);
});

test('isEnabled: 仅显式 0/false/off/no 关闭', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    assert.strictEqual(av.isEnabled({ KHY_ANSWER_VERIFIER: v }), false, `v=${v}`);
  }
  for (const v of ['1', 'true', 'on', 'yes', '']) {
    assert.strictEqual(av.isEnabled({ KHY_ANSWER_VERIFIER: v }), true, `v=${v}`);
  }
});

test('VERIFY_MARKER 已导出且为非空字符串', () => {
  assert.strictEqual(typeof av.VERIFY_MARKER, 'string');
  assert.ok(av.VERIFY_MARKER.length > 0);
});

// ── verifyArithmeticClaims:算式真值复核(零假阳性优先)─────────────────────────

test('错乘积被点名,exact 为确定性结果', () => {
  const r = av.verifyArithmeticClaims('所以 12*12 = 140,因此……', ON);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].exact, '144');
  assert.strictEqual(r[0].stated, '140');        // 不含尾随千分逗号
  assert.match(r[0].expr, /12\*12/);
});

test('算对的不报', () => {
  assert.deepStrictEqual(av.verifyArithmeticClaims('12*12 = 144', ON), []);
  assert.deepStrictEqual(av.verifyArithmeticClaims('(2+3)*4 = 20', ON), []);
  assert.deepStrictEqual(av.verifyArithmeticClaims('2^10 = 1024', ON), []);
});

test('裸 +/- 不取(避免页码/区间/范围误报)', () => {
  // 2+2=5 错,但无强算符 → 刻意不报(零假阳性优先,宁可漏报)
  assert.deepStrictEqual(av.verifyArithmeticClaims('见 2+2=5 的笑话', ON), []);
  assert.deepStrictEqual(av.verifyArithmeticClaims('第 1-2 页', ON), []);
});

test('近似标记(≈/约/~)跳过,不算证伪', () => {
  assert.deepStrictEqual(av.verifyArithmeticClaims('10/3 ≈ 3.33', ON), []);
  assert.deepStrictEqual(av.verifyArithmeticClaims('10/3 约 3.3', ON), []);
  assert.deepStrictEqual(av.verifyArithmeticClaims('22/7 ~ 3.14', ON), []);
});

test('非终止小数即便无近似标记也跳过(模型合理四舍五入)', () => {
  assert.deepStrictEqual(av.verifyArithmeticClaims('10/3 = 3.333', ON), []);
  assert.deepStrictEqual(av.verifyArithmeticClaims('1/3 = 0.333', ON), []);
});

test('日期 / 版本号不被当算式', () => {
  assert.deepStrictEqual(av.verifyArithmeticClaims('窗口 2024-01-02 = 起点', ON), []);
  assert.deepStrictEqual(av.verifyArithmeticClaims('v1.2.3 = 5', ON), []);
});

test('千分逗号:左右两侧都能归一比较', () => {
  // 1,000*2 真值 2000,模型写 3,000 → 报
  const r = av.verifyArithmeticClaims('1,000*2 = 3,000', ON);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].exact, '2000');
  assert.strictEqual(r[0].stated, '3,000');
  // 写对则不报
  assert.deepStrictEqual(av.verifyArithmeticClaims('1,000*2 = 2,000', ON), []);
});

test('小数尾随零归一:50/4 = 12.50 视同 12.5,不报', () => {
  assert.deepStrictEqual(av.verifyArithmeticClaims('50/4 = 12.50', ON), []);
});

test('同一错误算式只报一次(去重)', () => {
  const r = av.verifyArithmeticClaims('6*7 = 41,我再说一遍 6*7 = 41。', ON);
  assert.strictEqual(r.length, 1);
});

test('门控关 → 恒空(答复逐字节不变)', () => {
  assert.deepStrictEqual(av.verifyArithmeticClaims('6*7 = 41', OFF), []);
});

test('verifyArithmeticClaims: 畸形输入不抛、返回空', () => {
  assert.doesNotThrow(() => av.verifyArithmeticClaims());
  assert.deepStrictEqual(av.verifyArithmeticClaims(null, ON), []);
  assert.deepStrictEqual(av.verifyArithmeticClaims(123, ON), []);
});

// ── verifyActionClaims:动作声称对账(委派 claimReconciler 单一真源)─────────────

test('声称已删除但无工具记录 → 矛盾', () => {
  const r = av.verifyActionClaims('我已经删除了那个文件。', [], ON);
  assert.ok(r.length >= 1);
  assert.strictEqual(r[0].expectedTool, 'Delete');
});

test('门控关 → 动作对账恒空', () => {
  assert.deepStrictEqual(av.verifyActionClaims('我已经删除了那个文件。', [], OFF), []);
});

test('verifyActionClaims: 畸形输入不抛', () => {
  assert.doesNotThrow(() => av.verifyActionClaims());
  assert.doesNotThrow(() => av.verifyActionClaims('x', 'not-an-array', ON));
});

// ── buildVerificationNote ────────────────────────────────────────────────────

test('无证伪 → null(接缝据此不改动答复)', () => {
  assert.strictEqual(av.buildVerificationNote({ arithmetic: [], action: [] }), null);
  assert.strictEqual(av.buildVerificationNote({}), null);
  assert.strictEqual(av.buildVerificationNote(), null);
});

test('注记以 VERIFY_MARKER 开头(去重锚)、含 exact 与 stated', () => {
  const note = av.buildVerificationNote({
    arithmetic: [{ expr: '6*7', stated: '41', exact: '42' }],
    action: [],
  });
  assert.ok(note.includes(av.VERIFY_MARKER));
  assert.match(note, /42/);
  assert.match(note, /41/);
  assert.match(note, /以 42 为准/);
});

// ── verifyAnswer:组合 ────────────────────────────────────────────────────────

test('verifyAnswer: 算式 + 动作都证伪 → note 含两段', () => {
  const v = av.verifyAnswer({
    answer: '我已删除该文件。另外 6*7 = 41。', toolCallLog: [], actions: true, env: ON,
  });
  assert.strictEqual(v.arithmetic.length, 1);
  assert.ok(v.action.length >= 1);
  assert.ok(v.note.includes(av.VERIFY_MARKER));
  assert.match(v.note, /6\*7/);
  assert.match(v.note, /Delete/);
});

test('verifyAnswer: actions:false 时不做动作对账(纯聊天 seam)', () => {
  const v = av.verifyAnswer({
    answer: '我已删除该文件。另外 6*7 = 41。', actions: false, env: ON,
  });
  assert.strictEqual(v.arithmetic.length, 1);
  assert.deepStrictEqual(v.action, []);
});

test('verifyAnswer: 全对 → note 为 null', () => {
  const v = av.verifyAnswer({ answer: '6*7 = 42。', actions: false, env: ON });
  assert.strictEqual(v.note, null);
});

test('verifyAnswer: 门控关 → 空结果、note 为 null(字节回退)', () => {
  const v = av.verifyAnswer({ answer: '6*7 = 41', actions: true, env: OFF });
  assert.deepStrictEqual(v, { arithmetic: [], action: [], math: { ran: false, confirmed: [], falsified: [] }, note: null });
});

test('verifyAnswer: 畸形输入不抛', () => {
  assert.doesNotThrow(() => av.verifyAnswer());
  assert.doesNotThrow(() => av.verifyAnswer({ env: ON }));
});
