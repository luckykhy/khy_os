'use strict';

/**
 * backupColdExport.test.js — 冷数据封存(W8)的机器化验收。
 *
 * 冷导出把「只增不改」的历史流水(audit / receipts / events …)压成单个 .jsonl.gz,
 * 代替逐文件复制。这条路径**改变了备份集的形状**,所以验收标准比一般优化严:任何
 * 一条「进了归档就不再复制」的判定出错,都是静默丢数据 —— manifest 上看起来一切
 * 正常,只有真去恢复的那天才会发现。
 *
 * 因此这里盯的是四类事实:
 *   1. **不丢**:归档 + 逐文件复制合起来必须覆盖备份时刻的全部数据;
 *   2. **不重**:同一份数据不能既进归档又被逐文件复制(体积正是要治的东西);
 *   3. **F1 边界**:冷导出器绝不碰 .db —— 白名单而非黑名单;
 *   4. **契约兼容**:默认关闭、core 级不生效、旧 kind 一条没动、目标路径不可穿越。
 *
 * node:test(NOT jest):主体是 async,jest 会在 async body 跑完前拆环境
 * (见 jest.config.js 对 `require('node:test')` 套件的自动忽略)。运行:
 *   node --test tests/backupColdExport.test.js
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const backupService = require('../src/services/backup/backupService');
const restoreService = require('../src/services/backup/restoreService');
const cold = require('../src/services/backup/coldExportService');
const plan = require('../src/services/backup/backupAssetPlan');
const mf = require('../src/services/backup/backupManifest');
const { BACKUP, COLD_EXPORT } = require('../src/constants/serviceDefaults');

const NL = String.fromCharCode(10);

let tmpRoot;
let homeDir;
let backupRoot;
/** 注入的家目录:全部 IO 关在临时目录内,绝不碰真实 ~/.khy。 */
let HOMES;

/** 固定「现在」,让窗口判定与机器时钟无关。 */
const NOW = Date.parse('2026-08-19T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
/** 稳稳落在冷窗口外 / 内,不贴边界 —— 边界语义由 withinColdWindow 的单测负责。 */
const COLD_AGE = COLD_EXPORT.WINDOW_DAYS + 60;
const HOT_AGE = 1;

function drillOpts(extra = {}) {
  return { root: backupRoot, homes: HOMES, nowMs: NOW, ...extra };
}

/** 写一份 JSONL 流水,返回绝对路径。 */
function writeFlow(rel, records) {
  const abs = path.join(homeDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, records.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf-8');
  return abs;
}

/** 导出器的公共入参,单测里只覆盖真正关心的那几项。 */
function exportSpec(extra = {}) {
  return {
    sourceDir: path.join(homeDir, 'audit'),
    setDir: path.join(tmpRoot, 'set'),
    role: plan.HOME_USER,
    dirName: 'audit',
    nowMs: NOW,
    windowDays: COLD_EXPORT.WINDOW_DAYS,
    dirMode: BACKUP.DIR_MODE,
    fileMode: BACKUP.FILE_MODE,
    ...extra,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cold-export-'));
  homeDir = path.join(tmpRoot, 'home');
  backupRoot = path.join(tmpRoot, 'backups');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'set'), { recursive: true });
  HOMES = [{ role: plan.HOME_USER, dir: homeDir }];
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发文件占用,不影响断言结论 */
  }
});

// ── 导出器本身(纯 IO 层,不经 backupService)──────────────────────────────

describe('exportColdDir', () => {
  test('全冷的文件整份进归档,并报告为已覆盖', () => {
    writeFlow('audit/old.jsonl', [
      { ts: iso(COLD_AGE), act: 'a' },
      { ts: iso(COLD_AGE + 1), act: 'b' },
    ]);

    const res = cold.exportColdDir(exportSpec());

    assert.equal(res.ok, true);
    assert.equal(res.exported, true);
    assert.equal(res.records, 2);
    assert.deepEqual(res.coveredFiles, ['old.jsonl']);
    assert.ok(res.bytes > 0, 'gzip 归档不应为空');
    assert.match(res.sha256, /^[0-9a-f]{64}$/);
    assert.equal(res.target, `${COLD_EXPORT.SUBDIR}/${plan.HOME_USER}-audit.jsonl.gz`);

    // 真的是 gzip:magic 必须是 1f 8b。sha256 对得上不代表内容能解压。
    const buf = fs.readFileSync(path.join(tmpRoot, 'set', res.target));
    assert.equal(buf[0], 0x1f);
    assert.equal(buf[1], 0x8b);
  });

  test('掺了一条热记录的文件整份不进归档 —— 半份归档会在恢复时覆盖完整副本', () => {
    writeFlow('audit/mixed.jsonl', [
      { ts: iso(COLD_AGE), act: 'cold' },
      { ts: iso(HOT_AGE), act: 'hot' },
    ]);

    const res = cold.exportColdDir(exportSpec());

    assert.equal(res.ok, true);
    // 整份跳过:连那条冷记录也不收。expandColdArchive 按 _source 重建**整个文件**,
    // 收一半就意味着恢复时把 mixed.jsonl 写成只剩冷记录的版本,而 kind='file'
    // 那份完整副本可能已经先落盘了 —— 谁后跑谁赢,输的那次是完整数据。
    assert.equal(res.exported, false, '不应产出归档');
    assert.equal(res.records, 0);
    assert.deepEqual(res.coveredFiles, []);
    assert.equal(res.skippedRecent, 1);
  });

  test('零记录时不产文件 —— 一条恢复不出任何东西的 entry 比没有更容易骗人', () => {
    writeFlow('audit/hot.jsonl', [{ ts: iso(HOT_AGE), act: 'now' }]);

    const res = cold.exportColdDir(exportSpec());

    assert.equal(res.ok, true);
    assert.equal(res.exported, false);
    assert.equal(res.target, '');
    assert.deepEqual(res.coveredFiles, [], '没产文件就不能声称覆盖了任何东西');
    assert.equal(fs.existsSync(path.join(tmpRoot, 'set', COLD_EXPORT.SUBDIR)), false);
  });

  test('绝不读 .db(F1 的边界):白名单排除库文件与顶层数组 .json', () => {
    writeFlow('audit/ok.jsonl', [{ ts: iso(COLD_AGE), act: 'a' }]);
    // 库文件诱饵:按文件遍历拷走一个正在写的库,得到的是缺了大半已提交事务的残库,
    // 而它看起来完全正常。库一律走 sqliteHotCopy 的 VACUUM INTO。
    fs.writeFileSync(path.join(homeDir, 'audit', 'live.db'), 'SQLite format 3');
    fs.writeFileSync(path.join(homeDir, 'audit', 'live.db-wal'), 'wal');
    // 顶层数组 .json:每次写都整份重写,是状态文件不是流水;而且拆开拼回来会变成
    // JSONL,文件名还叫 .json 而内容已经换了形状。
    fs.writeFileSync(
      path.join(homeDir, 'audit', 'state.json'),
      JSON.stringify([{ ts: iso(COLD_AGE) }]),
      'utf-8'
    );

    assert.equal(cold._isExportableFile('live.db'), false);
    assert.equal(cold._isExportableFile('live.db-wal'), false);
    assert.equal(cold._isExportableFile('state.json'), false);
    assert.equal(cold._isExportableFile('app.log'), false);
    assert.equal(cold._isExportableFile('a.jsonl'), true);
    assert.equal(cold._isExportableFile('a.ndjson'), true);

    assert.deepEqual(cold._listFlowFiles(path.join(homeDir, 'audit')), ['ok.jsonl']);

    const res = cold.exportColdDir(exportSpec());
    assert.deepEqual(res.coveredFiles, ['ok.jsonl']);
    const text = zlib.gunzipSync(fs.readFileSync(path.join(tmpRoot, 'set', res.target))).toString('utf-8');
    assert.equal(/SQLite format/.test(text), false, '归档里绝不能出现库文件的任何字节');
  });

  test('文件列表按相对路径排序 —— 同一份数据两次导出的 sha256 才可比', () => {
    for (const name of ['c.jsonl', 'a.jsonl', 'b.jsonl']) {
      writeFlow(`audit/${name}`, [{ ts: iso(COLD_AGE) }]);
    }
    writeFlow('audit/nested/z.jsonl', [{ ts: iso(COLD_AGE) }]);
    assert.deepEqual(cold._listFlowFiles(path.join(homeDir, 'audit')), [
      'a.jsonl',
      'b.jsonl',
      'c.jsonl',
      'nested/z.jsonl',
    ]);
  });

  test('中断不留半个归档:目录里只有最终文件,没有 .tmp 残渣', () => {
    writeFlow('audit/a.jsonl', [{ ts: iso(COLD_AGE) }]);
    const res = cold.exportColdDir(exportSpec());
    assert.equal(res.exported, true);
    const files = fs.readdirSync(path.join(tmpRoot, 'set', COLD_EXPORT.SUBDIR));
    assert.deepEqual(files, [`${plan.HOME_USER}-audit.jsonl.gz`]);
  });

  test('目录不存在不是错误,拒绝覆盖已有归档才是', () => {
    const missing = cold.exportColdDir(exportSpec({ sourceDir: path.join(homeDir, 'nope') }));
    assert.equal(missing.ok, true, '该功能可能从未被使用过,目录不存在很正常');
    assert.equal(missing.exported, false);
    assert.equal(missing.error, null);

    writeFlow('audit/a.jsonl', [{ ts: iso(COLD_AGE) }]);
    assert.equal(cold.exportColdDir(exportSpec()).exported, true);
    const second = cold.exportColdDir(exportSpec());
    assert.equal(second.ok, false);
    assert.match(second.error, /拒绝覆盖/);
  });
});

// ── 记录保真 ─────────────────────────────────────────────────────────────

describe('记录保真', () => {
  test('解析不了的行原样保留,摊回后逐字节一致 —— 归档是归档,不是清洗', () => {
    const abs = path.join(homeDir, 'audit', 'broken.jsonl');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // 一条坏行 + 一条无时间戳的记录。两者都必须活下来:悄悄滤掉一条格式意外的
    // 审计记录,和删除证据没有区别,而且没有任何人会发现。
    const original = `NOT JSON AT ALL${NL}${JSON.stringify({ no: 'timestamp' })}${NL}`;
    fs.writeFileSync(abs, original, 'utf-8');

    const res = cold.exportColdDir(exportSpec());
    assert.equal(res.records, 2, '读不懂时间戳的记录一律留下,绝不因为读不懂就丢掉');

    const dest = path.join(tmpRoot, 'restored');
    const exp = cold.expandColdArchive({
      archiveAbs: path.join(tmpRoot, 'set', res.target),
      destDir: dest,
      fileMode: BACKUP.FILE_MODE,
    });
    assert.equal(exp.ok, true);
    assert.deepEqual(exp.skipped, []);
    assert.equal(
      fs.readFileSync(path.join(dest, 'broken.jsonl'), 'utf-8'),
      original,
      '_raw 必须按原文写回,不能套一层 {"_raw":...}'
    );
  });

  test('嵌套目录结构在摊回时被还原', () => {
    writeFlow('audit/2026/08/a.jsonl', [{ ts: iso(COLD_AGE), act: 'nested' }]);
    const res = cold.exportColdDir(exportSpec());
    assert.deepEqual(res.coveredFiles, ['2026/08/a.jsonl']);

    const dest = path.join(tmpRoot, 'restored');
    const exp = cold.expandColdArchive({ archiveAbs: path.join(tmpRoot, 'set', res.target), destDir: dest });
    assert.equal(exp.files, 1);
    assert.equal(
      fs.readFileSync(path.join(dest, '2026', '08', 'a.jsonl'), 'utf-8'),
      fs.readFileSync(path.join(homeDir, 'audit', '2026', '08', 'a.jsonl'), 'utf-8')
    );
  });

  test('_source 路径穿越被拒绝 —— 归档可能来自别处,不能盲信它写的相对路径', () => {
    const archive = path.join(tmpRoot, 'set', COLD_EXPORT.SUBDIR, 'user-audit.jsonl.gz');
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const evil =
      JSON.stringify({ _source: '../../../evil.jsonl', pwned: true }) + NL +
      JSON.stringify({ _source: 'ok.jsonl', fine: true }) + NL;
    fs.writeFileSync(archive, zlib.gzipSync(Buffer.from(evil, 'utf-8')));

    const dest = path.join(tmpRoot, 'restored', 'audit');
    const exp = cold.expandColdArchive({ archiveAbs: archive, destDir: dest });

    assert.equal(exp.ok, true);
    assert.equal(exp.files, 1, '只应写回合法的那个文件');
    assert.equal(exp.skipped.length, 1);
    assert.match(exp.skipped[0].reason, /非法或缺失/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'restored', 'evil.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dest, 'ok.jsonl')), true);
  });
});

// ── manifest 契约 ────────────────────────────────────────────────────────

describe('manifest 契约', () => {
  test('cold-export 是追加的 kind,既有三条分支一条都没动', () => {
    assert.ok(mf.ENTRY_KINDS.includes('cold-export'));
    for (const k of ['sqlite', 'pgdump', 'file']) {
      assert.ok(mf.ENTRY_KINDS.includes(k), `${k} 必须仍在`);
    }
    // 冷归档专属字段不该给其它 entry 添噪。
    const fileEntry = mf.makeEntry({ kind: 'file', target: 'home-user/a.json', bytes: 1, sha256: 'ab' });
    assert.equal('records' in fileEntry, false);
    assert.equal('compression' in fileEntry, false);
    assert.equal('window' in fileEntry, false);
  });

  test('空归档是契约违反而不是空数据:records=0 必须校验失败', () => {
    const base = {
      schemaVersion: BACKUP.MANIFEST_SCHEMA_VERSION,
      id: mf.makeBackupId(new Date(NOW).toISOString(), 'abcdef'),
      createdAt: new Date(NOW).toISOString(),
      tier: plan.TIER_FULL,
      dataHomes: { [plan.HOME_USER]: homeDir },
      excluded: [],
    };

    const bad = mf.validateManifest(
      mf.buildManifest({
        ...base,
        entries: [
          mf.makeEntry({
            kind: 'cold-export',
            home: plan.HOME_USER,
            target: `${COLD_EXPORT.SUBDIR}/user-audit.jsonl.gz`,
            bytes: 0,
            sha256: 'a'.repeat(64),
            records: 0,
            sourceFiles: 0,
          }),
        ],
      })
    );
    assert.equal(bad.ok, false);
    // 导出器在 records===0 时根本不写文件,所以 manifest 里出现这条只可能是记账错了。
    // 放行它等于让 verify 通过一份恢复不出任何东西的归档。
    assert.ok(bad.errors.some((e) => /records/.test(e)), `应报 records 非法: ${bad.errors}`);
    assert.ok(bad.errors.some((e) => /bytes/.test(e)), `应报 bytes 为 0: ${bad.errors}`);

    const good = mf.validateManifest(
      mf.buildManifest({
        ...base,
        entries: [
          mf.makeEntry({
            kind: 'cold-export',
            home: plan.HOME_USER,
            target: `${COLD_EXPORT.SUBDIR}/user-audit.jsonl.gz`,
            bytes: 128,
            sha256: 'a'.repeat(64),
            records: 3,
            sourceFiles: 1,
            window: { days: COLD_EXPORT.WINDOW_DAYS, untilMs: NOW },
          }),
        ],
      })
    );
    assert.deepEqual(good.errors, []);
    assert.equal(good.ok, true);
  });
});

// ── 与 backupService 的接线 ──────────────────────────────────────────────

describe('backupService 接线', () => {
  test('默认关闭:不开就不该出现任何 cold-export entry', async () => {
    writeFlow('audit/old.jsonl', [{ ts: iso(COLD_AGE), act: 'a' }]);
    const created = await backupService.createBackup(drillOpts({ tier: plan.TIER_FULL }));
    assert.equal(created.ok, true, created.error);
    assert.equal(
      created.manifest.entries.some((e) => e.kind === 'cold-export'),
      false,
      '它改变的是备份集的形状,必须显式开启'
    );
    // 关着的时候流水照常逐文件收 —— 关掉一条优化路径不该让数据少收。
    assert.ok(created.manifest.entries.some((e) => e.kind === 'file' && /audit\//.test(e.target)));
  });

  test('core 级不生效 —— 否则「core = 权威且体积可控」的承诺就反了', async () => {
    writeFlow('audit/old.jsonl', [{ ts: iso(COLD_AGE), act: 'a' }]);
    // core 级会把 audit/ 整个剪掉。备份集必须仍有至少一份 core 资产,否则失败的
    // 是「空备份没有恢复价值」那条校验,而不是这里要证的事。
    fs.writeFileSync(path.join(homeDir, 'permissions.json'), JSON.stringify({ allow: ['ls'] }), 'utf-8');
    const created = await backupService.createBackup(
      drillOpts({ tier: plan.TIER_CORE, includeCold: true })
    );
    assert.equal(created.ok, true, created.error);
    assert.equal(created.manifest.entries.some((e) => e.kind === 'cold-export'), false);
    // core 本来就把 audit/ 整个剪掉,冷导出在这一级开着也不该把它捡回来。
    assert.equal(created.manifest.entries.some((e) => /audit/.test(e.target)), false);
  });

  test('开启后:归档与逐文件复制不重叠,合起来覆盖全部数据', async () => {
    writeFlow('audit/cold-a.jsonl', [{ ts: iso(COLD_AGE), act: 'a' }]);
    writeFlow('audit/cold-b.jsonl', [{ ts: iso(COLD_AGE + 5), act: 'b' }]);
    writeFlow('audit/mixed.jsonl', [{ ts: iso(COLD_AGE), act: 'c' }, { ts: iso(HOT_AGE), act: 'd' }]);
    fs.writeFileSync(path.join(homeDir, 'permissions.json'), JSON.stringify({ allow: ['ls'] }), 'utf-8');

    const created = await backupService.createBackup(
      drillOpts({ tier: plan.TIER_FULL, includeCold: true })
    );
    assert.equal(created.ok, true, created.error);

    const coldEntries = created.manifest.entries.filter((e) => e.kind === 'cold-export');
    assert.equal(coldEntries.length, 1);
    assert.equal(coldEntries[0].records, 2, '两个全冷文件各一条');
    assert.equal(coldEntries[0].compression, 'gzip');
    assert.equal(coldEntries[0].window.days, COLD_EXPORT.WINDOW_DAYS);

    const fileTargets = created.manifest.entries
      .filter((e) => e.kind === 'file')
      .map((e) => e.target);

    // 不重:已整份归档的两个文件不能再出现在逐文件复制里。
    assert.equal(fileTargets.some((t) => /cold-a\.jsonl$/.test(t)), false);
    assert.equal(fileTargets.some((t) => /cold-b\.jsonl$/.test(t)), false);
    // 不丢:掺了热记录的文件必须仍被逐文件收走。
    assert.ok(fileTargets.some((t) => /mixed\.jsonl$/.test(t)), 'mixed.jsonl 必须照常复制');
    assert.ok(fileTargets.some((t) => /permissions\.json$/.test(t)));

    // 被折叠的文件要在 excluded 里留下解释 —— manifest 必须能说清每一个「没收」的文件。
    const reasons = created.manifest.excluded
      .filter((x) => /cold-a\.jsonl|cold-b\.jsonl/.test(x.path))
      .map((x) => x.reason);
    assert.equal(reasons.length, 2);
    for (const r of reasons) assert.match(r, /冷归档/);
  });

  test('归档真的落在备份集里,sha256/字节数与 manifest 一致,verify 认这条新 kind', async () => {
    writeFlow('audit/old.jsonl', [{ ts: iso(COLD_AGE), act: 'a' }]);
    const created = await backupService.createBackup(
      drillOpts({ tier: plan.TIER_FULL, includeCold: true })
    );
    assert.equal(created.ok, true, created.error);

    const entry = created.manifest.entries.find((e) => e.kind === 'cold-export');
    const abs = path.join(created.dir, entry.target.split('/').join(path.sep));
    assert.ok(fs.existsSync(abs), '归档必须真的在盘上');
    assert.equal(fs.statSync(abs).size, entry.bytes);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
      entry.sha256
    );

    const verified = backupService.verifyBackup(created.id, drillOpts());
    assert.deepEqual(verified.problems, []);
    assert.equal(verified.ok, true);
    // .complete 是「这份可用」的唯一判据,必须在 manifest 之后写。
    assert.ok(fs.existsSync(path.join(created.dir, BACKUP.COMPLETE_MARKER)));
  });
});

// ── 全流程:备份 → 破坏 → 恢复 ────────────────────────────────────────────

describe('冷归档全流程演练', () => {
  test('被折叠的流水在恢复后逐字节回到原样', async () => {
    const coldA = writeFlow('audit/cold-a.jsonl', [
      { ts: iso(COLD_AGE), act: 'a1' },
      { ts: iso(COLD_AGE + 1), act: 'a2' },
    ]);
    const mixed = writeFlow('audit/mixed.jsonl', [
      { ts: iso(COLD_AGE), act: 'c' },
      { ts: iso(HOT_AGE), act: 'd' },
    ]);
    fs.writeFileSync(path.join(homeDir, 'permissions.json'), JSON.stringify({ allow: ['ls'] }), 'utf-8');

    const beforeColdA = fs.readFileSync(coldA, 'utf-8');
    const beforeMixed = fs.readFileSync(mixed, 'utf-8');

    const created = await backupService.createBackup(
      drillOpts({ tier: plan.TIER_FULL, includeCold: true })
    );
    assert.equal(created.ok, true, created.error);

    // ── 破坏:删掉被折叠的,改掉没被折叠的 ──
    fs.rmSync(coldA);
    fs.writeFileSync(mixed, JSON.stringify({ ts: iso(0), act: 'tampered' }) + NL, 'utf-8');

    const restored = await restoreService.restoreBackup(
      created.id,
      drillOpts({ ignoreDaemon: true, skipPreBackup: true, skipReindex: true })
    );
    assert.deepEqual(restored.blockers, []);
    assert.equal(restored.error, null);
    assert.equal(restored.ok, true);
    assert.deepEqual(restored.failed, []);
    assert.ok(restored.restored.cold >= 1, '冷归档必须被摊回,否则就是默认丢数据');

    assert.equal(fs.readFileSync(coldA, 'utf-8'), beforeColdA, '折叠过的文件必须逐字节回来');
    assert.equal(fs.readFileSync(mixed, 'utf-8'), beforeMixed, '没折叠的文件走 kind=file 回来');
  });

  test('默认 kinds 含 cold-export —— 默认不恢复就是默认丢数据', async () => {
    writeFlow('audit/old.jsonl', [{ ts: iso(COLD_AGE), act: 'a' }]);
    const created = await backupService.createBackup(
      drillOpts({ tier: plan.TIER_FULL, includeCold: true })
    );
    assert.equal(created.ok, true, created.error);

    // 不传 kinds:走默认集合。dry-run 已经把落点算完,足以证明它没被跳过。
    const dry = await restoreService.restoreBackup(
      created.id,
      drillOpts({ ignoreDaemon: true, dryRun: true })
    );
    assert.equal(dry.ok, true);
    assert.equal(
      dry.skipped.some((s) => /未选中 cold-export/.test(s.reason)),
      false,
      'cold-export 必须在默认 kinds 里'
    );
  });

  test('归档目录名不在冷导出清单中时拒绝落点 —— 否则能往家目录任意写', () => {
    const homeByRole = { [plan.HOME_USER]: homeDir };

    // 一个 target 写着 `user-.ssh.jsonl.gz` 的归档,若被信任就能覆盖家目录里的任意目录。
    const evil = restoreService.resolveEntryDestination(
      { kind: 'cold-export', home: plan.HOME_USER, target: `${COLD_EXPORT.SUBDIR}/user-.ssh.jsonl.gz` },
      homeByRole
    );
    assert.equal(evil.ok, false);
    assert.match(evil.reason, /不在冷导出清单/);

    const wrongRole = restoreService.resolveEntryDestination(
      { kind: 'cold-export', home: plan.HOME_USER, target: `${COLD_EXPORT.SUBDIR}/project-audit.jsonl.gz` },
      homeByRole
    );
    assert.equal(wrongRole.ok, false);

    const good = restoreService.resolveEntryDestination(
      { kind: 'cold-export', home: plan.HOME_USER, target: `${COLD_EXPORT.SUBDIR}/user-audit.jsonl.gz` },
      homeByRole
    );
    assert.equal(good.ok, true);
    assert.equal(good.dest, path.join(homeDir, 'audit'));
  });
});
