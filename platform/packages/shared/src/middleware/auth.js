/**
 * JWT Authentication Guard Middleware
 *
 * Access & Routing Layer (接入与路由层) - Step 5 of 5.
 * Verifies JWT token from the Authorization header and attaches
 * the decoded user to req.user. Also supports API key authentication.
 * See thesis Chapter 5.1 (JWT auth flow, Code Block 3).
 * @pattern Proxy
 */
const jwt = require('jsonwebtoken');
const { QueryTypes } = require('sequelize');
const { User, ApiKey, sequelize } = require('../models');
const { hashApiKey } = require('../utils/apiKeyHash');

const API_KEY_SCHEMA_CACHE_MS = 60 * 1000;
let _apiKeySchemaCache = null;
let _apiKeySchemaCachedAt = 0;

function hasColumn(schema, columnName) {
  return !!(schema && Object.prototype.hasOwnProperty.call(schema, columnName));
}

async function getApiKeySchema() {
  const now = Date.now();
  if (_apiKeySchemaCache && (now - _apiKeySchemaCachedAt) < API_KEY_SCHEMA_CACHE_MS) {
    return _apiKeySchemaCache;
  }

  try {
    const queryInterface = sequelize.getQueryInterface();
    const schema = await queryInterface.describeTable('api_keys');
    _apiKeySchemaCache = schema;
    _apiKeySchemaCachedAt = now;
    return schema;
  } catch {
    _apiKeySchemaCache = null;
    _apiKeySchemaCachedAt = now;
    return null;
  }
}

async function findApiKeyRecord(apiKeyValue) {
  const keyHash = hashApiKey(apiKeyValue);

  // Preferred path: modern schema (key_hash) via Sequelize model.
  try {
    const record = await ApiKey.findOne({
      where: { keyHash, isActive: true },
      include: [{ model: User, as: 'user' }]
    });
    if (record?.user) {
      return {
        user: record.user,
        touch: () => record.update({ lastUsedAt: new Date() }).catch(() => {}),
      };
    }
  } catch {
    // Fall through to legacy-compatible raw query path.
  }

  // Compatibility path: tolerate historical "key" column until migration completes.
  const schema = await getApiKeySchema();
  if (!schema) return null;

  const whereParts = [];
  const replacements = {
    keyHash,
    activeValue: true,
  };

  if (hasColumn(schema, 'key_hash')) whereParts.push('key_hash = :keyHash');
  // Legacy "key" column no longer queried — all keys should be hashed by now.
  // Migration in seed.js backfills key_hash for any rows that had plain "key".
  if (whereParts.length === 0) return null;

  const activeClause = hasColumn(schema, 'is_active') ? 'AND is_active = :activeValue' : '';
  let rows = [];
  try {
    rows = await sequelize.query(
      `SELECT id, user_id
         FROM api_keys
        WHERE (${whereParts.join(' OR ')})
          ${activeClause}
        ORDER BY id DESC
        LIMIT 1`,
      { replacements, type: QueryTypes.SELECT }
    );
  } catch {
    return null;
  }

  const row = rows[0];
  if (!row) return null;

  const userId = Number(row.user_id || row.userId || 0);
  if (!userId) return null;

  const user = await User.findByPk(userId);
  if (!user) return null;

  const touch = async () => {
    if (!hasColumn(schema, 'last_used_at')) return;
    try {
      await sequelize.query(
        'UPDATE api_keys SET last_used_at = :lastUsedAt WHERE id = :id',
        {
          replacements: { lastUsedAt: new Date(), id: Number(row.id) || 0 },
          type: QueryTypes.UPDATE,
        }
      );
    } catch {
      // best effort
    }
  };

  return { user, touch };
}

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: '未提供认证令牌'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: '用户不存在'
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: '账户已被禁用'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: '认证失败'
    });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: '需要管理员权限'
    });
  }
  next();
};

// Flexible auth: accepts JWT Bearer token OR X-API-Key header.
// Use this on endpoints that external scripts/services call.
const flexibleAuth = async (req, res, next) => {
  // --- Path A: JWT Bearer token ---
  const bearerToken = req.headers.authorization?.split(' ')[1];
  if (bearerToken) {
    try {
      const decoded = jwt.verify(bearerToken, process.env.JWT_SECRET);
      const user = await User.findByPk(decoded.userId);
      if (!user) {
        return res.status(401).json({ success: false, message: 'User not found' });
      }
      if (user.status !== 'active') {
        return res.status(403).json({ success: false, message: 'Account disabled' });
      }
      req.user = user;
      req.authMethod = 'jwt';
      return next();
    } catch (err) {
      // JWT was explicitly provided but invalid — reject immediately
      const msg = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
      return res.status(401).json({ success: false, message: msg });
    }
  }

  // --- Path B: X-API-Key header ---
  const apiKeyValue = req.headers['x-api-key'];
  if (apiKeyValue) {
    try {
      const matched = await findApiKeyRecord(apiKeyValue);
      if (!matched || !matched.user) {
        return res.status(401).json({ success: false, message: 'Invalid or revoked API key' });
      }
      if (matched.user.status !== 'active') {
        return res.status(403).json({ success: false, message: 'Account disabled' });
      }
      req.user = matched.user;
      req.authMethod = 'apiKey';
      // Update lastUsedAt (fire-and-forget)
      matched.touch?.();
      return next();
    } catch {
      return res.status(401).json({ success: false, message: 'API key verification failed' });
    }
  }

  // --- Neither auth method provided ---
  return res.status(401).json({ success: false, message: 'Authentication required (Bearer token or X-API-Key)' });
};

// 别名导出以兼容不同的使用方式
const authenticateToken = authMiddleware;
const requireAdmin = adminMiddleware;

module.exports = {
  authMiddleware,
  adminMiddleware,
  flexibleAuth,
  authenticateToken,
  requireAdmin
};
