/**
 * Audit Log Middleware
 *
 * Access & Routing Layer (接入与路由层) - Step 2 of 5 in the middleware chain.
 * Logs write operations (POST/PUT/DELETE) to the audit_logs table
 * for security traceability. See thesis Chapter 4.2, Table 12.
 */
const { sequelize } = require('../config/database');
const { QueryTypes } = require('sequelize');
const logger = require('../utils/logger');

// Ensure audit_logs table exists
async function ensureAuditTable() {
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        username VARCHAR(255),
        method VARCHAR(10) NOT NULL,
        path VARCHAR(512) NOT NULL,
        body JSONB,
        status_code INTEGER,
        ip VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
  } catch (err) {
    logger.warn('Could not create audit_logs table (may already exist or DB not ready)', { error: err.message });
  }
}

// Initialize table on first load
let tableReady = false;

function auditLog(req, res, next) {
  // Only audit mutating methods
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  // Skip health checks and high-frequency endpoints
  if (req.originalUrl.includes('/health') || req.originalUrl.includes('/cache')) {
    return next();
  }

  const originalEnd = res.end;
  res.end = function (...args) {
    res.end = originalEnd;
    res.end(...args);

    // Fire-and-forget audit insert
    const record = {
      userId: req.user?.id || null,
      username: req.user?.username || null,
      method: req.method,
      path: req.originalUrl,
      body: sanitizeBody(req.body),
      statusCode: res.statusCode,
      ip: req.ip,
      userAgent: req.get('user-agent')
    };

    insertAuditLog(record).catch(err => {
      logger.warn('Audit log insert failed', { error: err.message });
    });
  };

  next();
}

async function insertAuditLog(record) {
  if (!tableReady) {
    await ensureAuditTable();
    tableReady = true;
  }

  await sequelize.query(
    `INSERT INTO audit_logs (user_id, username, method, path, body, status_code, ip, user_agent)
     VALUES (:userId, :username, :method, :path, :body, :statusCode, :ip, :userAgent)`,
    {
      replacements: {
        ...record,
        body: record.body ? JSON.stringify(record.body) : null
      },
      type: QueryTypes.INSERT
    }
  );
}

// Remove sensitive fields from logged body
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return null;
  const sanitized = { ...body };
  const sensitive = ['password', 'token', 'secret', 'authorization', 'apiKey', 'api_key'];
  for (const key of sensitive) {
    if (sanitized[key]) sanitized[key] = '[REDACTED]';
  }
  return sanitized;
}

module.exports = auditLog;
