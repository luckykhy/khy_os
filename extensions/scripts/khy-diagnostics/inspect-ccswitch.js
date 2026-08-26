#!/usr/bin/env node
'use strict';

/**
 * inspect-ccswitch.js — dump the cc-switch sqlite schema plus a two-row sample.
 *
 * Ad-hoc inspector, deliberately not registered in khy.extension.json: it reads a
 * third-party tool's database, so it is a one-off probe rather than a doctor.
 *
 * DB path resolution order: argv[2] -> KHY_CCSWITCH_DB -> <home>/.cc-switch/cc-switch.db.
 * Never write an absolute path into the source (engineering red line "zero hardcoding");
 * the previous literal pointed at another machine's home directory, so the script could
 * not run for anyone but its author.
 *
 * better-sqlite3 is an optional peer (CONTRIBUTING §11.2) and is absent from a default
 * install, so it must not be required at top level without a guard: a missing optional
 * capability has to print an actionable Chinese hint, not a raw MODULE_NOT_FOUND stack.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveDbPath() {
  const explicit = process.argv[2] || process.env.KHY_CCSWITCH_DB;
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
}

function loadSqlite() {
  try {
    return require('better-sqlite3');
  } catch {
    console.error('[inspect-ccswitch] 读取 sqlite 失败：可选依赖 better-sqlite3 未安装（0/1 就位）。');
    console.error(
      '[inspect-ccswitch] 安装：npm install --no-save better-sqlite3' +
        '（含原生编译步骤，装出来约 12 MB；仓库默认安装刻意不带它）。'
    );
    return null;
  }
}

const Database = loadSqlite();
if (!Database) {
  process.exit(2);
}

const dbPath = resolveDbPath();
if (!fs.existsSync(dbPath)) {
  console.error('[inspect-ccswitch] 找不到数据库文件：' + dbPath);
  console.error(
    '[inspect-ccswitch] 换一个位置：node inspect-ccswitch.js <db 文件路径>，或设置 KHY_CCSWITCH_DB。'
  );
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });
console.log('[inspect-ccswitch] 只读打开 ' + dbPath);
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('[inspect-ccswitch] 共 ' + tables.length + ' 张表：' + JSON.stringify(tables));
  let done = 0;
  for (const t of tables) {
    done += 1;
    console.log('\n=== Table (' + done + '/' + tables.length + '):', t.name, '===');
    const cols = db.prepare('PRAGMA table_info("' + t.name + '")').all();
    cols.forEach((c) => console.log('  col:', c.name, '-', c.type));
    const rows = db.prepare('SELECT * FROM "' + t.name + '" LIMIT 2').all();
    console.log(JSON.stringify(rows, null, 2));
  }
} finally {
  db.close();
}
