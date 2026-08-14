'use strict';

/**
 * Unit tests for restoreProvenanceCheck.js — bundled 运行时纯叶，把关还原「来源可溯性」：
 * 这份还原源码到底等于哪个 git 状态（干净提交 / 提交+未提交增量 / 无从溯源），并渲染一行
 * 诚实横幅提示（run via `node --test`）。
 *
 * 覆盖:
 *   - clean:          HEAD/head 归档，或 working-tree 且 includesUncommitted===false → ok:true。
 *   - dirty:          includesUncommitted===true 或 dirty===true → ok:false，横幅 severity:'warn'。
 *   - indeterminate:  有提交、非脏、无正面 clean 证据 → ok:false，保守不臆断。
 *   - no-provenance:  无 gitCommit → ok:false，无从溯源。
 *   - unverifiable:   头非对象 / 数组 / 标量 → ok:false，横幅 null（字节等价）。
 *   - 绝不抛:          各种畸形入参 → 保守裁决，不抛。
 *   - ok 红线:         ok===true 仅当 status==='clean'，其余一律 false。
 *   - buildProvenanceBannerLine: 每档渲染 severity + 关键措辞；unverifiable / 裁决畸形 → null。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const M = require('../../src/services/restoreProvenanceCheck');
const {
  assessRestoreProvenance,
  buildProvenanceBannerLine,
  STATUS_CLEAN,
  STATUS_DIRTY,
  STATUS_INDETERMINATE,
  STATUS_NO_PROVENANCE,
  STATUS_UNVERIFIABLE,
  _BANNER_SEVERITY,
} = M;

const COMMIT = '44a491fbdeadbeefcafe';
const SHORT = '44a491fbdead'; // 前 12 位

// ── clean ─────────────────────────────────────────────────────────────────────
test('HEAD 归档 → clean + ok:true', () => {
  const v = assessRestoreProvenance({ gitCommit: COMMIT, captureMode: 'HEAD', includesUncommitted: false });
  assert.strictEqual(v.status, STATUS_CLEAN);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.shortCommit, SHORT);
});

test('head（小写，makeSourceSnapshot 实际写法）→ clean', () => {
  const v = assessRestoreProvenance({ gitCommit: COMMIT, captureMode: 'head', includesUncommitted: false });
  assert.strictEqual(v.status, STATUS_CLEAN);
  assert.strictEqual(v.ok, true);
});

test('working-tree 且 includesUncommitted===false → clean', () => {
  const v = assessRestoreProvenance({ gitCommit: COMMIT, captureMode: 'working-tree', includesUncommitted: false });
  assert.strictEqual(v.status, STATUS_CLEAN);
  assert.strictEqual(v.ok, true);
});

// ── dirty（默认 shipped 快照形态）────────────────────────────────────────────
test('includesUncommitted===true → dirty + ok:false', () => {
  const v = assessRestoreProvenance({ gitCommit: COMMIT, captureMode: 'working-tree', includesUncommitted: true, dirty: true });
  assert.strictEqual(v.status, STATUS_DIRTY);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /未提交增量/);
});

test('仅 dirty===true（includesUncommitted 未记录）→ dirty', () => {
  const v = assessRestoreProvenance({ gitCommit: COMMIT, captureMode: 'working-tree', dirty: true });
  assert.strictEqual(v.status, STATUS_DIRTY);
  assert.strictEqual(v.ok, false);
});

test('dirty 优先于 clean 证据（脏但 includesUncommitted:false 冲突 → 仍保守取 dirty 由 true 触发）', () => {
  // includesUncommitted:true 时脏判定优先，绝不误报 clean。
  const v = assessRestoreProvenance({ gitCommit: COMMIT, captureMode: 'HEAD', includesUncommitted: true });
  assert.strictEqual(v.status, STATUS_DIRTY);
});

// ── indeterminate ─────────────────────────────────────────────────────────────
test('有提交、非脏、无正面 clean 证据 → indeterminate + ok:false', () => {
  const v = assessRestoreProvenance({ gitCommit: COMMIT, captureMode: 'working-tree' });
  assert.strictEqual(v.status, STATUS_INDETERMINATE);
  assert.strictEqual(v.ok, false);
});

// ── no-provenance ─────────────────────────────────────────────────────────────
test('无 gitCommit → no-provenance + ok:false', () => {
  const v = assessRestoreProvenance({ captureMode: 'working-tree', includesUncommitted: true });
  assert.strictEqual(v.status, STATUS_NO_PROVENANCE);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.gitCommit, null);
  assert.strictEqual(v.shortCommit, null);
});

test('gitCommit 空串 → no-provenance', () => {
  const v = assessRestoreProvenance({ gitCommit: '', dirty: true });
  assert.strictEqual(v.status, STATUS_NO_PROVENANCE);
});

// ── unverifiable / 绝不抛 ──────────────────────────────────────────────────────
test('null → unverifiable + ok:false', () => {
  const v = assessRestoreProvenance(null);
  assert.strictEqual(v.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(v.ok, false);
});

test('数组 → unverifiable（typeof []==="object" 陷阱须排除）', () => {
  const v = assessRestoreProvenance([1, 2, 3]);
  assert.strictEqual(v.status, STATUS_UNVERIFIABLE);
});

test('标量 → unverifiable', () => {
  assert.strictEqual(assessRestoreProvenance('x').status, STATUS_UNVERIFIABLE);
  assert.strictEqual(assessRestoreProvenance(42).status, STATUS_UNVERIFIABLE);
  assert.strictEqual(assessRestoreProvenance(undefined).status, STATUS_UNVERIFIABLE);
});

test('畸形入参绝不抛', () => {
  for (const h of [null, undefined, [], {}, 'x', 0, true, { gitCommit: 123 }, { gitCommit: COMMIT, includesUncommitted: 'yes' }]) {
    assert.doesNotThrow(() => assessRestoreProvenance(h));
  }
});

// ── 裁决字段透传 ───────────────────────────────────────────────────────────────
test('裁决透传 captureMode / includesUncommitted / version', () => {
  const v = assessRestoreProvenance({ gitCommit: COMMIT, captureMode: 'working-tree', includesUncommitted: true, dirty: true, version: '0.1.190' });
  assert.strictEqual(v.captureMode, 'working-tree');
  assert.strictEqual(v.includesUncommitted, true);
  assert.strictEqual(v.version, '0.1.190');
});

test('ok 红线：仅 clean 为 true，其余全 false', () => {
  assert.strictEqual(assessRestoreProvenance({ gitCommit: COMMIT, includesUncommitted: false }).ok, true);
  assert.strictEqual(assessRestoreProvenance({ gitCommit: COMMIT, dirty: true }).ok, false);
  assert.strictEqual(assessRestoreProvenance({ gitCommit: COMMIT, captureMode: 'working-tree' }).ok, false);
  assert.strictEqual(assessRestoreProvenance({}).ok, false);
  assert.strictEqual(assessRestoreProvenance(null).ok, false);
});

// ── buildProvenanceBannerLine ──────────────────────────────────────────────────
test('dirty → severity:warn + 提到 git diff 与提交短串', () => {
  const v = assessRestoreProvenance({ gitCommit: COMMIT, dirty: true });
  const b = buildProvenanceBannerLine(v);
  assert.ok(b);
  assert.strictEqual(b.severity, 'warn');
  assert.match(b.line, /未提交增量/);
  assert.match(b.line, /git diff/);
  assert.match(b.line, new RegExp(SHORT));
});

test('clean → severity:info + 提到干净提交', () => {
  const v = assessRestoreProvenance({ gitCommit: COMMIT, includesUncommitted: false });
  const b = buildProvenanceBannerLine(v);
  assert.strictEqual(b.severity, 'info');
  assert.match(b.line, /干净提交/);
});

test('indeterminate → severity:info', () => {
  const v = assessRestoreProvenance({ gitCommit: COMMIT, captureMode: 'working-tree' });
  const b = buildProvenanceBannerLine(v);
  assert.strictEqual(b.severity, 'info');
  assert.match(b.line, /保守/);
});

test('no-provenance → severity:info + 无从溯源', () => {
  const v = assessRestoreProvenance({ dirty: true });
  const b = buildProvenanceBannerLine(v);
  assert.strictEqual(b.severity, 'info');
  assert.match(b.line, /无从.*溯源|未记录/);
});

test('unverifiable → null（横幅字节等价，不打行）', () => {
  const v = assessRestoreProvenance(null);
  assert.strictEqual(buildProvenanceBannerLine(v), null);
});

test('裁决畸形 / null / 非对象 → banner null，绝不抛', () => {
  for (const x of [null, undefined, 'x', 42, [], { status: 'bogus' }, {}]) {
    assert.doesNotThrow(() => buildProvenanceBannerLine(x));
    const r = buildProvenanceBannerLine(x);
    if (x && typeof x === 'object' && !Array.isArray(x) && (x.status === STATUS_DIRTY)) continue;
    // bogus/empty status → severity 'none' → null
    if (!(x && x.status && _BANNER_SEVERITY[x.status] && _BANNER_SEVERITY[x.status] !== 'none')) {
      assert.strictEqual(r, null);
    }
  }
});

test('_BANNER_SEVERITY 映射齐全', () => {
  assert.strictEqual(_BANNER_SEVERITY[STATUS_DIRTY], 'warn');
  assert.strictEqual(_BANNER_SEVERITY[STATUS_CLEAN], 'info');
  assert.strictEqual(_BANNER_SEVERITY[STATUS_INDETERMINATE], 'info');
  assert.strictEqual(_BANNER_SEVERITY[STATUS_NO_PROVENANCE], 'info');
  assert.strictEqual(_BANNER_SEVERITY[STATUS_UNVERIFIABLE], 'none');
});
