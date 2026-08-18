'use strict';

/**
 * backupNoRawDbCopy.test.js — F1「禁止直接复制正在写入的 .db 文件」的**静态防线**。
 *
 * 前面的测试证明当前代码走的是 VACUUM INTO;这个文件负责让它**继续**如此。行为测试
 * 抓不住的那种回归恰恰最危险:某天有人为了「顺手也备一下 sessions.db」在 backupService
 * 里加一行 `fs.copyFileSync(dbPath, target)` —— 备份照样成功、测试照样绿,只有恢复那天
 * 才会发现拿到的是缺了半个 WAL 的库。所以把「SQLite 复制只允许经单点」写成源码级断言。
 *
 * 三条规则:
 *   1. 备份域内只有 sqliteHotCopy.js 可以接触 SQLite 驱动;
 *   2. 备份域内只有 sqliteHotCopy.js 可以出现 VACUUM INTO;
 *   3. 备份域内任何文件复制/流式读写语句都不得同时指向 .db/sqlite(sqliteHotCopy.js 除外
 *      —— 它复制的是**已经静止的备份副本**,不是活库)。
 *
 * 规则 3 有意用文本级判定:它要拦的正是「随手加一行」这种改动,而文本级恰好是这种改动
 * 唯一稳定的特征。误报的代价(改个变量名或走单点)远低于漏报。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '..', 'src', 'services', 'backup');
const HANDLER = path.join(__dirname, '..', 'src', 'cli', 'handlers', 'backup.js');
const HOT_COPY = 'sqliteHotCopy.js';

/** 备份域的全部源文件:services/backup/*.js + CLI handler。 */
function _sources() {
  const out = fs
    .readdirSync(BACKUP_DIR)
    .filter((n) => n.endsWith('.js'))
    .map((n) => ({ name: n, abs: path.join(BACKUP_DIR, n) }));
  out.push({ name: 'cli/handlers/backup.js', abs: HANDLER });
  return out.map((f) => ({ ...f, text: fs.readFileSync(f.abs, 'utf-8') }));
}

/** 逐行扫描,跳过纯注释行(注释里必须能自由讨论「不要裸拷 .db」)。 */
function _codeLines(text) {
  return text.split(/\r?\n/).map((line, i) => ({ n: i + 1, line })).filter(({ line }) => {
    const t = line.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
}

const SOURCES = _sources();

describe('备份域源码盘点', () => {
  test('待检文件存在且包含热备单点与两个服务', () => {
    const names = SOURCES.map((f) => f.name);
    for (const expected of [HOT_COPY, 'backupService.js', 'restoreService.js', 'backupAssetPlan.js', 'backupManifest.js']) {
      assert.ok(names.includes(expected), `缺少 ${expected}:规则扫不到的文件等于没有规则`);
    }
    assert.ok(fs.existsSync(HANDLER), 'CLI handler 必须在扫描范围内');
  });
});

describe('规则 1:SQLite 连接只在热备单点被打开', () => {
  test('其它文件不得打开或操作库(new Database / prepare / pragma / exec)', () => {
    const OPEN_RE = /\bnew\s+Database\b|\bDatabaseSync\b|\.\s*(?:prepare|pragma)\s*\(/;
    for (const f of SOURCES) {
      if (f.name === HOT_COPY) continue;
      for (const { n, line } of _codeLines(f.text)) {
        assert.ok(
          !OPEN_RE.test(line),
          `${f.name}:${n} 打开/操作了 SQLite 连接 —— 库操作必须经 ${HOT_COPY}:\n    ${line.trim()}`
        );
      }
    }
  });

  test('引用驱动只允许读元信息(__driverInfo),不允许拿它开库', () => {
    // backupService 需要把驱动名写进 manifest(排障时「这份备份是哪个驱动产的」很关键),
    // 那是纯元信息读取,与「打开库做 IO」是两件事。放行这一种,其余一概拦下。
    const driverRe = /require\(\s*['"](?:[^'"]*sqlite-adapter|better-sqlite3|node:sqlite)['"]\s*\)/;
    for (const f of SOURCES) {
      if (f.name === HOT_COPY) continue;
      for (const { n, line } of _codeLines(f.text)) {
        if (!driverRe.test(line)) continue;
        assert.match(
          line,
          /__driverInfo/,
          `${f.name}:${n} 引用了 SQLite 驱动却不是在读 __driverInfo —— 开库必须经 ${HOT_COPY}:\n    ${line.trim()}`
        );
      }
    }
  });

  test('热备单点自己确实引用了适配器(规则不能因为单点空了而形同虚设)', () => {
    const text = SOURCES.find((f) => f.name === HOT_COPY).text;
    assert.match(text, /require\([^)]*sqlite-adapter[^)]*\)/, 'sqliteHotCopy 应经共享适配器打开库');
    assert.match(text, /new Database\(/, 'sqliteHotCopy 应是唯一开库的地方');
  });
});

describe('规则 2:VACUUM 只在热备单点被执行', () => {
  test('其它文件不得执行 VACUUM(出现在提示文案里可以,交给 exec/run/prepare 不行)', () => {
    const EXEC_RE = /\.\s*(?:exec|run|query|prepare|all|get)\s*\(/;
    for (const f of SOURCES) {
      if (f.name === HOT_COPY) continue;
      for (const { n, line } of _codeLines(f.text)) {
        if (!/VACUUM/i.test(line)) continue;
        assert.ok(
          !EXEC_RE.test(line),
          `${f.name}:${n} 在 ${HOT_COPY} 之外执行了 VACUUM:\n    ${line.trim()}`
        );
      }
    }
  });

  test('热备单点里 VACUUM INTO 确实存在,且写成不可覆盖的形态', () => {
    const text = SOURCES.find((f) => f.name === HOT_COPY).text;
    assert.match(text, /VACUUM INTO/, '热备必须使用 VACUUM INTO');
    // 目标先落临时名再 rename:VACUUM INTO 拒绝已存在的目标,直写正式名会在重试时失败
    assert.match(text, /tmp-\$\{process\.pid\}/, '应先写 <target>.tmp-<pid> 再 rename');
    assert.match(text, /renameSync/, '应以 rename 收尾(原子替换)');
  });
});

describe('规则 3:没有任何一行把 .db 交给文件复制/流', () => {
  const COPY_RE = /\b(?:copyFileSync|copyFile|createReadStream|createWriteStream|cpSync|renameSync|readFileSync|writeFileSync)\b/;
  const DB_RE = /\.db\b|sqlite|SQLITE_ASSETS|dbPath|journal_mode|-wal|-shm/i;

  test('backupService / restoreService / handler / plan / manifest 全部干净', () => {
    for (const f of SOURCES) {
      if (f.name === HOT_COPY) continue; // 单点内复制的是静止的备份副本,已由其自身用例覆盖
      for (const { n, line } of _codeLines(f.text)) {
        if (!COPY_RE.test(line)) continue;
        assert.ok(
          !DB_RE.test(line),
          `${f.name}:${n} 用文件复制/读写语句碰了 SQLite 相关路径 —— 违反 F1,` +
            `库的复制必须走 sqliteHotCopy.hotCopySqlite / restoreSqliteInPlace:\n    ${line.trim()}`
        );
      }
    }
  });

  test('backupService 备份库时确实调用热备单点(证明规则 3 不是靠「什么都不做」满足的)', () => {
    const text = SOURCES.find((f) => f.name === 'backupService.js').text;
    assert.match(text, /require\(['"]\.\/sqliteHotCopy['"]\)/, 'backupService 必须引入热备单点');
    assert.match(text, /hotCopySqlite\s*\(/, 'backupService 必须调用 hotCopySqlite');
    assert.match(text, /SQLITE_ASSETS/, 'backupService 必须按 plan 的库清单逐个热备');
  });

  test('restoreService 写回库时确实调用恢复单点', () => {
    const text = SOURCES.find((f) => f.name === 'restoreService.js').text;
    assert.match(text, /restoreSqliteInPlace\s*\(/, '库的写回必须走 restoreSqliteInPlace(它负责删旧 WAL/SHM)');
  });
});

describe('规则的规则:排除清单必须把 .db 关在文件遍历之外', () => {
  test('backupAssetPlan 里存在 sqlite:hot-copy-only 这条排除理由', () => {
    const text = SOURCES.find((f) => f.name === 'backupAssetPlan.js').text;
    assert.match(text, /sqlite:hot-copy-only/, '排除理由是 F1 在遍历侧的机器化落点,不可删');
  });

  test('规则实际生效(与 backupAssetPlan.test.js 互为双保险)', () => {
    const plan = require('../src/services/backup/backupAssetPlan');
    for (const n of ['x.db', 'x.sqlite', 'x.db-wal', 'x.db-shm', 'x.db-journal']) {
      const r = plan.classifyFile(n, plan.TIER_FULL);
      assert.equal(r.include, false, n);
      assert.equal(r.reason, 'sqlite:hot-copy-only', n);
    }
  });
});
