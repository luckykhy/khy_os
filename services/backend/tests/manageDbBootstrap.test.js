'use strict';

/**
 * manageDbBootstrap.test.js — 幂等 DB 自愈契约。
 *
 * 覆盖:门控(default-on + CANON off)、空库 → 建表 + 写 admin/admin123、二次调用幂等
 * (不重复建表/不重复写 admin)、门控关时不建表(逐字节回退今日「不自愈」行为)、fail-soft。
 *
 * 隔离:进程启动前把 SQLITE_DB_PATH 指向 tmp 空文件、DB_TYPE=sqlite,故整测用一个全新
 * 空库;sequelize 实例在首次 require('../models') 时按该路径构造(单例),因此各用例共享同
 * 一 db 文件,用例顺序刻意为:先 gate-off(证不建表)→ 再 gate-on(建表 + admin)→ 幂等。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// 必须在 require('../models') 之前设好,让 sequelize 单例绑定隔离库。
const TMP_DB = path.join(os.tmpdir(), `khy-manageseed-${process.pid}-${Date.now()}.sqlite`);
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DB_TYPE = 'sqlite';
process.env.DB_SQLITE3_OPTIONAL = '1';

const test = require('node:test');
const assert = require('node:assert');

const bootstrap = require(path.join(__dirname, '../src/services/manageDbBootstrap'));

test.after(() => {
  for (const f of [TMP_DB, `${TMP_DB}-journal`, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

test('isEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(bootstrap.isEnabled({}), true);
  assert.strictEqual(bootstrap.isEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(bootstrap.isEnabled({ KHY_MANAGE_DB_AUTOSEED: off }), false, `off=${off}`);
  }
  assert.strictEqual(bootstrap.isEnabled({ KHY_MANAGE_DB_AUTOSEED: 'yes' }), true);
});

test('gate OFF: no-op, does not create tables (byte-revert)', async () => {
  const out = await bootstrap.ensureManageDbSeeded({ KHY_MANAGE_DB_AUTOSEED: 'off' });
  assert.strictEqual(out.seeded, false);
  assert.strictEqual(out.reason, 'disabled');

  // Prove the users table is still absent on the shared empty DB.
  const { sequelize } = require('../src/models');
  let usersExists = true;
  try {
    await sequelize.getQueryInterface().describeTable('users');
  } catch (e) {
    const msg = String((e && e.message) || '').toLowerCase();
    usersExists = !(msg.includes('no description found') || msg.includes('no such table'));
  }
  assert.strictEqual(usersExists, false, 'gate-off must not create tables');
});

test('gate ON, empty DB: creates base tables + admin/admin123', async () => {
  const out = await bootstrap.ensureManageDbSeeded({});
  assert.strictEqual(out.seeded, true);
  assert.strictEqual(out.tablesCreated, true);
  assert.strictEqual(out.adminCreated, true);

  const { User } = require('../src/models');
  const admin = await User.findOne({ where: { username: 'admin' } });
  assert.ok(admin, 'admin row must exist');
  assert.strictEqual(admin.role, 'admin');
  assert.strictEqual(admin.status, 'active');

  // Password must be a bcrypt hash of admin123 (not stored plaintext).
  const bcrypt = require('bcryptjs');
  assert.ok(await bcrypt.compare('admin123', admin.password), 'admin123 must verify against stored hash');
  assert.ok(!admin.password.includes('admin123'), 'password must not be plaintext');
});

test('idempotent: second call creates nothing new', async () => {
  const out = await bootstrap.ensureManageDbSeeded({});
  assert.strictEqual(out.seeded, true);
  assert.strictEqual(out.tablesCreated, false, 'tables already present');
  assert.strictEqual(out.adminCreated, false, 'admin already present');

  const { User } = require('../src/models');
  const count = await User.count({ where: { username: 'admin' } });
  assert.strictEqual(count, 1, 'exactly one admin row');
});

test('fail-soft: never throws on garbage env', async () => {
  for (const junk of [null, 42, 'str', []]) {
    const out = await bootstrap.ensureManageDbSeeded(junk);
    assert.strictEqual(typeof out.seeded, 'boolean');
  }
});

// --- schema-drift heal (the khychat pip-upgrade 5×500 fix) ---
// Old behavior only synced when `users` was missing, so an upgraded DB (users present,
// but newer model tables like marketplace_plugins / user_workflows never created) left
// those routes 500ing "no such table". Trigger is now "ANY model table missing".

test('missingModelTables: [] when schema is complete (steady state)', async () => {
  const { sequelize } = require('../src/models');
  const missing = await bootstrap.missingModelTables(sequelize);
  assert.deepStrictEqual(missing, [], 'no drift after full seed');
});

test('schema drift heal: dropped model table is re-created while users stays intact', async () => {
  const { sequelize } = require('../src/models');
  const tableName = String(sequelize.models.MarketplacePlugin.getTableName());

  // Simulate an upgraded DB: users + most tables intact, one newer table absent.
  await sequelize.getQueryInterface().dropTable(tableName);

  const missingBefore = await bootstrap.missingModelTables(sequelize);
  assert.ok(missingBefore.includes(tableName.toLowerCase()), `drift must report ${tableName}`);

  // users still present — the OLD "users missing" trigger would NOT have synced here.
  assert.strictEqual(await bootstrap.tableExists(sequelize, 'users'), true, 'users unaffected');

  const out = await bootstrap.ensureManageDbSeeded({});
  assert.strictEqual(out.seeded, true);
  assert.strictEqual(out.tablesCreated, true, 'drift must trigger an additive sync');
  assert.ok(out.missingCount >= 1, 'missingCount reflects the drift');
  assert.strictEqual(out.adminCreated, false, 'admin already present — not re-created');

  assert.strictEqual(await bootstrap.tableExists(sequelize, tableName), true, 'table re-created');
  assert.deepStrictEqual(await bootstrap.missingModelTables(sequelize), [], 'no drift after heal');
});

test('gate OFF does not heal drift (byte-revert)', async () => {
  const { sequelize } = require('../src/models');
  const tableName = String(sequelize.models.UserInstalledPlugin.getTableName());
  await sequelize.getQueryInterface().dropTable(tableName);

  const out = await bootstrap.ensureManageDbSeeded({ KHY_MANAGE_DB_AUTOSEED: 'off' });
  assert.strictEqual(out.seeded, false);
  assert.strictEqual(out.reason, 'disabled');
  assert.strictEqual(await bootstrap.tableExists(sequelize, tableName), false, 'gate-off must not heal');

  // Re-heal so the shared DB is clean for any later assertions.
  await bootstrap.ensureManageDbSeeded({});
  assert.strictEqual(await bootstrap.tableExists(sequelize, tableName), true);
});

// --- column-level drift heal (additive ADD COLUMN) ---
// `sync({alter:false})` never adds columns to an EXISTING table, so an upgraded DB whose
// old table is missing a newly-added model column 500s "no such column" (marketplace /
// plugins have no self-heal service). backfillMissingColumns closes this additively.

test('missingColumns: [] when a model table has all its columns (steady state)', async () => {
  const { sequelize } = require('../src/models');
  const missing = await bootstrap.missingColumns(sequelize, sequelize.models.User);
  assert.deepStrictEqual(missing, [], 'no column drift after full sync');
});

test('missingColumns: table absent → [] (delegated to table-level sync)', async () => {
  const { sequelize } = require('../src/models');
  const model = sequelize.models.MarketplacePlugin;
  const tableName = String(model.getTableName());
  await sequelize.getQueryInterface().dropTable(tableName);
  const missing = await bootstrap.missingColumns(sequelize, model);
  assert.deepStrictEqual(missing, [], 'missing table is not a column-drift concern');
  await bootstrap.ensureManageDbSeeded({}); // restore
});

test('column drift heal: a manually-dropped column is re-added, existing rows preserved', async () => {
  const { sequelize } = require('../src/models');
  const qi = sequelize.getQueryInterface();

  // Simulate an old marketplace_plugins table lacking a newer column. SQLite cannot DROP
  // COLUMN on older engines, so rebuild the table WITHOUT one model column, with a data row.
  const model = sequelize.models.MarketplacePlugin;
  const tableName = String(model.getTableName());
  const attrs = model.getAttributes();
  // pick a nullable, non-PK column to omit
  const omit = Object.entries(attrs).find(([k, a]) =>
    a && a.field && !a.primaryKey && a.allowNull !== false
    && !(a.type && a.type.constructor && a.type.constructor.key === 'VIRTUAL'));
  assert.ok(omit, 'need a droppable column to simulate drift');
  const omitField = String(omit[1].field);

  await qi.dropTable(tableName);
  // minimal recreate: id + a couple of guaranteed columns, WITHOUT omitField.
  await sequelize.query(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, name TEXT)`);
  await sequelize.query(`INSERT INTO ${tableName} (name) VALUES ('legacy-row')`);

  const before = await bootstrap.missingColumns(sequelize, model);
  assert.ok(before.some((c) => c.field === omitField), `drift must report ${omitField}`);

  const out = await bootstrap.ensureManageDbSeeded({});
  assert.strictEqual(out.seeded, true);
  assert.ok(out.columnsAdded >= 1, 'column backfill must add at least the omitted column');

  const desc = await qi.describeTable(tableName);
  assert.ok(Object.keys(desc).map((c) => c.toLowerCase()).includes(omitField.toLowerCase()),
    `${omitField} must be re-added`);
  const [rows] = await sequelize.query(`SELECT COUNT(*) AS c FROM ${tableName} WHERE name='legacy-row'`);
  assert.strictEqual(Number(rows[0].c), 1, 'existing row must be preserved (additive, never drop)');

  // fully heal for steady-state, then confirm idempotent (no further columns).
  await bootstrap.ensureManageDbSeeded({});
  assert.deepStrictEqual(await bootstrap.missingColumns(sequelize, model), [], 'no drift after heal');
});

test('admin check survives users column drift (raw-SQL existence, not User.findOne)', async () => {
  const { sequelize } = require('../src/models');
  const qi = sequelize.getQueryInterface();

  // Rebuild users WITHOUT last_login_at (a real newer column) + keep a non-admin row, drop admin.
  await qi.dropTable('users');
  await sequelize.query(
    'CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT, email TEXT, '
      + 'role TEXT, status TEXT, created_at TEXT, updated_at TEXT)'
  );
  await sequelize.query(
    "INSERT INTO users (username,password,email,role,status,created_at,updated_at) "
      + "VALUES ('someone','x','s@s','user','active','t','t')"
  );

  const out = await bootstrap.ensureManageDbSeeded({});
  assert.strictEqual(out.seeded, true, 'bootstrap must not silently fail on users column drift');
  assert.strictEqual(out.adminCreated, true, 'admin must be created despite the drift');

  const descAfter = await qi.describeTable('users');
  assert.ok(Object.keys(descAfter).includes('last_login_at'), 'users.last_login_at backfilled');

  // Full-model read now works (drift healed) and the pre-existing row is intact.
  const { User } = require('../src/models');
  const admin = await User.findOne({ where: { username: 'admin' } });
  assert.ok(admin && admin.role === 'admin', 'admin readable via full model post-heal');
  const [c] = await sequelize.query("SELECT COUNT(*) AS c FROM users WHERE username='someone'");
  assert.strictEqual(Number(c[0].c), 1, 'pre-existing user row preserved');
});
