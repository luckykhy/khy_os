'use strict';

/**
 * serviceDefaults.js — Single source of truth for external service URLs/ports.
 *
 * Every env-based default lives here so no file needs to independently
 * hardcode "localhost:XXXX" OR a production domain.  Import from this module
 * instead.  Domain migration / self-hosting = one edit here, every consumer
 * follows (see AGENTS.md "Zero Hardcoding").
 */

const fs = require('fs');
const path = require('path');

// ── Cloud (telemetry / profile sync / skill registry) endpoint ──────────────
// The production cloud endpoint. Overridable per-install via env or the user's
// cloud.json (cloudSync.getEndpoint reads config.endpoint first). Every module
// that needs the default MUST import these instead of re-hardcoding the domain.
const CLOUD_DEFAULT_ENDPOINT = process.env.KHY_CLOUD_ENDPOINT || 'https://api.khyquant.top';
const CLOUD_FALLBACK_ENDPOINTS = [
  CLOUD_DEFAULT_ENDPOINT,
  // Future domain migrations are appended here (single source of truth).
];
// Default telemetry sink derived from the cloud endpoint (no second literal).
const TELEMETRY_DEFAULT_ENDPOINT =
  process.env.KHY_TELEMETRY_ENDPOINT || `${CLOUD_DEFAULT_ENDPOINT}/telemetry`;
// Bare host used by diagnostics/help text when no host is supplied.
const CLOUD_DEFAULT_HOST = (() => {
  try {
    return new URL(CLOUD_DEFAULT_ENDPOINT).host.replace(/^api\./, '');
  } catch {
    return 'khyquant.top';
  }
})();
// Attribution referer sent to OpenRouter-style upstreams (HTTP-Referer header).
const HTTP_REFERER = process.env.KHY_HTTP_REFERER || 'https://khyquant.com';

// ── Local AI backend (daemon) default ───────────────────────────────────────
// The loopback port the daemon listens on when nothing else is discoverable.
// apps/ai-frontend/backendDiscovery.mjs MIRRORS this value (a separate browser
// package that cannot import backend code) — keep the two in lock-step.
const AI_BACKEND_DEFAULT_PORT = parseInt(process.env.KHY_DAEMON_PORT || '9090', 10);
const AI_BACKEND_DEFAULT_URL = `http://localhost:${AI_BACKEND_DEFAULT_PORT}`;

/**
 * Discover the daemon API URL from runtime state.
 * Returns null when no valid runtime or env-derived port is available.
 */
function _discoverAiBackendUrl(env = process.env) {
  const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');
  const files = [
    path.join(getDataHome(), 'ai_manage_runtime.json'),
    path.join(getLegacyDataHome(), 'ai_manage_runtime.json'),
  ];

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const apiPort = parseInt(String(raw?.apiPort ?? ''), 10);
      if (Number.isFinite(apiPort) && apiPort > 0 && apiPort <= 65535) {
        return `http://localhost:${apiPort}`;
      }
    } catch {
      /* try next */
    }
  }

  const envPort = parseInt(String(env.KHY_DAEMON_PORT || env.AI_MGMT_PORT || ''), 10);
  if (Number.isFinite(envPort) && envPort > 0 && envPort <= 65535) {
    return `http://localhost:${envPort}`;
  }
  return null;
}

function getAiBackendUrl(env = process.env) {
  return env.AI_BACKEND_URL || _discoverAiBackendUrl(env) || AI_BACKEND_DEFAULT_URL;
}

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const INFERENCE_SERVER_PORT = parseInt(process.env.INFERENCE_SERVER_PORT || '8765', 10);
const BACKEND_PORT = parseInt(process.env.PORT || '3000', 10);

// ── AI provider preset endpoints (gateway/providerPresets.js SSOT) ──────────
// One-click preset base URLs for aggregators / popular providers. The literal
// default lives ONLY here (Zero Hardcoding): providerPresets.js imports these
// instead of writing an endpoint literal inline. Each is env-overridable so a
// self-host / mirror is a single edit. All speak the OpenAI wire protocol
// (Ollama via its /v1 OpenAI-compatible endpoint derived from OLLAMA_HOST).
const OPENROUTER_BASE_URL = process.env.KHY_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const GROQ_BASE_URL = process.env.KHY_GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const TOGETHER_BASE_URL = process.env.KHY_TOGETHER_BASE_URL || 'https://api.together.xyz/v1';
const DEEPSEEK_BASE_URL = process.env.KHY_DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
// Local Ollama OpenAI-compatible endpoint: derived from OLLAMA_HOST so the host
// is defined once; env override wins when a fully custom URL is needed.
const OLLAMA_OPENAI_BASE_URL = process.env.KHY_OLLAMA_OPENAI_BASE_URL || `${OLLAMA_HOST}/v1`;

// Redis gateway key prefix (shared across all gateway Redis keys)
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'khy:gw:';

// ── Portable copy root (khy portable sync) ─────────────────────────────────────
// Default target root of the portable copy used by `khy portable sync`.
// The literal path lives ONLY here (Zero Hardcoding SSOT); every consumer
// must import PORTABLE_ROOT_DEFAULT. Non-Windows platforms have no default
// (empty string) — the CLI requires an explicit --target there.
const PORTABLE_ROOT_DEFAULT =
  process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT || '';

// ── Geolocation (GetLocation tool / geolocationService) ────────────────────
// SSOT for the IP-geolocation endpoints and geolocation timeouts. The
// geolocation engine (services/geolocationService.js) MUST import these
// instead of hardcoding URLs/timeouts (Zero Hardcoding).
const GEOLOCATION_IP_API_URL = process.env.KHY_GEOLOCATION_IP_API || 'http://ip-api.com/json';
const GEOLOCATION_IPIFY_URL =
  process.env.KHY_GEOLOCATION_IPIFY || 'https://api.ipify.org?format=json';
const GEOLOCATION_HTTP_TIMEOUT_MS = parseInt(
  process.env.KHY_GEOLOCATION_HTTP_TIMEOUT_MS || '5000',
  10
);
const WINDOWS_GEO_TIMEOUT_MS = parseInt(process.env.KHY_WINDOWS_GEO_TIMEOUT_MS || '4000', 10);
const GEOLOCATION_CACHE_TTL_MS = parseInt(process.env.KHY_GEOLOCATION_CACHE_TTL_MS || '300000', 10);

// ── 微信 ilink bot 通道(个人微信扫码接入)单一真源 ──────────────────────────
// 官方 ilink bot API。与企业微信(wecom)是**两套不同的东西**:wecom 走群机器人
// webhook,ilink 走 bot_token + 长轮询。故平台键为 'ilink' 而非 'wechat'
// (后者已被 msgChannelCore.normalizePlatform 别名到 wecom)。
const ILINK_BASE_URL = process.env.KHY_ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com';
const ILINK_CDN_BASE_URL =
  process.env.KHY_ILINK_CDN_BASE_URL || 'https://novac2c.cdn.weixin.qq.com/c2c';
// baseUrl 白名单:服务端在扫码应答里回传的 baseurl 不可盲信,只接受这些域名 + https。
const ILINK_ALLOWED_HOSTS = ['weixin.qq.com', 'wechat.com'];
// 二维码登录:3s 轮询一次,单次请求 60s 超时。
const ILINK_QR_POLL_INTERVAL_MS = parseInt(process.env.KHY_ILINK_QR_POLL_INTERVAL_MS || '3000', 10);
const ILINK_QR_POLL_TIMEOUT_MS = parseInt(process.env.KHY_ILINK_QR_POLL_TIMEOUT_MS || '60000', 10);
// getupdates 是长轮询,超时必须明显大于服务端挂起时长。
const ILINK_GETUPDATES_TIMEOUT_MS = parseInt(
  process.env.KHY_ILINK_GETUPDATES_TIMEOUT_MS || '35000',
  10
);
const ILINK_REQUEST_TIMEOUT_MS = parseInt(process.env.KHY_ILINK_REQUEST_TIMEOUT_MS || '15000', 10);
const ILINK_GETCONFIG_TIMEOUT_MS = parseInt(
  process.env.KHY_ILINK_GETCONFIG_TIMEOUT_MS || '10000',
  10
);
const ILINK_SENDTYPING_TIMEOUT_MS = parseInt(
  process.env.KHY_ILINK_SENDTYPING_TIMEOUT_MS || '5000',
  10
);
const ILINK_CDN_TIMEOUT_MS = parseInt(process.env.KHY_ILINK_CDN_TIMEOUT_MS || '30000', 10);
// 出站文件大小上限(字节)。默认 25MB;超过则降级为「发路径文本」而不做上传。env 覆盖。
const ILINK_MAX_FILE_SIZE_BYTES = parseInt(
  process.env.KHY_ILINK_MAX_FILE_SIZE || String(25 * 1024 * 1024),
  10
);
// 大文件上传到 CDN 的墙钟上限。图片仍走 ILINK_CDN_TIMEOUT_MS(30s);文件可能达 25MB,
// 在其基线上放宽到默认 180s 以覆盖大文件场景。基于活动的超时,超时后 abort 在飞请求,不硬 kill。
const ILINK_FILE_UPLOAD_TIMEOUT_MS = parseInt(
  process.env.KHY_ILINK_FILE_UPLOAD_TIMEOUT_MS || '180000',
  10
);
// 轮询退避:连续失败 >= 阈值转长退避;ret=-14(会话过期)暂停 1 小时。
const ILINK_BACKOFF_SHORT_MS = parseInt(process.env.KHY_ILINK_BACKOFF_SHORT_MS || '3000', 10);
const ILINK_BACKOFF_LONG_MS = parseInt(process.env.KHY_ILINK_BACKOFF_LONG_MS || '30000', 10);
const ILINK_BACKOFF_THRESHOLD = parseInt(process.env.KHY_ILINK_BACKOFF_THRESHOLD || '3', 10);
const ILINK_SESSION_EXPIRED_PAUSE_MS = parseInt(
  process.env.KHY_ILINK_SESSION_EXPIRED_PAUSE_MS || '3600000',
  10
);
// 出站分片上限(UTF-16 码元,非字节)与去重表容量。
const ILINK_MAX_MESSAGE_LENGTH = parseInt(process.env.KHY_ILINK_MAX_MESSAGE_LENGTH || '2048', 10);
const ILINK_DEDUPE_MAX = parseInt(process.env.KHY_ILINK_DEDUPE_MAX || '1000', 10);
// typing 指示器保活周期;权限审批超时与「吞掉迟到 y/n」的宽限期。
const ILINK_TYPING_KEEPALIVE_MS = parseInt(process.env.KHY_ILINK_TYPING_KEEPALIVE_MS || '5000', 10);
const ILINK_PERMISSION_TIMEOUT_MS = parseInt(
  process.env.KHY_ILINK_PERMISSION_TIMEOUT_MS || '120000',
  10
);
const ILINK_PERMISSION_GRACE_MS = parseInt(
  process.env.KHY_ILINK_PERMISSION_GRACE_MS || '15000',
  10
);
// 单次 agent 查询的墙钟上限。chat() 既不收 abort signal 也没有整体超时,一次卡死的查询
// 会让串行队列永久阻塞 —— 微信从此不理人,只能重启守护进程。给它一个上限,超时后
// cancelActiveRequest 掐掉在飞请求并放行队列。默认 10 分钟:长任务要留余量,但不能无界。
const ILINK_QUERY_TIMEOUT_MS = parseInt(process.env.KHY_ILINK_QUERY_TIMEOUT_MS || '600000', 10);
// 出站发送的瞬时故障重试(网络错/超时/429/5xx)。零重试时一次网络抖动就丢一条回复。
const ILINK_SEND_MAX_RETRIES = parseInt(process.env.KHY_ILINK_SEND_MAX_RETRIES || '2', 10);
const ILINK_SEND_RETRY_BASE_MS = parseInt(process.env.KHY_ILINK_SEND_RETRY_BASE_MS || '800', 10);
// 通道心跳:每轮长轮询成功后打一次,但**最快每 60s 才落盘一次**(轮询约 35s 一轮,
// 不限流的话又变成高频写)。用途是让 CLI 跨进程看出「通道是活的 / 崩了 / 卡住了」——
// 守护进程 PID 还在不代表长轮询还在转。
const ILINK_HEARTBEAT_MIN_INTERVAL_MS = parseInt(
  process.env.KHY_ILINK_HEARTBEAT_MIN_INTERVAL_MS || '60000',
  10
);
// 心跳多久没更新就判定「通道可能已停摆」。取轮询周期(35s)+ 心跳限流(60s)的宽裕倍数,
// 避免正常抖动被误报成故障。
const ILINK_HEARTBEAT_STALE_MS = parseInt(process.env.KHY_ILINK_HEARTBEAT_STALE_MS || '240000', 10);
// 终端二维码的纠错等级。实测(89 字符的登录 URL、small 模式)各档可见尺寸:
//   L 20行×39列 · M 22行×43列 · Q 26行×51列 · H 28行×55列
// 默认 L:屏幕上显示的码没有污损/磨损风险,L 足够稳,且比 M 省 2 行 4 列。
// 注:`margin` 选项对 terminal 渲染器**无效**(静区固定),所以纠错等级是唯一的尺寸杠杆。
const ILINK_QR_ERROR_CORRECTION = String(
  process.env.KHY_ILINK_QR_ERROR_CORRECTION || 'L'
).toUpperCase();
// 会话隔离策略：多账号下一条消息归属哪个 agent 会话的单一真源。
// per-account-channel-peer：按《账号 + 通道 + 对端》隔离，避免不同微信账号/不同聊天对象的上下文串位。
const ILINK_SESSION_SCOPE = process.env.KHY_ILINK_SESSION_SCOPE || 'per-account-channel-peer';
const ILINK_SESSION_SCOPES = ['main', 'per-peer', 'per-channel-peer', 'per-account-channel-peer'];

// ── 语音输入（Win+H 触发，voiceInputService）────────────────────────────────
// PowerShell 模拟 Win+H 按键的墙钟上限；超时后 kill 子进程，避免挂死请求。
const VOICE_INPUT_TRIGGER_TIMEOUT_MS = parseInt(
  process.env.KHY_VOICE_INPUT_TRIGGER_TIMEOUT_MS || '8000',
  10
);
// 听写静音判定：TUI 麦克风按钮开启听写后，若输入框 N 毫秒没有新内容（用户停止说话），
// 自动再次触发 Win+H 关闭听写面板。基于「活动重置」的空闲超时（AGENTS.md 规则 3），
// 每收到一个听写字符就重置计时，绝不硬杀进行中的任务。
const VOICE_SILENCE_TIMEOUT_MS = parseInt(process.env.KHY_VOICE_SILENCE_MS || '6000', 10);

const exported = {
  OLLAMA_HOST,
  INFERENCE_SERVER_PORT,
  getAiBackendUrl,
  BACKEND_PORT,
  REDIS_KEY_PREFIX,
  // AI provider preset endpoints single source of truth (providerPresets.js)
  OPENROUTER_BASE_URL,
  GROQ_BASE_URL,
  TOGETHER_BASE_URL,
  DEEPSEEK_BASE_URL,
  OLLAMA_OPENAI_BASE_URL,
  // Cloud endpoint single source of truth
  CLOUD_DEFAULT_ENDPOINT,
  CLOUD_FALLBACK_ENDPOINTS,
  TELEMETRY_DEFAULT_ENDPOINT,
  CLOUD_DEFAULT_HOST,
  HTTP_REFERER,
  // Local AI backend default
  AI_BACKEND_DEFAULT_PORT,
  AI_BACKEND_DEFAULT_URL,
  // Portable copy root single source of truth (khy portable sync)
  PORTABLE_ROOT_DEFAULT,
  // Geolocation single source of truth (GetLocation tool)
  GEOLOCATION_IP_API_URL,
  GEOLOCATION_IPIFY_URL,
  GEOLOCATION_HTTP_TIMEOUT_MS,
  WINDOWS_GEO_TIMEOUT_MS,
  GEOLOCATION_CACHE_TTL_MS,
  // 微信 ilink bot 通道单一真源(个人微信扫码;与 wecom 无关)
  ILINK_BASE_URL,
  ILINK_CDN_BASE_URL,
  ILINK_ALLOWED_HOSTS,
  ILINK_QR_POLL_INTERVAL_MS,
  ILINK_QR_POLL_TIMEOUT_MS,
  ILINK_GETUPDATES_TIMEOUT_MS,
  ILINK_REQUEST_TIMEOUT_MS,
  ILINK_GETCONFIG_TIMEOUT_MS,
  ILINK_SENDTYPING_TIMEOUT_MS,
  ILINK_CDN_TIMEOUT_MS,
  ILINK_MAX_FILE_SIZE_BYTES,
  ILINK_FILE_UPLOAD_TIMEOUT_MS,
  ILINK_BACKOFF_SHORT_MS,
  ILINK_BACKOFF_LONG_MS,
  ILINK_BACKOFF_THRESHOLD,
  ILINK_SESSION_EXPIRED_PAUSE_MS,
  ILINK_MAX_MESSAGE_LENGTH,
  ILINK_DEDUPE_MAX,
  ILINK_TYPING_KEEPALIVE_MS,
  ILINK_PERMISSION_TIMEOUT_MS,
  ILINK_PERMISSION_GRACE_MS,
  ILINK_QUERY_TIMEOUT_MS,
  ILINK_SEND_MAX_RETRIES,
  ILINK_SEND_RETRY_BASE_MS,
  ILINK_HEARTBEAT_MIN_INTERVAL_MS,
  ILINK_HEARTBEAT_STALE_MS,
  ILINK_QR_ERROR_CORRECTION,
  ILINK_SESSION_SCOPE,
  ILINK_SESSION_SCOPES,
  // 语音输入（Win+H）单一真源
  VOICE_INPUT_TRIGGER_TIMEOUT_MS,
  VOICE_SILENCE_TIMEOUT_MS,
  // LEGACY portable sync configuration — consumed only by the degraded
  // `khy sync` handler (handlers/portableSync.js). The watcher mode it
  // configured was replaced by the one-shot `khy portable sync` engine,
  // which uses KHY_PORTABLE_ROOT / PORTABLE_ROOT_DEFAULT above. Kept for
  // interface compatibility; do not add new consumers.
  PORTABLE_SYNC: {
    DEV_SOURCE: process.env.KHY_SYNC_SOURCE || null,
    PORTABLE_TARGET: process.env.KHY_SYNC_TARGET || PORTABLE_ROOT_DEFAULT || null,
    DEBOUNCE_MS: Number(process.env.KHY_SYNC_DEBOUNCE_MS) || 1500,
    EXCLUDE_PATTERNS: [
      'node_modules',
      '.git',
      'dist',
      'build',
      '__pycache__',
      '.env',
      '.env.*',
      '.tmp',
      'logs',
      '*.log',
      '.DS_Store',
      '.khyquant-data',
      '.sync-state',
      'models',
    ],
    NPM_INSTALL_TRIGGERS: ['package.json', 'package-lock.json'],
    ENABLED: process.env.KHY_SYNC_ENABLED !== '0',
  },
};

Object.defineProperty(exported, 'AI_BACKEND_URL', {
  enumerable: true,
  get() {
    return getAiBackendUrl();
  },
});

module.exports = exported;
