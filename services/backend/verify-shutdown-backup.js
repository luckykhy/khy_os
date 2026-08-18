'use strict';

/**
 * 正常退出备份: 使用 SQLite 热拷贝生成一致快照，并仅保留最近 3 份。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('./src/config/sqlite-adapter');
const dbHealthService = require('./src/services/dbHealthService');

const testDir = path.join(os.tmpdir(), `db-health-shutdown-${Date.now()}`);
const testDb = path.join(testDir, 'sessions.db');
const backupDir = path.join(testDir, 'db_backup');

async function main() {
  fs.mkdirSync(testDir, { recursive: true });
  const db = new Database(testDb);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY, data TEXT)');
  const insert = db.prepare('INSERT INTO sessions (data) VALUES (?)');
  for (let i = 0; i < 40; i++) insert.run(`session-${i}`);
  db.close();

  const databases = [{ name: 'sessions.db', path: testDb }];
  const runs = [];
  for (let day = 10; day <= 14; day++) {
    runs.push(await dbHealthService.shutdownBackup(
      databases,
      new Date(`2026-08-${day}T12:00:00.000Z`)
    ));
  }

  const files = fs.readdirSync(backupDir).sort();
  const expected = [
    'sessions.2026-08-12T12-00-00.db',
    'sessions.2026-08-13T12-00-00.db',
    'sessions.2026-08-14T12-00-00.db',
  ];
  const valid = files.every(file => {
    const backupPath = path.join(backupDir, file);
    if (!dbHealthService.checkIntegrity(backupPath).ok) return false;
    const copy = new Database(backupPath, { readonly: true });
    const count = copy.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
    copy.close();
    return count === 40;
  });
  const allRunsOk = runs.flat().every(result => result.ok);
  const passed = allRunsOk
    && JSON.stringify(files) === JSON.stringify(expected)
    && valid;

  console.log(`备份结果: ${JSON.stringify(runs)}`);
  console.log(`保留文件: ${files.join(', ')}`);
  console.log(`完整性与记录数: ${valid ? '通过' : '失败'}`);
  console.log(passed ? '✓ 正常退出备份: PASSED' : '✗ 正常退出备份: FAILED');

  fs.rmSync(testDir, { recursive: true, force: true });
  process.exitCode = passed ? 0 : 1;
}

main().catch(err => {
  console.error(err);
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exitCode = 1;
});
