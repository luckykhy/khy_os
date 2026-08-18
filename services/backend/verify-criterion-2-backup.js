'use strict';

/**
 * 验收标准2: 损坏数据库优先从 `.khy/checkpoints` 的最近有效备份恢复。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('./src/config/sqlite-adapter');
const dbHealthService = require('./src/services/dbHealthService');

const testDir = path.join(os.tmpdir(), `db-health-backup-${Date.now()}`);
const checkpointDir = path.join(testDir, 'checkpoints');
const testDb = path.join(testDir, 'sessions.db');
const auditLog = path.join(process.cwd(), '.khy', 'logs', 'heal-audit.jsonl');

function readAuditSince(sinceTime) {
  if (!fs.existsSync(auditLog)) return [];
  return fs.readFileSync(auditLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(entry => entry && entry.component === 'dbHealth')
    .filter(entry => new Date(entry.timestamp) >= sinceTime);
}

async function main() {
  fs.mkdirSync(checkpointDir, { recursive: true });

  const db = new Database(testDb);
  db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY, session_id TEXT)');
  const insert = db.prepare('INSERT INTO sessions (session_id) VALUES (?)');
  for (let i = 0; i < 50; i++) insert.run(`session-${i}`);
  db.close();

  const backupTimestamp = '2026-08-17T12-00-00';
  const backupPath = path.join(checkpointDir, `sessions.${backupTimestamp}.db`);
  fs.copyFileSync(testDb, backupPath);
  fs.writeFileSync(testDb, Buffer.alloc(100, 0xa5));

  const startedAt = new Date();
  const result = await dbHealthService.healDatabase(testDb, 'sessions.db');
  const entries = readAuditSince(startedAt);
  const restoreEntry = entries.find(entry =>
    entry.result === 'success'
    && entry.action.includes('从备份恢复 sessions.db')
    && entry.action.includes(`备份时间 ${backupTimestamp}`)
  );

  const check = dbHealthService.checkIntegrity(testDb);
  let rows = -1;
  if (check.ok) {
    const restored = new Database(testDb, { readonly: true });
    rows = restored.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
    restored.close();
  }

  const passed = result.ok
    && result.method === 'backup_restore'
    && Boolean(restoreEntry)
    && check.ok
    && rows === 50;

  console.log(`修复结果: ${JSON.stringify(result)}`);
  console.log(`审计记录: ${restoreEntry ? restoreEntry.action : '缺失'}`);
  console.log(`恢复后完整性: ${check.ok}; sessions: ${rows}`);
  console.log(passed ? '✓ 验收标准2: PASSED' : '✗ 验收标准2: FAILED');

  fs.rmSync(testDir, { recursive: true, force: true });
  process.exitCode = passed ? 0 : 1;
}

main().catch(err => {
  console.error(err);
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exitCode = 1;
});
