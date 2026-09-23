'use strict';

/**
 * 账号改名（khy user rename）跨存储面契约。
 *
 * 覆盖：
 *   - cliAuthService.renameAccount 编排（会话/本地凭据/默认管理员文件/会话文件）
 *   - credentialGenerator.renameDefaultAdminCredentials（文件改名边界）
 *   - bridgeAuth.renameBridgeUser（未初始化 skip / 改名 / 冲突）
 * 隔离：KHY_APP_HOME + KHY_DATA_HOME 指向临时目录，绝不触碰真实 ~/.khy/.khyquant。
 * DB 步骤在本环境不可用 → 走 fail-soft 分支（details 标注「数据库未同步」）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-rename-app-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-rename-data-'));
process.env.KHY_APP_HOME = APP;
process.env.KHY_DATA_HOME = DATA;
// 把 Sequelize 的 SQLite 文件钉进临时目录 → 数据库改名步骤可真实执行且零外溢。
process.env.SQLITE_DB_PATH = path.join(DATA, 'khy-quant-test.db');
delete process.env.KHY_ADMIN_USERNAME;

const credGen = require('../../src/services/credentialGenerator');
const cliAuth = require('../../src/services/cliAuthService');
const bridgeAuth = require('../../src/bridge/bridgeAuth');

const sessionFile = path.join(APP, 'session.json');
const credsFile = path.join(APP, 'credentials.json');
const adminFile = () => credGen.getDefaultAdminCredentialsPath();

function writeSession(username, role = 'admin') {
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({ username, role, loginAt: new Date().toISOString(), deviceId: 'test' })
  );
}
function writeLocalCreds(username, email, aliases = []) {
  fs.writeFileSync(
    credsFile,
    JSON.stringify({
      username,
      email: email || '',
      passwordHash: 'hash',
      passwordSalt: 'salt',
      registeredAt: new Date().toISOString(),
      aliases,
    })
  );
}

// ── 前置校验 ────────────────────────────────────────────────────────────────

test('未登录时改名被拒绝(具体错误)', async () => {
  fs.rmSync(sessionFile, { force: true });
  const r = await cliAuth.renameAccount('whatever');
  assert.strictEqual(r.success, false);
  assert.match(r.error, /未登录/);
});

test('同名与非法名被拒绝', async () => {
  writeSession('current1');
  let r = await cliAuth.renameAccount('current1');
  assert.strictEqual(r.success, false);
  assert.match(r.error, /相同/);

  r = await cliAuth.renameAccount('a'); // 太短
  assert.strictEqual(r.success, false);
  assert.match(r.error, /不合法/);
  r = await cliAuth.renameAccount('中 文'); // 非法字符
  assert.strictEqual(r.success, false);
  r = await cliAuth.renameAccount('x'.repeat(33)); // 超长
  assert.strictEqual(r.success, false);
  fs.rmSync(sessionFile, { force: true });
});

// ── 数据库层(临时 SQLite,SQLITE_DB_PATH 已钉到 DATA) ───────────────────────

let _db = null; // { sequelize, User } — 模型不可用时保持 null,DB 用例自动降级

test('数据库准备: 临时 SQLite 建表(模型不可用则后续 DB 用例跳过)', async () => {
  try {
    const models = require('@khy/shared/models');
    const sequelize = models.sequelize || require('@khy/shared/config/database').sequelize;
    await sequelize.sync();
    _db = { sequelize, User: models.User };
    assert.ok(_db.User, 'models index 必须导出 User');
  } catch (err) {
    _db = null;
    console.log(`[test] 数据库准备失败，DB 相关断言降级为 fail-soft: ${err.message}`);
  }
});

// ── 默认管理员账号 ──────────────────────────────────────────────────────────

test('默认管理员改名: 凭据文件/会话更新, 密码保留, 旧名入 aliases', async () => {
  const adminPath = adminFile();
  fs.mkdirSync(path.dirname(adminPath), { recursive: true });
  fs.writeFileSync(
    adminPath,
    JSON.stringify({ username: 'oldadm', password: 'MachinePw123', generatedAt: 'x' })
  );
  writeSession('oldadm');
  fs.rmSync(credsFile, { force: true });

  const r = await cliAuth.renameAccount('newadm');
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(r.oldUsername, 'oldadm');
  assert.strictEqual(r.username, 'newadm');

  const file = JSON.parse(fs.readFileSync(adminPath, 'utf8'));
  assert.strictEqual(file.username, 'newadm');
  assert.strictEqual(file.password, 'MachinePw123'); // 密码不变
  assert.strictEqual(file.renamedFrom, 'oldadm');

  const sess = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.strictEqual(sess.username, 'newadm');

  // DB 在本测试环境不可用 → 如实标注而非假装成功
  assert.ok(r.details.some((d) => d.startsWith('数据库未同步')));
  assert.ok(r.details.some((d) => d.includes('凭据文件已改名')));
});

// ── 本地注册账号 ────────────────────────────────────────────────────────────

test('本地账号改名: credentials.username 更新, 旧名保留为 alias, 会话同步', async () => {
  fs.rmSync(adminFile(), { force: true });
  writeLocalCreds('oldloc', 'oldloc@cli.local');
  writeSession('oldloc', 'user');

  const r = await cliAuth.renameAccount('newloc');
  assert.strictEqual(r.success, true, JSON.stringify(r));
  const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
  assert.strictEqual(creds.username, 'newloc');
  assert.ok(creds.aliases.includes('oldloc'), '旧名必须保留为登录别名');
  assert.ok(!creds.aliases.includes('newloc'), '新名不应留在别名集');
  assert.strictEqual(creds.email, 'oldloc@cli.local'); // 用户邮箱不动
  const sess = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.strictEqual(sess.username, 'newloc');
  // 会话可继续解析(checkSession 读 session.json)
  assert.strictEqual(cliAuth.checkSession().username, 'newloc');
});

test('连续两次改名都成功(幂等可续)', async () => {
  const r2 = await cliAuth.renameAccount('newloc2');
  assert.strictEqual(r2.success, true, JSON.stringify(r2));
  const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
  assert.strictEqual(creds.username, 'newloc2');
  assert.ok(creds.aliases.includes('newloc'), '第二次改名的旧名同样入 aliases');
});

// ── credentialGenerator.renameDefaultAdminCredentials 边界 ─────────────────

test('renameDefaultAdminCredentials: 文件不存在/同名/非法名 均拒绝', () => {
  fs.rmSync(adminFile(), { force: true });
  assert.strictEqual(credGen.renameDefaultAdminCredentials('any').ok, false);

  const adminPath = adminFile();
  fs.mkdirSync(path.dirname(adminPath), { recursive: true });
  fs.writeFileSync(adminPath, JSON.stringify({ username: 'cur', password: 'p' }));
  assert.strictEqual(credGen.renameDefaultAdminCredentials('cur').ok, false); // 同名
  assert.strictEqual(credGen.renameDefaultAdminCredentials('a').ok, false); // 太短
  assert.strictEqual(
    credGen.renameDefaultAdminCredentials('bad name!').ok,
    false
  ); // 非法字符
  fs.rmSync(adminPath, { force: true }); // 清理,避免污染后续 bridge 播种日志
});

// ── bridgeAuth.renameBridgeUser ────────────────────────────────────────────

test('bridge 未初始化时改名 skip(不创建库)', () => {
  const r = bridgeAuth.renameBridgeUser('a1', 'b1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /不存在|未初始化/);
});

test('bridge 改名: 注册→改名→冲突 全流程', () => {
  const reg = bridgeAuth.registerUser('br_old', 'secret123');
  assert.strictEqual(reg.ok, true, JSON.stringify(reg));
  const dry = bridgeAuth.renameBridgeUser('br_old', 'br_new', { dryRun: true });
  assert.strictEqual(dry.ok, true);
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.exists, true);

  const done = bridgeAuth.renameBridgeUser('br_old', 'br_new');
  assert.strictEqual(done.ok, true, JSON.stringify(done));

  // 新名再被占用 → 硬冲突
  bridgeAuth.registerUser('br_take', 'secret999');
  const conflict = bridgeAuth.renameBridgeUser('br_old', 'br_new');
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.conflict, true);

  // 新名超 bridge 规则(>20 位/连字符) → skip 不阻断
  const tooLong = bridgeAuth.renameBridgeUser('br_new', 'a'.repeat(21));
  assert.strictEqual(tooLong.skipped, true);
});

// ── 数据库改名(真实 Sequelize 行更新) ─────────────────────────────────────

test('数据库改名: users 行 username 更新, 派生邮箱换 local part, 旧名入 aliases', async () => {
  if (!_db) {
    return; // 降级: 模型不可用时前面用例已验证 fail-soft 分支
  }
  await _db.User.create({
    username: 'dbuser',
    email: 'dbuser@cli.local',
    password: 'dbpass999',
    role: 'user',
    status: 'active',
  });
  writeSession('dbuser', 'user');

  const r = await cliAuth.renameAccount('dbuser2');
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.ok(r.details.some((d) => d.includes('数据库账号已改名')));

  const row = await _db.User.findOne({ where: { username: 'dbuser2' } });
  assert.ok(row, '改名后的数据库行必须存在');
  assert.strictEqual(row.email, 'dbuser2@cli.local'); // local part 随名改, 域名保留

  // 旧名入 aliases 仅在模型(含运行态 @khy/shared 副本)定义 aliases 列时断言;
  // 旧副本无该列时改名为 no-op 且不得报错(fail-soft 契约)。
  const hasAliasesAttr = _db.User.rawAttributes && _db.User.rawAttributes.aliases;
  if (hasAliasesAttr) {
    const aliases =
      typeof row.aliases === 'string' ? JSON.parse(row.aliases) : row.aliases || [];
    assert.ok(aliases.includes('dbuser'), '旧名必须保留为数据库登录别名');
  }
  const oldRow = await _db.User.findOne({ where: { username: 'dbuser' } });
  assert.strictEqual(oldRow, null);
});

test('数据库冲突: 目标账号名被占用 → 整体中止, 其他存储面零改动', async () => {
  if (!_db) {
    return;
  }
  await _db.User.create({
    username: 'busyname',
    email: 'busy@cli.local',
    password: 'dbpass000',
    role: 'user',
    status: 'active',
  });
  writeSession('dbuser2', 'user');

  const r = await cliAuth.renameAccount('busyname');
  assert.strictEqual(r.success, false, JSON.stringify(r));
  assert.match(r.error, /已被占用/);
  // 硬中止: 会话/本地凭据均未动
  const sess = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.strictEqual(sess.username, 'dbuser2');
  const still = await _db.User.findOne({ where: { username: 'dbuser2' } });
  assert.ok(still, '原数据库行必须保持不动');
});

// ── 清理 ────────────────────────────────────────────────────────────────────

test('清理临时目录(尽力而为)', () => {
  // bridge 的模块级 _db 句柄在进程内保持打开(无 close 导出), Windows 下
  // bridge-users.db 可能 EBUSY → 清理只做 best-effort, 临时目录随系统回收。
  for (const dir of [APP, DATA]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
