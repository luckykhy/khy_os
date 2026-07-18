'use strict';

/**
 * manageDbBootstrap.js — 幂等 DB 自愈:管理服务(aiManagementServer)启动时,若底层
 * SQLite 库缺任一已注册 model 表(空库 **或** 升级后的 schema drift),additive 建齐缺
 * 表并写入 log 里 advertise 的 `admin / admin123` 账号,让新装 / 升级(pip install)环境
 * **首次即可登录**、DB 支撑路由(khychat 的 /api/marketplace、/api/workflow、
 * /api/plugins、/api/user-gateway 等)不再 500。
 *
 * 背景(已逐行核实):
 *   - 新装环境 SQLite 库由 sequelize 自动创建为空库;`scripts/seed.js`(建表 + 写 admin)
 *     是手动步骤,pip 装后无人运行。
 *   - `admin/admin123` 不是内置账号(cliAuthService._BUILTIN_ACCOUNTS 只有 admin05/youke5),
 *     故登录落到 DB 分支 `User.findOne`(aiManagementServer.js:889)→ 抛
 *     `SQLITE_ERROR: no such table: users` → catch 返 500(:926-931)。
 *   - **schema drift**:老库里 `users` 早已存在,但后加的 model 表(marketplace_plugins /
 *     user_workflows / user_installed_plugins / user_gateway_configs 等)从未建 —— 升级后
 *     旧「仅当 users 缺失才 sync」的触发条件永远不成立,这些新表始终不建,对应路由
 *     稳定 500「no such table」。故触发条件从「users 缺失」放宽为「任一 model 表缺失」。
 *
 * 单一真源:建表 + admin upsert 逻辑镜像 `scripts/seed.js`(ensureBaseTables:54-69 /
 * admin upsert:207-224,同款凭据、同款预哈希 raw SQL 避免 model hook 双哈希)。**只**建
 * base 表 + admin,不跑 seed.js 的样例策略/合约数据(避免重活/污染真实库)。
 *
 * 契约:
 *   - 门控 KHY_MANAGE_DB_AUTOSEED(default-on·off:CANON)。关 / 任何异常 → 直接返回
 *     `{ seeded:false, reason }`,不建表、不写账号(逐字节回退到今日「不自愈」行为)。
 *   - best-effort:全程 try/catch 包裹,**绝不抛**(调用方 await 时不会因它 reject)。
 *   - 幂等 + additive-only:仅当有 model 表缺失才 sync,且 `alter:false, force:false`
 *     (= CREATE TABLE IF NOT EXISTS,从不 drop / alter 既有表 / 触碰既有数据);对已存在
 *     表另做 additive column backfill(只 `ADD COLUMN`·allowNull·从不改类型/删列),收口
 *     升级后「老表缺新列」的 500「no such column」;仅当 admin 不存在才 INSERT。
 *
 * 注:本模块**非纯叶子**(有 DB IO),故不走 leaf-contract 守卫、不加叶子注释 token。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('./flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_MANAGE_DB_AUTOSEED', e);
  } catch {
    const raw = e && e.KHY_MANAGE_DB_AUTOSEED;
    if (raw === undefined || raw === null) return true;
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  }
}

/**
 * 判定某表是否存在(镜像 seed.js:tableExists)。缺失特征返 false,其它异常上抛给调用方兜底。
 */
async function tableExists(sequelize, tableName) {
  const queryInterface = sequelize.getQueryInterface();
  try {
    await queryInterface.describeTable(tableName);
    return true;
  } catch (error) {
    const message = String((error && error.message) || '').toLowerCase();
    if (message.includes('no description found') || message.includes('no such table')) {
      return false;
    }
    throw error;
  }
}

/**
 * 列出「已注册 model 但库中缺失」的表名(schema drift 检测)。空数组 = 库已含全部 model
 * 表(稳态);非空 = 需 additive sync。任何异常上抛给调用方 try/catch 兜底。
 *
 * 归一化:`showAllTables()` 在不同方言 / sequelize 版本可能返回 `string[]` 或
 * `[{ tableName }]`;`model.getTableName()` 同理可能是 string 或 `{ tableName, schema }`。
 * 一律取表名小写比对。库里多出的表(sqlite_sequence 等内部表)不影响判定。
 */
async function missingModelTables(sequelize) {
  require('../models'); // 确保全部 model 注册,sequelize.models 完整
  const queryInterface = sequelize.getQueryInterface();
  const existingRaw = await queryInterface.showAllTables();
  const existing = new Set(
    (existingRaw || []).map((t) => String((t && t.tableName) || t).toLowerCase())
  );
  const missing = [];
  for (const model of Object.values(sequelize.models)) {
    const tn = model.getTableName();
    const name = String((tn && tn.tableName) || tn).toLowerCase();
    if (!existing.has(name)) missing.push(name);
  }
  return missing;
}

/**
 * 列出某已存在表「model 已声明但库中缺失」的列(column-level schema drift 检测)。
 *
 * `sequelize.sync({alter:false})` 只 CREATE TABLE IF NOT EXISTS —— 对**已存在**的表**从不**
 * 加列。故升级场景里,老表在、但 model 后加了列时,读该列的路由会 500「no such column」。
 * 本函数为 additive column backfill 提供缺列清单。表不存在 → 返回 `[]`(交给 table-level
 * sync 处理)。VIRTUAL 属性(无物理列)跳过。
 *
 * @returns {Promise<Array<{ field: string, attr: object }>>}
 */
async function missingColumns(sequelize, model) {
  const queryInterface = sequelize.getQueryInterface();
  const tableName = model.getTableName();
  let described;
  try {
    described = await queryInterface.describeTable(tableName);
  } catch (error) {
    const message = String((error && error.message) || '').toLowerCase();
    if (message.includes('no description found') || message.includes('no such table')) {
      return []; // 表不存在 —— 非本函数职责
    }
    throw error;
  }
  const existing = new Set(Object.keys(described || {}).map((c) => String(c).toLowerCase()));
  const attrs = (model.getAttributes ? model.getAttributes() : model.rawAttributes) || {};
  const missing = [];
  for (const [key, attr] of Object.entries(attrs)) {
    if (!attr) continue;
    const type = attr.type;
    // VIRTUAL 属性不落物理列,跳过(否则 addColumn 会失败或造出多余列)。
    if (type && type.constructor && type.constructor.key === 'VIRTUAL') continue;
    const field = String(attr.field || key);
    if (!existing.has(field.toLowerCase())) missing.push({ field, attr });
  }
  return missing;
}

/**
 * 对所有已注册 model 的已存在表补齐缺失列(additive·`ALTER TABLE ADD COLUMN`)。
 *
 * - **纯 additive**:只 addColumn,**从不** drop / alter / 改类型,绝不动既有数据。
 * - **强制 allowNull:true**:对已有行,新列必须可空(即便 model 声明 NOT NULL 且无默认值,
 *   也不能让既有行违反约束)——这是「让老库不再 500」而非「完美迁移」。
 * - **逐列 best-effort**:单列失败(如方言不支持某类型)不影响其它列 / 其它表。
 *
 * @returns {Promise<number>} 实际新增的列数(稳态 = 0)。
 */
async function backfillMissingColumns(sequelize) {
  const queryInterface = sequelize.getQueryInterface();
  let added = 0;
  for (const model of Object.values(sequelize.models)) {
    let cols;
    try {
      cols = await missingColumns(sequelize, model);
    } catch {
      continue; // 该表探测失败 → 跳过,不阻断其它表
    }
    if (!cols.length) continue;
    const tableName = model.getTableName();
    for (const { field, attr } of cols) {
      try {
        await queryInterface.addColumn(tableName, field, { type: attr.type, allowNull: true });
        added += 1;
      } catch {
        /* best-effort per column — 方言/类型不支持则跳过该列 */
      }
    }
  }
  return added;
}

/**
 * 确保底层库有 base 表 + `admin / admin123`(role=admin, status=active)。
 *
 * @param {object} [env] 环境变量(默认 process.env),用于门控。
 * @returns {Promise<{ seeded: boolean, reason?: string, tablesCreated?: boolean, adminCreated?: boolean }>}
 *   门控关 / 异常 → `{ seeded:false, reason }`(never throws)。
 */
async function ensureManageDbSeeded(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  if (!isEnabled(e)) {
    return { seeded: false, reason: 'disabled' };
  }

  try {
    const bcrypt = require('bcryptjs');
    const { sequelize } = require('../models');

    // 1. schema drift 自愈:任一已注册 model 表缺失则 sync(additive·CREATE IF NOT
    //    EXISTS)。覆盖两种病症:(a) 空库(users 缺失)—— 首装从未 seed;(b) 老库缺新表
    //    (users 在、但 marketplace_plugins / user_workflows / user_installed_plugins /
    //    user_gateway_configs 等后加的表缺)—— 升级后 khychat 对应路由稳定 500
    //    「no such table」。alter:false 保证从不改动既有表 / 数据。
    let tablesCreated = false;
    const missing = await missingModelTables(sequelize);
    if (missing.length > 0) {
      await sequelize.sync({ alter: false, force: false });
      tablesCreated = true;
      const usersExistsAfterSync = await tableExists(sequelize, 'users');
      if (!usersExistsAfterSync) {
        return { seeded: false, reason: 'sync-did-not-create-users' };
      }
    }

    // 2. column-level drift 自愈:已存在表补齐 model 后加的列(additive·allowNull)。
    //    `sync({alter:false})` 对已存在表**不**加列 → 升级后老表缺新列的路由 500
    //    「no such column」(marketplace / plugins 等无自愈 service 的路由尤甚)。此步与
    //    table-level 独立运行:表全在但列缺时 missing=[] 不 sync,列 drift 仍需在此收口。
    //    best-effort,绝不 drop/alter 既有列,失败不阻断后续。
    let columnsAdded = 0;
    try {
      columnsAdded = await backfillMissingColumns(sequelize);
    } catch {
      columnsAdded = 0; // 列自愈失败不影响 table 自愈 / admin 写入
    }

    // 3. 幂等确保 admin(镜像 seed.js:207-224,预哈希 + raw SQL 避免 model hook 双哈希)。
    //    存在性判定用 **raw SQL COUNT** 而非 `User.findOne`——后者 SELECT 全部 model 列,
    //    若 users 表尚有未 backfill 的列 drift 会抛「no such column」,把整个 bootstrap
    //    带进 catch → seeded:false、admin 漏建。raw `SELECT 1` 只碰 username,免疫列 drift。
    let adminCreated = false;
    const [adminRows] = await sequelize.query(
      'SELECT 1 FROM users WHERE username = :username LIMIT 1',
      { replacements: { username: 'admin' } }
    );
    const adminExists = Array.isArray(adminRows) && adminRows.length > 0;
    if (!adminExists) {
      // 登记:'admin123' 为首启 seed 的示范默认口令(默认账号 admin),非真实凭据;
      // 真实部署应经 env 覆盖或首登强制改密。pragma: allowlist secret
      const adminPassword = await bcrypt.hash('admin123', 10); // pragma: allowlist secret
      const now = new Date().toISOString();
      await sequelize.query(
        'INSERT INTO users (username, password, email, role, status, created_at, updated_at) '
          + 'VALUES (:username, :password, :email, :role, :status, :now, :now)',
        {
          replacements: {
            username: 'admin',
            password: adminPassword,
            email: 'admin@khy-quant.com',
            role: 'admin',
            status: 'active',
            now,
          },
        }
      );
      adminCreated = true;
    }

    return { seeded: true, tablesCreated, columnsAdded, adminCreated, missingCount: missing.length };
  } catch (err) {
    // best-effort:绝不阻断服务启动。
    return { seeded: false, reason: (err && err.message) || 'error' };
  }
}

module.exports = { isEnabled, ensureManageDbSeeded, tableExists, missingModelTables, missingColumns, backfillMissingColumns };
