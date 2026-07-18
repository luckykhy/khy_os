'use strict';

/**
 * health handler — `khy health`（统一自助健康诊断）
 *
 *   khy health            一条命令体检：运行时 / 数据目录 / 认证密钥 / 网络 /
 *                         模型通道 / 外部后端 / 凭证守护 / 服务注册表 / 磁盘 / 内存
 *   khy health --json     机器可读输出（CI / 脚本消费）
 *
 * 这是此前缺失的「可观测」自助入口：把分散在 `khy services health`、
 * `khy maintain`、`khy doctor`、HTTP `/health` 的健康信号聚合到一个顶层命令，
 * 并新增了「外部后端是否已配置」的可见性（治理工具静默/未配置时的诊断盲区）。
 *
 * 设计原则（与 maintain 驾驶舱一致）：
 *   • 确定性、fail-soft、默认零主动联网——只读 networkDetector 的缓存判定与
 *     已加载服务的健康，不触发新的远端探测，离线也能秒回。
 *   • 任何一项探测抛错都降级为「无法检测」(yellow) 而非让整条命令崩溃。
 *   • 存在 red 项时以非零退出，可作提交前 / 部署后的健康门禁。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

function fmt() {
  return require('../formatters');
}

// ── 单项探测都经此包裹：抛错统一降级为 yellow「无法检测」，绝不冒泡 ──
function _safeCheck(id, label, fn) {
  try {
    const r = fn();
    return { id, label, status: r.status || 'info', detail: r.detail || '', hint: r.hint || null };
  } catch (err) {
    return { id, label, status: 'yellow', detail: `无法检测：${err && err.message ? err.message : err}`, hint: null };
  }
}

// CC 后端口径对齐:字节数 → 人类可读走 CC `formatFileSize` 单一真源(ccFormat SSOT,
// 同 handlers/workspace.js / atMentionInject / toolResultSummary 已采纳的口径)。CC 后端
// 把**所有**文件大小都过同一个 formatFileSize;Khy 此前 health/storage 各有一套发散本地
// 算法(此处旧逻辑:`<1024`→"NB"无空格、变小数位、含 TB 档)。门控 KHY_CC_FORMAT
// (经 ccFormatEnabled)默认开;关 / require 失败 / 非有限输入 → 逐字节回退旧本地口径。
function _bytesHuman(n, env = process.env) {
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(n);
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  if (!Number.isFinite(n) || n < 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

// ── 各项探测 ────────────────────────────────────────────────────────

function _checkRuntime() {
  return {
    status: 'green',
    detail: `Node ${process.version} · ${process.platform}/${process.arch} · pid ${process.pid}`,
  };
}

function _checkInstall() {
  let root = process.cwd();
  try { root = require('../../utils/dataHome').getAppRoot() || root; } catch { /* fall back to cwd */ }
  return { status: 'info', detail: root };
}

function _checkDataHome() {
  const dataHome = require('../../utils/dataHome').getDataHome();
  // 可写性：dataHome 不可写会导致几乎所有持久化失败，属硬故障。
  try {
    fs.accessSync(dataHome, fs.constants.W_OK);
  } catch {
    return { status: 'red', detail: `${dataHome}（不可写）`, hint: '检查目录权限，或运行 `khy storage migrate` 迁移到可写位置' };
  }
  return { status: 'green', detail: dataHome };
}

function _checkAuthSecret() {
  // ensureAuthSecret 会在启动链路自愈 JWT_SECRET（env → 规范 .env → 生成持久化）。
  // 这里只读：env 命中即 green；规范 .env 命中即 green；都没有则 yellow（首启会自愈）。
  if (process.env.JWT_SECRET && String(process.env.JWT_SECRET).trim()) {
    return { status: 'green', detail: '已配置（环境变量）' };
  }
  // 规范后端 .env（services/backend/.env）
  let envFile = null;
  try { envFile = path.join(require('../../utils/dataHome').getAppRoot() || process.cwd(), '.env'); } catch { /* ignore */ }
  const candidates = [envFile, path.join(process.cwd(), '.env'), path.join(__dirname, '../../../.env')].filter(Boolean);
  for (const f of candidates) {
    try {
      if (fs.existsSync(f) && /^\s*JWT_SECRET\s*=\s*\S/m.test(fs.readFileSync(f, 'utf8'))) {
        return { status: 'green', detail: `已配置（${f}）` };
      }
    } catch { /* skip unreadable */ }
  }
  return { status: 'yellow', detail: '未检测到 JWT_SECRET', hint: '首次启动后端会自动生成并持久化；如登录报「认证配置缺失」，运行 `khy preflight`' };
}

function _checkNetwork() {
  // 只读缓存判定，不触发新探测（保持离线秒回）。
  const detector = require('../../services/networkDetector');
  const st = detector.getStatus();
  if (st.online) {
    const age = st.ageMs != null ? ` · ${Math.round(st.ageMs / 1000)}s 前` : '';
    return { status: 'green', detail: `在线（${st.mode}${st.stale ? ' · 缓存可能过期' : ''}${age}）` };
  }
  // 尚未探测（一次性命令未触发探测）≠ 确认离线——避免误报。
  if (!st.initialized || st.lastCheck == null) {
    return { status: 'info', detail: '尚未探测（按需触发；联网功能会在使用时自动探测）' };
  }
  // 已确认离线不是错误（本地模式合法），但需可见。
  return { status: 'yellow', detail: `离线（${st.reason || '无连接'}）`, hint: '本地能力仍可用；联网功能将降级。`khy` 会按需自动重试探测' };
}

function _checkModelChannels() {
  // 启发式：自定义供应商 + 常见供应商 env key。不主动联网，只看是否「配过」。
  let custom = 0;
  try {
    const f = require('../../utils/dataHome').getDataDir('custom_providers.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const arr = Array.isArray(j) ? j : (j && Array.isArray(j.providers) ? j.providers : []);
      custom = arr.length;
    }
  } catch { /* treat as 0 */ }
  const ENV_KEYS = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'AGNES_API_KEY',
    'DOMESTIC_API_KEY', 'KHY_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY',
  ];
  const envHits = ENV_KEYS.filter(k => process.env[k] && String(process.env[k]).trim()).length;
  const total = custom + envHits;
  if (total > 0) {
    return { status: 'green', detail: `${total} 个已配置通道（自定义 ${custom} · 环境 ${envHits}）` };
  }
  return { status: 'yellow', detail: '未检测到模型通道', hint: '运行 `khy gateway` 配置供应商与 API Key，或设置 *_API_KEY 环境变量' };
}

function _checkExternalBackend(id, label, mod) {
  // 外部后端（图像/视频生成）未配置不是错误——但要可见，避免「工具静默无响应」的盲区。
  let svc;
  try { svc = require(mod); } catch (err) { return { status: 'yellow', detail: `模块不可用：${err.message}` }; }
  const configured = typeof svc.isAnyBackendConfigured === 'function' ? svc.isAnyBackendConfigured() : false;
  if (configured) {
    let backend = '';
    try { backend = svc.resolveBackend ? (svc.resolveBackend() || '') : ''; } catch { /* ignore */ }
    return { status: 'green', detail: `已配置${backend ? `（${backend}）` : ''}` };
  }
  return { status: 'info', detail: '未配置（可选能力）', hint: `如需${label}，配置对应 KHY_*_GEN_* 环境变量` };
}

function _checkCredentialWatcher() {
  const svc = require('../../services/credentialWatcherService');
  const st = svc.getStatus();
  if (st.running) {
    return { status: 'green', detail: `运行中 · 监视 ${st.watcherCount} 个凭证源` };
  }
  return { status: 'info', detail: '未运行（守护进程模式下启用）' };
}

async function _checkServiceRegistry() {
  const registry = require('../../services/serviceRegistry');
  const results = await registry.healthCheck();
  const loaded = results.filter(r => r.healthy !== null);
  const unhealthy = loaded.filter(r => r.healthy === false);
  const healthy = loaded.filter(r => r.healthy === true);
  if (unhealthy.length) {
    const names = unhealthy.map(r => r.name).join('、');
    return { status: 'red', detail: `${unhealthy.length} 个服务异常：${names}`, hint: '查看 `khy services health` 获取逐项错误' };
  }
  if (!loaded.length) {
    return { status: 'info', detail: '当前进程未加载常驻服务（一次性命令属正常）' };
  }
  return { status: 'green', detail: `${healthy.length}/${loaded.length} 已加载服务健康` };
}

function _checkDisk() {
  const dataHome = require('../../utils/dataHome').getDataHome();
  if (typeof fs.statfsSync !== 'function') {
    return { status: 'info', detail: '当前 Node 不支持 statfs，跳过磁盘检测' };
  }
  const st = fs.statfsSync(dataHome);
  const free = st.bavail * st.bsize;
  const total = st.blocks * st.bsize;
  const detail = `剩余 ${_bytesHuman(free)} / ${_bytesHuman(total)} @ ${dataHome}`;
  if (free < 100 * 1024 * 1024) {
    return { status: 'red', detail, hint: '磁盘空间不足 100MB，写入可能失败；请清理后重试' };
  }
  if (free < 1024 * 1024 * 1024) {
    return { status: 'yellow', detail, hint: '剩余空间不足 1GB，建议清理' };
  }
  return { status: 'green', detail };
}

function _checkMemory() {
  // Linux freemem() 排除可回收的页缓存，常态偏低；故只做信息展示，不据此告警，
  // 避免在健康内存的机器上误报。真正的内存压力由 OS OOM 与 resourceGuard 处理。
  const free = os.freemem();
  const total = os.totalmem();
  return { status: 'info', detail: `空闲 ${_bytesHuman(free)} / ${_bytesHuman(total)}` };
}

// ── 聚合 ────────────────────────────────────────────────────────────

/**
 * 收集全部健康项，返回结构化报告。纯聚合、fail-soft，可被测试与 --json 直接消费。
 * @returns {Promise<{level:'green'|'yellow'|'red', checks:Array, summary:{green:number,yellow:number,red:number,info:number}}>}
 */
// Bug 哨兵:主动呈现「越早暴露 + 主动监听发现」的进程内信号(静默吞咽 / 不变量违反 /
// 滑窗越阈值预警)。一次性 CLI 进程多为空(无累积),长驻守护进程里才攒得到信号 —— 但作为
// 统一可观测出口,把哨兵接进健康体检,使主动发现的 bug 浮到顶层而非埋在日志。
function _checkBugSentinel() {
  let sentinel;
  try { sentinel = require('../../services/bugSentinel'); } catch { return { status: 'info', detail: '哨兵未加载' }; }
  if (!sentinel.isEnabled()) return { status: 'info', detail: '已关闭（KHY_BUG_SENTINEL=off）' };
  const s = sentinel.snapshot();
  if (s.active && s.active.length) {
    const top = s.active.slice(0, 3).join('、');
    return {
      status: 'yellow',
      detail: `主动预警 ${s.active.length} 项：${top}（窗口内复发越阈值）`,
      hint: '高频静默吞咽或不变量违反，查 `khy health --json` 的 byCode/anomalies 定位',
    };
  }
  if (s.breaches > 0) {
    return {
      status: 'yellow',
      detail: `不变量违反 ${s.breaches} 次（被动兜底未崩，但应排查）`,
      hint: '设 KHY_BUG_SENTINEL=strict 可让其在最早边界抛出',
    };
  }
  if (s.swallowed > 0) {
    return { status: 'info', detail: `已登记 ${s.swallowed} 处静默吞咽（${s.distinctCodes} 类），无越阈值复发` };
  }
  return { status: 'green', detail: '无静默吞咽 / 不变量违反' };
}

// 输出层软 bug 监听(goal 2026-06-25):呈现「输出不全 / 乱码 / 缩放丢行」的进程内累积。
// 一次性 CLI 多为空(无渲染累积),长驻 TUI/守护进程里才攒得到;不可修复计入 yellow,
// 仅有已修复计入 info,干净 green —— 把主动发现的输出软 bug 浮到 health 顶层而非埋日志。
function _checkOutputMonitor() {
  let mon;
  try { mon = require('../../services/outputIntegrityMonitor'); } catch { return { status: 'info', detail: '监听器未加载' }; }
  if (!mon.isEnabled()) return { status: 'info', detail: '已关闭（KHY_OUTPUT_MONITOR=off）' };
  const s = mon.snapshot();
  if (s.unrepaired > 0) {
    const top = Object.keys(s.byType).slice(0, 3).join('、');
    return {
      status: 'yellow',
      detail: `${s.unrepaired} 处不可修复的输出软 bug（${top}），已写错误日志`,
      hint: '查 logs/error-*.log 定位（乱码源/截断点）；KHY_OUTPUT_MONITOR=strict 可让其在 CI 抛出',
    };
  }
  if (s.repaired > 0) {
    return { status: 'info', detail: `已自动修复 ${s.repaired} 处输出软 bug（乱码 strip / 围栏闭合 / 缩放重绘）` };
  }
  return { status: 'green', detail: '无输出不全 / 乱码 / 缩放丢行' };
}

async function collectHealth() {
  const checks = [];
  checks.push(_safeCheck('runtime', '运行时', _checkRuntime));
  checks.push(_safeCheck('install', '安装位置', _checkInstall));
  checks.push(_safeCheck('dataHome', '数据目录', _checkDataHome));
  checks.push(_safeCheck('auth', '认证密钥', _checkAuthSecret));
  checks.push(_safeCheck('network', '网络', _checkNetwork));
  checks.push(_safeCheck('modelChannels', '模型通道', _checkModelChannels));
  checks.push(_safeCheck('imageBackend', '图像后端', () => _checkExternalBackend('image', '图像生成', '../../services/imageGenService')));
  checks.push(_safeCheck('videoBackend', '视频后端', () => _checkExternalBackend('video', '视频生成', '../../services/videoGenService')));
  checks.push(_safeCheck('credentialWatcher', '凭证守护', _checkCredentialWatcher));
  checks.push(_safeCheck('disk', '磁盘空间', _checkDisk));
  checks.push(_safeCheck('memory', '内存', _checkMemory));
  checks.push(_safeCheck('bugSentinel', 'Bug 哨兵', _checkBugSentinel));
  checks.push(_safeCheck('outputMonitor', '输出软 bug 监听', _checkOutputMonitor));

  // 服务注册表是异步项，单独 fail-soft 包裹。
  try {
    const r = await _checkServiceRegistry();
    checks.push({ id: 'services', label: '服务注册表', status: r.status, detail: r.detail, hint: r.hint || null });
  } catch (err) {
    checks.push({ id: 'services', label: '服务注册表', status: 'yellow', detail: `无法检测：${err.message}`, hint: null });
  }

  const summary = { green: 0, yellow: 0, red: 0, info: 0 };
  for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;
  const level = summary.red > 0 ? 'red' : (summary.yellow > 0 ? 'yellow' : 'green');
  return { level, checks, summary };
}

// ── 渲染 ────────────────────────────────────────────────────────────

function _printByStatus(status, line, f) {
  if (status === 'green') return f.printSuccess(line);
  if (status === 'yellow') return f.printWarn(line);
  if (status === 'red') return f.printError(line);
  return f.printInfo(line);
}

function _levelLabel(level) {
  switch (level) {
    case 'green': return '健康';
    case 'yellow': return '有告警';
    case 'red': return '需处理';
    default: return '未知';
  }
}

async function handleHealth(parsed = {}) {
  const f = fmt();
  const opts = parsed.options || {};
  const asJson = opts.json === true || opts.json === 'true'
    || (Array.isArray(parsed.args) && parsed.args.includes('--json'));

  const report = await collectHealth();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    if (report.level === 'red') process.exitCode = 1;
    return true;
  }

  const { printInfo } = f;
  printInfo('Khy 健康体检');
  printInfo('─'.repeat(48));
  for (const c of report.checks) {
    _printByStatus(c.status, `${c.label}：${c.detail}`, f);
    if (c.hint) printInfo(`    → ${c.hint}`);
  }
  printInfo('─'.repeat(48));
  const s = report.summary;
  _printByStatus(report.level, `总体：${_levelLabel(report.level)}（✓${s.green} ⚠${s.yellow} ✗${s.red}）`, f);

  // red → 非零退出（可作健康门禁）。
  if (report.level === 'red') process.exitCode = 1;
  return true;
}

module.exports = { handleHealth, collectHealth, _bytesHuman };
