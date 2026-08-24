/**
 *
 * KHY-Quant 量化交易系统 - 后端服务
 *
 * Copyright (c) 2026 孔浩原 (Kong Haoyuan). All Rights Reserved.
 *
 * 未经授权，禁止复制、修改或商业使用。
 *
 */

/**
 * KHY-Quant 后端服务器入口 —— Express.js + WebSocket 应用启动文件
 *
 * 架构概览（对应论文第4章，图5）：
 *   1. Express HTTP 服务器：CORS 跨域、限流、审计日志
 *   2. WebSocket 服务器：实时行情推送和通知
 *   3. 路由注册按五层架构组织：
 *      - 接入与路由层：认证(auth)、用户(user)、设置(settings)
 *      - 策略适配层：策略(strategy)、回测(backtest)
 *      - 多智能体协同层：交易智能体(tradingAgents)、AI代理
 *      - 数据聚合层：综合数据(comprehensiveData)、K线(klineData)、行情
 *   4. SPA 前端静态文件服务
 *   5. 数据库初始化与优雅关闭
 *
 * 关键设计决策：
 *   - 启用 trust proxy 以支持 Nginx 反向代理部署
 *   - 服务器超时 180 秒，适配大量历史数据加载
 *   - 无 WebSocket 客户端连接时自动关闭（释放端口）
 *   - 统一错误信封中间件处理异常
 */

const path = require('path');
// Windows: hide child-process console windows before loading any module that may
// spawn. Prevents the "black box flicker" when this server runs. Reuses the
// central patch (win32-only, gated KHY_WINDOWS_SPAWN_HIDE, idempotent,
// fail-soft); no-op on non-win32. Must precede the child_process require below.
try {
  require('./src/bootstrap/windowsSpawnHardening').installWindowsSpawnHardening();
} catch {
  /* best effort */
}
const canonicalEnvPath = process.env.KHY_ENV_FILE
  ? path.resolve(process.env.KHY_ENV_FILE)
  : path.resolve(__dirname, '.env');
require('dotenv').config({ path: canonicalEnvPath });

// ── Shadow startup-phase FSM (observability only, zero behavior change) ──
// Fail-soft + optional: the stateMachine module must never break server boot.
// Mounted on `process` so diagnostics can read it from anywhere.
let _serverStartupFsm = null;
try {
  _serverStartupFsm = require('./src/services/stateMachine/startupPhases').createStartupFsm({
    name: 'server-startup',
  });
} catch {
  /* fsm is optional */
}
try {
  process.__khyServerStartupFsm = _serverStartupFsm;
} catch {
  /* best effort */
}
// Optional stderr transition logger (KHY_STATE_DEBUG=1 only); fail-soft.
try {
  require('./src/services/stateMachine/debugLog').attachDebugLog(
    _serverStartupFsm,
    'server-startup'
  );
} catch {
  /* debug log optional */
}
if (_serverStartupFsm) _serverStartupFsm.fire('advance', { step: 'dotenv_loaded' }); // -> env_check

// Ensure the JWT signing secret exists before any auth path reads it.
// Self-provisions + persists a strong secret if the canonical .env lacks one.
try {
  require('./src/bootstrap/ensureAuthSecret').ensureJwtSecret({
    log: (m) => {
      try {
        console.warn(`  ⚠ ${m}`);
      } catch {
        /* ignore */
      }
    },
  });
} catch {
  /* helper unavailable — validateRequiredEnv below will surface it */
}

const { applyEnvDefaults, validateRequiredEnv } = require('./src/config/env');

// Shutdown handler - must be loaded early because idle-shutdown and API shutdown
// endpoints reference it before the bulk require block near EOF.
const { requestShutdown } = require('./src/bootstrap/shutdown');

const { patchExpressAsync } = require('./src/utils/expressAsyncPatch');
const { version: backendVersion } = require('./package.json');
const {
  initializeOpenTelemetry,
  createMetrics,
  getOpenTelemetryStatus,
  shutdownOpenTelemetry,
} = require('./src/observability');

applyEnvDefaults();
if (typeof validateRequiredEnv === 'function') {
  validateRequiredEnv();
}

// Install crash recovery early (before any async work)
try {
  const crashRecovery = require('./src/services/crashRecovery');
  crashRecovery.install({ logger: console });
} catch {
  /* crashRecovery not available */
}

patchExpressAsync();

initializeOpenTelemetry({
  serviceName: 'khy-os-backend',
  serviceVersion: backendVersion,
  logger: console,
});
if (_serverStartupFsm) _serverStartupFsm.fire('advance', { step: 'otel_init' }); // -> modules_load

// 生产环境下禁止 debug 级别控制台输出，保留 warn/error 用于运维告警
if (process.env.NODE_ENV === 'production') {
  const _origLog = console.log;
  console.log = (...args) => {
    // Still let through startup banner messages (they contain health check URLs, port info)
    // L1: 加 u flag 以正确匹配 emoji（星标/占位符等码点）
    if (args.length > 0 && typeof args[0] === 'string' && args[0].match(/^[\s]*[⚡🚀⚠✗✓☐]/u)) {
      _origLog(...args);
      return;
    }
    // M2: 非 banner 日志路由到 logger，避免静默丢弃（此闭包仅在 logger 就绪后被调用）
    try {
      logger.info(args.map(String).join(' '));
    } catch {
      /* logger 尚未就绪时忽略 */
    }
  };
  console.debug = () => {};
  console.warn = (...args) => {
    _origLog('[WARN]', ...args);
  };
  console.error = (...args) => {
    _origLog('[ERROR]', ...args);
  };
}

// ─── 核心依赖导入 ──────────────────────────────────────────────────────
// Express 框架、CORS 跨域、HTTP 服务器、WebSocket 等基础模块
const express = require('express');

const cors = require('cors');

const helmet = require('helmet');

const http = require('http');

const WebSocket = require('ws');

let { sequelize, initDatabase } = require('./src/config/database');

const models = require('./src/models'); // 加载所有模型

const { spawn } = require('child_process');

const axios = require('axios');

const fs = require('fs');

// path already required at the top for canonical .env loading.

const logger = require('./src/utils/logger');

const requestLogger = require('./src/middleware/requestLogger');

const errorHandler = require('./src/middleware/errorHandler');

const auditLog = require('./src/middleware/auditLog');

const { apiLimiter, authLimiter, aiLimiter } = require('./src/middleware/rateLimit');

const { authMiddleware } = require('./src/middleware/auth');
const { AI_BACKEND_URL, BACKEND_PORT } = require('./src/constants/serviceDefaults');

// ─── 延迟初始化的服务层单例（在后台启动 IIFE 中赋值）────────────────────
// C1+C2: 这些服务被健康检查、WebSocket handler、优雅关闭 hooks 引用，
// 必须在模块顶层用 let 声明并初始化为 null，避免 IIFE 内 const 声明导致
// 外部引用抛 ReferenceError（被各层 try-catch 静默吞掉）。所有使用点需 null 守卫。
let realtimeDataService = null;
let notificationService = null;
let instrumentSyncService = null;
let authSessionService = null;

// ─── 路由模块导入 ──────────────────────────────────────────────────────
// 按五层架构分组导入所有 API 路由（对应论文第4章 §4.2 路由层设计）

const authRoutes = require('./src/routes/auth');

const userRoutes = require('./src/routes/user');

const strategyRoutes = require('./src/routes/strategy');

const backtestRoutes = require('./src/routes/backtest');

const marketDataRoutes = require('./src/routes/marketData');

const watchlistRoutes = require('./src/routes/watchlist');

const adminRoutes = require('./src/routes/admin');

const stockProxyRoutes = require('./src/routes/stockProxy');

const settingsRoutes = require('./src/routes/settings');

const dashboardRoutes = require('./src/routes/dashboard');

const passwordResetRoutes = require('./src/routes/passwordReset');

const tradeRoutes = require('./src/routes/trade');

const tradesRoutes = require('./src/routes/trades'); // 交易记录路由

const tradingAgentsRoutes = require('./src/routes/tradingAgents');

const announcementRoutes = require('./src/routes/announcement');

const commandCatalogRoutes = require('./src/routes/commands');

const feedbackRoutes = require('./src/routes/feedback');

const comprehensiveDataRoutes = require('./src/routes/comprehensiveData');

const marketRoutes = require('./src/routes/market'); // 市场数据路由

const replayRoutes = require('./src/routes/replay'); // 数据回放路由

const remoteSshRoutes = require('./src/routes/remoteSsh'); // 远程 SSH 会话管理
const largeTaskRoutes = require('./src/routes/largeTasks'); // 大型任务运行时控制面
const aiGatewayPaymentsRoutes = require('./src/routes/aiGatewayPayments'); // AI 网关支付订单本地闭环
const videoRoutes = require('./src/routes/video'); // 视频生成（文生视频 / 图生视频 / 关键帧动画）
const imageRoutes = require('./src/routes/image'); // 图像生成（文生图 / 图生图，Agnes Image 2.1 Flash）

if (_serverStartupFsm) _serverStartupFsm.fire('advance', { step: 'routes_loaded' }); // -> service_discover

// ─── 创建 Express 应用、HTTP 服务器和 WebSocket 服务器 ─────────────────
// 三者共享同一端口，HTTP 与 WebSocket 在同一进程中运行（对应论文第4章 §4.1 系统架构）
const app = express();
app.set('trust proxy', 1); // 信任 Nginx 反向代理的 X-Forwarded-For 头

const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

const parsedPort = BACKEND_PORT;

const START_PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;

// Build default CORS origins dynamically from actual port config
function _buildDefaultCorsOrigins() {
  // START_PORT: the backend/prod origin. 8080/8090: the Vite dev server (8090 is
  // this project's configured default — see apps/ai-frontend/vite.config.js — so
  // a dev browser hitting the backend with an absolute URL is not silently CORS-blocked).
  const ports = new Set([START_PORT, 8080, 8090]);
  const hosts = ['localhost', '127.0.0.1'];
  const origins = [];
  for (const host of hosts) {
    for (const port of ports) {
      origins.push(`http://${host}:${port}`);
    }
  }
  return origins;
}

// Discover PostgreSQL installation paths dynamically instead of hardcoding
function _discoverPgPaths() {
  // 1. Env override takes priority
  if (process.env.PG_HOME) return [process.env.PG_HOME];

  if (process.platform !== 'win32') {
    // Linux/macOS: pg_ctl is typically in PATH
    return ['/usr/lib/postgresql', '/usr/local/pgsql'];
  }

  // 2. Windows: scan "Program Files" on all available drive letters
  const versions = [18, 17, 16, 15, 14];
  const prefixes = ['Program Files', 'Program Files (x86)'];
  const drives = [];
  for (let code = 67; code <= 90; code++) {
    // C..Z
    const letter = String.fromCharCode(code);
    try {
      if (fs.existsSync(`${letter}:\\`)) drives.push(`${letter}:`);
    } catch {
      /* drive not accessible */
    }
  }
  const paths = [];
  for (const drive of drives) {
    for (const prefix of prefixes) {
      for (const ver of versions) {
        paths.push(path.join(drive, prefix, 'PostgreSQL', String(ver)));
      }
    }
  }
  return paths;
}

const parsedPortRetry = Number.parseInt(process.env.PORT_AUTO_RETRY || '20', 10);

const MAX_PORT_RETRY =
  Number.isFinite(parsedPortRetry) && parsedPortRetry > 0 ? parsedPortRetry : 20;

// 服务器超时设置：180秒，适配大量历史K线数据加载场景
// headersTimeout 须略大于 keepAliveTimeout，防止 Node.js 警告

server.timeout = 180000;

server.keepAliveTimeout = 180000;

server.headersTimeout = 185000; // 略大于keepAliveTimeout

// ─── 中间件注册 ──────────────────────────────────────────────────────────
// Security headers, CORS, JSON parsing, request logging, audit, rate limiting
// Security headers (helmet)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // SPA bundler needs inline; eval removed for XSS hardening
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'https:'], // WebSocket + API calls
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Needed for external chart/data loading
  })
);

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (same-origin, curl, mobile apps)
      if (!origin) return callback(null, true);
      const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
        ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim())
        : _buildDefaultCorsOrigins();
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // L3: 拒绝跨域时返回 (null, false)，让 cors 中间件回退到无 CORS 头的正常响应，
      // 而非将 Error 抛入 Express 错误处理链（会返回 500）。
      callback(null, false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '50mb' }));

app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const metrics = createMetrics({
  logger,
  serviceName: 'khy-os-backend',
});
if (metrics.enabled) {
  app.use(metrics.metricsMiddleware);
  logger.info('Observability metrics middleware enabled', {
    path: metrics.path,
    authMode: metrics.authMode,
  });
}

// 事件循环延迟连续监测（profiling 方案 B）。默认关闭；KHY_PROFILING_ENABLED=1
// 时才创建直方图与定时器，定时器已 unref，不阻止进程退出。
try {
  const { eventLoopMonitor } = require('./src/observability');
  if (eventLoopMonitor.start({ logger })) {
    logger.info('事件循环延迟监测已挂载 采样在 C++ 侧维护，稳态开销可忽略');
  }
} catch {
  /* profiling is optional — never block startup */
}

app.use((req, res, next) => {
  // Only set JSON content-type for API routes, not static files
  if (req.path.startsWith('/api') || req.path === '/health') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }

  next();
});

// 统一错误响应信封中间件（对应论文第4章 §4.3 统一错误处理）
// 设计模式：装饰器模式（Decorator），包装 res.json 方法以规范化错误结构
// 作用：防止原始错误对象泄漏到前端，统一 { success, message } 格式

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (payload) => {
    if (payload && typeof payload === 'object' && payload.success === false) {
      if (payload.error && typeof payload.error !== 'string') {
        payload.error = undefined;
      }

      if (!payload.message) {
        payload.message = '请求处理失败';
      }
    }

    return originalJson(payload);
  };

  next();
});

app.use(requestLogger);

app.use(auditLog);

app.use('/api', apiLimiter);

// ============================================================
// 路由注册区域（对应论文第4章，图5 五层架构路由映射）
// 第1组：认证与授权（接入与路由层）
// 设计模式：策略模式（Strategy），authLimiter 按策略限制登录频率
// ============================================================
app.use('/api/auth', authLimiter, authRoutes); // 登录、注册、Token刷新

app.use('/api/users', userRoutes); // 用户信息增删改查

// ============================================================
// 第2组：策略管理（策略适配层）
// 设计模式：适配器模式（Adapter），将不同策略语言统一为内部可执行格式
// ============================================================
// ── 由拓展提供的路由：缺席时跳过，而不是让整机起不来 ────────────────────
// [DESIGN-ARCH-069] §4.1 承诺「删目录即卸载」。量化应用（服务名 quant-app）的路由
// 经兼容壳解析，应用缺席时壳得到 null —— 而 app.use(path, null) 会抛，于是「卸载一个
// 应用」又变成了「服务器起不来」。这个挂载器把 null 变成一次跳过 + 一行汇总日志。
//
// 汇总而非逐条打印：应用整个缺席时会跳过 19 条，19 行日志是噪音不是信息。
const _skippedMounts = [];

/**
 * 挂载一个可选路由。
 * @param {string} mountPath - 挂载路径
 * @param {*} router - 路由器，或应用缺席时的 null
 * @returns {boolean} 是否挂上
 */
function mountOptional(mountPath, router) {
  if (typeof router === 'function' || (router && typeof router.handle === 'function')) {
    app.use(mountPath, router);
    return true;
  }
  _skippedMounts.push(mountPath);
  return false;
}

/** 汇报跳过情况。文案点**服务名**而非拓展 id，且说「未安装」不说「探测失败」（§3.4）。 */
function reportSkippedMounts(total) {
  if (_skippedMounts.length === 0) return;
  logger.warn(
    '已跳过 ' + _skippedMounts.length + '/' + total + ' 条量化应用路由：' +
      'quant-app 服务未安装（' + _skippedMounts.join('、') + '）'
  );
}

mountOptional('/api/strategies', strategyRoutes); // 策略 CRUD 和执行

mountOptional('/api/strategy', strategyRoutes); // 单数别名，向后兼容

mountOptional('/api/backtest', backtestRoutes); // 回测引擎接口

mountOptional('/api/backtests', backtestRoutes); // 复数别名，论文中引用形式

mountOptional('/api/watchlist', watchlistRoutes); // 自选股管理

app.use('/api/admin', adminRoutes); // 管理员后台接口

mountOptional('/api/stock', stockProxyRoutes); // 股票数据代理（解决跨域）

app.use('/api/settings', settingsRoutes); // 系统设置

mountOptional('/api/dashboard', dashboardRoutes); // 仪表盘汇总数据

app.use('/api/password-reset', passwordResetRoutes); // 密码重置流程

// ============================================================
// 第3组：交易与多智能体协同（对应论文第5章 §5.2 多智能体协同层）
// 设计模式：观察者模式（Observer），智能体之间通过事件通信
// ============================================================
mountOptional('/api/trading', tradeRoutes); // 交易下单与持仓管理

mountOptional('/api/trades', tradesRoutes); // 交易历史记录查询

mountOptional('/api/trading-agents', tradingAgentsRoutes); // 多智能体交易系统

// ─── AI 请求代理 ──────────────────────────────────────────────────────
// AI 路由由独立的 AI 管理后端 (ai-backend/) 提供服务。
// 此处创建反向代理，将前端 AI 请求透传到 AI 后端，保持前端接口不变。
// 设计模式：代理模式（Proxy），解耦主服务与 AI 子系统（对应论文第5章 §5.3 AI网关）
const activeAiBackendUrl = AI_BACKEND_URL;

/**
 * 创建支持流式传输的反向代理中间件
 * 支持 SSE（Server-Sent Events）流式响应，用于 LLM 生成端点的实时输出
 * @param {Object} options - 配置项
 * @param {number} options.timeout - 请求超时时间（毫秒），默认30秒
 * @returns {Function} Express 中间件函数
 */
function createAiProxy({ timeout = 30000 } = {}) {
  return async (req, res) => {
    try {
      const url = `${activeAiBackendUrl}${req.originalUrl}`;
      // Security: only forward safe headers (prevent info leak)
      const PROXY_ALLOWED_HEADERS = [
        'content-type',
        'accept',
        'accept-language',
        'authorization',
        'user-agent',
        'x-request-id',
      ];
      const forwardHeaders = {};
      for (const key of PROXY_ALLOWED_HEADERS) {
        if (req.headers[key]) forwardHeaders[key] = req.headers[key];
      }
      const resp = await axios({
        method: req.method,
        url,
        data: req.body,
        headers: forwardHeaders,
        timeout,
        validateStatus: () => true,
        responseType: 'stream',
      });
      res.status(resp.status);
      // Forward response headers (exclude transfer-encoding to let Express handle it)
      const skipHeaders = new Set(['transfer-encoding', 'connection']);
      for (const [key, value] of Object.entries(resp.headers)) {
        if (!skipHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }
      resp.data.on('error', (streamErr) => {
        if (!res.headersSent) {
          res.status(502).json({
            success: false,
            message: 'AI backend stream error',
            detail: streamErr.message,
          });
        } else {
          res.end();
        }
      });
      resp.data.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res
          .status(503)
          .json({ success: false, message: 'AI backend unavailable', detail: err.message });
      }
    }
  };
}

app.use('/api/ai', authMiddleware, aiLimiter, createAiProxy({ timeout: 120000 })); // AI 接口代理，超时120秒适配大模型推理
app.use('/api/analysis', (req, res) => res.redirect(307, `/api/ai${req.url}`)); // 分析接口重定向到 AI

app.use('/api/announcements', announcementRoutes); // 系统公告管理

app.use('/api/commands', commandCatalogRoutes); // 功能索引（命令目录，公开只读）

app.use('/api/feedback', feedbackRoutes); // 用户反馈收集

// ============================================================
// 第4组：数据治理层（对应论文第4章 §4.4 四级降级数据获取策略）
// 数据获取优先级：缓存 → AKShare → 备用源 → 本地存储
// ============================================================
mountOptional('/api/comprehensive', comprehensiveDataRoutes); // 综合数据聚合接口（多源融合）

mountOptional('/api/comprehensive-data', comprehensiveDataRoutes); // 别名路由

mountOptional('/api/market', marketRoutes); // 市场行情数据

mountOptional('/api/replay', replayRoutes); // 历史数据回放（用于策略复盘）

mountOptional('/api/tick-backtest', require('./src/routes/tickBacktest')); // Tick 级回测引擎

mountOptional('/api/futures-tick', require('./src/routes/futuresTickData')); // 期货逐笔数据（ZIP 归档）

mountOptional('/api/bank-transfer', require('./src/routes/bankTransfer')); // 银行转账模拟

// ============================================================
// 第5组：标的管理与缓存（对应论文第4章 §4.5 缓存策略）
// ============================================================
mountOptional('/api/instruments', require('./src/routes/instruments')); // 金融标的列表（股票/期货/指数）

mountOptional('/api/favorites', require('./src/routes/favorites')); // 用户收藏（自选股）

mountOptional('/api/kline-data', require('./src/routes/klineData')); // K线 OHLCV 数据接口

app.use('/api/cache', require('./src/routes/cache')); // 缓存管理（清理、查看统计）

mountOptional('/api/instrument-sync', require('./src/routes/instrumentSync')); // 标的自动同步接口

reportSkippedMounts(21); // 量化应用路由挂载结果汇总

// ============================================================
// 第6组：系统管理与外部服务接口
// ============================================================
app.use('/api/system', require('./src/routes/system')); // 系统信息（局域网IP、版本等）

app.use('/api/webauthn', require('./src/routes/webauthn')); // 生物认证（WebAuthn 指纹/面容）

app.use('/api/news', authMiddleware, aiLimiter, createAiProxy()); // 新闻资讯（代理到 AI 后端，需认证+限流）

app.use('/api/external', require('./src/routes/external')); // 外部信号 Webhook（JWT 鉴权）
app.use('/api/payment-webhooks', require('./src/routes/paymentWebhooks')); // 支付网关公开回调（签名校验）

app.use('/api/api-keys', require('./src/routes/apiKey')); // API 密钥管理

app.use('/api/downloads', require('./src/routes/downloads')); // 安装包下载（Windows/APK）
app.use('/api/ai-gateway-admin', require('./src/routes/aiGatewayAdmin')); // AI 网关管理（本地 Key Pool 管理，需 Admin 认证）
app.use('/api/ai-gateway/payments', authMiddleware, aiGatewayPaymentsRoutes); // 支付订单（本地实现，避免落到通用 AI 代理）
app.use('/api/ai-gateway', authMiddleware, aiLimiter, createAiProxy({ timeout: 120000 })); // AI 网关（代理到 AI 后端，120s 适配大模型推理）
app.use('/api/video', authMiddleware, aiLimiter, videoRoutes); // 视频生成（文生视频 / 图生视频 / 关键帧动画，Agnes Video V2.0）
app.use('/api/image', authMiddleware, aiLimiter, imageRoutes); // 图像生成（文生图 / 图生图，Agnes Image 2.1 Flash）
app.use('/api/remote/ssh', authMiddleware, remoteSshRoutes); // 远程 SSH 会话与命令预演（需认证）
app.use('/api/large-tasks', authMiddleware, largeTaskRoutes); // 大型任务调度与审计（需认证）
app.use('/api/proxy-subscriptions', authMiddleware, require('./src/routes/proxySubscription')); // 代理管理：订阅组导入（需认证，SSRF 校验）

// ============================================================
// 第7组：AI Chain 子系统（LangChain 兼容 chain.run() 接口）
// ============================================================
app.use('/api/chain', require('./src/routes/chain')); // Chain 执行（WASM + Python 双引擎）
app.use('/api/llm', require('./src/routes/freeLLM')); // 免费 LLM 连接测试和状态查询
app.use('/webhooks', require('./src/routes/webhooks')); // 外部渠道回调（Slack Events API 等）

// ─── 服务健康检查端点 ─────────────────────────────────────────────────
// 检测数据库、缓存、WebSocket、标的同步等子系统的运行状态
// 部署时 Nginx/Docker 通过此端点判断服务是否可用（对应论文第6章 §6.2 运维监控）

const healthHandler = async (req, res) => {
  // Check if request is authenticated for detailed diagnostics
  let isAuthed = false;
  try {
    const authHeader = req.headers.authorization;
    if (authSessionService && authHeader && process.env.JWT_SECRET) {
      const token = authHeader.split(' ')[1];
      if (token) {
        const authResult = await authSessionService.authenticateAccessToken(token, {
          touch: false,
        });
        if (authResult?.ok && authResult.user?.id) isAuthed = true;
      }
    }
  } catch {
    /* not authenticated */
  }

  const checks = {
    database: { ok: false, detail: 'disconnected' },

    cache: { ok: false, detail: 'unknown' },

    websocket: { ok: true, detail: `clients:${wss.clients?.size || 0}` },

    instrumentSync: { ok: true, detail: 'running' },
  };

  try {
    await sequelize.authenticate();

    checks.database = { ok: true, detail: 'connected' };
  } catch (error) {
    checks.database = { ok: false, detail: isAuthed ? error.message : 'error' };
  }

  try {
    const cacheStats = await require('./src/services/cacheService').getStats();

    const isCacheHealthy = cacheStats?.type === 'redis' || cacheStats?.type === 'memory';

    checks.cache = { ok: isCacheHealthy, detail: cacheStats?.type || 'unknown' };
  } catch (error) {
    checks.cache = { ok: false, detail: isAuthed ? error.message : 'error' };
  }

  const allOk = Object.values(checks).every((item) => item.ok);

  if (!isAuthed) {
    // Unauthenticated: return minimal info only
    return res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
    });
  }

  // Authenticated: return full diagnostics
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',

    timestamp: new Date().toISOString(),

    uptime: process.uptime(),

    dbMode: process.env.DB_MODE || 'unknown',

    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),

    checks,
  });
};

app.get('/health', healthHandler);

app.get('/api/health', healthHandler);
if (metrics.enabled) {
  app.use(metrics.path, metrics.metricsRouter);
}

// ═══════════════════════════════════════════════════════════════════════
// 零级启动：立即开始监听，不等待数据库/种子数据/服务初始化
// 所有非关键初始化推迟到服务器接受连接后的后台 IIFE 中执行
// ═══════════════════════════════════════════════════════════════════════
let _bootDbConnected = false;
let _bootActivePort = null;

// 启动HTTP服务器 — 最先执行，确保客户端可立即连接
(async () => {
  try {
    _bootActivePort = await listenWithAutoPort(server, START_PORT, '0.0.0.0');
    if (_serverStartupFsm)
      _serverStartupFsm.fire('skip_to_running', { step: 'http_listening', port: _bootActivePort }); // -> running
    startIdleShutdownIfEmpty();
    // 立即获取 IP 信息用于 banner
    const _os = require('os');
    const _nifs = _os.networkInterfaces();
    const _ips = [];
    Object.keys(_nifs).forEach((iface) => {
      _nifs[iface].forEach((n) => {
        if (n.family === 'IPv4' && !n.internal) _ips.push(n.address);
      });
    });
    console.log('\n🚀 服务器已就绪，后台初始化中...');
    console.log(`   http://localhost:${_bootActivePort}`);
    if (_ips[0]) console.log(`   http://${_ips[0]}:${_bootActivePort}`);
    console.log(`   ws://localhost:${_bootActivePort}`);
    console.log(`   健康检查: http://localhost:${_bootActivePort}/health\n`);

    // ─── 延迟加载的服务层模块（原同步路径，已推迟到 listen() 之后）──────────
    // 这些服务仅用于 WebSocket 连接处理和后台任务，不在请求路由路径上。
    // 推迟加载可将 ~800ms 的服务实例化从冷启动关键路径移除。
    // C1+C2: 赋值到模块顶层的 let 变量（而非 const），使外部引用可见。
    realtimeDataService = require('./src/services/realtimeDataService');
    notificationService = require('./src/services/notificationService');
    instrumentSyncService = require('./src/services/instrumentSyncService');
    authSessionService = require('./src/services/authSessionService');

    // ─── 后台初始化（不阻塞 HTTP 监听）─────────────────────────────
    const bootStart = Date.now();
    try {
      // 数据库初始化
      if (process.env.DB_TYPE === 'postgres') {
        await autoStartPostgreSQL();
      }
      sequelize = await initDatabase();
      require('./src/config/database').sequelize = sequelize;
      const maxRetries = parseInt(process.env.DB_RETRY_ATTEMPTS) || 3;
      const retryDelay = parseInt(process.env.DB_RETRY_DELAY) || 1000;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await sequelize.authenticate();
          _bootDbConnected = true;
          console.log('Database connected');
          break;
        } catch (e) {
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, retryDelay));
          } else {
            console.error('Database connection failed:', e.message);
          }
        }
      }

      if (_bootDbConnected) {
        // 并行：迁移 + 非关键服务
        await Promise.allSettled([
          (async () => {
            try {
              const { runAutoDbMigration } = require('./src/bootstrap/dbAutoMigration');
              await runAutoDbMigration({ silent: true, reason: 'server-startup' });
            } catch (e) {
              logger.warn('init:dbMigration failed', { error: e.message });
            }
            try {
              const useAlterSync = process.env.DB_SYNC_ALTER === 'true';
              await sequelize.sync({ alter: useAlterSync, force: false });
            } catch (e) {
              try {
                await sequelize.sync({ force: false });
              } catch {}
            }
            // 默认管理员自动初始化（幂等，失败不阻断启动）
            const { ensureDefaultAdmin } = require('./src/bootstrap/adminAutoInit');
            await ensureDefaultAdmin();
            // 默认标的和自选股
            try {
              const { Instrument, Watchlist, User } = require('./src/models');
              const defaultInstruments = [
                {
                  symbol: 'sh000300',
                  name: '沪深300',
                  type: 'index',
                  market: 'SSE',
                  category: '指数',
                },
                {
                  symbol: 'sh000001',
                  name: '上证指数',
                  type: 'index',
                  market: 'SSE',
                  category: '指数',
                },
                {
                  symbol: 'sz399001',
                  name: '深证成指',
                  type: 'index',
                  market: 'SZSE',
                  category: '指数',
                },
                {
                  symbol: 'sz399006',
                  name: '创业板指',
                  type: 'index',
                  market: 'SZSE',
                  category: '指数',
                },
                {
                  symbol: 'rb_main',
                  name: '螺纹钢主力',
                  type: 'futures',
                  market: 'SHFE',
                  category: '期货',
                },
                {
                  symbol: 'rb2510',
                  name: '螺纹钢2510',
                  type: 'futures',
                  market: 'SHFE',
                  category: '期货',
                },
                {
                  symbol: 'sh600519',
                  name: '贵州茅台',
                  type: 'stock',
                  market: 'SSE',
                  category: 'A股',
                },
                {
                  symbol: 'sh600036',
                  name: '招商银行',
                  type: 'stock',
                  market: 'SSE',
                  category: 'A股',
                },
              ];
              for (const inst of defaultInstruments) {
                await Instrument.findOrCreate({ where: { symbol: inst.symbol }, defaults: inst });
              }
              const adminUser = await User.findOne({ where: { username: 'admin' } });
              if (adminUser) {
                const defaultWatchlist = [
                  {
                    symbol: 'sh000300',
                    symbolName: '沪深300',
                    instrumentType: 'index',
                    category: '指数',
                    basePrice: 4660,
                  },
                  {
                    symbol: 'sh000001',
                    symbolName: '上证指数',
                    instrumentType: 'index',
                    category: '指数',
                    basePrice: 3350,
                  },
                  {
                    symbol: 'sz399001',
                    symbolName: '深证成指',
                    instrumentType: 'index',
                    category: '指数',
                    basePrice: 10800,
                  },
                  {
                    symbol: 'rb_main',
                    symbolName: '螺纹钢主力',
                    instrumentType: 'futures',
                    category: '期货',
                    basePrice: 3380,
                  },
                  {
                    symbol: 'sh600519',
                    symbolName: '贵州茅台',
                    instrumentType: 'stock',
                    category: '股票',
                    basePrice: 1680,
                  },
                  {
                    symbol: 'sh600036',
                    symbolName: '招商银行',
                    instrumentType: 'stock',
                    category: '股票',
                    basePrice: 38,
                  },
                ];
                for (const item of defaultWatchlist) {
                  await Watchlist.findOrCreate({
                    where: { userId: adminUser.id, symbol: item.symbol },
                    defaults: { userId: adminUser.id, ...item },
                  });
                }
                console.log('Default instruments and watchlist seeded');
              }
            } catch (e) {
              logger.warn('init:seedInstruments failed', { error: e.message });
            }
            // 螺纹钢高频策略模板（H2: 种子数据已外置到 src/seeds/rebarStrategy.js）
            try {
              const { seedRebarStrategy } = require('./src/seeds/rebarStrategy');
              await seedRebarStrategy();
            } catch (e) {
              logger.warn('init:seedRebarStrategy failed', { error: e.message });
            }

            // 定时任务注册
            try {
              const instrumentService = require('./src/services/instrumentService');
              const { scheduleDaily } = require('./src/utils/dailyScheduler');
              scheduleDaily({
                hour: 2,
                minute: 0,
                task: async () => {
                  try {
                    await instrumentService.syncInstrumentsFromAData();
                  } catch (e) {
                    logger.warn('cron:instrumentSync failed', { error: e.message });
                  }
                },
              });
              console.log('Cron: 标的数据同步 (每天2:00)');
              const cacheController = require('./src/controllers/cacheController');
              const comprehensiveDataService = require('./src/services/comprehensiveDataService');
              scheduleDaily({
                hour: 3,
                minute: 0,
                task: async () => {
                  try {
                    const instruments = await instrumentService.getInstruments({
                      status: 'active',
                      limit: 100,
                    });
                    for (const inst of instruments) {
                      try {
                        const klineData = await comprehensiveDataService.getComprehensiveData(
                          inst.symbol,
                          { period: 'daily', limit: 500 }
                        );
                        if (klineData?.kline?.length) {
                          const klineDataService = require('./src/services/klineDataService');
                          await klineDataService.saveKlineData(
                            inst.symbol,
                            inst.name,
                            'daily',
                            klineData.kline
                          );
                        }
                        await new Promise((r) => setTimeout(r, 100));
                      } catch (e) {
                        logger.warn('cron:klineData item failed', { error: e.message });
                      }
                    }
                  } catch (e) {
                    logger.warn('cron:klineData failed', { error: e.message });
                  }
                },
              });
              console.log('Cron: K线数据持久化 (每天3:00)');
            } catch (e) {
              logger.warn('cron:register failed', { error: e.message });
            }

            // 标的同步服务
            try {
              if (instrumentSyncService) instrumentSyncService.start();
            } catch (e) {
              logger.warn('cron:instrumentSync start failed', { error: e.message });
            }

            // 非关键服务
            try {
              const trainingData = require('./src/services/trainingDataService');
              trainingData.runMaintenance();
            } catch (e) {
              logger.warn('cron:trainingData maintenance failed', { error: e.message });
            }
            try {
              const credentialWatcher = require('./src/services/credentialWatcherService');
              credentialWatcher.start();
            } catch (e) {
              logger?.warn?.('CredentialWatcher failed', { error: e.message });
            }
            try {
              const workflowRunWorker = require('./src/services/workflow/workflowRunWorker');
              workflowRunWorker.start();
            } catch (e) {
              logger?.warn?.('WorkflowRunWorker failed', { error: e.message });
            }
            try {
              const akshareUpdater = require('./src/services/akshareUpdater');
              akshareUpdater.startScheduler();
            } catch (e) {
              logger.warn('init:akshareUpdater failed', { error: e.message });
            }

            console.log(
              '\n⚡ 后台初始化完成 (' + ((Date.now() - bootStart) / 1000).toFixed(1) + 's)'
            );
          })(),
          (async () => {
            try {
              const networkDetector = require('./src/services/networkDetector');
              await networkDetector.init();
              console.log('Network mode: ' + networkDetector.getDataMode());
            } catch (e) {
              logger.warn('init:networkDetector failed', { error: e.message });
            }
          })(),
          (async () => {
            try {
              const sqliteBackup = require('./src/services/sqliteBackupService');
              sqliteBackup.init();
            } catch (e) {
              logger.warn('init:sqliteBackup failed', { error: e.message });
            }
          })(),
          (async () => {
            try {
              const mlAgentService = require('./src/services/mlAgentService');
              const mlStatus = await mlAgentService.checkPythonRuntimeDependencies();
              if (!mlStatus.ok) console.warn('ML Python dependencies missing');
            } catch (e) {
              logger.warn('init:mlAgentDeps failed', { error: e.message });
            }
          })(),
          (async () => {
            try {
              const result =
                await require('./src/services/instrumentService').syncInstrumentsFromAData();
              console.log(
                '标的同步: ' + result.successCount + ' 成功, ' + result.failCount + ' 失败'
              );
            } catch (e) {
              console.error('标的同步失败:', e.message);
            }
          })(),
        ]);
      } else {
        // Even without DB, start non-critical services
        try {
          if (instrumentSyncService) instrumentSyncService.start();
        } catch (e) {
          logger.warn('cron:instrumentSync start failed', { error: e.message });
        }
        try {
          const akshareUpdater = require('./src/services/akshareUpdater');
          akshareUpdater.startScheduler();
        } catch (e) {
          logger.warn('cron:akshareUpdater failed', { error: e.message });
        }
      }

      // Update bootstrap state
      try {
        const bootstrapState = require('./src/bootstrap/state');
        bootstrapState.set('activePort', _bootActivePort);
        bootstrapState.set('dbConnected', _bootDbConnected);
        bootstrapState.set('dbMode', process.env.DB_MODE || null);
      } catch (e) {
        logger.warn('cron:bootstrapState update failed', { error: e.message });
      }
    } catch (e) {
      console.warn('后台初始化异常:', e.message);
    }
  } catch (error) {
    console.error('✗ 服务器启动失败:', error);
    process.exit(1);
  }
})();

// ─── 空闲自动关闭机制 ─────────────────────────────────────────────────
// 仅在独立运行模式下生效（非 Docker、非 CLI 管理）
// 当所有前端 WebSocket 客户端断开后，启动倒计时；
// 若 IDLE_SHUTDOWN_MS 内无新连接，则优雅退出以释放端口。
// 适用场景：桌面端启动后关闭浏览器，自动回收后端进程资源
const IDLE_SHUTDOWN_MS = parseInt(process.env.IDLE_SHUTDOWN_MS || '60000', 10); // 60s default
const IDLE_SHUTDOWN_ENABLED = process.env.IDLE_SHUTDOWN !== 'false' && !process.env.DOCKER;
let _idleShutdownTimer = null;
const WS_HEARTBEAT_INTERVAL_MS = parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS || '30000', 10); // 30s
const WS_HEARTBEAT_TIMEOUT_MS = parseInt(process.env.WS_HEARTBEAT_TIMEOUT_MS || '70000', 10); // 70s
let _wsHeartbeatTimer = null;

function getActiveWsClientCount() {
  if (!wss.clients) return 0;
  let active = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      active++;
    }
  }
  return active;
}

function resetIdleShutdown() {
  if (_idleShutdownTimer) {
    clearTimeout(_idleShutdownTimer);
    _idleShutdownTimer = null;
  }
}

function startIdleShutdownIfEmpty() {
  if (!IDLE_SHUTDOWN_ENABLED) return;
  if (getActiveWsClientCount() > 0) return;
  resetIdleShutdown();
  _idleShutdownTimer = setTimeout(() => {
    // Double-check: still no clients?
    if (getActiveWsClientCount() > 0) return;
    logger.info(
      'No frontend clients connected for ' +
        IDLE_SHUTDOWN_MS / 1000 +
        's, shutting down to release port'
    );
    requestShutdown('idle-shutdown');
  }, IDLE_SHUTDOWN_MS);
  _idleShutdownTimer.unref();
}

function startWsProtocolHeartbeat() {
  if (WS_HEARTBEAT_INTERVAL_MS <= 0) return;

  if (_wsHeartbeatTimer) {
    clearInterval(_wsHeartbeatTimer);
  }

  _wsHeartbeatTimer = setInterval(() => {
    const now = Date.now();

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      const lastPongAt = client._lastPongAt || 0;
      if (lastPongAt > 0 && now - lastPongAt > WS_HEARTBEAT_TIMEOUT_MS) {
        logger.warn('WebSocket protocol heartbeat timeout, terminating stale client', {
          elapsedMs: now - lastPongAt,
        });
        try {
          client.terminate();
        } catch {}
        continue;
      }

      try {
        client.ping();
      } catch {}
    }
  }, WS_HEARTBEAT_INTERVAL_MS);

  _wsHeartbeatTimer.unref?.();
}

function stopWsProtocolHeartbeat() {
  if (_wsHeartbeatTimer) {
    clearInterval(_wsHeartbeatTimer);
    _wsHeartbeatTimer = null;
  }
}

// Endpoint for frontend to explicitly trigger shutdown (e.g., on page unload)
// Requires admin authentication to prevent unauthorized server termination
const {
  authMiddleware: shutdownAuth,
  adminMiddleware: shutdownAdmin,
} = require('./src/middleware/auth');
app.post('/api/shutdown', shutdownAuth, shutdownAdmin, (req, res) => {
  res.status(200).json({ ok: true, success: true }); // 兼容旧客户端依赖的 ok 字段
  // Delay shutdown slightly to allow response to be sent
  setTimeout(() => requestShutdown('api-shutdown'), 500);
});

// API 404 (JSON only)

app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,

    message: '接口不存在',

    path: req.originalUrl,
  });
});

// ─── 前端静态文件服务（SPA 单页应用） ──────────────────────────────────
// 从 frontend/dist/ 目录提供 Vue.js 构建产物
// 必须在所有 /api/* 路由之后注册，否则会拦截 API 请求
// SPA 模式：所有非 API、非文件请求都返回 index.html，由前端路由接管
// （对应论文第4章 §4.6 前后端一体化部署方案）
const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDistPath) && fs.existsSync(path.join(frontendDistPath, 'index.html'))) {
  // Remove the default JSON Content-Type for static files
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) {
      res.removeHeader('Content-Type');
    }
    next();
  });
  app.use(express.static(frontendDistPath));
  // SPA catch-all: serve index.html for any non-API, non-file route
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
  logger.info('Frontend static files served from frontend/dist/');
} else {
  // No frontend build — show a helpful message
  app.get('/', (req, res) => {
    res.removeHeader('Content-Type');
    res.type('html').send(`
      <html><body style="font-family:system-ui;padding:40px;text-align:center">
        <h2>KHY-Quant Backend</h2>
        <p>API is running. Frontend not found at <code>frontend/dist/</code>.</p>
        <p>Run <code>cd frontend && npm run build</code> to build the Vue.js UI.</p>
        <p><a href="/health">Health Check</a> | <a href="/api/health">API Health</a></p>
      </body></html>
    `);
  });
}

// 全局错误处理中间件 —— Express 四参数中间件，捕获所有路由中抛出的异常
app.use(errorHandler);

// ─── WebSocket 实时通信模块 ────────────────────────────────────────────
// 用于实时行情推送、系统通知和心跳检测（对应论文第4章 §4.7 实时数据推送）
// 连接流程：建立连接 → JWT 认证 → 订阅标的 → 接收实时行情
// 设计模式：发布-订阅模式（Pub/Sub），客户端按标的代码订阅行情频道

// ─── WebSocket connection rate limiting (per IP) ─────────────────────
const _wsConnectionLog = new Map();
const WS_MAX_CONNECTIONS_PER_MINUTE = 20;
const WS_WINDOW_MS = 60000;

function wsRateLimitCheck(req) {
  // Use req.ip (respects trust proxy setting) when available, fall back to
  // the socket remote address. Do NOT read x-forwarded-for directly — it is
  // trivially spoofable from client-side WebSocket connections and would
  // bypass the per-IP rate limit.
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const log = _wsConnectionLog.get(ip) || [];
  const recent = log.filter((t) => now - t < WS_WINDOW_MS);
  if (recent.length >= WS_MAX_CONNECTIONS_PER_MINUTE) return false;
  recent.push(now);
  _wsConnectionLog.set(ip, recent);
  // Prevent memory leak: prune stale IPs periodically
  if (_wsConnectionLog.size > 1000) {
    for (const [k, v] of _wsConnectionLog) {
      if (v.every((t) => now - t > WS_WINDOW_MS)) _wsConnectionLog.delete(k);
    }
  }
  return true;
}

// M1+M3: 定时清理 _wsConnectionLog 中的过期条目，避免仅在 size>1000 时才清理
// 导致的内存缓慢增长。每 60s 扫描一次，.unref() 使其不阻塞进程退出。
const _wsConnectionLogCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _wsConnectionLog) {
    if (v.every((t) => now - t > WS_WINDOW_MS)) _wsConnectionLog.delete(k);
  }
}, WS_WINDOW_MS);
_wsConnectionLogCleanupTimer.unref?.();

wss.on('connection', (ws, req) => {
  if (!wsRateLimitCheck(req)) {
    ws.close(1008, 'Rate limit exceeded');
    return;
  }

  console.log('新的WebSocket连接');
  resetIdleShutdown(); // Cancel any pending idle shutdown
  ws._lastPongAt = Date.now();

  ws.on('pong', () => {
    ws._lastPongAt = Date.now();
  });

  const subscriptions = new Set();

  let userId = null;

  let userRole = null;

  let isAuthenticated = false;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // 处理认证

      if (data.type === 'auth') {
        try {
          const token = data.token;

          if (!token) {
            ws.send(
              JSON.stringify({
                type: 'auth_error',

                message: '缺少认证令牌',
              })
            );

            return;
          }

          if (!authSessionService) {
            ws.send(
              JSON.stringify({
                type: 'auth_error',
                message: '认证服务尚未就绪，请稍后重试',
              })
            );
            return;
          }
          const authResult = await authSessionService.authenticateAccessToken(token, {
            touch: false,
          });
          if (!authResult?.ok || !authResult.user) {
            const messageText =
              authResult?.code === 'session_revoked' ||
              authResult?.code === 'session_expired' ||
              authResult?.code === 'token_version_mismatch' ||
              authResult?.code === 'legacy_token_revoked'
                ? '登录会话已失效，请重新登录'
                : '认证失败';
            ws.send(
              JSON.stringify({
                type: 'auth_error',
                message: messageText,
              })
            );
            return;
          }

          userId = authResult.user.id;
          userRole = authResult.user.role;
          isAuthenticated = true;

          if (notificationService) notificationService.registerConnection(ws, userId, userRole);

          ws.send(
            JSON.stringify({
              type: 'auth_success',
              message: '认证成功',
              userId,
              role: userRole,
            })
          );

          console.log(`WebSocket用户认证成功: ${authResult.user.username} (${userRole})`);
        } catch (error) {
          console.error('WebSocket认证失败:', error);

          ws.send(
            JSON.stringify({
              type: 'auth_error',

              message: '认证令牌无效',
            })
          );
        }

        return;
      }

      // 需要认证的操作

      if (!isAuthenticated) {
        ws.send(
          JSON.stringify({
            type: 'error',

            message: '请先进行认证',
          })
        );

        return;
      }

      if (data.type === 'subscribe') {
        // 订阅实时数据

        const symbol = data.symbol;

        subscriptions.add(symbol);

        if (realtimeDataService) realtimeDataService.subscribe(symbol, ws);

        ws.send(
          JSON.stringify({
            type: 'subscribed',

            symbol,

            message: `已订阅 ${symbol} 的实时数据`,
          })
        );
      } else if (data.type === 'unsubscribe') {
        // 取消订阅

        const symbol = data.symbol;

        subscriptions.delete(symbol);

        if (realtimeDataService) realtimeDataService.unsubscribe(symbol, ws);

        ws.send(
          JSON.stringify({
            type: 'unsubscribed',

            symbol,

            message: `已取消订阅 ${symbol}`,
          })
        );
      } else if (data.type === 'ping') {
        // 心跳检测

        ws.send(
          JSON.stringify({
            type: 'pong',

            timestamp: new Date().toISOString(),
          })
        );
      } else if (data.type === 'get_stats' && userRole === 'admin') {
        // 管理员获取连接统计

        const stats = notificationService ? notificationService.getStats() : {};

        ws.send(
          JSON.stringify({
            type: 'stats',

            data: stats,
          })
        );
      }
    } catch (error) {
      console.error('WebSocket消息处理错误:', error);

      // H3: 不将 error.message 直接回传客户端，仅 dev 模式附带详情
      const errorPayload = { type: 'error', message: '消息处理失败' };
      if (process.env.NODE_ENV !== 'production') errorPayload.detail = error.message;

      ws.send(JSON.stringify(errorPayload));
    }
  });

  ws.on('close', () => {
    console.log('WebSocket连接关闭');

    // 清理所有订阅

    subscriptions.forEach((symbol) => {
      if (realtimeDataService) realtimeDataService.unsubscribe(symbol, ws);
    });

    subscriptions.clear();

    // Delay one tick to avoid race with ws internal client-set cleanup
    setTimeout(() => {
      startIdleShutdownIfEmpty();
    }, 0);
  });

  ws.on('error', (error) => {
    // H3: 不输出完整 error 对象，仅记录错误消息
    console.error('WebSocket错误:', error?.message || error);
  });

  // 发送欢迎消息

  ws.send(
    JSON.stringify({
      type: 'connected',

      message: '已连接到实时服务，请进行认证',
    })
  );
});

startWsProtocolHeartbeat();

// ─── Windows 下自动启动 PostgreSQL 服务 ───────────────────────────────
// 仅 Windows 平台生效：自动检测 PostgreSQL 安装路径并启动服务
// 支持 C:/D: 盘的 16/17/18 版本自动探测，30秒超时保护

async function autoStartPostgreSQL() {
  return new Promise((resolve) => {
    try {
      console.log('🔍 检查 PostgreSQL 服务状态...');

      // Discover PostgreSQL installation paths dynamically
      // Supports: env override, Windows "Program Files" scan across drives, PATH lookup
      const possiblePaths = _discoverPgPaths();

      let pgPath = null;

      let pgData = null;

      // 查找 PostgreSQL 安装路径

      for (const basePath of possiblePaths) {
        const pgCtlPath = path.join(basePath, 'bin', 'pg_ctl.exe');

        const dataPath = path.join(basePath, 'data');

        if (fs.existsSync(pgCtlPath) && fs.existsSync(dataPath)) {
          pgPath = path.join(basePath, 'bin', 'pg_ctl.exe');

          pgData = dataPath;

          console.log(`✓ 找到 PostgreSQL: ${basePath}`);

          break;
        }
      }

      if (!pgPath) {
        console.log('⚠️ PostgreSQL 未安装或未找到，跳过自动启动');

        resolve();

        return;
      }

      // 检查服务状态

      const checkProcess = spawn(pgPath, ['status', '-D', pgData], {
        stdio: ['pipe', 'pipe', 'pipe'],

        windowsHide: true,
      });

      let checkResolved = false;

      checkProcess.on('exit', (code) => {
        if (checkResolved) return;

        checkResolved = true;

        if (code === 0) {
          console.log('✓ PostgreSQL 服务已在运行');

          resolve();
        } else {
          console.log('🚀 正在启动 PostgreSQL 服务...');

          // 启动 PostgreSQL

          const startProcess = spawn(pgPath, ['start', '-D', pgData], {
            stdio: ['pipe', 'pipe', 'pipe'],

            windowsHide: true,
          });

          let startResolved = false;

          startProcess.on('exit', (startCode) => {
            if (startResolved) return;

            startResolved = true;

            if (startCode === 0) {
              console.log('✓ PostgreSQL 服务启动成功');

              // 等待服务完全启动

              setTimeout(() => resolve(), 3000);
            } else {
              console.log('⚠️ PostgreSQL 服务启动失败，但继续运行');

              resolve();
            }
          });

          startProcess.on('error', (error) => {
            if (!startResolved) {
              console.error('PostgreSQL 启动错误:', error.message);

              startResolved = true;

              resolve();
            }
          });

          // 30秒超时

          setTimeout(() => {
            if (!startResolved) {
              console.log('⏰ PostgreSQL 启动超时，但继续运行');

              startResolved = true;

              resolve();
            }
          }, 30000);
        }
      });

      checkProcess.on('error', (error) => {
        if (!checkResolved) {
          console.error('PostgreSQL 状态检查错误:', error.message);

          checkResolved = true;

          resolve();
        }
      });

      // 10秒超时

      setTimeout(() => {
        if (!checkResolved) {
          console.log('⏰ PostgreSQL 状态检查超时，尝试直接启动');

          checkResolved = true;

          // 直接尝试启动

          const directStartProcess = spawn(pgPath, ['start', '-D', pgData], {
            stdio: ['pipe', 'pipe', 'pipe'],

            windowsHide: true,
          });

          directStartProcess.on('exit', () => {
            setTimeout(() => resolve(), 3000);
          });

          directStartProcess.on('error', () => {
            resolve();
          });
        }
      }, 10000);
    } catch (error) {
      console.error('自动启动 PostgreSQL 失败:', error.message);

      resolve(); // 即使失败也继续
    }
  });
}

// ─── 端口自动递增监听 ─────────────────────────────────────────────────
// 若指定端口被占用，自动尝试下一个端口，最多重试 MAX_PORT_RETRY 次
// 避免用户手动修改端口号，提升开箱即用体验

function listenWithAutoPort(serverInstance, startPort, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const tryListen = (port, attempt) => {
      const onError = (error) => {
        serverInstance.off('listening', onListening);

        if (error?.code === 'EADDRINUSE' && attempt < MAX_PORT_RETRY) {
          const nextPort = port + 1;

          logger.warn('Port is in use, retrying next port', {
            port,

            nextPort,

            attempt,

            maxAttempts: MAX_PORT_RETRY,
          });

          setTimeout(() => tryListen(nextPort, attempt + 1), 80);

          return;
        }

        reject(error);
      };

      const onListening = () => {
        serverInstance.off('error', onError);

        resolve(port);
      };

      serverInstance.once('error', onError);

      serverInstance.once('listening', onListening);

      serverInstance.listen(port, host);
    };

    tryListen(startPort, 1);
  });
}

/**
 * 主启动函数
 * 零级启动：实际初始化已在路由注册后的 IIFE 中完成
 * 此函数仅保留作为历史接口和错误兜底
 */
async function startServer() {
  // All initialization is done in the deferred-boot IIFE (line ~656)
  // which calls listenWithAutoPort() immediately after route registration.
  // Wait for boot to complete, or timeout after 30s.
  try {
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (_bootActivePort) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 30000);
    });
  } catch (error) {
    console.error('✗ 服务器启动失败:', error);
    process.exit(1);
  }
}

// ─── 优雅关闭机制 ─────────────────────────────────────────────────────
// 收到 SIGTERM/SIGINT 信号时，按顺序清理各子系统资源：
//   1. 停止实时行情数据服务
//   2. 关闭通知服务连接
//   3. 停止标的同步定时任务
//   4. 关闭 HTTP 服务器（等待已有请求完成，最多3秒超时）
// 使用 bootstrap 模块统一编排，5秒总超时保护
// 设计模式：命令模式（Command），每个清理动作封装为独立的 hook 函数
try {
  const {
    addShutdownHook,
    registerShutdownHandlers,
    requestShutdown,
  } = require('./src/bootstrap/shutdown');
  addShutdownHook('realtimeData', async () => {
    try {
      if (realtimeDataService) realtimeDataService.cleanup();
    } catch {}
  });
  addShutdownHook('notifications', async () => {
    try {
      if (notificationService) notificationService.cleanup();
    } catch {}
  });
  addShutdownHook('instrumentSync', async () => {
    try {
      if (instrumentSyncService) instrumentSyncService.stop();
    } catch {}
  });
  addShutdownHook('wsProtocolHeartbeat', async () => {
    try {
      stopWsProtocolHeartbeat();
    } catch {}
  });
  addShutdownHook('idleShutdownTimer', async () => {
    try {
      resetIdleShutdown();
    } catch {}
  });
  addShutdownHook('credentialWatcher', async () => {
    try {
      require('./src/services/credentialWatcherService').stop();
    } catch {}
  });
  addShutdownHook('workflowRunWorker', async () => {
    try {
      require('./src/services/workflow/workflowRunWorker').stop();
    } catch {}
  });
  addShutdownHook('openTelemetry', async () => {
    try {
      await shutdownOpenTelemetry(logger);
    } catch {}
  });
  // 停掉事件循环直方图，并把缓冲中的慢请求明细冲刷到 .khy/monitor/。
  // 两者都是同步且永不抛的，放在关停链上只是为了不丢最后几条明细。
  addShutdownHook('observability', async () => {
    try {
      const obs = require('./src/observability');
      obs.eventLoopMonitor.stop();
      obs.slowRequest.flush();
    } catch {
      /* 可观测性是尽力而为的:关停路径上宁可丢几条明细,也不能拖住退出 */
    }
  });
  addShutdownHook('startupFsm', async () => {
    if (_serverStartupFsm) _serverStartupFsm.fire('shutdown', { step: 'graceful_shutdown' });
  });
  addShutdownHook(
    'httpServer',
    () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve();
        }, 3000);
        server.close(() => {
          clearTimeout(timer);
          logger.info('Server closed gracefully');
          resolve();
        });
      })
  );
  registerShutdownHandlers();
} catch {
  // Fallback: original inline shutdown if bootstrap module unavailable
  function gracefulShutdown(signal) {
    logger.warn('Shutdown signal received', { signal });
    if (_serverStartupFsm)
      _serverStartupFsm.fire('shutdown', { step: 'graceful_shutdown', signal });
    try {
      if (realtimeDataService) realtimeDataService.cleanup();
    } catch {}
    try {
      if (notificationService) notificationService.cleanup();
    } catch {}
    try {
      if (instrumentSyncService) instrumentSyncService.stop();
    } catch {}
    try {
      stopWsProtocolHeartbeat();
    } catch {}
    try {
      resetIdleShutdown();
    } catch {}
    try {
      require('./src/services/credentialWatcherService').stop();
    } catch {}
    try {
      require('./src/services/workflow/workflowRunWorker').stop();
    } catch {}
    try {
      void shutdownOpenTelemetry(logger);
    } catch {}
    server.close(() => {
      logger.info('Server closed gracefully');
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// ─── 全局异常兜底 ─────────────────────────────────────────────────────
// 捕获未处理的异常和 Promise 拒绝，记录日志后继续运行
// 避免单个请求异常导致整个进程崩溃，提升系统可用性（对应论文第6章 §6.3 容错设计）

process.on('uncaughtException', (error) => {
  logger.error('uncaughtException captured', {
    message: error.message,

    stack: error.stack,
  });

  console.error('[FATAL] Uncaught exception:', error.message);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);

  const stack = reason instanceof Error ? reason.stack : undefined;

  logger.error('unhandledRejection captured', { message, stack });
});

// 启动入口：调用主启动函数，开始整个系统的初始化流程
logger.info('Observability OpenTelemetry status', { status: getOpenTelemetryStatus() });
startServer();
