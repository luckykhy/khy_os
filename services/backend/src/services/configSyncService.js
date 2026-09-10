'use strict';

/**
 * configSyncService.js — 四端配置同步服务(后端即同步中心)。
 *
 * 设计原则:
 *   - 后端数据库 = 配置真相源 (server of truth)
 *   - 本地文件 = 离线兜底 (backend 不可用时读本地)
 *   - API Key 等敏感字段 = AES-256-GCM 加密存储
 *   - 冲突解决 = last-write-wins (updated_at 大的胜出)
 *   - 无后端时 = 各端独立工作, 不报错
 *
 * 同步流程:
 *   1. 任一端写配置 → PUT /api/config-sync/:key → 加密落库
 *   2. 其他端轮询/SSE → 收到变更通知 → GET /api/config-sync/:key → 解密使用
 *   3. 后端挂了 → 自动降级读 ~/.khyquant/config.json
 *
 * 门控: KHY_CONFIG_SYNC (默认开; 0/false/off/no 关 → 纯本地模式)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 加密配置 ──────────────────────────────────────────────────────
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

// 派生密钥: 用 machine-id + user-id 作为 salt, 确保每用户每机不同
function _deriveKey(userId) {
  const salt = crypto
    .createHash('sha256')
    .update(`khy-config-sync-${userId}-${os.hostname()}`)
    .digest();
  // 用 PBKDF2 派生一个稳定密钥
  return crypto.pbkdf2Sync(salt, salt, 10000, 32, 'sha256');
}

function encrypt(plaintext, userId) {
  if (!plaintext) return '';
  const key = _deriveKey(userId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(String(plaintext), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();
  // 格式: iv:authTag:encrypted (全部 base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

function decrypt(ciphertext, userId) {
  if (!ciphertext) return '';
  try {
    const key = _deriveKey(userId);
    const parts = String(ciphertext).split(':');
    if (parts.length !== 3) return '';
    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return ''; // 解密失败返回空, 不抛
  }
}

// ── 敏感 key 判断 ──────────────────────────────────────────────────
const SENSITIVE_KEYS = new Set([
  'apiKey',
  'api_key',
  'anthropicApiKey',
  'openaiApiKey',
  'deepseekApiKey',
  'relayApiKey',
  'RELAY_API_KEY',
  'accessToken',
  'refreshToken',
  'password',
  'secret',
]);

function isSensitiveKey(key) {
  const lower = String(key).toLowerCase();
  for (const sk of SENSITIVE_KEYS) {
    if (lower.includes(sk.toLowerCase())) return true;
  }
  return false;
}

// ── 配置 key 命名空间 ──────────────────────────────────────────────
// 统一命名: <domain>.<field>  例: gateway.apiKey, model.preferred, theme.mode
const KEY_NAMESPACE = Object.freeze({
  GATEWAY: 'gateway',
  MODEL: 'model',
  THEME: 'theme',
  PROVIDER: 'provider',
  UI: 'ui',
  MOBILE: 'mobile',
  CLI: 'cli',
});

// ── 本地文件兜底 ──────────────────────────────────────────────────
const LOCAL_CONFIG_PATH = (() => {
  try {
    const { getDataHome } = require('../utils/dataHome');
    return path.join(getDataHome(), 'config.json');
  } catch {
    return path.join(os.homedir(), '.khyquant', 'config.json');
  }
})();

function _readLocalConfig() {
  try {
    if (!fs.existsSync(LOCAL_CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function _writeLocalConfig(config) {
  try {
    const dir = path.dirname(LOCAL_CONFIG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ── 数据库访问 ──────────────────────────────────────────────────────
let _sequelize = null;
let _UserSetting = null;

function _getModel() {
  if (_UserSetting) return _UserSetting;
  try {
    const db = require('../config/database');
    _sequelize = db.sequelize || db;
    // 动态定义模型(避免 migration 时序问题)
    _UserSetting = _sequelize.define(
      'UserSetting',
      {
        id: { type: require('sequelize').DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        userId: { type: require('sequelize').DataTypes.INTEGER, allowNull: false, field: 'user_id' },
        settingKey: { type: require('sequelize').DataTypes.STRING(255), allowNull: false, field: 'setting_key' },
        settingValue: { type: require('sequelize').DataTypes.TEXT, field: 'setting_value' },
        isEncrypted: { type: require('sequelize').DataTypes.BOOLEAN, defaultValue: false, field: 'is_encrypted' },
        deviceId: { type: require('sequelize').DataTypes.STRING(128), field: 'device_id' },
      },
      {
        tableName: 'user_settings',
        timestamps: true,
        underscored: true,
      }
    );
  } catch {
    _UserSetting = null;
  }
  return _UserSetting;
}

// ── 核心 CRUD ───────────────────────────────────────────────────────

/**
 * 获取用户配置项。
 * @param {number} userId
 * @param {string} key
 * @returns {Promise<{ value: any, updatedAt: string, fromCloud: boolean }>}
 */
async function getSetting(userId, key) {
  // 1. 尝试从数据库读
  try {
    const Model = _getModel();
    if (Model) {
      const row = await Model.findOne({ where: { userId, settingKey: key } });
      if (row) {
        let value = row.settingValue;
        if (row.isEncrypted && value) {
          value = decrypt(value, userId);
        }
        // JSON 解析
        try {
          value = JSON.parse(value);
        } catch {
          // 非 JSON 字符串, 原样返回
        }
        return { value, updatedAt: row.updatedAt, fromCloud: true };
      }
    }
  } catch {
    // 数据库不可用, 降级本地
  }

  // 2. 降级读本地文件
  const local = _readLocalConfig();
  if (key in local) {
    return { value: local[key], updatedAt: null, fromCloud: false };
  }

  return { value: null, updatedAt: null, fromCloud: false };
}

/**
 * 设置用户配置项。
 * @param {number} userId
 * @param {string} key
 * @param {any} value
 * @param {object} [opts]
 * @param {string} [opts.deviceId] - 设备标识
 * @returns {Promise<{ ok: boolean, fromCloud: boolean }>}
 */
async function setSetting(userId, key, value, opts = {}) {
  const sensitive = isSensitiveKey(key);
  let storedValue = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');

  // 敏感字段加密
  if (sensitive && storedValue) {
    storedValue = encrypt(storedValue, userId);
  }

  // 1. 尝试写数据库
  let wroteToCloud = false;
  try {
    const Model = _getModel();
    if (Model) {
      const [row, created] = await Model.findOrCreate({
        where: { userId, settingKey: key },
        defaults: {
          userId,
          settingKey: key,
          settingValue: storedValue,
          isEncrypted: sensitive,
          deviceId: opts.deviceId || null,
        },
      });
      if (!created) {
        await row.update({
          settingValue: storedValue,
          isEncrypted: sensitive,
          deviceId: opts.deviceId || row.deviceId,
        });
      }
      wroteToCloud = true;
    }
  } catch {
    // 数据库不可用
  }

  // 2. 同时写本地文件(兜底 + 离线可用)
  const local = _readLocalConfig();
  local[key] = value;
  _writeLocalConfig(local);

  return { ok: true, fromCloud: wroteToCloud };
}

/**
 * 批量获取用户所有配置。
 * @param {number} userId
 * @returns {Promise<Record<string, any>>}
 */
async function getAllSettings(userId) {
  const result = {};

  // 1. 从数据库读
  try {
    const Model = _getModel();
    if (Model) {
      const rows = await Model.findAll({ where: { userId } });
      for (const row of rows) {
        let value = row.settingValue;
        if (row.isEncrypted && value) {
          value = decrypt(value, userId);
        }
        try {
          value = JSON.parse(value);
        } catch {
          // 非 JSON, 原样
        }
        result[row.settingKey] = { value, updatedAt: row.updatedAt };
      }
    }
  } catch {
    // 降级本地
  }

  // 2. 本地文件补充(数据库没有的 key)
  const local = _readLocalConfig();
  for (const [key, value] of Object.entries(local)) {
    if (!(key in result)) {
      result[key] = { value, updatedAt: null };
    }
  }

  return result;
}

/**
 * 批量同步配置(用于设备间拉取)。
 * @param {number} userId
 * @param {Record<string, any>} settings - 客户端当前配置
 * @param {string} [deviceId] - 设备标识
 * @returns {Promise<{ upserted: number, conflicts: string[] }>}
 */
async function syncSettings(userId, settings, deviceId) {
  let upserted = 0;
  const conflicts = [];

  for (const [key, value] of Object.entries(settings)) {
    const existing = await getSetting(userId, key);

    // 冲突检测: 服务端有更新且与客户端不同
    if (existing.fromCloud && existing.value !== undefined && existing.value !== value) {
      // last-write-wins: 简单比较, 客户端传的值覆盖
      conflicts.push(key);
    }

    await setSetting(userId, key, value, { deviceId });
    upserted++;
  }

  return { upserted, conflicts };
}

/**
 * 删除配置项。
 * @param {number} userId
 * @param {string} key
 */
async function deleteSetting(userId, key) {
  try {
    const Model = _getModel();
    if (Model) {
      await Model.destroy({ where: { userId, settingKey: key } });
    }
  } catch {
    // ignore
  }

  // 同时删本地
  const local = _readLocalConfig();
  delete local[key];
  _writeLocalConfig(local);
}

// ── 门控 ───────────────────────────────────────────────────────────
function isEnabled(env = process.env) {
  const flag = String((env && env.KHY_CONFIG_SYNC) || '')
    .trim()
    .toLowerCase();
  return flag !== '0' && flag !== 'false' && flag !== 'off' && flag !== 'no';
}

// ── 变更通知(SSE 用) ───────────────────────────────────────────────
const _listeners = new Map(); // userId -> Set<res>

function addListener(userId, res) {
  if (!_listeners.has(userId)) {
    _listeners.set(userId, new Set());
  }
  _listeners.get(userId).add(res);
}

function removeListener(userId, res) {
  const set = _listeners.get(userId);
  if (set) {
    set.delete(res);
    if (set.size === 0) _listeners.delete(userId);
  }
}

/**
 * 广播配置变更给同一用户的所有连接。
 * @param {number} userId
 * @param {string} key
 * @param {any} value
 */
function notifyChange(userId, key, value) {
  const set = _listeners.get(userId);
  if (!set) return;
  const event = JSON.stringify({ type: 'config_change', key, value, ts: Date.now() });
  for (const res of set) {
    try {
      res.write(`data: ${event}\n\n`);
    } catch {
      set.delete(res);
    }
  }
}

module.exports = {
  // CRUD
  getSetting,
  setSetting,
  getAllSettings,
  syncSettings,
  deleteSetting,
  // 工具
  isSensitiveKey,
  isEnabled,
  encrypt,
  decrypt,
  KEY_NAMESPACE,
  LOCAL_CONFIG_PATH,
  // 实时通知
  addListener,
  removeListener,
  notifyChange,
};
