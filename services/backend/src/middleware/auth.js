const { QueryTypes } = require('sequelize');
const { User, ApiKey, sequelize } = require('../models');
const { hashApiKey } = require('@khy/shared/utils/apiKeyHash');
const authSessionService = require('../services/authSessionService');

const API_KEY_SCHEMA_CACHE_MS = 60 * 1000;
let apiKeySchemaCache = null;
let apiKeySchemaCachedAt = 0;

function hasColumn(schema, columnName) {
  return !!(schema && Object.prototype.hasOwnProperty.call(schema, columnName));
}

async function getApiKeySchema() {
  const now = Date.now();
  if (apiKeySchemaCache && (now - apiKeySchemaCachedAt) < API_KEY_SCHEMA_CACHE_MS) {
    return apiKeySchemaCache;
  }

  try {
    const queryInterface = sequelize.getQueryInterface();
    const schema = await queryInterface.describeTable('api_keys');
    apiKeySchemaCache = schema;
    apiKeySchemaCachedAt = now;
    return schema;
  } catch {
    apiKeySchemaCache = null;
    apiKeySchemaCachedAt = now;
    return null;
  }
}

async function findApiKeyRecord(apiKeyValue) {
  const keyHash = hashApiKey(apiKeyValue);

  try {
    const record = await ApiKey.findOne({
      where: { keyHash, isActive: true },
      include: [{ model: User, as: 'user' }],
    });

    if (record?.user) {
      return {
        user: record.user,
        touch: () => record.update({ lastUsedAt: new Date() }).catch(() => {}),
      };
    }
  } catch {
    // fall through to compatibility path
  }

  const schema = await getApiKeySchema();
  if (!schema) return null;

  const whereParts = [];
  const replacements = {
    keyHash,
    activeValue: true,
  };

  if (hasColumn(schema, 'key_hash')) whereParts.push('key_hash = :keyHash');
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

function attachAuthContext(req, authResult, method = 'jwt') {
  req.user = authResult.user;
  req.auth = {
    method,
    legacy: !!authResult.legacy,
    sessionId: authResult.session?.id || null,
  };
  req.authSession = authResult.session || null;
}

function sendAuthFailure(res, authResult) {
  if (authResult?.code === 'user_inactive') {
    return res.status(403).json({
      success: false,
      message: '账户已被禁用',
    });
  }

  if (authResult?.code === 'token_expired') {
    return res.status(401).json({
      success: false,
      message: '认证令牌已过期',
    });
  }

  if (authResult?.code === 'session_revoked' ||
      authResult?.code === 'session_expired' ||
      authResult?.code === 'token_version_mismatch' ||
      authResult?.code === 'legacy_token_revoked') {
    return res.status(401).json({
      success: false,
      message: '登录会话已失效，请重新登录',
    });
  }

  if (authResult?.code === 'user_not_found') {
    return res.status(401).json({
      success: false,
      message: '用户不存在',
    });
  }

  return res.status(401).json({
    success: false,
    message: '认证失败',
  });
}

const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: '未提供认证令牌',
    });
  }

  try {
    const authResult = await authSessionService.authenticateAccessToken(token);
    if (!authResult.ok) {
      return sendAuthFailure(res, authResult);
    }

    attachAuthContext(req, authResult, 'jwt');
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: '认证失败',
    });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: '需要管理员权限',
    });
  }
  return next();
};

const flexibleAuth = async (req, res, next) => {
  const bearerToken = req.headers.authorization?.split(' ')[1];
  if (bearerToken) {
    try {
      const authResult = await authSessionService.authenticateAccessToken(bearerToken);
      if (!authResult.ok) {
        return sendAuthFailure(res, authResult);
      }

      attachAuthContext(req, authResult, 'jwt');
      return next();
    } catch {
      return res.status(401).json({
        success: false,
        message: '认证失败',
      });
    }
  }

  const apiKeyValue = req.headers['x-api-key'];
  if (apiKeyValue) {
    try {
      const matched = await findApiKeyRecord(apiKeyValue);
      if (!matched?.user) {
        return res.status(401).json({ success: false, message: '无效或已撤销的 API 密钥' });
      }
      if (matched.user.status !== 'active') {
        return res.status(403).json({ success: false, message: '账户已被禁用' });
      }
      req.user = matched.user;
      req.auth = { method: 'apiKey', legacy: false, sessionId: null };
      req.authSession = null;
      matched.touch?.();
      return next();
    } catch {
      return res.status(401).json({ success: false, message: 'API 密钥校验失败' });
    }
  }

  return res.status(401).json({
    success: false,
    message: '需要认证（Bearer Token 或 X-API-Key）',
  });
};

module.exports = {
  authMiddleware,
  adminMiddleware,
  flexibleAuth,
  authenticateToken: authMiddleware,
  requireAdmin: adminMiddleware,
};
