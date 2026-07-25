#!/usr/bin/env node
/**
 * @pattern Command
 */
/**
 * Reset or create AI management admin account credentials.
 *
 * Usage:
 *   node ai-backend/scripts/reset-admin-password.js
 *   node ai-backend/scripts/reset-admin-password.js --password admin123
 *   node ai-backend/scripts/reset-admin-password.js --username admin --password newpass
 */
const path = require('path');

if (!process.env.KHYQUANT_ROOT) {
  process.env.KHYQUANT_ROOT = path.resolve(__dirname, '../../backend');
}

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../backend/.env') });

function parseArg(name, fallback = '') {
  const idx = process.argv.findIndex(arg => arg === name);
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
  return 'admin123';
}

async function main() {
  const username = String(parseArg('--username', 'admin') || 'admin').trim() || 'admin';
  const password = resolvePassword();
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
  console.log(`[info] password=${password}`);
  if (dbPath) {
    console.log(`[info] sqlite=${dbPath}`);
  }
  await sequelize.close().catch(() => {});
}

main().catch(err => {
  console.error(`[error] ${err.message}`);
  process.exit(1);
});
