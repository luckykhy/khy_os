/**
 * KHY-Quant AI Management Backend
 *
 * Standalone Express server for AI gateway management, monitoring,
 * protocol conversion, plugin chain, OAuth, and TLS sidecar.
 *
 * Port: AI_MGMT_PORT (default 9090)
 * Shared database with trading backend via @khy/shared.
 * @pattern Singleton
 */
const path = require('path');

// Set KHYQUANT_ROOT so shared config finds the right .env and data/ dir
if (!process.env.KHYQUANT_ROOT) {
  process.env.KHYQUANT_ROOT = path.resolve(__dirname, '../backend');
}

// Load environment
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const { authenticateToken, requireAdmin } = require('./src/middleware/auth');

const app = express();

// ── Database readiness flag (M4 graceful degradation) ──
// When the shared database is unreachable, the server keeps serving but marks
// itself as degraded so the health check can report 503 and load balancers /
// orchestrators can react. A background timer retries the connection.
let _dbReady = false;

// ── Middleware ──
app.use(
  cors({
    origin: process.env.AI_MGMT_CORS_ORIGINS || '*',
    credentials: true,
  })
);
// Coze collection uploads (a 200+ workflow zip, base64-encoded) far exceed the
// default body limit. Parse the import paths with a larger, env-tunable limit
// BEFORE the global parser; once parsed, express.json below is a no-op for them.
app.use(
  '/api/workflow/import/coze',
  express.json({ limit: process.env.KHY_COZE_UPLOAD_LIMIT || '64mb' })
);
app.use(express.json({ limit: '2mb' }));

// ── Health Check (no auth) ──
// Reflects DB readiness: 200/ok when the database is connected, 503/degraded
// otherwise so upstream health probes see the degraded state.
app.get('/api/health', (req, res) => {
  const healthy = _dbReady === true;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'khy-ai-backend',
    database: healthy ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── Auth (login — shared credentials with trading system) ──
app.use('/api/auth', require('./src/routes/auth'));

// ── AI Chat & Analysis (auth required) ──
app.use('/api/ai', require('./src/routes/ai'));

// ── AI Gateway Admin (admin only) ──
app.use('/api/ai-gateway', require('./src/routes/aiGatewayAdmin'));

// ── User-domain Gateway (per-user, auth only — multi-tenant) ──
app.use('/api/user-gateway', require('./src/routes/userGateway'));

// ── Visual Workflows (per-user, auth only — drag-and-drop editor) ──
app.use('/api/workflow', require('./src/routes/workflow'));

// ── Plugin marketplace (per-user, auth only — Coze-compatible OpenAPI tools) ──
app.use('/api/marketplace', require('./src/routes/marketplace'));
app.use('/api/plugins', require('./src/routes/plugins'));

// ── Markdown 工作台：服务器文件目录读写（登录 + 路径 confinement + 文本扩展名 allowlist）──
// 仅当特性门控 KHY_AI_MD_WORKBENCH_FILES 开（default-on）时挂载；门关整段不可达（逐字节回退，
// 等价于该增强从未存在）。浏览器内编辑版块在前端，无需登录、不经此路由。
const mdWorkbench = require('./src/routes/mdWorkbench');
if (mdWorkbench.enabled()) {
  app.use('/api/md-workbench', mdWorkbench);
}

// ── News Data (for AI agents) ──
app.use('/api/news', require('./src/routes/news'));

// ── Database Initialization ──
async function start() {
  const PORT = parseInt(process.env.AI_MGMT_PORT, 10) || 9090;

  const { sequelize } = require('./src/config/database');
  let _dbRetryTimer = null;

  // Retry the DB connection every 30s until it succeeds; once connected the
  // service leaves the degraded state. unref() so the timer never blocks exit.
  function scheduleDbReconnect() {
    if (_dbRetryTimer) return;
    _dbRetryTimer = setInterval(async () => {
      try {
        await sequelize.authenticate();
        _dbReady = true;
        clearInterval(_dbRetryTimer);
        _dbRetryTimer = null;
        console.log(`  [OK] Database reconnected`);
      } catch (err) {
        console.warn(`  [WARN] Database retry: ${err.message}`);
      }
    }, 30000);
    _dbRetryTimer.unref();
  }

  try {
    await sequelize.authenticate();
    _dbReady = true;
    console.log(`  [OK] Database connected`);
  } catch (err) {
    console.warn(`  [WARN] Database: ${err.message}`);
    scheduleDbReconnect();
  }

  const server = app.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║   KHY AI Management Backend          ║');
    console.log(`  ║   Running on port ${PORT}              ║`);
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
    console.log(`  Health:   http://localhost:${PORT}/api/health`);
    console.log(`  Gateway:  http://localhost:${PORT}/api/ai-gateway/status`);
    console.log('');
  });

  // WebSocket support for real-time AI chat (optional)
  try {
    const { WebSocketServer } = require('ws');
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'connected', service: 'khy-ai-backend' }));
    });
    console.log('  [OK] WebSocket enabled on /ws');
  } catch (err) {
    console.warn('  [WARN] WebSocket:', err.message);
  }

  // ── Graceful shutdown ──
  // Stop accepting new connections and let in-flight requests drain before exit.
  function shutdown(signal) {
    console.log(`\n  [INFO] Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      console.log('  [OK] HTTP server closed');
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

start().catch((err) => {
  console.error('AI Backend failed to start:', err);
  process.exit(1);
});

module.exports = app;
