'use strict';

/**
 * backupRestoreDrill.test.js — 备份/恢复全流程演练(F3「恢复必须可演练」的机器化验收)。
 *
 * 主链路:**备份 → 破坏 → 恢复 → 校验**,外加两条最容易出事的分支:
 *   1. **热备期间有并发写入**(F1 的实质考验):一边循环 INSERT 一边 VACUUM INTO,
 *      副本必须自洽(integrity_check ok)且能被打开读到一个一致的快照;
 *   2. **坏备份必须被拒绝**:sha256 被篡改、缺 .complete —— 用坏备份覆盖现有数据
 *      会同时毁掉两份,所以这两条必须是硬拒绝而不是告警。
 *
 * node:test(NOT jest):本套件全是 async 主体,jest 会在 async body 跑完前拆环境
 * (见 jest.config.js 自动忽略 `require('node:test')` 的套件)。运行:
 *   node --test tests/backupRestoreDrill.test.js
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backupService = require('../src/services/backup/backupService');
const restoreService = require('../src/services/backup/restoreService');
const plan = require('../src/services/backup/backupAssetPlan');
const { BACKUP } = require('../src/constants/serviceDefaults');
const Database = require('../src/config/sqlite-adapter');

let tmpRoot;
let homeDir;
let backupRoot;
/** 注入的家目录:全部 IO 关在临时目录内,绝不碰真实 ~/.khy。 */
let HOMES;

function _mkdb(dbPath, { wal = true } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  if (wal) {
    db.pragma('journal_mode = WAL');
  }
  db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  return db;
}

function _rowCount(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  } finally {
    db.close();
  }
}

/** 演练用的公共 opts:固定备份根 + 注入家目录 + 关掉守护进程/回退备份等真实副作用。 */
function drillOpts(extra = {}) {
  return { root: backupRoot, homes: HOMES, ...extra };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-backup-drill-'));
  homeDir = path.join(tmpRoot, 'home');
  backupRoot = path.join(tmpRoot, 'backups');
  fs.mkdirSync(homeDir, { recursive: true });
  HOMES = [{ role: plan.HOME_USER, dir: homeDir }];
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发文件占用,不影响断言结论 */
  }
});

describe('备份 → 破坏 → 恢复 → 校验', () => {
  test('JSON 状态文件与 SQLite 库都能完整走一轮', async () => {
    // 现状:一个状态文件 + 一个嵌套状态文件 + taskboard.db(权威状态,无 JSON 源)
    fs.writeFileSync(path.join(homeDir, 'permissions.json'), JSON.stringify({ allow: ['ls'] }), 'utf-8');
    fs.mkdirSync(path.join(homeDir, 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'mcp', 'servers.json'), JSON.stringify({ a: 1 }), 'utf-8');

    const dbPath = path.join(homeDir, 'taskboard.db');
    const db = _mkdb(dbPath);
    for (let i = 0; i < 50; i++) {
      db.prepare('INSERT INTO items (v) VALUES (?)').run(`row-${i}`);
    }
    db.close();

    const created = await backupService.createBackup(drillOpts({ tier: plan.TIER_CORE }));
    assert.equal(created.error, null);
    assert.equal(created.ok, true, `备份应成功: ${created.error}`);

    // 库必须以 sqlite entry 进备份集,而不是被当普通文件拷走(F1)。
    const kinds = created.manifest.entries.map((e) => e.kind);
    assert.ok(kinds.includes('sqlite'), '应有 sqlite entry');
    assert.ok(kinds.includes('file'), '应有 file entry');
    const dbEntry = created.manifest.entries.find((e) => e.kind === 'sqlite');
    assert.match(dbEntry.target, /^db\//, 'SQLite 必须落在 db/ 子目录');
    assert.equal(
      created.manifest.entries.some((e) => e.kind === 'file' && /\.db$/i.test(e.target)),
      false,
      '.db 绝不能作为普通文件进备份集'
    );

    // .complete 必须存在,且校验通过
    assert.ok(fs.existsSync(path.join(created.dir, BACKUP.COMPLETE_MARKER)));
    const verified = backupService.verifyBackup(created.id, drillOpts());
    assert.deepEqual(verified.problems, []);
    assert.equal(verified.ok, true);

    // ── 破坏:改内容、删文件、清空库 ──
    fs.writeFileSync(path.join(homeDir, 'permissions.json'), JSON.stringify({ allow: ['rm -rf /'] }), 'utf-8');
    fs.rmSync(path.join(homeDir, 'mcp', 'servers.json'));
    const db2 = new Database(dbPath);
    db2.exec('DELETE FROM items');
    db2.close();
    assert.equal(_rowCount(dbPath), 0, '破坏后库应为空');

    // ── 恢复 ──
    const restored = await restoreService.restoreBackup(created.id, drillOpts({
      ignoreDaemon: true,
      skipPreBackup: false,
      skipReindex: true,
    }));
    assert.deepEqual(restored.blockers, []);
    assert.equal(restored.error, null);
    assert.equal(restored.ok, true);
    assert.equal(restored.restored.sqlite, 1);
    assert.ok(restored.restored.file >= 2);
    assert.ok(restored.preBackupId, '必须先为现状拍一份回退备份');

    // ── 校验:三者全部回到备份时的样子 ──
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(homeDir, 'permissions.json'), 'utf-8')),
      { allow: ['ls'] }
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(homeDir, 'mcp', 'servers.json'), 'utf-8')),
      { a: 1 }
    );
    assert.equal(_rowCount(dbPath), 50, '库应恢复到 50 行');

    // 换库后不得留下旧的 WAL/SHM(旧 WAL 会重放污染新库)
    assert.equal(fs.existsSync(`${dbPath}-wal`), false, '恢复后不应残留 -wal');
    assert.equal(fs.existsSync(`${dbPath}-shm`), false, '恢复后不应残留 -shm');

    // 回退备份本身也必须是一份可用备份(否则「退回去」是空话)
    const preVerified = backupService.verifyBackup(restored.preBackupId, drillOpts());
    assert.equal(preVerified.ok, true, `回退备份应可用: ${preVerified.problems.join('; ')}`);
  });

  test('回退备份能把「恢复选错了」再退回去', async () => {
    const p = path.join(homeDir, 'state.json');
    fs.writeFileSync(p, JSON.stringify({ gen: 'A' }), 'utf-8');
    const snapA = await backupService.createBackup(drillOpts());
    assert.equal(snapA.ok, true, snapA.error);

    fs.writeFileSync(p, JSON.stringify({ gen: 'B' }), 'utf-8');

    // 误恢复到 A
    const r1 = await restoreService.restoreBackup(snapA.id, drillOpts({ ignoreDaemon: true, skipReindex: true }));
    assert.equal(r1.ok, true, r1.error);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { gen: 'A' });

    // 用回退备份退回 B
    const r2 = await restoreService.restoreBackup(r1.preBackupId, drillOpts({ ignoreDaemon: true, skipReindex: true }));
    assert.equal(r2.ok, true, r2.error);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { gen: 'B' }, '应退回误恢复前的状态');
  });
});

describe('F1:热备期间有并发写入', () => {
  test('另一个进程持续 INSERT 时热备,副本自洽且写入方不受阻', async () => {
    const dbPath = path.join(homeDir, 'taskboard.db');
    const seed = _mkdb(dbPath);
    const seedInsert = seed.prepare('INSERT INTO items (v) VALUES (?)');
    for (let i = 0; i < 200; i++) {
      seedInsert.run(`seed-${i}`);
    }
    seed.close(); // 本进程放开写连接:并发写入全部来自子进程

    // **必须是另一个进程**:createBackup 的主体是同步的(VACUUM INTO 是同步调用),
    // 同进程里的 setInterval 写入方根本拿不到事件循环 —— 那样测出来的是「先写完再备份」
    // 的假并发。生产里的真实场景本来也是跨进程:守护进程在写,CLI 在备份。
    const writerScript = path.join(tmpRoot, 'concurrent-writer.js');
    fs.writeFileSync(
      writerScript,
      [
        "'use strict';",
        `const Database = require(${JSON.stringify(require.resolve('../src/config/sqlite-adapter'))});`,
        'const db = new Database(process.argv[2]);',
        "db.pragma('journal_mode = WAL');",
        "const insert = db.prepare('INSERT INTO items (v) VALUES (?)');",
        'let n = 0;',
        'let stop = false;',
        "process.on('SIGTERM', () => { stop = true; });",
        // 每个 tick 写一批后让出事件循环:持续的写压力,但不把一个核跑满。
        'const timer = setInterval(() => {',
        '  if (stop) { clearInterval(timer); try { db.close(); } catch {} process.exit(0); }',
        '  for (let i = 0; i < 25; i++) { insert.run("child-" + n++); }',
        '  process.stdout.write("wrote " + n + "\\n");',
        '}, 1);',
        'process.stdout.write("ready\\n");',
      ].join('\n'),
      'utf-8'
    );

    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [writerScript, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childOut = '';
    let childErr = '';
    child.stdout.on('data', (d) => {
      childOut += String(d);
    });
    child.stderr.on('data', (d) => {
      childErr += String(d);
    });

    // 等到子进程**已提交足够多的行**再开始备份:光看到它启动不够 —— 备份一个小库只要几毫秒,
    // 若此刻子进程才写了第一批,快照就可能恰好等于最终状态,「并发」就没被真正考验到。
    const deadline = Date.now() + 10000;
    const wroteAtLeast = (n) => {
      const m = /wrote (\d+)(?![\s\S]*wrote \d+)/.exec(childOut);
      return m ? Number(m[1]) >= n : false;
    };
    while (Date.now() < deadline && !wroteAtLeast(200)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(wroteAtLeast(200), `子写入进程未能持续写入: out=${childOut.slice(-200)} err=${childErr}`);
    const beforeBackup = Number(/wrote (\d+)(?![\s\S]*wrote \d+)/.exec(childOut)[1]);

    const created = await backupService.createBackup(drillOpts());

    // 备份后再放子进程跑一会儿:既证明它没被备份卡死/杀掉,也保证「最终状态」严格多于快照。
    await new Promise((r) => setTimeout(r, 200));

    child.kill('SIGTERM');
    // 等 'close'(而不是 'exit'):它在 stdio 流关闭后才触发,此时子进程的全部输出都已收齐。
    // 注意:createBackup 的主体是**同步**的,它执行期间父进程根本没有处理 stdout 事件 ——
    // 所以「备份窗口内写了多少」不能靠父进程在窗口中途读 stdout 来测量(那必然读到旧值),
    // 只能靠**行数**这种不依赖父进程事件循环的证据。
    await new Promise((r) => {
      child.once('close', r);
      setTimeout(r, 3000);
    });
    const wroteTotal = Number((/wrote (\d+)(?![\s\S]*wrote \d+)/.exec(childOut) || [0, 0])[1]);

    assert.ok(
      wroteTotal > beforeBackup,
      `子进程应在备份期间及之后持续写入(备份前 ${beforeBackup} → 结束 ${wroteTotal});子进程 stderr: ${childErr || '(空)'}`
    );
    assert.equal(/SQLITE_BUSY|database is locked|Error/i.test(childErr), false, `并发写入不应报错: ${childErr}`);

    assert.equal(created.ok, true, `热备应成功: ${created.error}`);
    const entry = created.manifest.entries.find((e) => e.kind === 'sqlite');
    assert.ok(entry, '应产出 sqlite entry');
    assert.equal(entry.journalMode.toLowerCase(), 'wal', '源库应处于 WAL 模式(热备的实质考验)');

    const finalCount = _rowCount(dbPath);

    // 副本自洽:能打开、integrity_check ok、行数是介于「备份前已提交」与「最终」之间的快照
    const copyPath = path.join(created.dir, entry.target.split('/').join(path.sep));
    const copy = new Database(copyPath, { readonly: true });
    try {
      const integrity = copy.pragma('integrity_check');
      const val = Array.isArray(integrity) ? integrity[0].integrity_check : integrity;
      assert.equal(val, 'ok', '副本必须通过 integrity_check');
      const n = copy.prepare('SELECT COUNT(*) AS n FROM items').get().n;
      // 这两条一起才是「真并发」的证据:副本里已经含有子进程提交的行(> 200 的种子),
      // 而最终行数又多于副本(快照之后写入仍在继续)—— 即快照确实取自一个**正在被写**的库。
      assert.ok(n > 200, `副本应含子进程在备份前/中提交的行,实得 ${n}`);
      assert.ok(n < finalCount, `副本应是快照(最终 ${finalCount} 行 > 副本 ${n} 行)`);
      // 快照一致性:行数等于最大 id,无空洞 —— 半个事务被拷进来会破坏这一点
      const maxId = copy.prepare('SELECT MAX(id) AS m FROM items').get().m;
      assert.equal(maxId, n, `副本行数应等于最大 id(无空洞),n=${n} maxId=${maxId}`);
    } finally {
      copy.close();
    }

    // 备份集校验也必须过(sha256 对得上,说明副本落盘后没再被改写)
    assert.equal(backupService.verifyBackup(created.id, drillOpts()).ok, true);
  });
});

describe('坏备份必须被拒绝', () => {
  test('sha256 被篡改 → verify 失败,restore 拒绝', async () => {
    const p = path.join(homeDir, 'state.json');
    fs.writeFileSync(p, JSON.stringify({ v: 1 }), 'utf-8');
    const created = await backupService.createBackup(drillOpts());
    assert.equal(created.ok, true, created.error);

    // 篡改备份集里的文件内容(模拟静默位腐 / 有人手改)
    const entry = created.manifest.entries.find((e) => e.target.endsWith('state.json'));
    assert.ok(entry, '应有 state.json entry');
    fs.writeFileSync(path.join(created.dir, entry.target.split('/').join(path.sep)), JSON.stringify({ v: 666 }), 'utf-8');

    const verified = backupService.verifyBackup(created.id, drillOpts());
    assert.equal(verified.ok, false, '篡改后校验必须失败');
    assert.ok(verified.problems.some((s) => /sha256|字节数/.test(s)));

    // 现状不能被这份坏备份改写
    fs.writeFileSync(p, JSON.stringify({ v: 2 }), 'utf-8');
    const restored = await restoreService.restoreBackup(created.id, drillOpts({ ignoreDaemon: true, skipReindex: true }));
    assert.equal(restored.ok, false, 'restore 必须拒绝校验不通过的备份');
    assert.ok(restored.blockers.length > 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { v: 2 }, '拒绝时现有数据不得被改动');
  });

  test('缺 .complete → list 标 BROKEN、restore 拒绝(--force 也不放行)', async () => {
    const p = path.join(homeDir, 'state.json');
    fs.writeFileSync(p, JSON.stringify({ v: 1 }), 'utf-8');
    const created = await backupService.createBackup(drillOpts());
    assert.equal(created.ok, true, created.error);

    fs.rmSync(path.join(created.dir, BACKUP.COMPLETE_MARKER));

    const listed = backupService.listBackups(drillOpts());
    assert.equal(listed.sets.find((s) => s.id === created.id).complete, false);

    fs.writeFileSync(p, JSON.stringify({ v: 2 }), 'utf-8');
    const restored = await restoreService.restoreBackup(created.id, drillOpts({
      ignoreDaemon: true,
      skipReindex: true,
      force: true, // 即便 force 也不放行
    }));
    assert.equal(restored.ok, false);
    assert.ok(restored.blockers.some((b) => /\.complete/.test(b)));
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { v: 2 });
  });

  test('家目录路径变化 → 默认拒绝,--remap 放行', async () => {
    fs.writeFileSync(path.join(homeDir, 'state.json'), JSON.stringify({ v: 1 }), 'utf-8');
    const created = await backupService.createBackup(drillOpts());
    assert.equal(created.ok, true, created.error);

    // 模拟换机:同一份备份要落到另一个家目录
    const movedHome = path.join(tmpRoot, 'home-moved');
    fs.mkdirSync(movedHome, { recursive: true });
    const movedOpts = { root: backupRoot, homes: [{ role: plan.HOME_USER, dir: movedHome }] };

    const refused = await restoreService.restoreBackup(created.id, {
      ...movedOpts,
      ignoreDaemon: true,
      skipReindex: true,
    });
    assert.equal(refused.ok, false, '路径变化必须默认拒绝');
    assert.ok(refused.blockers.some((b) => /--remap/.test(b)), '拒绝理由要告诉用户怎么办');
    assert.equal(fs.existsSync(path.join(movedHome, 'state.json')), false);

    const allowed = await restoreService.restoreBackup(created.id, {
      ...movedOpts,
      ignoreDaemon: true,
      skipReindex: true,
      skipPreBackup: true,
      remap: true,
    });
    assert.equal(allowed.ok, true, allowed.error);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(movedHome, 'state.json'), 'utf-8')), { v: 1 });
  });

  test('--dry-run 不改动任何文件', async () => {
    const p = path.join(homeDir, 'state.json');
    fs.writeFileSync(p, JSON.stringify({ v: 1 }), 'utf-8');
    const created = await backupService.createBackup(drillOpts());
    fs.writeFileSync(p, JSON.stringify({ v: 2 }), 'utf-8');

    const before = fs.readdirSync(backupRoot).length;
    const dry = await restoreService.restoreBackup(created.id, drillOpts({
      ignoreDaemon: true,
      skipReindex: true,
      dryRun: true,
    }));
    assert.equal(dry.ok, true, dry.error);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { v: 2 }, 'dry-run 不得写回数据');
    assert.equal(fs.readdirSync(backupRoot).length, before, 'dry-run 不得创建回退备份');
  });

  test('守护进程存活 → 拒绝恢复,且提示用户自己停(绝不代为 kill)', async () => {
    fs.writeFileSync(path.join(homeDir, 'state.json'), JSON.stringify({ v: 1 }), 'utf-8');
    const created = await backupService.createBackup(drillOpts());
    assert.equal(created.ok, true, created.error);

    // daemon.pid 由 daemonManager 写在 getDataDir() 下;把 KHY_DATA_HOME 指到临时家目录,
    // 再写一个「当前进程 pid」冒充存活的守护进程 —— 一定存活,判定必然触发。
    const savedEnv = process.env.KHY_DATA_HOME;
    process.env.KHY_DATA_HOME = homeDir;
    try {
      fs.writeFileSync(
        path.join(homeDir, 'daemon.pid'),
        JSON.stringify({ pid: process.pid, port: 9090, startedAt: 1 }),
        'utf-8'
      );
      const alive = restoreService._daemonAlive();
      assert.equal(alive.alive, true, '应判定守护进程存活');

      const refused = await restoreService.restoreBackup(created.id, drillOpts({ skipReindex: true }));
      assert.equal(refused.ok, false);
      assert.ok(refused.blockers.some((b) => /khy daemon stop/.test(b)), '必须告诉用户自己停,而不是代为 kill');
    } finally {
      if (savedEnv === undefined) {
        delete process.env.KHY_DATA_HOME;
      } else {
        process.env.KHY_DATA_HOME = savedEnv;
      }
    }
  });
});

describe('分级与排除', () => {
  test('core 级不收 audit 流水,full 级收;两级都排除缓存', async () => {
    fs.writeFileSync(path.join(homeDir, 'state.json'), '{}', 'utf-8');
    fs.mkdirSync(path.join(homeDir, 'audit'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'audit', 'a.jsonl'), 'x\n', 'utf-8');
    fs.mkdirSync(path.join(homeDir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'cache', 'c.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(homeDir, 'hw_probe_cache.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(homeDir, 'daemon.pid'), '{}', 'utf-8');

    const core = await backupService.createBackup(drillOpts({ tier: plan.TIER_CORE }));
    assert.equal(core.ok, true, core.error);
    const coreTargets = core.manifest.entries.map((e) => e.target);
    assert.ok(coreTargets.some((t) => t.endsWith('state.json')));
    assert.equal(coreTargets.some((t) => t.includes('/audit/')), false, 'core 不收 audit');
    assert.equal(coreTargets.some((t) => t.includes('/cache/')), false, '缓存永不收');
    assert.equal(coreTargets.some((t) => t.endsWith('hw_probe_cache.json')), false);
    assert.equal(coreTargets.some((t) => t.endsWith('daemon.pid')), false);
    // 排除项必须带理由留在 manifest 里,漏备是可读的事实而不是沉默
    assert.ok(core.manifest.excluded.some((x) => /audit/.test(x.path) && x.reason));
    assert.ok(core.manifest.excluded.some((x) => /daemon\.pid/.test(x.path)));

    const full = await backupService.createBackup(drillOpts({ tier: plan.TIER_FULL }));
    assert.equal(full.ok, true, full.error);
    const fullTargets = full.manifest.entries.map((e) => e.target);
    assert.ok(fullTargets.some((t) => t.includes('/audit/')), 'full 应收 audit');
    assert.equal(fullTargets.some((t) => t.includes('/cache/')), false, 'full 也不收缓存');
  });

  test('备份根落在家目录内时不递归自吞', async () => {
    const innerBackupRoot = path.join(homeDir, 'backups');
    fs.writeFileSync(path.join(homeDir, 'state.json'), '{}', 'utf-8');
    const first = await backupService.createBackup({ root: innerBackupRoot, homes: HOMES });
    assert.equal(first.ok, true, first.error);
    const second = await backupService.createBackup({ root: innerBackupRoot, homes: HOMES });
    assert.equal(second.ok, true, second.error);
    assert.equal(
      second.manifest.entries.some((e) => e.target.includes('backups/')),
      false,
      '第二份备份不得把第一份吞进去'
    );
  });
});

describe('保留策略', () => {
  test('同时超份数且超天数才删,最新一份永不删,BROKEN 优先清', async () => {
    fs.writeFileSync(path.join(homeDir, 'state.json'), '{}', 'utf-8');

    // 三份备份,时间由 nowMs 注入:两份是 60 天前的老备份,一份是现在的。
    const dayMs = 86400000;
    const now = Date.parse('2026-08-16T00:00:00Z');
    const old1 = await backupService.createBackup(drillOpts({ nowMs: now - 60 * dayMs }));
    const old2 = await backupService.createBackup(drillOpts({ nowMs: now - 59 * dayMs }));
    const fresh = await backupService.createBackup(drillOpts({ nowMs: now }));
    for (const s of [old1, old2, fresh]) {
      assert.equal(s.ok, true, s.error);
    }

    // keepCount=1 且 keepDays=30:两份老的同时超份数+超天数 → 删;最新的留。
    const pruned = backupService.pruneBackups(drillOpts({ keepCount: 1, keepDays: 30, nowMs: now }));
    const droppedIds = pruned.dropped.filter((d) => d.removed).map((d) => d.id).sort();
    assert.deepEqual(droppedIds, [old1.id, old2.id].sort());
    assert.ok(pruned.kept.includes(fresh.id), '最新一份永不删除');
    assert.equal(fs.existsSync(fresh.dir), true);
    assert.equal(fs.existsSync(old1.dir), false);

    // 只超份数、不超天数 → 不删
    const again = await backupService.createBackup(drillOpts({ nowMs: now }));
    const pruned2 = backupService.pruneBackups(drillOpts({ keepCount: 1, keepDays: 30, nowMs: now }));
    assert.deepEqual(pruned2.dropped, [], '未超天数不应删除');
    assert.equal(fs.existsSync(again.dir), true);
  });

  test('缺 .complete 的残破备份被优先清理', async () => {
    fs.writeFileSync(path.join(homeDir, 'state.json'), '{}', 'utf-8');
    const a = await backupService.createBackup(drillOpts());
    const b = await backupService.createBackup(drillOpts());
    fs.rmSync(path.join(a.dir, BACKUP.COMPLETE_MARKER));

    const pruned = backupService.pruneBackups(drillOpts({ keepCount: 10, keepDays: 3650 }));
    assert.deepEqual(pruned.dropped.map((d) => d.id), [a.id], '只清残破的那份');
    assert.ok(pruned.dropped[0].reason.includes('.complete'));
    assert.equal(fs.existsSync(b.dir), true);
  });
});
