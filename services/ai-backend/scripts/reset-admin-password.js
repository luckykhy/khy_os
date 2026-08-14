#!/usr/bin/env node
/**
 * @pattern Command
 */
/**
 * Reset or create AI management admin account credentials.
 *
 * Usage:
 *   node ai-backend/scripts/reset-admin-password.js --password <new-password>
 *   node ai-backend/scripts/reset-admin-password.js --username admin --password <new-password>
 *
 * The password MUST be provided explicitly (--password / AI_MGMT_ADMIN_PASSWORD /
 * DEFAULT_ADMIN_PASSWORD) — there is no built-in default anymore.
 */
const path = require('path');

if (!process.env.KHYQUANT_ROOT) {
  process.env.KHYQUANT_ROOT = path.resolve(__dirname, '../../backend');
}

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../backend/.env') });

function parseArg(name, fallback = '') {
  const idx = process.argv.findIndex((arg) => arg === name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function resolvePassword() {
  const fromArg = parseArg('--password', '').trim();
  if (fromArg) return fromArg;
  const fromEnv = String(process.env.AI_MGMT_ADMIN_PASSWORD || '').trim();
  if (fromEnv) return fromEnv;
  const fromDefaultEnv = String(process.env.DEFAULT_ADMIN_PASSWORD || '').trim();
  if (fromDefaultEnv) return fromDefaultEnv;
  // No hardcoded fallback — refuse instead of resetting to a weak default.
  return '';
}

async function main() {
  const username = String(parseArg('--username', 'admin') || 'admin').trim() || 'admin';
  const password = resolvePassword();
  if (!password) {
    console.error(
      '[error] 未提供新密码。请使用 --password 参数或 AI_MGMT_ADMIN_PASSWORD / DEFAULT_ADMIN_PASSWORD 环境变量指定；初始自动生成的凭据见数据目录 .khy/credentials/default-admin.json'
    );
    process.exit(1);
  }
  const defaultEmail = `${username}@khy-quant.com`;
  const email = String(parseArg('--email', defaultEmail) || defaultEmail).trim() || defaultEmail;

  const { User, sequelize } = require('@khy/shared/models');
  const { getSQLitePath } = require('@khy/shared/config/database');

  try {
    await sequelize.sync({ force: false });
  } catch (syncErr) {
    console.warn(`[warn] sequelize sync failed: ${syncErr.message}`);
  }

  let user = await User.findOne({ where: { username } });
  if (!user) {
    user = await User.create({
      username,
      email,
      password,
      role: 'admin',
      status: 'active',
    });
    console.log(`[ok] admin user created: ${username}`);
  } else {
    const updates = {
      password,
      role: 'admin',
      status: 'active',
    };
    if (!user.email) updates.email = email;
    await user.update(updates);
    console.log(`[ok] admin password reset: ${username}`);
  }

  let dbPath = '';
  try {
    dbPath = getSQLitePath();
  } catch {
    dbPath = '';
  }

  console.log(`[info] username=${username}`);
  // The plaintext password is intentionally not echoed back.
  if (dbPath) {
    console.log(`[info] sqlite=${dbPath}`);
  }
  await sequelize.close().catch(() => {});
}

main().catch((err) => {
  console.error(`[error] ${err.message}`);
  process.exit(1);
});
