'use strict';

/**
 * 验收标准3: 通过 dbHealthService 执行周期 PASSIVE checkpoint；若 WAL
 * 已超过主库 3 倍，则由服务追加 TRUNCATE checkpoint，最终总量不超过 3 倍。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('./src/config/sqlite-adapter');
const dbHealthService = require('./src/services/dbHealthService');

const testDir = path.join(os.tmpdir(), `db-health-wal-${Date.now()}`);
const testDb = path.join(testDir, 'taskboard.db');
let writer = null;

function fileSize(file) {
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

function cleanup() {
  try { if (writer) writer.close(); } catch { /* ignore */ }
  fs.rmSync(testDir, { recursive: true, force: true });
}

function main() {
  fs.mkdirSync(testDir, { recursive: true });
  writer = new Database(testDb);
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec('CREATE TABLE payloads (id INTEGER PRIMARY KEY, body TEXT)');

  const insert = writer.prepare('INSERT INTO payloads (body) VALUES (?)');
  for (let i = 0; i < 1500; i++) insert.run(`${i}:${'x'.repeat(1000)}`);

  // First checkpoint establishes a representative main DB size; subsequent
  // single-row commits intentionally grow WAL beyond the 3x maintenance limit.
  writer.pragma('wal_checkpoint(TRUNCATE)');
  const originalDbSize = fileSize(testDb);
  const update = writer.prepare('UPDATE payloads SET body = ? WHERE id = ?');
  for (let i = 0; i < 2400; i++) {
    update.run(`${i}:${'y'.repeat(1000)}`, (i % 1500) + 1);
  }

  const beforeWalSize = fileSize(`${testDb}-wal`);
  const beforeRatio = beforeWalSize / originalDbSize;
  const results = dbHealthService._performPeriodicCheckpoint([
    { name: 'taskboard.db', path: testDb },
  ]);
  const afterDbSize = fileSize(testDb);
  const afterWalSize = fileSize(`${testDb}-wal`);
  const totalRatio = (afterDbSize + afterWalSize) / originalDbSize;
  const result = results[0];

  const passed = beforeRatio > 3
    && result?.ok
    && result.mode === 'wal'
    && afterWalSize === 0
    && totalRatio <= 3;

  console.log(`维护前 WAL/DB: ${beforeRatio.toFixed(2)}x`);
  console.log(`服务结果: ${JSON.stringify(result)}`);
  console.log(`维护后 (DB+WAL)/原始 DB: ${totalRatio.toFixed(2)}x`);
  console.log(passed ? '✓ 验收标准3: PASSED' : '✗ 验收标准3: FAILED');

  cleanup();
  process.exitCode = passed ? 0 : 1;
}

try {
  main();
} catch (err) {
  console.error(err);
  cleanup();
  process.exitCode = 1;
}
