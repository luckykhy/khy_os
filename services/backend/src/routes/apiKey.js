const express = require('express');
const router = express.Router();
const { QueryTypes } = require('sequelize');
const { authMiddleware } = require('../middleware/auth');
const { sequelize } = require('../models');
const { hashApiKey, generateKey } = require('@khy/shared/utils/apiKeyHash');

let _apiKeySchemaCache = null;
let _apiKeySchemaCachedAt = 0;
const API_KEY_SCHEMA_CACHE_MS = 60 * 1000;

function hasColumn(schema, name) {
  return !!(schema && Object.prototype.hasOwnProperty.call(schema, name));
}

async function getApiKeySchema() {
  const now = Date.now();
  if (_apiKeySchemaCache && (now - _apiKeySchemaCachedAt) < API_KEY_SCHEMA_CACHE_MS) {
    return _apiKeySchemaCache;
  }
  const queryInterface = sequelize.getQueryInterface();
  const schema = await queryInterface.describeTable('api_keys');
  _apiKeySchemaCache = schema;
  _apiKeySchemaCachedAt = now;
  return schema;
}

function mapApiKeyRow(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    keyPrefix: row.key_prefix || row.keyPrefix || '',
    label: row.label || 'default',
    isActive: typeof row.is_active === 'boolean' ? row.is_active : (typeof row.isActive === 'boolean' ? row.isActive : true),
    lastUsedAt: row.last_used_at || row.lastUsedAt || null,
    createdAt: row.created_at || row.createdAt || null,
  };
}

async function findActiveApiKeyByUserId(userId) {
  const schema = await getApiKeySchema();
  const activeClause = hasColumn(schema, 'is_active') ? 'AND is_active = :isActive' : '';
  const rows = await sequelize.query(
    `SELECT id, key_prefix, label, is_active, last_used_at, created_at
       FROM api_keys
      WHERE user_id = :userId
        ${activeClause}
      ORDER BY id DESC
      LIMIT 1`,
    {
      replacements: { userId: Number(userId), isActive: true },
      type: QueryTypes.SELECT,
    }
  );
  return mapApiKeyRow(rows[0] || null);
}

async function deactivateApiKeyById(id) {
  const schema = await getApiKeySchema();
  if (!hasColumn(schema, 'is_active')) return;
  const hasUpdatedAt = hasColumn(schema, 'updated_at');
  await sequelize.query(
    `UPDATE api_keys
        SET is_active = :inactive${hasUpdatedAt ? ', updated_at = :updatedAt' : ''}
      WHERE id = :id`,
    {
      replacements: {
        inactive: false,
        updatedAt: new Date(),
        id: Number(id),
      },
      type: QueryTypes.UPDATE,
    }
  );
}

async function deactivateAllApiKeysByUserId(userId) {
  const schema = await getApiKeySchema();
  if (!hasColumn(schema, 'is_active')) return;
  const hasUpdatedAt = hasColumn(schema, 'updated_at');
  await sequelize.query(
    `UPDATE api_keys
        SET is_active = :inactive${hasUpdatedAt ? ', updated_at = :updatedAt' : ''}
      WHERE user_id = :userId
        AND is_active = :active`,
    {
      replacements: {
        inactive: false,
        updatedAt: new Date(),
        userId: Number(userId),
        active: true,
      },
      type: QueryTypes.UPDATE,
    }
  );
}

async function createApiKeyRecord(userId, rawKey, label) {
  const schema = await getApiKeySchema();
  const now = new Date();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  const columns = ['user_id'];
  const values = [':userId'];
  const replacements = {
    userId: Number(userId),
    keyHash,
    keyPrefix,
    label: String(label || 'default'),
    now,
    isActive: true,
  };

  if (hasColumn(schema, 'key_hash')) {
    columns.push('key_hash');
    values.push(':keyHash');
  }
  if (hasColumn(schema, 'key')) {
    // Legacy compatibility: keep this column non-sensitive by storing hash, not plaintext key.
    columns.push('"key"');
    values.push(':keyHash');
  }
  if (hasColumn(schema, 'key_prefix')) {
    columns.push('key_prefix');
    values.push(':keyPrefix');
  }
  if (hasColumn(schema, 'label')) {
    columns.push('label');
    values.push(':label');
  }
  if (hasColumn(schema, 'is_active')) {
    columns.push('is_active');
    values.push(':isActive');
  }
  if (hasColumn(schema, 'created_at')) {
    columns.push('created_at');
    values.push(':now');
  }
  if (hasColumn(schema, 'updated_at')) {
    columns.push('updated_at');
    values.push(':now');
  }

  await sequelize.query(
    `INSERT INTO api_keys (${columns.join(', ')}) VALUES (${values.join(', ')})`,
    { replacements, type: QueryTypes.INSERT }
  );

  const insertedRows = await sequelize.query(
    `SELECT id, key_prefix, label, is_active, last_used_at, created_at
       FROM api_keys
      WHERE user_id = :userId
      ORDER BY id DESC
      LIMIT 1`,
    {
      replacements: { userId: Number(userId) },
      type: QueryTypes.SELECT,
    }
  );
  const created = mapApiKeyRow(insertedRows[0] || null);
  if (!created) throw new Error('Failed to fetch newly created API key record');
  return { record: created, key: rawKey };
}

// --------------------------------------------------------------------
// POST /api/api-keys/generate — Create a new API key (JWT required)
// --------------------------------------------------------------------
router.post('/generate', authMiddleware, async (req, res) => {
  try {
    const label = req.body.label || 'default';

    // Deactivate any existing active keys for this user.
    await deactivateAllApiKeysByUserId(req.user.id);

    const created = await createApiKeyRecord(req.user.id, generateKey(), label);

    res.status(201).json({
      success: true,
      message: 'API key generated — copy it now, it will not be shown again in full',
      data: {
        id: created.record.id,
        key: created.key, // Full key — shown only on creation
        keyPrefix: created.record.keyPrefix,
        label: created.record.label,
        isActive: created.record.isActive,
        createdAt: created.record.createdAt
      }
    });
  } catch (error) {
    console.error('API key generation error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate API key' });
  }
});

// --------------------------------------------------------------------
// POST /api/api-keys/refresh — Rotate: revoke old key, issue new one
// --------------------------------------------------------------------
router.post('/refresh', authMiddleware, async (req, res) => {
  try {
    const current = await findActiveApiKeyByUserId(req.user.id);

    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'No active API key to refresh — generate one first'
      });
    }

    // Revoke the old key.
    await deactivateApiKeyById(current.id);

    // Issue a new one.
    const created = await createApiKeyRecord(req.user.id, generateKey(), current.label);

    res.json({
      success: true,
      message: 'API key refreshed — old key revoked, copy the new one now',
      data: {
        id: created.record.id,
        key: created.key,
        keyPrefix: created.record.keyPrefix,
        label: created.record.label,
        isActive: created.record.isActive,
        createdAt: created.record.createdAt,
        previousKeyPrefix: current.keyPrefix
      }
    });
  } catch (error) {
    console.error('API key refresh error:', error);
    res.status(500).json({ success: false, message: 'Failed to refresh API key' });
  }
});

// --------------------------------------------------------------------
// POST /api/api-keys/revoke — Disable the active key
// --------------------------------------------------------------------
router.post('/revoke', authMiddleware, async (req, res) => {
  try {
    const current = await findActiveApiKeyByUserId(req.user.id);

    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'No active API key to revoke'
      });
    }

    await deactivateApiKeyById(current.id);

    res.json({
      success: true,
      message: `API key ${current.keyPrefix}... revoked`
    });
  } catch (error) {
    console.error('API key revocation error:', error);
    res.status(500).json({ success: false, message: 'Failed to revoke API key' });
  }
});

// --------------------------------------------------------------------
// GET /api/api-keys/current — Metadata only (no full key)
// --------------------------------------------------------------------
router.get('/current', authMiddleware, async (req, res) => {
  try {
    const current = await findActiveApiKeyByUserId(req.user.id);

    res.json({
      success: true,
      data: current   // null if no active key
    });
  } catch (error) {
    console.error('API key lookup error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve API key info' });
  }
});

module.exports = router;
