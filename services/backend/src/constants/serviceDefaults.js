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

// Zero-dependency leaf: the single source of truth for boolean env tokens
// (1/true/yes/on ↔ 0/false/no/off). Required at module scope is safe — it
// requires nothing itself, so it cannot participate in a cycle.
const parseBoolean = require('../utils/parseBoolean');

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

// ARCH-074: ai-backend listen 绑定的 host。默认 '0.0.0.0'（Node express 默认行为），
// 让 LAN 上其他机器可以访问 /api/auth/login 等公开鉴权端点。
// 如需收紧到仅本机，设 AI_MGMT_HOST=127.0.0.1。
const AI_MGMT_HOST = process.env.AI_MGMT_HOST || '0.0.0.0';

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
// 自动投递工具白名单与图片回复路径清洗。均可由 env 覆盖。
const ILINK_DELIVER_TOOLS = String(
  process.env.KHY_ILINK_DELIVER_TOOLS || 'SendUserFile,image_generate'
)
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const ILINK_SANITIZE_PATHS = !/^(?:0|false|off|no)$/i.test(
  String(process.env.KHY_ILINK_SANITIZE_PATHS || 'true').trim()
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

// ── 数据备份与恢复(khy backup / services/backup/*)单一真源 ─────────────────
// F5「备份目录、保留策略可配置,默认值进 constants,不许散落硬编码」的落点。
// backupService / restoreService / handlers/backup.js 一律从这里取值,不内联字面量。
//
// 保留策略语义(明确定义,免歧义):一份备份被删,当且仅当**同时**满足「按时间倒序排在
// KEEP_COUNT 之外」**且**「早于 KEEP_DAYS」。最新一份**永不删除**。缺 .complete 标记的
// 残破备份不受这两条保护,优先清理。
const BACKUP = Object.freeze({
  // 备份根目录。空字符串 = 落 utils/dataHome.getDataDir('backups')
  // (bootstrap/migrations.js 已在建该目录),避免在此内联一个绝对路径。
  ROOT: process.env.KHY_BACKUP_ROOT || '',
  // 默认分级。core = 权威且体积可控;full = 追加 audit/receipts 等大体积历史流水。
  // 取值集合与语义见 services/backup/backupAssetPlan.js(资产规则的单一真源)。
  TIER: process.env.KHY_BACKUP_TIER || 'core',
  KEEP_COUNT: parseInt(process.env.KHY_BACKUP_KEEP_COUNT || '10', 10),
  KEEP_DAYS: parseInt(process.env.KHY_BACKUP_KEEP_DAYS || '30', 10),
  // 起备前的最小可用空间。默认 512 MB:宁可拒绝开始,也不要写一半把盘撑爆。
  MIN_FREE_BYTES: parseInt(
    process.env.KHY_BACKUP_MIN_FREE_BYTES || String(512 * 1024 * 1024),
    10
  ),
  // PostgreSQL 分支(仅 DB_MODE=postgres 时启用)。
  PG_DUMP_BIN: process.env.KHY_PG_DUMP_BIN || 'pg_dump',
  PG_DUMP_IDLE_TIMEOUT_MS: parseInt(
    process.env.KHY_BACKUP_PG_DUMP_IDLE_TIMEOUT_MS || '120000',
    10
  ),
  // 备份集内部布局(restore 与演练测试都按这些名字寻址)。
  MANIFEST_FILENAME: 'manifest.json',
  COMPLETE_MARKER: '.complete',
  DB_SUBDIR: 'db',
  PG_DUMP_FILENAME: 'postgres.dump',
  HOME_SUBDIR_PREFIX: 'home-',
  MANIFEST_SCHEMA_VERSION: 1,
  // 备份集含 khy-quant.db 的 api_keys/auth_sessions 表与各通道 token,且按表裁剪会
  // 破坏引用完整性,故不裁 —— 用文件权限兜底,并在 manifest 标记 containsSecrets。
  DIR_MODE: 0o700,
  FILE_MODE: 0o600,
  // khy vault(~/.khyos/vault)属独立机密域,默认不进备份集(见域边界)。
  INCLUDE_VAULT: false,
});

// Runtime storage retention. Layout switches remain additive so deployments can roll back without moving live data.
const LOGS = Object.freeze({
  LAYOUT: process.env.KHY_LOG_LAYOUT || 'active',
  KEEP_DAYS: parseInt(process.env.KHY_LOG_KEEP_DAYS || '14', 10),
  MAX_FILES: parseInt(process.env.KHY_LOG_MAX_FILES || '40', 10),
  MAX_SIZE_BYTES: parseInt(process.env.KHY_LOG_MAX_SIZE_BYTES || String(120 * 1024 * 1024), 10),
});
// 审计流水（.khy/audit）的保留策略。与 LOGS 同形：先归档，再按总量删归档。
//
// 为什么归档而不是直接删：审计分片是「谁在什么时候做了什么」的流水，过了保留期
// 仍可能被回溯（事故复盘、合规问询）。旧实现对 sessions/ 里过期文件直接 unlink，
// 保留期一到证据就没了。改成打包成一份 .jsonl.gz 落进 audit/archive/，既压掉了
// 体积（实测 5.8 MB / 2129 个小文件 → 一份几百 KB 的 gz），又把「2483 个小文件」
// 这个真正贵的成本（每个文件一次 stat/一次 inode）收成一个。
//
// 注意：这里**不含** .khy/audit-trajectory。那条通道是外部质检要逐行解析的审计
// 记录，契约规定任何情况下都不压缩、不裁剪、不摘要，所以它既不在本策略内，也不
// 在 `khy clean --runtime` 的白名单内。别"顺手"把它加进来。
const AUDIT = Object.freeze({
  KEEP_DAYS: parseInt(process.env.KHY_AUDIT_KEEP_DAYS || '7', 10),
  MAX_TOTAL_MB: parseInt(process.env.KHY_AUDIT_MAX_TOTAL_MB || '200', 10),
  MAX_SUMMARY_FILES: parseInt(process.env.KHY_AUDIT_MAX_SUMMARY_FILES || '50', 10),
  MAX_EXPORT_FILES: parseInt(process.env.KHY_AUDIT_MAX_EXPORT_FILES || '10', 10),
  EVENTS_MAX_SIZE_BYTES: parseInt(
    process.env.KHY_AUDIT_EVENTS_MAX_SIZE_BYTES || String(10 * 1024 * 1024),
    10
  ),
  // 关掉 → 退回旧行为（过期直接删，不留归档）。留这个开关是为了让磁盘极紧的部署
  // 有退路，默认开：多数场合下 gz 归档比原始分片小一个量级，留着更划算。
  ARCHIVE: process.env.KHY_AUDIT_ARCHIVE !== '0',
});
// 运行时体积自检的提示阈值。超过就在启动时说一句「跑 khy clean --runtime 看看」，
// 绝不自动删——.khy 里躺着会话历史与凭据，自动清理的错误代价是不可逆的。
const RUNTIME_FOOTPRINT = Object.freeze({
  NOTICE_MB: parseInt(process.env.KHY_FOOTPRINT_NOTICE_MB || '500', 10),
  ENABLED: process.env.KHY_FOOTPRINT_NOTICE !== '0',
});
const CHECKPOINT = Object.freeze({
  STORAGE_MODE: process.env.KHY_CHECKPOINT_STORAGE_MODE || 'legacy',
  MAX_TOTAL_MB: parseInt(process.env.KHY_CHECKPOINT_MAX_TOTAL_MB || '500', 10),
});
// 冷导出:把 audit/receipts/events 这类「只增不改」的历史流水压成单个 .jsonl.gz,
// 代替逐文件复制 —— 代价几乎全在**文件数**而不是字节数:audit 一个目录就是
// 1300+ 个小文件,每个都要一次 copy、一次 stat、一次 sha256、一条 manifest entry。
//
// 默认关闭是刻意的:它改变的是**备份集的形状**,恢复端要按 kind 分派才拿得回来。
// 先让 full 级备份的人显式开一段时间、验证 verify/restore 无碍,再谈默认打开。
const COLD_EXPORT = Object.freeze({
  ENABLED: process.env.KHY_COLD_EXPORT_ENABLED === '1',
  // 冷归档**不单独设保留期**。它躺在备份集内部(<set>/cold/…),随所属集一起被
  // pruneBackups 按 KEEP_COUNT/KEEP_DAYS 删除 —— 这是唯一正确的粒度:单独删掉一份
  // 归档会让 manifest 指向不存在的文件,verify 当场失败,而那批数据**只存在于**
  // 归档里(备份端已把它们从逐文件复制清单去掉),删了就没了。
  // 保留期语义在 BACKUP.KEEP_COUNT / BACKUP.KEEP_DAYS,别在这里再开一个。
  // 记录进入「冷」的年龄门槛:比这更新的记录不进归档,留在原地逐文件收。
  // 热窗口内的流水还在被追加,把它折叠进 gz 会让 restore 之后的增量写入
  // 落到一个刚被整体覆盖过的目录上。与备份保留期无关,独立可调。
  WINDOW_DAYS: parseInt(process.env.KHY_COLD_EXPORT_WINDOW_DAYS || '30', 10),
  // 归档在备份集内的子目录。与 DB_SUBDIR / HOME_SUBDIR_PREFIX 同级,restore 按它寻址。
  SUBDIR: 'cold',
});

// ── API key 池冷却/退避单一真源(services/apiKeyPool.js) ─────────────────────
// F5「默认值进 constants,不许散落硬编码」的落点。这四个值原先内联在 apiKeyPool.js
// 顶部且**没有任何 env 覆盖**:某 provider 抖动一阵把 key 推到最高退避级后,用户除了
// 干等 5 分钟别无办法,想调短必须改代码重装 —— 正是用户报的「硬编码错误」。
//
// 退避语义:第 n 次触发冷却(n = backoffLevel,从 1 起)→ BASE_COOLDOWN_MS · 2^(n-1),
// 取 MAX_COOLDOWN_MS 为上限,级数取 MAX_BACKOFF_LEVEL 为上限。默认 10s→20→40→80→160s,
// 封顶 300s。**只有** 429/403/401 与限流类文案会触发 key 级冷却;网络抖动
// (ECONNRESET / socket hang up)只记失败计数,不冷却 —— 换条连接就能好的错误不该停用 key。
const _poolInt = (raw, fallback, min) => {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const API_KEY_POOL = Object.freeze({
  BASE_COOLDOWN_MS: _poolInt(process.env.KHY_API_KEY_POOL_BASE_COOLDOWN_MS, 10000, 1000),
  MAX_COOLDOWN_MS: _poolInt(process.env.KHY_API_KEY_POOL_MAX_COOLDOWN_MS, 300000, 1000),
  MAX_BACKOFF_LEVEL: _poolInt(process.env.KHY_API_KEY_POOL_MAX_BACKOFF_LEVEL, 5, 1),
  // 服务端 Retry-After 的上界。上游给出的秒数不可无条件信任(实测见过 86400):
  // 没有这个夹子,一个坏响应就能把一把好 key 停用一整天。
  MAX_RETRY_AFTER_MS: _poolInt(process.env.KHY_API_KEY_POOL_MAX_RETRY_AFTER_MS, 600000, 1000),
});

// ── Self-update sources ─────────────────────────────────────────────────────
// Release sources and release tracks are separate concepts. Consumers select
// sources in this fixed order while stable/preview/dev remains the track.
const UPDATE = Object.freeze({
  GITHUB_REPOSITORY: process.env.KHY_UPDATE_GITHUB_REPOSITORY || 'luckykhy/khy_os',
  GITHUB_RELEASES_API: process.env.KHY_UPDATE_GITHUB_RELEASES_API || `https://api.github.com/repos/${process.env.KHY_UPDATE_GITHUB_REPOSITORY || 'luckykhy/khy_os'}/releases`,
  GITHUB_REPOSITORY_API:
    process.env.KHY_UPDATE_GITHUB_REPOSITORY_API ||
    `https://api.github.com/repos/${process.env.KHY_UPDATE_GITHUB_REPOSITORY || 'luckykhy/khy_os'}`,
  GITHUB_RAW_BASE_URL: process.env.KHY_UPDATE_GITHUB_RAW_BASE_URL || 'https://raw.githubusercontent.com',
  // The runnable backend manifest on GitHub's default branch is also a release surface:
  // it may advance before a GitHub Release/tag is created.
  GITHUB_VERSION_MANIFEST_PATH:
    process.env.KHY_UPDATE_GITHUB_VERSION_MANIFEST_PATH || 'services/backend/package.json',
  GITHUB_TAG_PATTERN: 'v<version>',
  PROBE_TIMEOUT_MS: parseInt(process.env.KHY_UPDATE_PROBE_TIMEOUT_MS || '8000', 10),
  PROBE_TOTAL_TIMEOUT_MS: parseInt(process.env.KHY_UPDATE_PROBE_TOTAL_TIMEOUT_MS || '10000', 10),
  DOWNLOAD_IDLE_TIMEOUT_MS: parseInt(process.env.KHY_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS || '10000', 10),
  PROGRESS_MIN_INTERVAL_MS: parseInt(process.env.KHY_UPDATE_PROGRESS_MIN_INTERVAL_MS || '1000', 10),
  RETRY_COUNT: parseInt(process.env.KHY_UPDATE_RETRY_COUNT || '1', 10),
  ENABLED_CHANNELS: Object.freeze(['github', 'pypi', 'npm', 'local']),
  PYPI_BASE_URL: process.env.KHY_UPDATE_PYPI_BASE_URL || 'https://pypi.org/pypi',
  NPM_REGISTRY_URL: process.env.KHY_UPDATE_NPM_REGISTRY_URL || 'https://registry.npmjs.org',
});

// Runtime assets excluded from install packages live beside their immutable
// GitHub release. payloadProvisioner is the only consumer of these endpoints.
const PAYLOAD = Object.freeze({
  GITHUB_REPOSITORY:
    process.env.KHY_PAYLOAD_GITHUB_REPOSITORY || UPDATE.GITHUB_REPOSITORY,
  RELEASE_DOWNLOAD_BASE_URL:
    process.env.KHY_PAYLOAD_RELEASE_BASE_URL ||
    `https://github.com/${process.env.KHY_PAYLOAD_GITHUB_REPOSITORY || UPDATE.GITHUB_REPOSITORY}/releases/download`,
  TAG_PATTERN: process.env.KHY_PAYLOAD_TAG_PATTERN || UPDATE.GITHUB_TAG_PATTERN,
  MANIFEST_ASSET: process.env.KHY_PAYLOAD_MANIFEST_ASSET || 'khy-payload-manifest.json',
  DOWNLOAD_IDLE_TIMEOUT_MS: parseInt(
    process.env.KHY_PAYLOAD_DOWNLOAD_IDLE_TIMEOUT_MS || String(UPDATE.DOWNLOAD_IDLE_TIMEOUT_MS),
    10
  ),
  RETRY_COUNT: parseInt(
    process.env.KHY_PAYLOAD_RETRY_COUNT || String(UPDATE.RETRY_COUNT),
    10
  ),
  CACHE_ROOT: process.env.KHY_PAYLOAD_CACHE_ROOT || '',
});

// ── Observability: slow-request alerting & CPU profiling ───────────────────
// Single source of truth for every slow-request / profiling threshold. Both
// features default to OFF: an install that sets none of these env vars pays
// exactly one boolean check per request and starts no timers at all.
//
// Consumers MUST NOT re-read these env vars inline. The pure leaves
// observability/slowRequestCore.js and observability/profilerCore.js expose
// resolveConfig(env) which layers env overrides on top of these defaults, so a
// test can flip a threshold without reloading this module.
const OBSERVABILITY = Object.freeze({
  // Slow-request alerting (hooked into observability/metrics.js middleware).
  SLOW_REQUEST_ENABLED: parseBoolean(process.env.KHY_SLOW_REQUEST_ENABLED, false),
  SLOW_REQUEST_THRESHOLD_MS: parseInt(process.env.KHY_SLOW_REQUEST_THRESHOLD_MS || '3000', 10),
  // 0..1 — deterministic token-bucket sampling, not Math.random (reproducible).
  SLOW_REQUEST_SAMPLE_RATE: Number(process.env.KHY_SLOW_REQUEST_SAMPLE_RATE || '1'),
  // Per-route alert debounce: slow requests arrive in bursts; logging every one
  // buries the signal. Aggregation still counts every sampled request.
  SLOW_REQUEST_ALERT_COOLDOWN_MS: parseInt(
    process.env.KHY_SLOW_REQUEST_ALERT_COOLDOWN_MS || '60000',
    10
  ),
  // Cardinality cap for the persisted store; overflow lands in `_other`.
  SLOW_REQUEST_MAX_ROUTES: parseInt(process.env.KHY_SLOW_REQUEST_MAX_ROUTES || '200', 10),
  SLOW_REQUEST_MAX_SAMPLES: parseInt(process.env.KHY_SLOW_REQUEST_MAX_SAMPLES || '256', 10),
  // Daily JSONL shards under .khy/monitor/ older than this are pruned.
  SLOW_REQUEST_RETENTION_DAYS: parseInt(process.env.KHY_SLOW_REQUEST_RETENTION_DAYS || '7', 10),

  // CPU profiling (node:inspector on demand + event-loop delay continuous).
  PROFILING_ENABLED: parseBoolean(process.env.KHY_PROFILING_ENABLED, false),
  PROFILING_DURATION_MS: parseInt(process.env.KHY_PROFILING_DURATION_MS || '10000', 10),
  PROFILING_MAX_DURATION_MS: parseInt(process.env.KHY_PROFILING_MAX_DURATION_MS || '120000', 10),
  PROFILING_SAMPLE_INTERVAL_US: parseInt(
    process.env.KHY_PROFILING_SAMPLE_INTERVAL_US || '1000',
    10
  ),
  // perf_hooks.monitorEventLoopDelay resolution + how often the histogram is read.
  EVENTLOOP_RESOLUTION_MS: parseInt(process.env.KHY_EVENTLOOP_RESOLUTION_MS || '20', 10),
  EVENTLOOP_CHECK_INTERVAL_MS: parseInt(
    process.env.KHY_EVENTLOOP_CHECK_INTERVAL_MS || '30000',
    10
  ),
  EVENTLOOP_LAG_THRESHOLD_MS: parseInt(process.env.KHY_EVENTLOOP_LAG_THRESHOLD_MS || '200', 10),
});

const exported = {
  OLLAMA_HOST,
  INFERENCE_SERVER_PORT,
  getAiBackendUrl,
  BACKEND_PORT,
  // ARCH-074
  AI_MGMT_HOST,
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
  ILINK_DELIVER_TOOLS,
  ILINK_SANITIZE_PATHS,
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
  // 数据备份与恢复单一真源(khy backup;保留策略/根目录/分级默认值)
  BACKUP,
  // Runtime storage retention and rollback policy.
  LOGS,
  AUDIT,
  RUNTIME_FOOTPRINT,
  CHECKPOINT,
  COLD_EXPORT,
  // API key 池冷却/退避单一真源(services/apiKeyPool.js)
  API_KEY_POOL,
  UPDATE,
  PAYLOAD,
  // Observability thresholds SSOT (slow-request alerting + CPU profiling).
  // Read through slowRequestCore.resolveConfig / profilerCore.resolveConfig.
  OBSERVABILITY,
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
