'use strict';

/**
 * actionContractVerifier — 极小核验器 V + 可机检谓词契约 的确定性测试(node:test)。
 *
 * 锁定:
 *  ① 公理集极小且封闭(describeAxioms 即全部行为面;集外算子 fail-closed);
 *  ② 谓词语义正确(and/or/not/eq/ne/序/in/type/exists/absent/forbiddenKey);
 *  ③ verify 的 Hoare 语义(Φ_pre ⇒ Φ_post;缺省 Φ = vacuous;失败带 stage);
 *  ④ fail-closed 铁律(畸形/未知算子/异常一律 ok:false,绝不 fail-open);
 *  ⑤ 门控关 → 一律 fail-closed;
 *  ⑥ canonicalize 键序稳定、确定性、防环;
 *  ⑦ 自证其伪:五条投毒路径(谓词即代码 / 原型污染 / fail-open / ReDoS 面 / 资源耗尽)
 *     在代码中已被物理切断 —— 用白盒断言逐条证明。
 */

const test = require('node:test');
const assert = require('node:assert');

const V = require('../src/services/syscallGateway/actionContractVerifier');

const ON = { KHY_ACTION_CONTRACT: 'true' };
const OFF = { KHY_ACTION_CONTRACT: 'off' };

// ── ① 公理集极小且封闭 ────────────────────────────────────────────────────────
test('describeAxioms: 极小封闭公理集,且不含正则(ReDoS 面被剔除)', () => {
  const ax = V.describeAxioms();
  assert.ok(Array.isArray(ax) && ax.length > 0);
  // 正则类算子刻意不在公理集内([P4] 消灭 ReDoS 面)
  for (const banned of ['matches', 'regex', 'match', 're', 'test', 'js', 'eval', 'call']) {
    assert.ok(!ax.includes(banned), `公理集不得含 ${banned}`);
  }
  // 返回副本,改不动内部 SSOT
  ax.push('__pwn__');
  assert.ok(!V.describeAxioms().includes('__pwn__'), 'describeAxioms 须返回副本');
  // AXIOMS 本体冻结
  assert.ok(Object.isFrozen(V.AXIOMS));
});

// ── ② 谓词语义 ────────────────────────────────────────────────────────────────
test('布尔/相等/序/成员/类型/存在 语义正确', () => {
  const st = { a: 1, b: 'x', n: 5, arr: [1, 2, 3], obj: { k: 'v' } };
  const ev = (p) => V.evaluatePredicate(p, st, ON);

  assert.strictEqual(ev({ op: 'true' }), true);
  assert.strictEqual(ev({ op: 'false' }), false);
  assert.strictEqual(ev({ op: 'eq', path: 'a', value: 1 }), true);
  assert.strictEqual(ev({ op: 'eq', path: 'a', value: 2 }), false);
  assert.strictEqual(ev({ op: 'ne', path: 'b', value: 'y' }), true);
  assert.strictEqual(ev({ op: 'eq', path: 'arr', value: [1, 2, 3] }), true); // 深比较
  assert.strictEqual(ev({ op: 'eq', path: 'obj', value: { k: 'v' } }), true);

  assert.strictEqual(ev({ op: 'lt', path: 'n', value: 10 }), true);
  assert.strictEqual(ev({ op: 'ge', path: 'n', value: 5 }), true);
  assert.strictEqual(ev({ op: 'gt', path: 'n', value: 5 }), false);

  assert.strictEqual(ev({ op: 'in', path: 'a', value: [1, 2, 3] }), true);
  assert.strictEqual(ev({ op: 'in', path: 'a', value: [7, 8] }), false);

  assert.strictEqual(ev({ op: 'type', path: 'arr', value: 'array' }), true);
  assert.strictEqual(ev({ op: 'type', path: 'b', value: 'string' }), true);
  assert.strictEqual(ev({ op: 'type', path: 'a', value: 'string' }), false);

  assert.strictEqual(ev({ op: 'exists', path: 'a' }), true);
  assert.strictEqual(ev({ op: 'absent', path: 'zzz' }), true);
  assert.strictEqual(ev({ op: 'exists', path: 'zzz' }), false);

  assert.strictEqual(ev({ op: 'and', args: [{ op: 'true' }, { op: 'eq', path: 'a', value: 1 }] }), true);
  assert.strictEqual(ev({ op: 'and', args: [{ op: 'true' }, { op: 'false' }] }), false);
  assert.strictEqual(ev({ op: 'or', args: [{ op: 'false' }, { op: 'eq', path: 'a', value: 1 }] }), true);
  assert.strictEqual(ev({ op: 'not', arg: { op: 'false' } }), true);
  assert.strictEqual(ev({ op: 'and', args: [] }), true);  // vacuous
  assert.strictEqual(ev({ op: 'or', args: [] }), false);
});

test('数值序:非有限数两侧一律 fail-closed', () => {
  const ev = (p, st) => V.evaluatePredicate(p, st, ON);
  assert.strictEqual(ev({ op: 'lt', path: 'x', value: 1 }, { x: 'not-a-number' }), false);
  assert.strictEqual(ev({ op: 'lt', path: 'x', value: Infinity }, { x: 1 }), false);
  assert.strictEqual(ev({ op: 'lt', path: 'x', value: NaN }, { x: 1 }), false);
});

// ── ③ verify Hoare 语义 ──────────────────────────────────────────────────────
test('verify: Φ_pre ⇒ Φ_post,缺省 Φ = vacuous,失败带 stage', () => {
  const contract = {
    name: 'write-file',
    pre: { op: 'eq', path: 'approved', value: true },
    post: { op: 'eq', path: 'out.written', value: true },
  };
  const ok = V.verify(contract, { pre: { approved: true }, post: { written: true } }, ON);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.stage, null);
  assert.strictEqual(ok.contract, 'write-file');

  const preFail = V.verify(contract, { pre: { approved: false }, post: { written: true } }, ON);
  assert.strictEqual(preFail.ok, false);
  assert.strictEqual(preFail.stage, 'pre');

  const postFail = V.verify(contract, { pre: { approved: true }, post: { written: false } }, ON);
  assert.strictEqual(postFail.ok, false);
  assert.strictEqual(postFail.stage, 'post');

  // 缺省 Φ:无 pre/post 约束 → vacuously ok
  const vac = V.verify({ name: 'noop' }, { pre: {}, post: {} }, ON);
  assert.strictEqual(vac.ok, true);
});

test('verify: Φ_post 可关联输入(in)与输出(out)', () => {
  // 后置:输出余额 = 输入余额 - 输入扣款额(此处用相等链验证可读 in/out)
  const contract = {
    name: 'debit',
    post: {
      op: 'and',
      args: [
        { op: 'eq', path: 'in.balance', value: 100 },
        { op: 'eq', path: 'out.balance', value: 90 },
      ],
    },
  };
  const r = V.verify(contract, { pre: { balance: 100 }, post: { balance: 90 } }, ON);
  assert.strictEqual(r.ok, true);
});

// ── ④ fail-closed 铁律 ────────────────────────────────────────────────────────
test('fail-closed: 畸形契约 / 未知算子 / 缺字段 一律 ok:false(绝不 fail-open)', () => {
  for (const bad of [null, undefined, 42, 'str', [], { pre: 123 }, { pre: { op: 'js', src: 'x' } }]) {
    const r = V.verify(bad, { pre: {}, post: {} }, ON);
    assert.strictEqual(r.ok, false, `畸形契约须 fail-closed: ${JSON.stringify(bad)}`);
  }
  // 未知算子 → stage:'error'
  const unknown = V.verify({ pre: { op: 'exec', cmd: 'rm -rf' } }, { pre: {}, post: {} }, ON);
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.stage, 'error');
  assert.ok(/unknown axiom/.test(unknown.reason || ''));
});

test('绝不抛:任意坏输入 fail-soft', () => {
  const nasty = { get pre() { throw new Error('boom'); } };
  assert.doesNotThrow(() => V.verify(nasty, {}, ON));
  assert.strictEqual(V.verify(nasty, {}, ON).ok, false);
  assert.doesNotThrow(() => V.evaluatePredicate({ op: 'and', args: 'notarray' }, {}, ON));
  assert.strictEqual(V.evaluatePredicate(null, {}, ON), true); // 无约束 = vacuous
});

// ── ⑤ 门控 ────────────────────────────────────────────────────────────────────
test('门控关 → 一律 fail-closed(verify ok:false, evaluatePredicate false)', () => {
  assert.strictEqual(V.isEnabled({}), true);
  assert.strictEqual(V.isEnabled(OFF), false);
  const r = V.verify({ name: 'x', pre: { op: 'true' } }, { pre: {}, post: {} }, OFF);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'error');
  assert.strictEqual(V.evaluatePredicate({ op: 'true' }, {}, OFF), false);
});

// ── ⑥ canonicalize ───────────────────────────────────────────────────────────
test('canonicalize: 键序稳定 / 确定性 / 防环 / 不抛', () => {
  const a = V.canonicalize({ b: 1, a: 2, c: [3, { y: 1, x: 2 }] });
  const b = V.canonicalize({ c: [3, { x: 2, y: 1 }], a: 2, b: 1 });
  assert.strictEqual(a, b, '逻辑相同对象须规范化为同一字符串');
  assert.ok(a.indexOf('"a"') < a.indexOf('"b"'), '键须排序');

  const cyc = {}; cyc.self = cyc;
  assert.doesNotThrow(() => V.canonicalize(cyc));
  assert.ok(/__cycle__/.test(V.canonicalize(cyc)));

  // 函数等不可表示值 → 占位,不抛
  assert.doesNotThrow(() => V.canonicalize({ f: () => 1, n: NaN }));
});

// ── ⑦ 自证其伪:五条投毒路径已被物理切断 ──────────────────────────────────────
test('[P1 谓词即代码] 契约携带 {op:js/exec/...} 绝不被执行,fail-closed', () => {
  let sideEffect = false;
  const evil = { op: 'js', fn: () => { sideEffect = true; return true; }, src: 'globalThis.x=1' };
  const r = V.verify({ pre: evil }, { pre: {}, post: {} }, ON);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(sideEffect, false, '契约里的函数绝不被调用');
  // 即便把函数放进字段值,也只是数据,绝不执行
  assert.strictEqual(V.evaluatePredicate({ op: 'eq', path: 'a', value: () => true }, { a: 1 }, ON), false);
});

test('[P2 原型污染] 经契约路径读写 __proto__/constructor/prototype 一律判缺失', () => {
  // 路径里的越权段 → MISSING(读不到),且不会污染原型
  assert.strictEqual(V.evaluatePredicate({ op: 'exists', path: '__proto__' }, {}, ON), false);
  assert.strictEqual(V.evaluatePredicate({ op: 'exists', path: 'constructor.prototype' }, {}, ON), false);
  assert.strictEqual(V.evaluatePredicate({ op: 'absent', path: '__proto__.polluted' }, {}, ON), true);
  assert.strictEqual(V._get({ a: { __proto__: { evil: 1 } } }, 'a.__proto__.evil'), V.MISSING);
  // forbiddenKey:对象含越权键 → 不满足(可作为后置不变量)
  assert.strictEqual(
    V.evaluatePredicate({ op: 'forbiddenKey', path: 'p', value: ['__proto__', 'force', 'skipApproval'] }, { p: { force: true } }, ON),
    false,
  );
  assert.strictEqual(
    V.evaluatePredicate({ op: 'forbiddenKey', path: 'p', value: ['force', 'skipApproval'] }, { p: { ok: 1 } }, ON),
    true,
  );
  // 真实污染探针:跑完后 Object.prototype 不得被写入
  V.verify({ pre: { op: 'eq', path: '__proto__.polluted', value: 1 } }, { pre: JSON.parse('{"__proto__":{"polluted":1}}'), post: {} }, ON);
  assert.strictEqual({}.polluted, undefined, 'Object.prototype 不得被污染');
});

test('[P3 fail-open] 契约抛异常时绝不被解读为放行', () => {
  const throwingState = { get balance() { throw new Error('side'); } };
  // 即使状态读取抛错,verify 也只会 ok:false,绝不 ok:true
  const r = V.verify({ pre: { op: 'eq', path: 'balance', value: 1 } }, { pre: throwingState, post: {} }, ON);
  assert.strictEqual(r.ok, false);
});

test('[P5 资源耗尽] 深嵌套谓词被节点预算截断 → fail-closed,不爆栈/不挂起', () => {
  // 构造超过 MAX_PRED_NODES 的深 and 链
  let deep = { op: 'true' };
  for (let i = 0; i < 2000; i++) deep = { op: 'and', args: [deep] };
  const r = V.verify({ pre: deep }, { pre: {}, post: {} }, ON);
  assert.strictEqual(r.ok, false, '超预算谓词须 fail-closed');
  // 超深路径同样被截断
  const longPath = Array.from({ length: 100 }, (_, i) => 'a' + i).join('.');
  assert.strictEqual(V.evaluatePredicate({ op: 'exists', path: longPath }, {}, ON), false);
});

// ── ⑧ 谓词逻辑升级:有界量词 every(∀) / some(∃) ──────────────────────────────
test('every(∀): 全称量词 —— 全满足真 / 一个不满足假 / 空数组 vacuous 真 / 缺失非数组 fail-closed', () => {
  const ev = (p, st) => V.evaluatePredicate(p, st, ON);
  const allSanitized = { op: 'every', path: 'outs', as: 'o', body: { op: 'eq', path: 'o.safe', value: true } };
  assert.strictEqual(ev(allSanitized, { outs: [{ safe: true }, { safe: true }] }), true);
  assert.strictEqual(ev(allSanitized, { outs: [{ safe: true }, { safe: false }] }), false);
  assert.strictEqual(ev(allSanitized, { outs: [] }), true);            // 空数组 → ∀ 真
  assert.strictEqual(ev(allSanitized, { outs: 'nope' }), false);       // 非数组 → fail-closed
  assert.strictEqual(ev(allSanitized, {}), false);                     // 缺失 → fail-closed
});

test('some(∃): 存在量词 —— 有一个满足真 / 都不满足假 / 空数组假', () => {
  const ev = (p, st) => V.evaluatePredicate(p, st, ON);
  const hasApproved = { op: 'some', path: 'sigs', as: 's', body: { op: 'eq', path: 's.approved', value: true } };
  assert.strictEqual(ev(hasApproved, { sigs: [{ approved: false }, { approved: true }] }), true);
  assert.strictEqual(ev(hasApproved, { sigs: [{ approved: false }] }), false);
  assert.strictEqual(ev(hasApproved, { sigs: [] }), false);            // 空数组 → ∃ 假
});

test('量词体内既能引用绑定元素、又能引用外层路径', () => {
  // 所有元素的 owner 都等于外层 currentUser(关联绑定与外层)
  const p = { op: 'every', path: 'files', as: 'f', body: { op: 'eq', path: 'f.owner', ref: 'currentUser' } };
  assert.strictEqual(V.evaluatePredicate(p, { currentUser: 'alice', files: [{ owner: 'alice' }, { owner: 'alice' }] }, ON), true);
  assert.strictEqual(V.evaluatePredicate(p, { currentUser: 'alice', files: [{ owner: 'bob' }] }, ON), false);
});

// ── ⑨ 跨路径关系比较(ref)= 帧条件 / 关系不变量 ──────────────────────────────
test('ref: 比较的另一侧可为另一条路径(帧条件 / 单调 / 关系不变量)', () => {
  const st = { in: { id: 'x', balance: 100 }, out: { id: 'x', balance: 90 } };
  const ev = (p) => V.evaluatePredicate(p, st, ON);
  assert.strictEqual(ev({ op: 'eq', path: 'out.id', ref: 'in.id' }), true);     // 帧:id 不变
  assert.strictEqual(ev({ op: 'le', path: 'out.balance', ref: 'in.balance' }), true);  // 单调:余额不增
  assert.strictEqual(ev({ op: 'gt', path: 'out.balance', ref: 'in.balance' }), false);
  // ref 指向缺失路径 → fail-closed
  assert.strictEqual(ev({ op: 'eq', path: 'out.id', ref: 'in.nope' }), false);
});

// ── ⑩ Hoare 不变量 inv(balance ≥ 0 恒成立)──────────────────────────────────
test('inv: 不变量须在前态与后态都成立,否则 stage:inv', () => {
  const contract = {
    name: 'debit',
    pre: { op: 'ge', path: 'balance', value: 50 },
    post: { op: 'eq', path: 'out.balance', value: 90 },
    inv: { op: 'ge', path: 'balance', value: 0 },   // balance ≥ 0 恒成立
  };
  const ok = V.verify(contract, { pre: { balance: 100 }, post: { balance: 90 } }, ON);
  assert.strictEqual(ok.ok, true);

  // 后态破坏不变量(余额变负)→ stage:inv
  const broken = V.verify(
    { name: 'overdraw', inv: { op: 'ge', path: 'balance', value: 0 } },
    { pre: { balance: 10 }, post: { balance: -5 } }, ON,
  );
  assert.strictEqual(broken.ok, false);
  assert.strictEqual(broken.stage, 'inv');
  assert.ok(/后态/.test(broken.reason || ''));

  // 前态就违反不变量 → stage:inv(前态)
  const badPre = V.verify(
    { name: 'x', inv: { op: 'ge', path: 'balance', value: 0 } },
    { pre: { balance: -1 }, post: { balance: 0 } }, ON,
  );
  assert.strictEqual(badPre.ok, false);
  assert.strictEqual(badPre.stage, 'inv');
  assert.ok(/前态/.test(badPre.reason || ''));
});

test('describeAxioms 含量词 every/some(谓词逻辑已登记进封闭集)', () => {
  const ax = V.describeAxioms();
  assert.ok(ax.includes('every') && ax.includes('some'));
});

// ── ⑪ 自证其伪:谓词逻辑升级新增的投毒路径已切断 ─────────────────────────────
test('[P6 量词绑定名走私] as 为 __proto__/空/非串 → fail-closed,且不污染原型', () => {
  const ev = (p, st) => V.evaluatePredicate(p, st, ON);
  for (const bad of ['__proto__', 'constructor', 'prototype', '', 123, null]) {
    assert.strictEqual(
      ev({ op: 'every', path: 'a', as: bad, body: { op: 'true' } }, { a: [1] }), false,
      `绑定名 ${String(bad)} 须 fail-closed`,
    );
  }
  // 绑定后求值不得污染 Object.prototype
  ev({ op: 'every', path: 'a', as: 'x', body: { op: 'eq', path: 'x', value: 1 } }, { a: [1, 2] });
  assert.strictEqual({}.x, undefined);
});

test('[P7 量词 DoS] 超过元素上限的数组 → fail-closed,不耗时', () => {
  const huge = Array.from({ length: 5000 }, () => ({ safe: true }));
  const p = { op: 'every', path: 'a', as: 'o', body: { op: 'eq', path: 'o.safe', value: true } };
  assert.strictEqual(V.evaluatePredicate(p, { a: huge }, ON), false);
});

test('[P8 ref 路径逃逸] ref 指向 __proto__/constructor → 判缺失 → fail-closed', () => {
  assert.strictEqual(V.evaluatePredicate({ op: 'eq', path: 'a', ref: '__proto__.polluted' }, { a: 1 }, ON), false);
  assert.strictEqual(V.evaluatePredicate({ op: 'eq', path: 'a', ref: 'constructor.prototype' }, { a: 1 }, ON), false);
});
