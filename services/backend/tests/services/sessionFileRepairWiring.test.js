'use strict';

/**
 * OPS-MAN-153 接线验证:sessionFileRepair 叶 → sessionPersistence.restoreSession。
 *
 * 此前 sessionFileRepair.js 是「有能力但没接线」的孤儿叶(唯一消费者是它自己的
 * 单测)。本测证明它已被接进 restoreSession 的「JSON 快照损坏兜底」路径,直接服务
 * 送别礼诉求「完整的简单的还原」——损坏/截断的会话快照从「整段丢给 checkpoint/null」
 * 变为「先结构修复 / partial salvage 再还原」。
 *
 * 纯脚本 assert 风格(可 `node <file>` 直跑),便于在同进程内切换门控 env 做
 * byte-revert 对照——门控在 restoreSession 内按调用时读取 process.env,故可同进程切换。
 *
 * 关键:必须在 require sessionPersistence 之前设置 KHY_PROJECT_DATA_HOME,因为
 * dataHome 惰性缓存 project data home。
 */

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ---- 隔离数据目录:必须在任何 require sessionPersistence / dataHome 之前 ----
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sfr-wiring-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const { getProjectDataDir } = require('../../src/utils/dataHome');
const sessionPersistence = require('../../src/services/sessionPersistence');
const { repairSessionFile, tryParsePartialJson } = require('../../src/services/sessionFileRepair');

const SESSIONS_DIR = getProjectDataDir('sessions');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${e && e.message}`);
  }
}

function writeCorruptSnapshot(sessionId, messages, trailer) {
  const p = path.join(SESSIONS_DIR, `${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify({ sessionId, messages }) + (trailer || 'GARBAGE!!'));
  return p;
}

console.log('sessionFileRepairWiring.test.js');

// ---- 1) 叶自身能力(基线,复核接线前提) ----
ok('leaf repairSessionFile rewrites & backs up a snapshot with an invalid message', () => {
  const p = writeCorruptSnapshot('leaf-a', [
    { role: 'user', content: 'a' },
    { role: 'bogus' },
    { role: 'assistant', content: 'b' },
  ]);
  const r = repairSessionFile(p, { dryRun: false, backup: true });
  assert.strictEqual(r.repaired, true, 'expected repaired:true');
  assert.ok(r.backupPath && fs.existsSync(r.backupPath), '.bak should exist');
  const re = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.strictEqual(re.messages.length, 2, 'invalid message dropped');
});

ok('leaf tryParsePartialJson salvages a clean prefix + trailing garbage', () => {
  const salvaged = tryParsePartialJson(
    JSON.stringify({ sessionId: 'x', messages: [{ role: 'user', content: 'x' }] }) + 'TRAILING'
  );
  assert.ok(salvaged && Array.isArray(salvaged.messages), 'salvage yields messages');
  assert.strictEqual(salvaged.messages.length, 1);
});

// ---- 2) 接线:restoreSession 修复重写路径(repaired:true) ----
ok('restoreSession repairs a corrupt snapshot with an invalid message → _source:json-repaired', () => {
  const sid = 'wire-repaired';
  writeCorruptSnapshot(sid, [
    { role: 'user', content: 'hello' },
    { role: 'bogus' },
    { role: 'assistant', content: 'world' },
  ]);
  const res = sessionPersistence.restoreSession(sid);
  assert.ok(res, 'restoreSession returned a session, not null');
  assert.strictEqual(res._source, 'json-repaired', `_source should be json-repaired, got ${res && res._source}`);
  assert.ok(Array.isArray(res.messages) && res.messages.length === 2, 'valid messages salvaged');
  // .bak 应已生成(修复重写的证据)
  assert.ok(fs.existsSync(path.join(SESSIONS_DIR, `${sid}.json.bak`)), 'repair backup created');
});

// ---- 3) 接线:restoreSession partial-salvage 路径(repaired:false → tryParsePartialJson) ----
ok('restoreSession salvages a clean-prefix corrupt snapshot → _source:json-repaired', () => {
  const sid = 'wire-salvage';
  writeCorruptSnapshot(
    sid,
    [{ role: 'user', content: 'p' }, { role: 'assistant', content: 'q' }],
    'TRAILING_GARBAGE'
  );
  const res = sessionPersistence.restoreSession(sid);
  assert.ok(res, 'restoreSession returned a session');
  assert.strictEqual(res._source, 'json-repaired', `_source should be json-repaired, got ${res && res._source}`);
  assert.ok(res.messages.length >= 2, 'messages salvaged');
});

// ---- 4) 门控关 → byte-revert(逐字节回退到旧兜底 checkpoint/null) ----
ok('gate off (KHY_SESSION_FILE_REPAIR=0) → corrupt snapshot yields null (no repair)', () => {
  const sid = 'wire-gateoff';
  writeCorruptSnapshot(sid, [
    { role: 'user', content: 'x' },
    { role: 'bogus' },
    { role: 'assistant', content: 'y' },
  ]);
  const prev = process.env.KHY_SESSION_FILE_REPAIR;
  process.env.KHY_SESSION_FILE_REPAIR = '0';
  try {
    const res = sessionPersistence.restoreSession(sid);
    assert.strictEqual(res, null, 'gate off must not repair — falls back to null');
    // 门控关时绝不生成 .bak(未触碰修复叶)
    assert.ok(!fs.existsSync(path.join(SESSIONS_DIR, `${sid}.json.bak`)), 'no backup when gate off');
  } finally {
    if (prev === undefined) delete process.env.KHY_SESSION_FILE_REPAIR;
    else process.env.KHY_SESSION_FILE_REPAIR = prev;
  }
});

// ---- 5) 合法快照(未损坏)不受影响 → _source:json ----
ok('valid snapshot is untouched → _source:json (no regression)', () => {
  const sid = 'wire-valid';
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${sid}.json`),
    JSON.stringify({ sessionId: sid, title: 't', messages: [{ role: 'user', content: 'ok' }] })
  );
  const res = sessionPersistence.restoreSession(sid);
  assert.ok(res, 'restore ok');
  assert.strictEqual(res._source, 'json', 'valid snapshot uses plain json path');
});

// ---- 6) 源级接线断言(防止未来悄悄断桥) ----
ok('sessionPersistence.js source wires sessionFileRepair under the gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/sessionPersistence.js'), 'utf-8');
  assert.ok(/require\(['"]\.\/sessionFileRepair['"]\)/.test(src), 'requires ./sessionFileRepair');
  assert.ok(/repairSessionFile/.test(src), 'calls repairSessionFile');
  assert.ok(/tryParsePartialJson/.test(src), 'uses tryParsePartialJson salvage');
  assert.ok(/KHY_SESSION_FILE_REPAIR/.test(src), 'reads the gate flag');
  assert.ok(/json-repaired/.test(src), 'tags repaired sessions');
  assert.ok(/\['0',\s*'false',\s*'off',\s*'no'\]/.test(src), 'off-word byte-revert pattern');
});

// ---- 7) 门控已在 flagRegistry 登记为 default-on ----
ok('KHY_SESSION_FILE_REPAIR registered default-on in flagRegistry', () => {
  const reg = fs.readFileSync(path.join(__dirname, '../../src/services/flagRegistry.js'), 'utf-8');
  const idx = reg.indexOf('KHY_SESSION_FILE_REPAIR');
  assert.ok(idx >= 0, 'flag present in registry');
  const slice = reg.slice(idx, idx + 120);
  assert.ok(/default-on/.test(slice), 'mode default-on');
  assert.ok(/default:\s*true/.test(slice), 'default true');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
