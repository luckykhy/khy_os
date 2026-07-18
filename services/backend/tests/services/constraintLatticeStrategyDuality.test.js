'use strict';

/**
 * constraintLatticeStrategyDuality.test.js — 收敛验收：constraintLattice 是
 * constraintStrategy 的「可行性对偶投影」，二者绝不漂移（[GUARDS-AI] §2 单一真源）。
 *
 * 历史上有两条独立的三元有序链：
 *   - constraintStrategy（锁强度域，高=更锁）：Prompt_Soft ⊏ Code_Hard ⊏ System_Block
 *   - constraintLattice （可行性域，高=更可行）：⊥ BOTTOM ⊏ SOFT ⊏ ⊤ TOP
 * 它们不是两份真理，而是彼此的**序对偶**。constraintStrategy 现为唯一权威阶梯，
 * constraintLattice 经 toStrategy/fromStrategy 双射声明为其投影。本测试机械断言对偶不变式，
 * 任一文件单方面改阶/加级都会让本测试转红，从而阻止「双真源」复活。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const lattice = require('../../src/services/constraintLattice');
const strategy = require('../../src/services/metaplan/constraintStrategy');

const ELEMENTS = [lattice.BOTTOM, lattice.SOFT, lattice.TOP];
const STRATEGIES = [
  strategy.STRATEGIES.SYSTEM_BLOCK,
  strategy.STRATEGIES.CODE_HARD,
  strategy.STRATEGIES.PROMPT_SOFT,
];

describe('constraintLattice ⟷ constraintStrategy 对偶收敛', () => {
  test('双射：toStrategy/fromStrategy 在三元素上一一对应且互逆', () => {
    for (const el of ELEMENTS) {
      const s = lattice.toStrategy(el);
      assert.ok(strategy.isStrategy(s), `toStrategy(${el}) 应落在合法策略上，实得 ${s}`);
      assert.equal(lattice.fromStrategy(s), el, `fromStrategy∘toStrategy 应为恒等（${el}）`);
    }
    for (const s of STRATEGIES) {
      const el = lattice.fromStrategy(s);
      assert.ok(lattice.isElement(el), `fromStrategy(${s}) 应落在合法格元素上，实得 ${el}`);
      assert.equal(lattice.toStrategy(el), s, `toStrategy∘fromStrategy 应为恒等（${s}）`);
    }
  });

  test('对偶钉定的语义锚点：TOP=Prompt_Soft、SOFT=Code_Hard、BOTTOM=System_Block', () => {
    assert.equal(lattice.toStrategy(lattice.TOP), strategy.STRATEGIES.PROMPT_SOFT);
    assert.equal(lattice.toStrategy(lattice.SOFT), strategy.STRATEGIES.CODE_HARD);
    assert.equal(lattice.toStrategy(lattice.BOTTOM), strategy.STRATEGIES.SYSTEM_BLOCK);
  });

  test('秩互补不变式：可行性秩 + 锁强度秩 ≡ 2（两链同高、互为反序）', () => {
    const TOPRANK = 2; // 两链都是 0..2 的三元链
    for (const el of ELEMENTS) {
      const sum = lattice.RANK[el] + strategy.rankOf(lattice.toStrategy(el));
      assert.equal(sum, TOPRANK, `${el} 的秩互补应为 ${TOPRANK}，实得 ${sum}（链高漂移 = 双真源复活）`);
    }
  });

  test('算子对偶：lattice.meet（更受限）↔ strategy.escalate（更严锁）', () => {
    // 收紧在可行性域是 meet（取更低可行），在锁强度域是 escalate（取更高锁）。
    // 对偶应使二者一致：toStrategy(meet(a,b)) === escalate(toStrategy(a), toStrategy(b))。
    for (const a of ELEMENTS) {
      for (const b of ELEMENTS) {
        const viaLattice = lattice.toStrategy(lattice.meet(a, b));
        const viaStrategy = strategy.escalate(lattice.toStrategy(a), lattice.toStrategy(b));
        assert.equal(viaLattice, viaStrategy,
          `meet/escalate 对偶在 (${a},${b}) 失配：${viaLattice} ≠ ${viaStrategy}`);
      }
    }
  });

  test('对偶下 join（更可行）↔ 取更松锁（escalate 的对偶）', () => {
    // join 取更高可行 → 对应更低锁强度（两策略中较松者）。
    for (const a of ELEMENTS) {
      for (const b of ELEMENTS) {
        const looser = strategy.rankOf(lattice.toStrategy(a)) <= strategy.rankOf(lattice.toStrategy(b))
          ? lattice.toStrategy(a) : lattice.toStrategy(b);
        assert.equal(lattice.toStrategy(lattice.join(a, b)), looser,
          `join 应对应更松锁 (${a},${b})`);
      }
    }
  });

  test('未知输入 fail-closed：fromStrategy(垃圾)=BOTTOM、toStrategy(垃圾)=null', () => {
    assert.equal(lattice.fromStrategy('NoSuchStrategy'), lattice.BOTTOM);
    assert.equal(lattice.fromStrategy(undefined), lattice.BOTTOM);
    assert.equal(lattice.toStrategy('nonsense'), null);
  });

  test('红线对偶一致：BOTTOM 对应最严锁 System_Block，且 relax(⊥) 仍为 ⊥（不可逆）', () => {
    assert.equal(lattice.toStrategy(lattice.BOTTOM), strategy.STRATEGIES.SYSTEM_BLOCK);
    assert.equal(lattice.relax(lattice.BOTTOM, { approved: true }), lattice.BOTTOM);
    // 红线源经 position 仍判 BOTTOM（审批 fail-closed 行为不因收敛改变）。
    assert.equal(lattice.position({ action: 'block', source: 'pathtraversalguard', approvable: true }), lattice.BOTTOM);
  });
});
