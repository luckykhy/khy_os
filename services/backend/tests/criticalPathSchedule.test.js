'use strict';

/**
 * criticalPathSchedule leaf tests (node:test).
 *
 * Covers:
 *   - gate ladder (default on / 0·false·off·no incl. case + whitespace / other on)
 *   - the canonical 烧水泡茶 (boil-water-for-tea) 统筹 example end-to-end
 *   - ES/EF/LS/LF/slack + critical-path identification
 *   - waitFill: while a critical task runs, which independent slack tasks fit
 *   - serial-vs-makespan savings
 *   - cycle detection / unknown dependency / duplicate id / bad duration
 *   - defensive empty + default duration
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  scheduleEnabled,
  analyzeSchedule,
} = require('../src/services/orchestrator/criticalPathSchedule');

// ── gate ladder ──────────────────────────────────────────────────────────────
test('scheduleEnabled: default on (unset)', () => {
  assert.equal(scheduleEnabled({}), true);
});

test('scheduleEnabled: 0/false/off/no (case + whitespace) off', () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO', ' no ']) {
    assert.equal(scheduleEnabled({ KHY_ORCHESTRATE_SCHEDULE: v }), false, `value ${JSON.stringify(v)} should disable`);
  }
});

test('scheduleEnabled: other values on', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.equal(scheduleEnabled({ KHY_ORCHESTRATE_SCHEDULE: v }), true, `value ${JSON.stringify(v)} should enable`);
  }
});

// ── canonical 烧水泡茶 example ─────────────────────────────────────────────────
// 洗水壶(1) → 烧水(15) → 泡茶(1); 洗茶壶(1)/洗茶杯(1)/拿茶叶(1) feed 泡茶.
function teaTasks() {
  return [
    { id: 'kettle', label: '洗水壶', duration: 1 },
    { id: 'boil', label: '烧水', duration: 15, dependsOn: ['kettle'] },
    { id: 'pot', label: '洗茶壶', duration: 1 },
    { id: 'cup', label: '洗茶杯', duration: 1 },
    { id: 'leaves', label: '拿茶叶', duration: 1 },
    { id: 'brew', label: '泡茶', duration: 1, dependsOn: ['boil', 'pot', 'cup', 'leaves'] },
  ];
}

test('tea example: makespan = critical path (17), not serial sum (20)', () => {
  const r = analyzeSchedule(teaTasks());
  assert.equal(r.serialTotal, 20);
  assert.equal(r.makespan, 17); // 1 + 15 + 1
  assert.equal(r.savedTime, 3);
});

test('tea example: critical path is kettle → boil → brew', () => {
  const r = analyzeSchedule(teaTasks());
  assert.deepStrictEqual(r.criticalPath, ['kettle', 'boil', 'brew']);
  const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
  assert.equal(byId.kettle.critical, true);
  assert.equal(byId.boil.critical, true);
  assert.equal(byId.brew.critical, true);
  // The small chores have slack → not critical.
  assert.equal(byId.pot.critical, false);
  assert.equal(byId.cup.critical, false);
  assert.equal(byId.leaves.critical, false);
  assert.ok(byId.pot.slack > 0);
});

test('tea example: ES/EF/LS/LF/slack of boil and a chore', () => {
  const r = analyzeSchedule(teaTasks());
  const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
  // boil runs [1,16] on the critical path → zero slack
  assert.deepStrictEqual([byId.boil.es, byId.boil.ef, byId.boil.ls, byId.boil.lf], [1, 16, 1, 16]);
  assert.equal(byId.boil.slack, 0);
  // a chore: ES 0, EF 1, but LF = 16 (just before brew) → slack 15
  assert.equal(byId.pot.es, 0);
  assert.equal(byId.pot.ef, 1);
  assert.equal(byId.pot.lf, 16);
  assert.equal(byId.pot.slack, 15);
});

test('tea example: waitFill says "while boiling water, do the chores"', () => {
  const r = analyzeSchedule(teaTasks());
  const duringBoil = r.waitFill.find((w) => w.during === 'boil');
  assert.ok(duringBoil, 'expected a waitFill entry for the boil task');
  assert.deepStrictEqual(duringBoil.window, [1, 16]);
  const ids = duringBoil.canDo.map((c) => c.id).sort();
  assert.deepStrictEqual(ids, ['cup', 'leaves', 'pot']);
});

test('waitFill never recommends a dependency or dependent of the critical task', () => {
  const r = analyzeSchedule(teaTasks());
  for (const w of r.waitFill) {
    const ids = w.canDo.map((c) => c.id);
    // kettle is a dependency of boil; brew depends on boil → neither may appear
    assert.ok(!ids.includes('kettle'));
    assert.ok(!ids.includes('brew'));
    assert.ok(!ids.includes(w.during));
  }
});

// ── pure serial chain: no savings, full critical path ─────────────────────────
test('strict sequential chain: makespan = serial, every task critical, no waitFill', () => {
  const r = analyzeSchedule([
    { id: 'a', duration: 2 },
    { id: 'b', duration: 3, dependsOn: ['a'] },
    { id: 'c', duration: 4, dependsOn: ['b'] },
  ]);
  assert.equal(r.serialTotal, 9);
  assert.equal(r.makespan, 9);
  assert.equal(r.savedTime, 0);
  assert.deepStrictEqual(r.criticalPath, ['a', 'b', 'c']);
  assert.deepStrictEqual(r.waitFill, []);
});

// ── fully parallel independent tasks ──────────────────────────────────────────
test('independent tasks: makespan = longest single task', () => {
  const r = analyzeSchedule([
    { id: 'a', duration: 5 },
    { id: 'b', duration: 2 },
    { id: 'c', duration: 8 },
  ]);
  assert.equal(r.serialTotal, 15);
  assert.equal(r.makespan, 8);
  assert.equal(r.savedTime, 7);
  assert.deepStrictEqual(r.criticalPath, ['c']);
  // while c (the long one) runs, a and b (slack) can be done alongside it
  const duringC = r.waitFill.find((w) => w.during === 'c');
  assert.ok(duringC);
  assert.deepStrictEqual(duringC.canDo.map((x) => x.id).sort(), ['a', 'b']);
});

// ── default duration ──────────────────────────────────────────────────────────
test('absent duration defaults to 1', () => {
  const r = analyzeSchedule([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]);
  assert.equal(r.serialTotal, 2);
  assert.equal(r.makespan, 2);
  const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
  assert.equal(byId.a.duration, 1);
});

// ── validation / defensive ────────────────────────────────────────────────────
test('empty task list → zeroed result, no throw', () => {
  const r = analyzeSchedule([]);
  assert.deepStrictEqual(r, { tasks: [], order: [], makespan: 0, serialTotal: 0, savedTime: 0, criticalPath: [], waitFill: [] });
});

test('cycle detection throws', () => {
  assert.throws(
    () => analyzeSchedule([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]),
    /cycle detected/
  );
});

test('unknown dependency throws', () => {
  assert.throws(() => analyzeSchedule([{ id: 'a', dependsOn: ['ghost'] }]), /unknown task "ghost"/);
});

test('duplicate id throws', () => {
  assert.throws(() => analyzeSchedule([{ id: 'a' }, { id: 'a' }]), /duplicate task id "a"/);
});

test('self dependency throws', () => {
  assert.throws(() => analyzeSchedule([{ id: 'a', dependsOn: ['a'] }]), /depends on itself/);
});

test('negative / non-finite duration throws', () => {
  assert.throws(() => analyzeSchedule([{ id: 'a', duration: -3 }]), /non-negative number/);
  assert.throws(() => analyzeSchedule([{ id: 'a', duration: 'soon' }]), /non-negative number/);
});

test('non-array / bad task object throws clearly', () => {
  assert.throws(() => analyzeSchedule(null), /tasks must be an array/);
  assert.throws(() => analyzeSchedule([42]), /tasks\[0\] must be an object/);
});

test('zero-duration critical task produces no waitFill window for itself', () => {
  // A milestone (duration 0) on the critical path has an empty run window → skipped.
  const r = analyzeSchedule([
    { id: 'start', duration: 0 },
    { id: 'work', duration: 5, dependsOn: ['start'] },
    { id: 'side', duration: 2 },
  ]);
  assert.ok(!r.waitFill.some((w) => w.during === 'start'));
  // but the real work window still collects the side task
  const duringWork = r.waitFill.find((w) => w.during === 'work');
  assert.ok(duringWork);
  assert.deepStrictEqual(duringWork.canDo.map((x) => x.id), ['side']);
});
