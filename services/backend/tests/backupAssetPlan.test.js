'use strict';

/**
 * backupAssetPlan.test.js — 备份资产规则(纯叶子,零 IO)。
 *
 * 这些断言存在的意义是**把口头约定钉成回归**:F1 的「.db 绝不进文件遍历」、
 * core/full 的分级边界、以及「默认收录、逐条排除」的方向性。任何人日后放宽某条规则,
 * 都会在这里先撞墙,而不是等到用户恢复数据那一刻才发现漏备。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const plan = require('../src/services/backup/backupAssetPlan');

describe('F1:SQLite 一律排除在文件遍历之外', () => {
  test('.db / .sqlite / .sqlite3 及其 -wal/-shm/-journal 全部排除,理由为 sqlite:hot-copy-only', () => {
    const names = [
      'khy-quant.db',
      'taskboard.db',
      'sessions.db',
      'sessions.db-wal',
      'sessions.db-shm',
      'sessions.db-journal',
      'anything.sqlite',
      'anything.sqlite3',
      'anything.sqlite-wal',
      'UPPER.DB',
      'Mixed.Db-WAL',
    ];
    for (const n of names) {
      for (const tier of plan.TIERS) {
        const r = plan.classifyFile(n, tier);
        assert.equal(r.include, false, `${n} @${tier} 必须排除`);
        assert.equal(r.reason, 'sqlite:hot-copy-only', `${n} 的排除理由必须指向热备单点`);
      }
    }
  });

  test('full 级也不放行 —— 分级不能成为绕过 F1 的后门', () => {
    assert.equal(plan.classifyFile('khy-quant.db', plan.TIER_FULL).include, false);
    assert.equal(plan.classifyFile('taskboard.db-wal', plan.TIER_FULL).include, false);
  });

  test('需要热备的库清单里的每一项,其文件名都会被文件遍历排除(两条规则互相咬合)', () => {
    const path = require('path');
    assert.ok(plan.SQLITE_ASSETS.length > 0, '清单不能为空');
    for (const a of plan.SQLITE_ASSETS) {
      const base = path.basename(a.rel);
      assert.equal(
        plan.classifyFile(base, plan.TIER_FULL).include,
        false,
        `${base} 既在热备清单里,就必须被文件遍历排除,否则会被拷两次(其中一次是危险的裸拷)`
      );
    }
  });

  test('普通 json/jsonl/文本不受牵连(排除规则不能过宽)', () => {
    for (const n of ['api_keys.json', 'goals.json', 'sessions.jsonl', 'notes.md', 'dbconfig.json']) {
      assert.equal(plan.classifyFile(n, plan.TIER_CORE).include, true, n);
    }
  });
});

describe('分级 core / full', () => {
  test('normalizeTier:未知值一律落到 core(安全默认)', () => {
    assert.equal(plan.normalizeTier('core'), plan.TIER_CORE);
    assert.equal(plan.normalizeTier('FULL'), plan.TIER_FULL);
    assert.equal(plan.normalizeTier('  full  '), plan.TIER_FULL);
    for (const bad of [undefined, null, '', 'nope', 'partial', 0, {}, []]) {
      assert.equal(plan.normalizeTier(bad), plan.TIER_CORE, String(bad));
    }
  });

  test('tierIncludes:full 覆盖 core,core 不覆盖 full', () => {
    assert.equal(plan.tierIncludes(plan.TIER_FULL, plan.TIER_CORE), true);
    assert.equal(plan.tierIncludes(plan.TIER_FULL, plan.TIER_FULL), true);
    assert.equal(plan.tierIncludes(plan.TIER_CORE, plan.TIER_CORE), true);
    assert.equal(plan.tierIncludes(plan.TIER_CORE, plan.TIER_FULL), false);
  });

  test('历史流水目录:core 剪掉、full 收录,且理由非空', () => {
    for (const name of Object.keys(plan.FULL_ONLY_DIR_REASONS)) {
      const core = plan.classifyDir(name, plan.TIER_CORE);
      assert.equal(core.prune, true, `${name} 在 core 级应剪掉`);
      assert.ok(core.reason.length > 0, `${name} 必须给出理由`);
      assert.equal(plan.classifyDir(name, plan.TIER_FULL).prune, false, `${name} 在 full 级应收录`);
    }
  });

  test('审计流水文件 audit.jsonl 同理', () => {
    assert.equal(plan.classifyFile('audit.jsonl', plan.TIER_CORE).include, false);
    assert.equal(plan.classifyFile('audit.jsonl', plan.TIER_FULL).include, true);
  });

  test('硬排除目录在任何分级都剪掉', () => {
    for (const name of Object.keys(plan.EXCLUDED_DIR_REASONS)) {
      for (const tier of plan.TIERS) {
        assert.equal(plan.classifyDir(name, tier).prune, true, `${name} @${tier}`);
      }
    }
  });

  test('backups 目录必被剪掉(防止备份把上一次备份卷进去,体积指数爆炸)', () => {
    assert.equal(plan.classifyDir('backups', plan.TIER_FULL).prune, true);
  });
});

describe('缓存 / 派生物 / 别的域', () => {
  test('确切文件名排除清单逐条生效,且每条都有理由', () => {
    for (const [name, reason] of Object.entries(plan.EXCLUDED_FILE_REASONS)) {
      const r = plan.classifyFile(name, plan.TIER_FULL);
      assert.equal(r.include, false, name);
      assert.equal(r.reason, reason, name);
    }
  });

  test('安装台账归 uninstall 域,不由备份接管(域边界)', () => {
    const r = plan.classifyFile('.install-ledger.jsonl', plan.TIER_FULL);
    assert.equal(r.include, false);
    assert.match(r.reason, /uninstall/);
  });

  test('daemon.pid 不备份(恢复到别的机器上 PID 是错的)', () => {
    assert.equal(plan.classifyFile('daemon.pid', plan.TIER_FULL).include, false);
    assert.equal(plan.classifyFile('whatever.pid', plan.TIER_FULL).include, false);
  });

  test('日志、锁、原子写/恢复的临时残留都排除', () => {
    for (const n of [
      'khy.log',
      'a.lock',
      '.tmp-123',
      'state.json.tmp-4567',
      '.restore-tmp-999',
    ]) {
      assert.equal(plan.classifyFile(n, plan.TIER_FULL).include, false, n);
    }
  });
});

describe('幽灵 *.json 目录(dataHome 误用的产物)', () => {
  test('isPhantomJsonDir 只认目录名以 .json 结尾', () => {
    assert.equal(plan.isPhantomJsonDir('custom_providers.json'), true);
    assert.equal(plan.isPhantomJsonDir('api_keys.JSON'), true);
    assert.equal(plan.isPhantomJsonDir('sessions'), false);
    assert.equal(plan.isPhantomJsonDir(''), false);
    assert.equal(plan.isPhantomJsonDir(undefined), false);
  });

  test('作为目录被剪掉,但同名文件仍然照常收录 —— 两者不能混为一谈', () => {
    const d = plan.classifyDir('api_keys.json', plan.TIER_FULL);
    assert.equal(d.prune, true);
    assert.match(d.reason, /幽灵/);
    assert.equal(plan.classifyFile('api_keys.json', plan.TIER_FULL).include, true);
  });
});

describe('健壮性:纯叶子契约', () => {
  test('任何输入都不抛,且返回形状固定', () => {
    for (const bad of [undefined, null, '', '.', '..', 0, {}, [], NaN, true]) {
      const d = plan.classifyDir(bad, undefined);
      assert.equal(typeof d.prune, 'boolean');
      assert.equal(typeof d.reason, 'string');
      const f = plan.classifyFile(bad, 'nonsense');
      assert.equal(typeof f.include, 'boolean');
      assert.equal(typeof f.reason, 'string');
    }
  });

  test('. 与 .. 一定剪掉(遍历安全)', () => {
    assert.equal(plan.classifyDir('.', plan.TIER_FULL).prune, true);
    assert.equal(plan.classifyDir('..', plan.TIER_FULL).prune, true);
  });

  test('收录时 reason 为空串、排除时 reason 非空(输出契约)', () => {
    assert.equal(plan.classifyDir('sessions', plan.TIER_CORE).reason, '');
    assert.equal(plan.classifyFile('goals.json', plan.TIER_CORE).reason, '');
    assert.ok(plan.classifyDir('cache', plan.TIER_CORE).reason.length > 0);
    assert.ok(plan.classifyFile('x.db', plan.TIER_CORE).reason.length > 0);
  });

  test('导出的常量集合都是冻结的(规则不可被运行期偷改)', () => {
    for (const [name, obj] of [
      ['TIERS', plan.TIERS],
      ['HOMES', plan.HOMES],
      ['SQLITE_ASSETS', plan.SQLITE_ASSETS],
      ['EXCLUDED_DIR_REASONS', plan.EXCLUDED_DIR_REASONS],
      ['FULL_ONLY_DIR_REASONS', plan.FULL_ONLY_DIR_REASONS],
      ['EXCLUDED_FILE_REASONS', plan.EXCLUDED_FILE_REASONS],
      ['EXCLUDED_FILE_PATTERNS', plan.EXCLUDED_FILE_PATTERNS],
    ]) {
      assert.equal(Object.isFrozen(obj), true, name);
    }
  });
});

describe('恢复提示', () => {
  test('至少覆盖三件事:重建搜索索引、删旧 WAL、丢弃完整性清单', () => {
    const hints = plan.restoreHints();
    const kinds = hints.map((h) => h.kind);
    assert.ok(kinds.includes('reindex'), '必须提示重建 sessions.db 索引');
    assert.ok(kinds.includes('drop-wal'), '必须提示删除旧 WAL/SHM');
    assert.ok(kinds.includes('discard'), '必须提示丢弃派生物');
    for (const h of hints) {
      assert.ok(h.target && h.note, `${h.kind} 需要 target 与 note`);
    }
  });

  test('sessions.db 出现在提示里而不在备份清单里(它是可重建的索引)', () => {
    const path = require('path');
    const inAssets = plan.SQLITE_ASSETS.some((a) => path.basename(a.rel) === 'sessions.db');
    assert.equal(inAssets, false, 'sessions.db 是会话 JSON 的派生索引,不应进备份集');
    assert.ok(
      plan.restoreHints().some((h) => h.target === 'sessions.db' && h.kind === 'reindex'),
      '既然不备份,就必须有重建路径'
    );
  });
});
