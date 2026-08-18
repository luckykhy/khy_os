'use strict';
/**
 * 验收标准1: 故意损坏 sessions.db(truncate 一半) → 启动时自动检测 + 尝试 recover
 *            + 审计日志含 "修复数据库 sessions.db(recover 模式，恢复 N/M 条记录)"
 *
 * 这是规范原文场景，不做任何弱化替代。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const testDir = path.join(os.tmpdir(), `db-health-verify-${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });

const dbHealthService = require('./src/services/dbHealthService');
const Database = require('./src/config/sqlite-adapter');

// 审计日志由 healAuditService 统一写入 .khy/logs/heal-audit.jsonl
const AUDIT_LOG = path.join(process.cwd(), '.khy', 'logs', 'heal-audit.jsonl');

function readAuditSince(sinceTime) {
  if (!fs.existsSync(AUDIT_LOG)) return [];
  return fs.readFileSync(AUDIT_LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(e => e && e.component === 'dbHealth' && new Date(e.timestamp) >= sinceTime);
}

console.log('=== 验收标准1: 损坏数据库修复测试(truncate 一半) ===');

// 创建测试数据库 —— 名称必须是 sessions.db，审计文案按规范核对
const testDb = path.join(testDir, 'sessions.db');
const db = new Database(testDb);
db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY, data TEXT)');
const insert = db.prepare('INSERT INTO sessions (data) VALUES (?)');
for (let i = 0; i < 100; i++) {
  insert.run(`test-${i}`.padEnd(120, '.'));
}
db.exec('CREATE TABLE meta (id INTEGER PRIMARY KEY, k TEXT, v TEXT)');
const insertMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)');
for (let i = 0; i < 20; i++) {
  insertMeta.run(`key-${i}`, `value-${i}`);
}
const originalSize = fs.statSync(testDb).size;
db.close();

console.log(`创建测试数据库: ${testDb}, ${originalSize} bytes, 120 条记录`);

// 故意损坏 - truncate 一半
const corrupted = fs.readFileSync(testDb);
fs.writeFileSync(testDb, corrupted.slice(0, Math.floor(corrupted.length / 2)));
console.log(`损坏数据库: 截断到 ${fs.statSync(testDb).size} bytes`);

// 确认损坏确实被检测到
const preCheck = dbHealthService.checkIntegrity(testDb);
console.log(`损坏检测: ok=${preCheck.ok} error=${preCheck.error || '-'}`);

const startedAt = new Date();

dbHealthService.healDatabase(testDb, 'sessions.db').then(result => {
  console.log(`修复结果: ${JSON.stringify(result)}`);

  const entries = readAuditSince(startedAt);
  console.log('\n审计日志(本次):');
  entries.forEach(e => console.log(`  [${e.result}] ${e.action}`));

  const recoverEntry = entries.find(e =>
    e.action.includes('修复数据库 sessions.db(recover 模式')
    && /恢复 \d+\/\d+ 条记录/.test(e.action)
  );

  let passed = false;
  if (recoverEntry) {
    console.log(`\n✓ 验收标准1: PASSED - ${recoverEntry.action}`);

    // 修复后的库必须可读且通过完整性检查
    const post = dbHealthService.checkIntegrity(testDb);
    console.log(`  修复后完整性: ok=${post.ok}`);
    let rows = -1;
    try {
      const check = new Database(testDb, { readonly: true });
      rows = check.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
      check.close();
    } catch (err) {
      console.log(`  修复后读取失败: ${err.message}`);
    }
    console.log(`  修复后 sessions 表可读记录: ${rows}`);
    passed = post.ok && rows > 0;
    if (!passed) console.log('✗ 修复后的数据库不可用');
  } else {
    console.log('\n✗ 验收标准1: FAILED - 审计日志缺少 "recover 模式，恢复 N/M 条记录"');
  }

  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(passed ? 0 : 1);
}).catch(err => {
  console.error('修复失败:', err);
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
