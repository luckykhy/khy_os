'use strict';

/**
 * constraintLattice.test.js — Phase D of the CB-SSP redesign (§4.D).
 *
 * Asserts the MATHEMATICAL properties the constraint lattice Π_C must hold:
 *
 *   1. PARTIAL ORDER — ⊥ ⊏ SOFT ⊏ ⊤ is reflexive, antisymmetric, transitive;
 *      join/meet are the lub/glb of the chain.
 *   2. CLASSIFICATION (golden regression) — classifying each existing guard
 *      result reproduces the current hard/soft/allow contract exactly.
 *   3. RED-LINE IRREDUCIBILITY — relax(⊥, approved) = ⊥ for ANY approval; a
 *      red-line source stays infeasible even if a result mis-sets approvable.
 *   4. SOFT RELAXATION — relax(SOFT, true)=⊤, relax(SOFT, false)=SOFT; relax is
 *      monotone and idempotent.
 *   5. LIVENESS — ensureLiveness(actions) is never empty; the escape floor
 *      survives any policy block (feasibleUnderPolicy).
 */

const L = require('../../src/services/constraintLattice');

const ELEMENTS = [L.BOTTOM, L.SOFT, L.TOP];

afterEach(() => {
  delete process.env.KHY_LATTICE_REDLINE_SOURCES;
  delete process.env.KHY_LIVENESS_FALLBACK;
});

describe('partial order ⊥ ⊏ SOFT ⊏ ⊤', () => {
  test('reflexive: a ⊑ a for every element', () => {
    for (const a of ELEMENTS) expect(L.leq(a, a)).toBe(true);
  });

  test('antisymmetric: a ⊑ b and b ⊑ a ⇒ a = b', () => {
    for (const a of ELEMENTS) {
      for (const b of ELEMENTS) {
        if (L.leq(a, b) && L.leq(b, a)) expect(a).toBe(b);
      }
    }
  });

  test('transitive: a ⊑ b and b ⊑ c ⇒ a ⊑ c', () => {
    for (const a of ELEMENTS) {
      for (const b of ELEMENTS) {
        for (const c of ELEMENTS) {
          if (L.leq(a, b) && L.leq(b, c)) expect(L.leq(a, c)).toBe(true);
        }
      }
    }
  });

  test('the chain is exactly ⊥ ⊏ SOFT ⊏ ⊤', () => {
    expect(L.lt(L.BOTTOM, L.SOFT)).toBe(true);
    expect(L.lt(L.SOFT, L.TOP)).toBe(true);
    expect(L.lt(L.BOTTOM, L.TOP)).toBe(true);
    expect(L.lt(L.TOP, L.BOTTOM)).toBe(false);
    expect(L.lt(L.SOFT, L.BOTTOM)).toBe(false);
  });

  test('join = lub, meet = glb of the chain', () => {
    expect(L.join(L.BOTTOM, L.SOFT)).toBe(L.SOFT);
    expect(L.join(L.SOFT, L.TOP)).toBe(L.TOP);
    expect(L.join(L.BOTTOM, L.TOP)).toBe(L.TOP);
    expect(L.meet(L.BOTTOM, L.SOFT)).toBe(L.BOTTOM);
    expect(L.meet(L.SOFT, L.TOP)).toBe(L.SOFT);
    expect(L.meet(L.BOTTOM, L.TOP)).toBe(L.BOTTOM);
    // join/meet are commutative and absorb with the extremes.
    expect(L.join(L.SOFT, L.BOTTOM)).toBe(L.SOFT);
    expect(L.meet(L.TOP, L.SOFT)).toBe(L.SOFT);
  });
});

describe('classification — golden regression of the existing guard contract', () => {
  // Mirrors toolGuards.js return shapes exactly (anchors verified against the
  // registerBuiltinGuards block). If a guard ever changes its approvable
  // emission, one of these breaks — that is the intended tripwire.
  test('red-line blocks (no approvable) classify as ⊥', () => {
    expect(L.position({ action: 'block', source: 'builtin:PathTraversalGuard' })).toBe(L.BOTTOM);
    expect(L.position({ action: 'block', source: 'builtin:RateLimitGuard' })).toBe(L.BOTTOM);
    // EditBoundaryGuard's sensitive-home-write block sets NO approvable → ⊥,
    // even though the source's declared ceiling is SOFT.
    expect(L.position({ action: 'block', source: 'builtin:EditBoundaryGuard' })).toBe(L.BOTTOM);
  });

  test('soft blocks (approvable:true) classify as SOFT', () => {
    expect(L.position({ action: 'block', approvable: true, source: 'EditBoundaryGuard' })).toBe(L.SOFT);
    expect(L.position({ action: 'block', approvable: true, source: 'PriorReadGuard' })).toBe(L.SOFT);
    expect(L.position({ action: 'block', approvable: true, source: 'FileStaleGuard' })).toBe(L.SOFT);
  });

  test('allow (or non-block) classifies as ⊤', () => {
    expect(L.position({ action: 'allow' })).toBe(L.TOP);
    expect(L.position({})).toBe(L.TOP);
    expect(L.position(null)).toBe(L.TOP);
  });

  test('isRedLine / isApprovable mirror position', () => {
    const red = { action: 'block', source: 'builtin:PathTraversalGuard' };
    const soft = { action: 'block', approvable: true, source: 'PriorReadGuard' };
    expect(L.isRedLine(red)).toBe(true);
    expect(L.isApprovable(red)).toBe(false);
    expect(L.isApprovable(soft)).toBe(true);
    expect(L.isRedLine(soft)).toBe(false);
  });

  test('positionOfSource / isRedLineSource declare the formal ceiling', () => {
    expect(L.positionOfSource('builtin:PathTraversalGuard')).toBe(L.BOTTOM);
    expect(L.positionOfSource('RateLimitGuard')).toBe(L.BOTTOM);
    expect(L.positionOfSource('EditBoundaryGuard')).toBe(L.SOFT);
    expect(L.positionOfSource('PriorReadGuard')).toBe(L.SOFT);
    expect(L.positionOfSource('FileStaleGuard')).toBe(L.SOFT);
    expect(L.positionOfSource('UnknownGuard')).toBeNull();
    expect(L.isRedLineSource('builtin:SsrfGuard')).toBe(true);
    expect(L.isRedLineSource('ToolCallGuardrail')).toBe(true);
  });

  test('env may ADD a red line (tightening only)', () => {
    expect(L.isRedLineSource('CustomDangerGuard')).toBe(false);
    process.env.KHY_LATTICE_REDLINE_SOURCES = 'CustomDangerGuard, builtin:Foo';
    expect(L.isRedLineSource('CustomDangerGuard')).toBe(true);
    expect(L.isRedLineSource('Foo')).toBe(true);
    // A declared red line cannot be downgraded by env (env only adds).
    expect(L.positionOfSource('PathTraversalGuard')).toBe(L.BOTTOM);
  });
});

describe('red-line irreducibility — relax(⊥) is a fixed point', () => {
  test('relax(⊥, approved=true) = ⊥ (no approval can lift a red line)', () => {
    expect(L.relax(L.BOTTOM, { approved: true })).toBe(L.BOTTOM);
    expect(L.relax(L.BOTTOM, { approved: false })).toBe(L.BOTTOM);
    expect(L.relax(L.BOTTOM)).toBe(L.BOTTOM);
  });

  test('canRelax is true only for SOFT', () => {
    expect(L.canRelax(L.BOTTOM)).toBe(false);
    expect(L.canRelax(L.SOFT)).toBe(true);
    expect(L.canRelax(L.TOP)).toBe(false);
  });

  test('a mis-set approvable on a red-line source still classifies ⊥ → still unliftable', () => {
    const sneaky = { action: 'block', approvable: true, source: 'builtin:PathTraversalGuard' };
    expect(L.position(sneaky)).toBe(L.BOTTOM); // declaration dominates the flag
    expect(L.relax(L.position(sneaky), { approved: true })).toBe(L.BOTTOM);
  });
});

describe('soft relaxation — λ_human lifts SOFT to ⊤', () => {
  test('relax(SOFT, true)=⊤, relax(SOFT, false)=SOFT', () => {
    expect(L.relax(L.SOFT, { approved: true })).toBe(L.TOP);
    expect(L.relax(L.SOFT, { approved: false })).toBe(L.SOFT);
    expect(L.relax(L.SOFT)).toBe(L.SOFT);
  });

  test('relax is monotone (output ⊒ input)', () => {
    for (const el of ELEMENTS) {
      for (const approved of [true, false]) {
        expect(L.leq(el, L.relax(el, { approved }))).toBe(true);
      }
    }
  });

  test('relax is idempotent (relax∘relax = relax)', () => {
    for (const el of ELEMENTS) {
      for (const approved of [true, false]) {
        const once = L.relax(el, { approved });
        const twice = L.relax(once, { approved });
        expect(twice).toBe(once);
      }
    }
  });

  test('relax(⊤) = ⊤ (top is a fixed point)', () => {
    expect(L.relax(L.TOP, { approved: true })).toBe(L.TOP);
    expect(L.relax(L.TOP, { approved: false })).toBe(L.TOP);
  });

  test('unknown element fails closed to ⊥', () => {
    expect(L.relax('garbage', { approved: true })).toBe(L.BOTTOM);
  });
});

describe('liveness — A(s) ≠ ∅', () => {
  test('ensureLiveness on an empty set returns the escape floor', () => {
    const a = L.ensureLiveness([]);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(expect.arrayContaining(['ask_user', 'abort']));
  });

  test('ensureLiveness on a non-empty set is unchanged (zero behavior change)', () => {
    expect(L.ensureLiveness(['editFile', 'readFile'])).toEqual(['editFile', 'readFile']);
  });

  test('ensureLiveness filters falsy and still guarantees non-empty', () => {
    expect(L.ensureLiveness([null, undefined, ''])).toEqual(expect.arrayContaining(['ask_user', 'abort']));
    expect(L.ensureLiveness(null).length).toBeGreaterThan(0);
  });

  test('isLivenessFloor recognizes the escape actions (case-insensitive)', () => {
    expect(L.isLivenessFloor('ask_user')).toBe(true);
    expect(L.isLivenessFloor('askUserQuestion')).toBe(true);
    expect(L.isLivenessFloor('abort')).toBe(true);
    expect(L.isLivenessFloor('editFile')).toBe(false);
    expect(L.isLivenessFloor('')).toBe(false);
  });

  test('env can extend the floor', () => {
    expect(L.isLivenessFloor('panic_button')).toBe(false);
    process.env.KHY_LIVENESS_FALLBACK = 'panic_button';
    expect(L.isLivenessFloor('panic_button')).toBe(true);
  });

  test('feasibleUnderPolicy suppresses a block for a floor action only', () => {
    expect(L.feasibleUnderPolicy('ask_user', 'blocked by allowlist')).toBeNull();
    expect(L.feasibleUnderPolicy('abort', 'blocked by skill whitelist')).toBeNull();
    // A normal tool's block passes through unchanged.
    expect(L.feasibleUnderPolicy('editFile', 'blocked by allowlist')).toBe('blocked by allowlist');
    // No block reason → null regardless.
    expect(L.feasibleUnderPolicy('editFile', null)).toBeNull();
  });
});
