'use strict';

/**
 * backupManifest.test.js — manifest 组装/校验/保留策略(纯叶子,零 IO)。
 *
 * 保留策略是这里最值得钉死的部分:它是唯一会**删用户备份**的代码。语义必须是
 * 「超份数 **且** 超天数」的合取,且最新一份永不删 —— 任何把它悄悄改成析取的改动
 * 都会在这些用例上炸掉。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const mf = require('../src/services/backup/backupManifest');

const SHA = 'a'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

/** 造一个结构合法的最小 manifest。 */
function _validManifest(over = {}) {
  return mf.buildManifest({
    id: '20260816T074600Z-abc123',
    createdAt: '2026-08-16T07:46:00.000Z',
    tier: 'core',
    dataHomes: { user: '/home/u/.khy' },
    entries: [mf.makeEntry({ kind: 'file', home: 'user', target: 'home-user/a.json', bytes: 10, sha256: SHA })],
    ...over,
  });
}

/** 由「多少天前」造一个备份集 id(时间从 id 里解析,不看 mtime)。 */
function _setAgedDays(days, nowMs, suffix) {
  const t = new Date(nowMs - days * DAY);
  const id = mf.makeBackupId(t.toISOString(), suffix);
  assert.ok(id, `构造 id 失败: ${days} 天前`);
  return { id, complete: true };
}

describe('备份集 id', () => {
  test('makeBackupId:ISO → 紧凑 UTC 时间戳 + 后缀', () => {
    assert.equal(mf.makeBackupId('2026-08-16T07:46:00.000Z', 'abc123'), '20260816T074600Z-abc123');
    assert.equal(mf.makeBackupId('2026-08-16T07:46:00Z', 'ABC123'), '20260816T074600Z-abc123');
  });

  test('非法输入返回 null 而不是抛', () => {
    for (const [iso, sfx] of [
      ['', 'abc123'],
      ['not-a-date', 'abc123'],
      ['2026-08-16T07:46:00.000Z', 'xyz'], // 非十六进制
      ['2026-08-16T07:46:00.000Z', 'ab'], // 太短
      [undefined, undefined],
    ]) {
      assert.equal(mf.makeBackupId(iso, sfx), null, `${iso} / ${sfx}`);
    }
  });

  test('parseBackupId:从 id 还原时间;这是保留策略的时间真源(不依赖 mtime)', () => {
    const r = mf.parseBackupId('20260816T074600Z-abc123');
    assert.equal(r.ok, true);
    assert.equal(r.suffix, 'abc123');
    assert.equal(new Date(r.timeMs).toISOString(), '2026-08-16T07:46:00.000Z');
  });

  test('parseBackupId 对垃圾输入返回 ok:false', () => {
    for (const bad of ['', 'nope', 'manifest.json', '20260816-abc123', undefined, null, 42, {}]) {
      assert.equal(mf.parseBackupId(bad).ok, false, String(bad));
    }
  });

  test('id 按字典序排序 === 按时间排序(list 依赖这一点)', () => {
    const ids = [
      mf.makeBackupId('2026-01-02T03:04:05.000Z', 'aaaaaa'),
      mf.makeBackupId('2025-12-31T23:59:59.000Z', 'ffffff'),
      mf.makeBackupId('2026-08-16T07:46:00.000Z', '000000'),
    ];
    const byString = ids.slice().sort();
    const byTime = ids.slice().sort((a, b) => mf.parseBackupId(a).timeMs - mf.parseBackupId(b).timeMs);
    assert.deepEqual(byString, byTime);
  });
});

describe('entry 与 manifest 组装', () => {
  test('makeEntry:target 统一 POSIX 分隔符(跨平台恢复的前提)', () => {
    const e = mf.makeEntry({ kind: 'file', target: 'home-user\\sessions\\a.json', bytes: 1, sha256: SHA });
    assert.equal(e.target, 'home-user/sessions/a.json');
  });

  test('makeEntry:未知 kind 落到 file,sha256 转小写,bytes 归一为数字', () => {
    const e = mf.makeEntry({ kind: 'weird', target: 't', bytes: '42', sha256: 'A'.repeat(64) });
    assert.equal(e.kind, 'file');
    assert.equal(e.bytes, 42);
    assert.equal(e.sha256, 'a'.repeat(64));
  });

  test('makeEntry:journalMode 仅在给出时出现(file 项不该带库字段)', () => {
    assert.equal('journalMode' in mf.makeEntry({ kind: 'file', target: 't' }), false);
    assert.equal(mf.makeEntry({ kind: 'sqlite', target: 't', journalMode: 'wal' }).journalMode, 'wal');
  });

  test('buildManifest:totalBytes 由 entries 求和,不信调用方传的值', () => {
    const m = mf.buildManifest({
      id: '20260816T074600Z-abc123',
      createdAt: '2026-08-16T07:46:00.000Z',
      totalBytes: 999999,
      entries: [
        mf.makeEntry({ kind: 'file', target: 'a', bytes: 100, sha256: SHA }),
        mf.makeEntry({ kind: 'sqlite', target: 'b', bytes: 23, sha256: SHA }),
      ],
    });
    assert.equal(m.totalBytes, 123);
  });

  test('buildManifest:containsSecrets 默认 true,只有显式 false 才关掉', () => {
    assert.equal(mf.buildManifest({}).containsSecrets, true);
    assert.equal(mf.buildManifest({ containsSecrets: undefined }).containsSecrets, true);
    assert.equal(mf.buildManifest({ containsSecrets: false }).containsSecrets, false);
  });

  test('buildManifest:数组/对象是拷贝,不是外部引用(manifest 落盘后不该被人改)', () => {
    const entries = [mf.makeEntry({ kind: 'file', target: 'a', bytes: 1, sha256: SHA })];
    const homes = { user: '/x' };
    const m = mf.buildManifest({ entries, dataHomes: homes });
    entries.push(mf.makeEntry({ kind: 'file', target: 'b', bytes: 1, sha256: SHA }));
    homes.user = '/mutated';
    assert.equal(m.entries.length, 1);
    assert.equal(m.dataHomes.user, '/x');
  });
});

describe('manifest 校验', () => {
  test('合法 manifest 通过', () => {
    const r = mf.validateManifest(_validManifest());
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  });

  test('空 entries 不通过 —— 一份不含资产的备份没有恢复价值', () => {
    const r = mf.validateManifest(_validManifest({ entries: [] }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /entries 为空/.test(e)));
  });

  test('sha256 必须是 64 位小写十六进制', () => {
    for (const bad of ['', 'zz', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      const m = _validManifest();
      m.entries[0].sha256 = bad;
      const r = mf.validateManifest(m);
      assert.equal(r.ok, false, `sha256=${bad} 应被拒`);
      assert.ok(r.errors.some((e) => /sha256/.test(e)));
    }
  });

  test('id / createdAt / schemaVersion 缺失或非法都被点名', () => {
    const cases = [
      [{ id: 'garbage' }, /id 非法/],
      [{ createdAt: 'nope' }, /createdAt/],
      [{ schemaVersion: 0 }, /schemaVersion/],
    ];
    for (const [over, re] of cases) {
      const r = mf.validateManifest(_validManifest(over));
      assert.equal(r.ok, false, JSON.stringify(over));
      assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(over)} → ${r.errors.join(';')}`);
    }
  });

  // dataHomes 只能靠「读回磁盘后被改坏」的形态来测:buildManifest 会把 null 归一成 {},
  // 所以组装侧根本产不出这个错。validateManifest 校验的是从磁盘读回的对象,那才是它的
  // 真实输入 —— 手写/被截断的 manifest 才是它要拦的东西。
  test('dataHomes 缺失(读回来的 manifest 被改坏)被点名', () => {
    const m = _validManifest();
    delete m.dataHomes;
    assert.ok(mf.validateManifest(m).errors.some((e) => /dataHomes/.test(e)));

    const m2 = _validManifest();
    m2.dataHomes = null;
    const r2 = mf.validateManifest(m2);
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some((e) => /dataHomes/.test(e)));
  });

  test('buildManifest 把 null/非对象 dataHomes 归一成 {}(组装侧不产生这个错)', () => {
    for (const bad of [null, undefined, 'x', 42]) {
      assert.deepEqual(mf.buildManifest({ dataHomes: bad }).dataHomes, {}, String(bad));
    }
  });

  test('entry.kind 必须在白名单内', () => {
    const m = _validManifest();
    m.entries[0].kind = 'tarball';
    const r = mf.validateManifest(m);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /kind 非法/.test(e)));
  });

  test('非对象输入 → ok:false 而不是抛', () => {
    for (const bad of [null, undefined, 'x', 42, [], true]) {
      const r = mf.validateManifest(bad);
      assert.equal(r.ok, false, String(bad));
      assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
    }
  });

  test('一次报出全部问题,不是遇到第一个就返回(便于一次修完)', () => {
    const m = _validManifest({ id: 'bad', createdAt: 'bad', entries: [] });
    m.dataHomes = null;
    const r = mf.validateManifest(m);
    assert.ok(r.errors.length >= 4, `应报多条,实际:${r.errors.join(' | ')}`);
  });
});

describe('保留策略 planRetention', () => {
  const NOW = Date.parse('2026-08-16T00:00:00.000Z');

  test('超份数但不够老 → 一份都不删', () => {
    const sets = [
      _setAgedDays(0, NOW, 'aaaaaa'),
      _setAgedDays(1, NOW, 'bbbbbb'),
      _setAgedDays(2, NOW, 'cccccc'),
    ];
    const r = mf.planRetention(sets, { keepCount: 1, keepDays: 30, nowMs: NOW });
    assert.deepEqual(r.drop, []);
    assert.equal(r.keep.length, 3);
  });

  test('够老但没超份数 → 一份都不删', () => {
    const sets = [_setAgedDays(100, NOW, 'aaaaaa'), _setAgedDays(200, NOW, 'bbbbbb')];
    const r = mf.planRetention(sets, { keepCount: 10, keepDays: 30, nowMs: NOW });
    assert.deepEqual(r.drop, []);
    assert.equal(r.keep.length, 2);
  });

  test('同时超份数且够老 → 删,且理由把两个条件都写清', () => {
    const sets = [
      _setAgedDays(0, NOW, 'aaaaaa'),
      _setAgedDays(59, NOW, 'bbbbbb'),
      _setAgedDays(60, NOW, 'cccccc'),
    ];
    const r = mf.planRetention(sets, { keepCount: 1, keepDays: 30, nowMs: NOW });
    assert.equal(r.drop.length, 2);
    assert.deepEqual(r.keep, [sets[0].id]);
    for (const d of r.drop) {
      assert.match(d.reason, /保留份数/);
      assert.match(d.reason, /30 天/);
    }
  });

  test('最新一份永不删除,即使它既超份数又超天数(keepCount:0)', () => {
    const sets = [_setAgedDays(365, NOW, 'aaaaaa'), _setAgedDays(400, NOW, 'bbbbbb')];
    const r = mf.planRetention(sets, { keepCount: 0, keepDays: 1, nowMs: NOW });
    assert.deepEqual(r.keep, [sets[0].id], '最新一份必须留着,否则用户在裸奔');
    assert.equal(r.drop.length, 1);
  });

  test('缺 .complete 的残破备份优先清理,不受份数/天数保护', () => {
    const fresh = _setAgedDays(0, NOW, 'aaaaaa');
    const brokenFresh = { ..._setAgedDays(0, NOW, 'bbbbbb'), complete: false };
    const r = mf.planRetention([fresh, brokenFresh], { keepCount: 10, keepDays: 3650, nowMs: NOW });
    assert.deepEqual(r.keep, [fresh.id]);
    assert.equal(r.drop.length, 1);
    assert.equal(r.drop[0].id, brokenFresh.id);
    assert.match(r.drop[0].reason, /\.complete/);
  });

  test('残破备份不占份数配额(否则会把可用备份挤掉)', () => {
    const good = [_setAgedDays(0, NOW, 'aaaaaa'), _setAgedDays(40, NOW, 'bbbbbb')];
    const broken = [
      { ..._setAgedDays(1, NOW, 'cccccc'), complete: false },
      { ..._setAgedDays(2, NOW, 'dddddd'), complete: false },
      { ..._setAgedDays(3, NOW, 'eeeeee'), complete: false },
    ];
    const r = mf.planRetention([...good, ...broken], { keepCount: 2, keepDays: 30, nowMs: NOW });
    assert.deepEqual(r.keep.sort(), good.map((s) => s.id).sort(), '两份可用备份都应留下');
    assert.equal(r.drop.length, 3);
  });

  test('输入乱七八糟时不抛、不误删', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      const r = mf.planRetention(bad, { keepCount: 1, keepDays: 1, nowMs: NOW });
      assert.ok(Array.isArray(r.keep) && Array.isArray(r.drop), String(bad));
      assert.deepEqual(r.drop, [], '无法判定时不该删任何东西');
    }
    // id 不可解析的目录:没有时间可判,不能当成「很老」而删掉
    const r2 = mf.planRetention([{ id: 'not-an-id', complete: true }], {
      keepCount: 0,
      keepDays: 0,
      nowMs: NOW,
    });
    assert.deepEqual(r2.drop, []);
  });

  test('nowMs 缺失 → 不做天数判定,一份都不删(时间未知时保守)', () => {
    const sets = [
      _setAgedDays(0, NOW, 'aaaaaa'),
      _setAgedDays(999, NOW, 'bbbbbb'),
      _setAgedDays(1000, NOW, 'cccccc'),
    ];
    const r = mf.planRetention(sets, { keepCount: 1, keepDays: 30 });
    assert.deepEqual(r.drop, []);
  });

  test('keep + drop 是输入的完整划分(不丢集、不重算)', () => {
    const sets = [
      _setAgedDays(0, NOW, 'aaaaaa'),
      _setAgedDays(50, NOW, 'bbbbbb'),
      _setAgedDays(60, NOW, 'cccccc'),
      { ..._setAgedDays(70, NOW, 'dddddd'), complete: false },
    ];
    const r = mf.planRetention(sets, { keepCount: 1, keepDays: 30, nowMs: NOW });
    const seen = [...r.keep, ...r.drop.map((d) => d.id)].sort();
    assert.deepEqual(seen, sets.map((s) => s.id).sort());
    assert.equal(new Set(seen).size, sets.length, '不能有 id 同时出现在两边');
  });
});
