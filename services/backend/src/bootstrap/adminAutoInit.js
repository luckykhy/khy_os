/**
 * Default admin auto-initialization (idempotent).
 *
 * Runs after DB connection + schema sync during server startup.
 * - Creates the default admin account when it does not exist yet.
 * - NEVER overwrites an existing user's password or any other field.
 * - Failure must not block server startup (caller-safe: never throws).
 *
 * Env switches:
 *   KHY_ADMIN_AUTO_INIT  '0' / 'false' disables the whole routine (default: on)
 *   KHY_ADMIN_USERNAME   admin username override (default: sanitized OS user name)
 *   KHY_ADMIN_PASSWORD   admin password override (legacy DEFAULT_ADMIN_PASSWORD is
 *                        honored as fallback); when set, no credentials file is
 *                        written and nothing password-related is printed
 */
'use strict';

// Single source of truth for default credentials: credentialGenerator derives
// the username from the OS user and the password from machine fingerprint +
// random entropy, persisting plaintext once under .khy/credentials/.
// Password hashing is delegated to the User model's beforeCreate hook
// (bcryptjs, salt rounds = 10) — do NOT pre-hash here.
const {
  resolveDefaultAdminUsername,
  resolveDefaultAdminEmail,
  loadOrCreateDefaultAdminCredentials,
} = require('../services/credentialGenerator');

function isDisabled(env = process.env) {
  const raw = String(env.KHY_ADMIN_AUTO_INIT ?? '')
    .trim()
    .toLowerCase();
  return raw === '0' || raw === 'false';
}

/**
 * Ensure the default admin account exists. Idempotent and non-throwing.
 * @returns {Promise<{created: boolean, skipped: boolean, reason?: string}>}
 */
async function ensureDefaultAdmin() {
  let username = '';
  try {
    username = resolveDefaultAdminUsername();
    if (isDisabled()) {
      console.log(
        `ℹ️ 默认管理员自动初始化已通过 KHY_ADMIN_AUTO_INIT 禁用（用户名: ${username}），跳过`
      );
      return { created: false, skipped: true, reason: 'disabled' };
    }

    const { User } = require('../models');
    const existing = await User.findOne({ where: { username } });
    if (existing) {
      // Never touch an existing account (password/fields stay untouched).
      console.log(`ℹ️ 默认管理员已存在（用户名: ${username}），跳过自动初始化，未修改任何字段`);
      return { created: false, skipped: true, reason: 'exists' };
    }

    // Credentials from the unified generator (env override / persisted file /
    // freshly generated machine-derived password).
    const creds = loadOrCreateDefaultAdminCredentials();

    // Plain password here: the User model beforeCreate hook bcrypt-hashes it.
    await User.create({
      username: creds.username,
      password: creds.password,
      email: resolveDefaultAdminEmail(creds.username),
      role: 'admin',
      status: 'active',
    });

    // Never print the plaintext password — only where it was saved.
    if (creds.fromEnv) {
      console.log(`✅ 已生成初始管理员 ${creds.username}，密码来自环境变量，未写入凭据文件`);
    } else if (creds.filePath) {
      console.log(`✅ 已生成初始管理员 ${creds.username}，密码已保存至 ${creds.filePath}`);
    } else {
      console.log(
        `⚠️ 已生成初始管理员 ${creds.username}，但凭据文件写入失败，请通过 KHY_ADMIN_PASSWORD 重置密码`
      );
    }
    return { created: true, skipped: false };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err || 'unknown');
    console.error(`❌ 默认管理员自动初始化失败（目标: users 表，用户名: ${username}）: ${msg}`);
    try {
      const logger = require('../utils/logger');
      logger.warn('Default admin auto-init failed', { username, error: msg });
    } catch {
      /* logger may be unavailable in early bootstrap */
    }
    return { created: false, skipped: false, reason: msg };
  }
}

module.exports = { ensureDefaultAdmin };
