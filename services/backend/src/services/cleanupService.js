/**
 * Centralized auto-cleanup service for ~/.khyquant/ persistent data.
 *
 * Manages:
 *  - Security log rotation (5 MB cap, gzip, keep 2 archives)
 *  - Growth snapshots pruning (max 10)
 *  - Training interaction records trimming (10 000 lines / 50 MB)
 *  - Telemetry export pruning (max 5 files)
 *  - Trace audit logs rotation (trace-events.jsonl, sessions/, summaries/, exports/)
 *    过期分片先折成 audit/archive/sessions-<日期>.jsonl.gz 再删原件，总量超
 *    KHY_AUDIT_MAX_TOTAL_MB 时才从最旧的归档开始删。取回归档里的记录：
 *      node -e "process.stdout.write(require('zlib').gunzipSync(require('fs').readFileSync(process.argv[1])))" <归档.gz> > out.jsonl
 *    每行带 _source 字段指回原分片文件名。被总量封顶删掉的归档无法重建 —— 这是
 *    唯一不可逆的一档，所以它的阈值默认给到 200 MB（实测 audit 只有 14.8 MB）。
 *    .khy/audit-trajectory 不在本服务治理范围内：那条通道契约规定不压缩不裁剪。
 *  - Antivirus scan log rotation (scan.log)
 *  - Skill ledger audit rotation (skill-ledger/audit.jsonl)
 *  - Telemetry audit log rotation (~/.khy/audit.jsonl)
 *  - Training quarantine trimming (interaction_quarantine.jsonl)
 *  - Daily memory logs pruning (90 days)
 *  - Session files cleanup (7 days)
 *  - Trajectory cleanup (project .khy: transcripts + replay-ledger/trace-chain sidecars + trajectory_replay store, KHY_TRAJECTORY_MAX_AGE_D, default 30 days)
 *  - Task output cleanup (24 hours)
 *  - Context compressor archives (7 days)
 *  - Checkpoint storage cap (500 MB per project)
 *
 * Already self-cleaning (not touched here):
 *  - Conversations (MAX_SAVED_CONVERSATIONS = 20)
 *  - Command history (MAX_HISTORY = 500)
 *  - Token usage (90-day daily / 6-month monthly)
 *  - Growth strategies (500) / analysis patterns (200)
 *  - Knowledge base (200 entries)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const _formatBytesAtom = require('../utils/formatBytes');
const { LOGS, AUDIT, CHECKPOINT, RUNTIME_FOOTPRINT } = require('../constants/serviceDefaults');

// Lazily resolve the legacy-compatible app home (portable-aware).
// No local caching: preserves getAppHome() live-resolve semantics.
function _baseDir() {
  try {
    const { getAppHome } = require('../utils/dataHome');
    return getAppHome();
  } catch {
    return path.join(os.homedir(), '.khyquant');
  }
}
const BACKEND_ROOT = process.env.KHYQUANT_ROOT || path.resolve(__dirname, '..', '..');

// ── Limits ──────────────────────────────────────────────────────────────
const SECURITY_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const SECURITY_LOG_KEEP_ARCHIVES = 2;
const SNAPSHOTS_MAX_KEEP = 10;
const TRAINING_MAX_LINES = 10_000;
const TRAINING_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const TELEMETRY_MAX_FILES = 5;
const TEMP_MAX_AGE_HOURS = 24;
const LOG_MAX_AGE_HOURS = 168; // 7 days
const LOG_MAX_FILES = 20;
const TEMP_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const LOG_MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
// OS-temp khy- 前缀残留的销毁年龄（小时）。这是 kill -9 / 崩溃退出（不触发任何
// 进程钩子）后会话临时目录被回收的明确上限。可经 KHY_OS_TEMP_MAX_AGE_HOURS 覆盖。
// 实际最坏回收延迟 = 此年龄 + 扫描周期（KHY_CLEANUP_INTERVAL_MS，默认 2h）。
const OS_TEMP_MAX_AGE_HOURS = (() => {
  const v = parseFloat(process.env.KHY_OS_TEMP_MAX_AGE_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

// ── Extended coverage limits ───────────────────────────────────────────
// 审计流水的四个阈值搬到 constants/serviceDefaults 的 AUDIT 策略里,可用 KHY_AUDIT_*
// 覆盖。默认值逐字节等于此前的硬编码常量,所以不改环境的部署行为不变。
const TRACE_EVENTS_MAX_BYTES = AUDIT.EVENTS_MAX_SIZE_BYTES;
const TRACE_SESSION_MAX_AGE_D = AUDIT.KEEP_DAYS;
const TRACE_SUMMARY_MAX_FILES = AUDIT.MAX_SUMMARY_FILES;
const TRACE_EXPORT_MAX_FILES = AUDIT.MAX_EXPORT_FILES;
const SCAN_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const SKILL_AUDIT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const TELEM_AUDIT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const QUARANTINE_MAX_LINES = 5000;
const QUARANTINE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const DAILY_LOG_MAX_AGE_D = 90;
const SESSION_MAX_AGE_D = 7;
// 轨迹（project data home 下的 sessions transcript + replay-ledger + trace-chain
// sidecar + trajectory_replay content store）的定期清理保留期（天）。轨迹原本
// 从不被清理、无限堆积；此处给出明确的定期清理时间。可经 KHY_TRAJECTORY_MAX_AGE_D
// 覆盖；设为 0 或负数则关闭轨迹清理（永久保留）。清理在 cleanupService 周期内执行
// （KHY_CLEANUP_INTERVAL_MS，默认 2h），活跃会话因 mtime 持续刷新天然不被回收。
const TRAJECTORY_MAX_AGE_D = (() => {
  const v = parseFloat(process.env.KHY_TRAJECTORY_MAX_AGE_D);
  if (process.env.KHY_TRAJECTORY_MAX_AGE_D !== undefined) {
    return Number.isFinite(v) ? v : 30;
  }
  return 30;
})();
const TASK_OUTPUT_MAX_AGE_H = 24;
// Global checkpoint quota. Sourced from serviceDefaults so KHY_CHECKPOINT_MAX_TOTAL_MB
// is the single override point; the historical 500MB default is unchanged.
const CKPT_MAX_TOTAL_MB = CHECKPOINT.MAX_TOTAL_MB;

// Paths derived from well-known locations (portable-aware via dataHome).
function _khyHome() {
  try {
    const { getDataHome } = require('../utils/dataHome');
    return getDataHome();
  } catch {
    return path.join(os.homedir(), '.khy');
  }
}

// Only managed prefixes are eligible for OS-temp cleanup.
// Keep this explicit to avoid touching unrelated third-party temp files.
const OS_TEMP_PREFIXES = ['khy_', 'khy-', 'khyquant_', 'khyquant-'];

// File extensions that are always safe to clean
const JUNK_EXTENSIONS = new Set([
  '.tmp',
  '.temp',
  '.bak',
  '.swp',
  '.swo',
  '.pid',
  '.log.1',
  '.log.2',
  '.log.3',
  '.log.4',
  '.log.5',
]);

let _periodicTimer = null;
let _lastCleanupReport = null;

// ── Helpers ─────────────────────────────────────────────────────────────

function safeSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function safeLs(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Thin delegate to the canonical formatter (utils/formatBytes); the default
// 3-tier B/KB/MB cascade is byte-identical to the previous local implementation.
function humanSize(bytes) {
  return _formatBytesAtom(bytes);
}

function atomicWriteText(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function safeTreeSize(entryPath) {
  try {
    const stat = fs.lstatSync(entryPath);
    if (stat.isFile()) {
      return stat.size;
    }
    if (!stat.isDirectory()) {
      return 0;
    }
  } catch {
    return 0;
  }

  let total = 0;
  const stack = [entryPath];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const fp = path.join(cur, e.name);
      try {
        if (e.isDirectory()) {
          stack.push(fp);
        } else if (e.isFile()) {
          total += fs.statSync(fp).size;
        }
      } catch {
        /* skip broken nodes */
      }
    }
  }
  return total;
}

function isManagedOsTempEntry(name) {
  return OS_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function recordCleanupTarget(metrics, name, action, extra = {}) {
  const startedAt = Date.now();
  let result;
  try {
    result = action();
  } catch (err) {
    result = { error: err.message || String(err) };
  }

  const elapsedMs = Date.now() - startedAt;
  const metric = {
    name,
    elapsedMs,
    ok: !result || !result.error,
    ...extra,
  };

  if (typeof result?.removed === 'number') {
    metric.removed = result.removed;
  }
  if (typeof result?.bytes === 'number') {
    metric.bytes = result.bytes;
  }
  if (typeof result?.kept === 'number') {
    metric.kept = result.kept;
  }
  if (typeof result?.rotated === 'boolean') {
    metric.rotated = result.rotated;
  }
  if (typeof result?.trimmed === 'boolean') {
    metric.trimmed = result.trimmed;
  }
  if (!metric.ok) {
    metric.error = String(result.error || 'unknown error').slice(0, 200);
  }

  metrics.targets.push(metric);
  if (!metric.ok) {
    metrics.failureCount += 1;
  }
  return result;
}

function setLastCleanupReport(trigger, results) {
  const summary = results?.summary || {};
  const metrics = results?.metrics || {};
  const targets = Array.isArray(metrics.targets) ? metrics.targets.map((t) => ({ ...t })) : [];

  _lastCleanupReport = {
    at: Date.now(),
    trigger: String(trigger || 'manual'),
    freedBytes: summary.freedBytes || 0,
    freedHuman: summary.freedHuman || humanSize(summary.freedBytes || 0),
    actions: Array.isArray(summary.actions) ? [...summary.actions] : [],
    actionCount: Array.isArray(summary.actions) ? summary.actions.length : 0,
    elapsedMs: Number(metrics.elapsedMs || 0),
    targetCount: Number(metrics.targetCount || targets.length || 0),
    failureCount: Number(metrics.failureCount || 0),
    targets,
  };
}

function getLastCleanupReport() {
  if (!_lastCleanupReport) {
    return null;
  }
  return {
    ..._lastCleanupReport,
    actions: [...(_lastCleanupReport.actions || [])],
    targets: Array.isArray(_lastCleanupReport.targets)
      ? _lastCleanupReport.targets.map((t) => ({ ...t }))
      : [],
  };
}

// ── Security log rotation ───────────────────────────────────────────────

function rotateSecurityLog() {
  const logPath = path.join(_baseDir(), 'security.log');
  const size = safeSize(logPath);
  if (size <= SECURITY_LOG_MAX_BYTES) {
    return { rotated: false, size };
  }

  try {
    // Shift existing archives: .2.gz → delete, .1.gz → .2.gz
    for (let i = SECURITY_LOG_KEEP_ARCHIVES; i >= 1; i--) {
      const src = path.join(_baseDir(), `security.log.${i}.gz`);
      if (i === SECURITY_LOG_KEEP_ARCHIVES) {
        try {
          fs.unlinkSync(src);
        } catch {
          /* OK */
        }
      } else {
        const dst = path.join(_baseDir(), `security.log.${i + 1}.gz`);
        try {
          fs.renameSync(src, dst);
        } catch {
          /* OK */
        }
      }
    }

    // Compress current log → .1.gz
    const raw = fs.readFileSync(logPath);
    const compressed = zlib.gzipSync(raw);
    fs.writeFileSync(path.join(_baseDir(), 'security.log.1.gz'), compressed);
    fs.writeFileSync(logPath, ''); // truncate
    return { rotated: true, originalSize: size, compressedSize: compressed.length };
  } catch (err) {
    return { rotated: false, error: err.message };
  }
}

// ── Growth snapshots pruning ────────────────────────────────────────────

function cleanSnapshots(maxKeep = SNAPSHOTS_MAX_KEEP) {
  const dir = path.join(_baseDir(), 'growth', 'snapshots');
  const files = safeLs(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length <= maxKeep) {
    return { removed: 0, kept: files.length };
  }

  const toRemove = files.slice(0, files.length - maxKeep);
  let removed = 0,
    bytes = 0;
  for (const f of toRemove) {
    const fp = path.join(dir, f);
    try {
      bytes += safeSize(fp);
      fs.unlinkSync(fp);
      removed++;
    } catch {
      /* skip */
    }
  }
  return { removed, kept: files.length - removed, bytes };
}

// ── Training data trimming ──────────────────────────────────────────────

function trimTrainingData(maxLines = TRAINING_MAX_LINES) {
  const filePath = path.join(_baseDir(), 'training', 'interaction_records.jsonl');
  const size = safeSize(filePath);
  if (size === 0) {
    return { trimmed: false, lines: 0, size: 0 };
  }

  // If under size cap, only trim by line count
  if (size <= TRAINING_MAX_BYTES) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length <= maxLines) {
        return { trimmed: false, lines: lines.length, size };
      }

      const kept = lines.slice(-maxLines);
      atomicWriteText(filePath, kept.join('\n') + '\n');
      return {
        trimmed: true,
        before: lines.length,
        after: kept.length,
        freedBytes: size - safeSize(filePath),
      };
    } catch (err) {
      return { trimmed: false, error: err.message };
    }
  }

  // Over size cap — aggressive trim
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const half = Math.min(maxLines, Math.floor(lines.length / 2));
    const kept = lines.slice(-half);
    atomicWriteText(filePath, kept.join('\n') + '\n');
    return {
      trimmed: true,
      before: lines.length,
      after: kept.length,
      freedBytes: size - safeSize(filePath),
    };
  } catch (err) {
    return { trimmed: false, error: err.message };
  }
}

// ── Telemetry exports pruning ───────────────────────────────────────────

function cleanTelemetry(maxFiles = TELEMETRY_MAX_FILES) {
  const dir = path.join(_baseDir(), 'telemetry');
  const files = safeLs(dir).sort();

  if (files.length <= maxFiles) {
    return { removed: 0, kept: files.length };
  }

  const toRemove = files.slice(0, files.length - maxFiles);
  let removed = 0,
    bytes = 0;
  for (const f of toRemove) {
    const fp = path.join(dir, f);
    try {
      bytes += safeSize(fp);
      fs.unlinkSync(fp);
      removed++;
    } catch {
      /* skip */
    }
  }
  return { removed, kept: files.length - removed, bytes };
}

// ── Storage report ──────────────────────────────────────────────────────

/**
 * 运行时体积自检:算出数据家目录的现状,超阈值就给出一句可执行的提示。
 *
 * **只报不删**。这里刻意不接任何删除动作:.khy 下躺着 checkpoints(工作区快照)、
 * sessions(会话存档)、credentials/、api_keys.json —— 自动清理一旦判错就是不可逆
 * 的损失,而多占几百 MB 是可逆的。所以本函数的产出是一段文字,执行权留给用户。
 *
 * 纯函数式:不写盘、不发通知,调用方决定怎么展示。KHY_FOOTPRINT_NOTICE=0 关掉,
 * KHY_FOOTPRINT_NOTICE_MB 调阈值。
 *
 * @param {string} [root] 数据家目录,缺省 _khyHome()
 * @returns {{root:string,totalBytes:number,totalHuman:string,thresholdBytes:number,
 *            overThreshold:boolean,reclaimableBytes:number,reclaimableHuman:string,
 *            notice:string|null,breakdown:Array<{rel:string,bytes:number,human:string}>}}
 */
function assessRuntimeFootprint(root = _khyHome()) {
  const thresholdBytes = Math.max(0, RUNTIME_FOOTPRINT.NOTICE_MB) * 1024 * 1024;
  // `khy clean --runtime` 的白名单(见 cli/handlers/clean.js RUNTIME_TARGETS)。
  // 提示里报的「可回收」必须与那条命令实际会删的一致,否则用户跑完发现回收数字
  // 对不上,下一次就不信这个提示了。
  const RECLAIMABLE = ['logs', 'audit', 'tmp', 'cache', 'break-cache', 'change-watch'];
  const breakdown = [];
  let totalBytes = 0;
  let reclaimableBytes = 0;
  for (const name of safeLs(root)) {
    const fp = path.join(root, name);
    let bytes = 0;
    try {
      const st = fs.statSync(fp);
      bytes = st.isDirectory() ? safeTreeSize(fp) : st.size;
    } catch {
      continue;
    }
    totalBytes += bytes;
    if (RECLAIMABLE.includes(name)) {
      reclaimableBytes += bytes;
    }
    breakdown.push({ rel: name, bytes, human: humanSize(bytes) });
  }
  breakdown.sort((a, b) => b.bytes - a.bytes);
  const overThreshold =
    RUNTIME_FOOTPRINT.ENABLED && thresholdBytes > 0 && totalBytes > thresholdBytes;
  let notice = null;
  if (overThreshold) {
    const top = breakdown
      .slice(0, 3)
      .map((b) => `${b.rel} ${b.human}`)
      .join('、');
    // 状态文本按红线 2 写成「动作 + 目标 + 进度」:说清测了什么、测出多少、下一步
    // 敲什么命令。绝不写成「空间不足…」这种没有下一步的话。
    notice =
      `已统计 ${root}:占用 ${humanSize(totalBytes)}，超过提示阈值 ` +
      `${humanSize(thresholdBytes)}（最大三项:${top}）。` +
      `可运行 khy clean --runtime --dry-run 查看可回收的 ${humanSize(reclaimableBytes)}；` +
      `会话存档与工作区快照不在其中,不会被清掉。`;
  }
  return {
    root,
    totalBytes,
    totalHuman: humanSize(totalBytes),
    thresholdBytes,
    overThreshold,
    reclaimableBytes,
    reclaimableHuman: humanSize(reclaimableBytes),
    notice,
    breakdown,
  };
}

function getStorageReport() {
  const report = {};

  // Security log
  const logPath = path.join(_baseDir(), 'security.log');
  report.securityLog = { size: safeSize(logPath), path: logPath };

  // Security log archives
  let archiveSize = 0;
  for (let i = 1; i <= SECURITY_LOG_KEEP_ARCHIVES; i++) {
    archiveSize += safeSize(path.join(_baseDir(), `security.log.${i}.gz`));
  }
  report.securityLogArchives = { size: archiveSize };

  // Growth snapshots
  const snapDir = path.join(_baseDir(), 'growth', 'snapshots');
  const snapFiles = safeLs(snapDir);
  let snapSize = 0;
  for (const f of snapFiles) {
    snapSize += safeSize(path.join(snapDir, f));
  }
  report.growthSnapshots = { count: snapFiles.length, size: snapSize, path: snapDir };

  // Training data
  const trainPath = path.join(_baseDir(), 'training', 'interaction_records.jsonl');
  report.trainingData = { size: safeSize(trainPath), path: trainPath };

  // Telemetry
  const telDir = path.join(_baseDir(), 'telemetry');
  const telFiles = safeLs(telDir);
  let telSize = 0;
  for (const f of telFiles) {
    telSize += safeSize(path.join(telDir, f));
  }
  report.telemetry = { count: telFiles.length, size: telSize, path: telDir };

  // Conversations
  const convoDir = path.join(_baseDir(), 'conversations');
  const convoFiles = safeLs(convoDir);
  let convoSize = 0;
  for (const f of convoFiles) {
    convoSize += safeSize(path.join(convoDir, f));
  }
  report.conversations = { count: convoFiles.length, size: convoSize };

  // Trace audit (~/.khy/audit/)
  const auditRoot = path.join(_khyHome(), 'audit');
  report.traceAudit = { size: safeTreeSize(auditRoot), path: auditRoot };

  // Scan log
  report.scanLog = { size: safeSize(path.join(_baseDir(), 'scan.log')) };

  // Skill ledger
  report.skillAudit = { size: safeSize(path.join(_baseDir(), 'skill-ledger', 'audit.jsonl')) };

  // Telemetry audit
  report.telemetryAudit = { size: safeSize(path.join(_khyHome(), 'audit.jsonl')) };

  // Sessions
  const sessDir = path.join(_khyHome(), 'sessions');
  report.sessions = { size: safeTreeSize(sessDir), count: safeLs(sessDir).length };

  // Checkpoints
  const ckptRoot = path.join(_baseDir(), 'checkpoints');
  report.checkpoints = { size: safeTreeSize(ckptRoot) };

  const runtimeLogRoot = _runtimeLogRoot();
  const runtimeArchiveDir = path.join(runtimeLogRoot, 'archive');
  const runtimeLogLayout = String(process.env.KHY_LOG_LAYOUT || 'active').toLowerCase();
  const activeLogSize = safeTreeSize(path.join(runtimeLogRoot, 'active'));
  const archiveLogSize = safeTreeSize(runtimeArchiveDir);
  const legacyLogSize = runtimeLogLayout === 'legacy'
    ? Math.max(0, safeTreeSize(runtimeLogRoot) - archiveLogSize)
    : 0;
  report.runtimeLogs = {
    size: activeLogSize + legacyLogSize + archiveLogSize,
    activeSize: activeLogSize,
    legacySize: legacyLogSize,
    archiveSize: archiveLogSize,
    path: runtimeLogRoot,
  };

  // Task outputs
  const taskDir = path.join(_khyHome(), 'tmp', 'tasks');
  report.taskOutputs = { size: safeTreeSize(taskDir) };

  // Daily logs
  const dailyLogDir = path.join(_khyHome(), 'memory', 'logs');
  report.dailyLogs = { size: safeTreeSize(dailyLogDir) };

  // Total
  report.total = Object.values(report).reduce((acc, v) => acc + (v.size || 0), 0);
  report.totalHuman = humanSize(report.total);

  return report;
}

// ── Trace audit cleanup ────────────────────────────────────────────────

function _rotateAppendLog(filePath, maxBytes, label) {
  const size = safeSize(filePath);
  if (size <= maxBytes) {
    return { rotated: false, size };
  }
  try {
    const archivePath = `${filePath}.1.gz`;
    try {
      fs.unlinkSync(`${filePath}.2.gz`);
    } catch {
      /* OK */
    }
    try {
      fs.renameSync(archivePath, `${filePath}.2.gz`);
    } catch {
      /* OK */
    }
    const raw = fs.readFileSync(filePath);
    fs.writeFileSync(archivePath, zlib.gzipSync(raw));
    fs.writeFileSync(filePath, '');
    return { rotated: true, originalSize: size };
  } catch (err) {
    return { rotated: false, error: err.message };
  }
}

/**
 * 把一批过期审计分片折成 audit/archive/sessions-<最新分片日期>.jsonl.gz。
 *
 * 每行形如 {"_source": "<原文件名>", ...原始行}:归档后仍要能按来源回溯到具体
 * 分片,否则压缩就等于丢失溯源信息。非 JSON 行原样包一层 {_source, _raw},
 * 不做丢弃——审计流水里出现坏行本身就是需要留证的事实。
 *
 * @param {string} auditRoot 审计根目录
 * 返回值刻意是三态而不是 boolean:「没内容可留」(全是空分片)与「归档失败」
 * (磁盘满 / 目录只读)对调用方的含义完全相反 —— 前者可以放心删原件,后者必须
 * 留着。压成一个 false 会让空分片永远清不掉。
 *
 * @param {Array<{name:string,path:string,mtimeMs:number}>} expired 过期分片
 * @returns {{ok:boolean,wrote:boolean}} ok=可以删原件了;wrote=真写出了归档
 */
function _archiveExpiredAuditSessions(auditRoot, expired) {
  try {
    const archiveDir = path.join(auditRoot, 'archive');
    const newest = expired.reduce((acc, x) => (x.mtimeMs > acc ? x.mtimeMs : acc), 0);
    const stamp = new Date(newest || Date.now()).toISOString().slice(0, 10);
    const lines = [];
    for (const item of expired) {
      let raw;
      try {
        raw = fs.readFileSync(item.path, 'utf-8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = null;
        }
        lines.push(
          JSON.stringify(
            parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? Object.assign({ _source: item.name }, parsed)
              : { _source: item.name, _raw: line }
          )
        );
      }
    }
    if (lines.length === 0) {
      // 过期分片全是空文件:没有证据需要保全,原件可以直接删。
      return { ok: true, wrote: false };
    }
    // 建目录推迟到确定有内容要写之后:全是空分片时不留一个空 archive/ 目录。
    // 同时这也是「归档写不出去」的第一道判定点——目录建不出来就直接落进 catch。
    fs.mkdirSync(archiveDir, { recursive: true });
    // 同一天可能归档多次(重启/周期清理各来一趟),所以带序号避免互相覆盖。
    let target = path.join(archiveDir, `sessions-${stamp}.jsonl.gz`);
    let n = 2;
    while (fs.existsSync(target)) {
      target = path.join(archiveDir, `sessions-${stamp}.${n}.jsonl.gz`);
      n++;
    }
    fs.writeFileSync(target, zlib.gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf-8')));
    return { ok: true, wrote: true };
  } catch {
    return { ok: false, wrote: false };
  }
}

/**
 * 审计根目录总量封顶:超过 AUDIT.MAX_TOTAL_MB 时,从**最旧的归档**开始删。
 * 只删 archive/ 下的 .gz,不碰保留期内的活跃分片——活跃分片是当前会话正在写的
 * 东西,按体积去删它等于随机截断本轮审计。
 *
 * @param {string} auditRoot 审计根目录
 * @returns {{removed:number,bytes:number,overCap:boolean}}
 */
function _capAuditArchives(auditRoot) {
  const maxBytes = Math.max(0, AUDIT.MAX_TOTAL_MB) * 1024 * 1024;
  let removed = 0;
  let bytes = 0;
  if (maxBytes === 0) {
    return { removed, bytes, overCap: false };
  }
  let total = safeTreeSize(auditRoot);
  if (total <= maxBytes) {
    return { removed, bytes, overCap: false };
  }
  const archiveDir = path.join(auditRoot, 'archive');
  const entries = [];
  for (const name of safeLs(archiveDir)) {
    const fp = path.join(archiveDir, name);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && name.endsWith('.gz')) {
        entries.push({ path: fp, size: st.size, mtimeMs: st.mtimeMs });
      }
    } catch {
      /* skip */
    }
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const e of entries) {
    if (total <= maxBytes) {
      break;
    }
    try {
      fs.unlinkSync(e.path);
      total -= e.size;
      bytes += e.size;
      removed++;
    } catch {
      /* skip */
    }
  }
  return { removed, bytes, overCap: total > maxBytes };
}

/**
 * 审计流水治理:滚动 trace-events.jsonl、把过期分片归档、给 summaries/exports 封顶、
 * 最后按总量删最旧的归档。
 *
 * 参数化 auditRoot 与 cleanRuntimeLogs 同理:让单测在临时目录里跑真实分支,而不是
 * 去 mock fs。缺省仍是数据家下的 audit,调用方行为不变。
 *
 * @param {string} [auditRoot] 审计根目录,缺省 <dataHome>/audit
 */
function cleanTraceAudit(auditRoot = path.join(_khyHome(), 'audit')) {
  let removed = 0,
    bytes = 0;

  // 1. Rotate trace-events.jsonl
  const eventsFile = path.join(auditRoot, 'trace-events.jsonl');
  const rot = _rotateAppendLog(eventsFile, TRACE_EVENTS_MAX_BYTES, 'trace-events');
  if (rot.rotated) {
    bytes += rot.originalSize || 0;
  }

  // 2. 过期会话分片:先打包压缩进 archive/,再删原件(AUDIT.ARCHIVE=0 → 退回直接删)
  const sessionDir = path.join(auditRoot, 'sessions');
  const cutoff = Date.now() - TRACE_SESSION_MAX_AGE_D * 86400000;
  const expired = [];
  for (const f of safeLs(sessionDir)) {
    const fp = path.join(sessionDir, f);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && st.mtimeMs < cutoff) {
        expired.push({ name: f, path: fp, size: st.size, mtimeMs: st.mtimeMs });
      }
    } catch {
      /* skip */
    }
  }
  let archived = 0;
  // 归档关掉时(KHY_AUDIT_ARCHIVE=0)按旧行为直接删,所以 safeToDelete 起点是 !ARCHIVE。
  let safeToDelete = !AUDIT.ARCHIVE;
  if (expired.length > 0 && AUDIT.ARCHIVE) {
    // 一批过期分片折成**一个** gz。按批而不是逐文件归档是刻意的:这个目录的成本
    // 主要在文件数(实测 2483 个分片才 14.8 MB),逐文件 gz 只换字节不换文件数。
    const res = _archiveExpiredAuditSessions(auditRoot, expired);
    safeToDelete = res.ok;
    if (res.wrote) {
      archived = expired.length;
    }
  }
  // 归档失败(磁盘满 / 目录只读)时不删原件:宁可留着占地方,也不能让证据在没有副本
  // 的情况下消失。这是 fail-soft 的正确方向。反过来,全是空分片时 ok 为真而 wrote
  // 为假 —— 没有证据需要保全,那就该照删,否则空文件永远清不掉。
  if (expired.length > 0 && safeToDelete) {
    for (const item of expired) {
      try {
        fs.unlinkSync(item.path);
        bytes += item.size;
        removed++;
      } catch {
        /* skip */
      }
    }
  }

  // 3. Cap summaries
  const summaryDir = path.join(auditRoot, 'summaries');
  const summaryFiles = safeLs(summaryDir).sort();
  if (summaryFiles.length > TRACE_SUMMARY_MAX_FILES) {
    for (const f of summaryFiles.slice(0, summaryFiles.length - TRACE_SUMMARY_MAX_FILES)) {
      const fp = path.join(summaryDir, f);
      try {
        bytes += safeSize(fp);
        fs.unlinkSync(fp);
        removed++;
      } catch {
        /* skip */
      }
    }
  }

  // 4. Cap exports
  const exportDir = path.join(auditRoot, 'exports');
  const exportFiles = safeLs(exportDir).sort();
  if (exportFiles.length > TRACE_EXPORT_MAX_FILES) {
    for (const f of exportFiles.slice(0, exportFiles.length - TRACE_EXPORT_MAX_FILES)) {
      const fp = path.join(exportDir, f);
      try {
        bytes += safeSize(fp);
        fs.unlinkSync(fp);
        removed++;
      } catch {
        /* skip */
      }
    }
  }

  // 5. 总量封顶(删最旧的归档)。放在最后:先把过期件折成归档,再看总量还超不超。
  const capped = _capAuditArchives(auditRoot);
  removed += capped.removed;
  bytes += capped.bytes;

  return { removed, bytes, rotated: rot.rotated, archived, overCap: capped.overCap };
}

// ── Scan log rotation ──────────────────────────────────────────────────

function rotateScanLog() {
  return _rotateAppendLog(path.join(_baseDir(), 'scan.log'), SCAN_LOG_MAX_BYTES, 'scan');
}

// ── Skill ledger audit rotation ────────────────────────────────────────

function rotateSkillAudit() {
  return _rotateAppendLog(
    path.join(_baseDir(), 'skill-ledger', 'audit.jsonl'),
    SKILL_AUDIT_MAX_BYTES,
    'skill-audit'
  );
}

// ── Telemetry audit.jsonl rotation ───────────────────────────────────────

function rotateTelemetryAudit() {
  return _rotateAppendLog(
    path.join(_khyHome(), 'audit.jsonl'),
    TELEM_AUDIT_MAX_BYTES,
    'telemetry-audit'
  );
}

// ── Training quarantine trimming ───────────────────────────────────────

function trimQuarantine() {
  // Try both possible locations
  const candidates = [
    path.join(_khyHome(), 'training', 'interaction_quarantine.jsonl'),
    path.join(_baseDir(), 'training', 'interaction_quarantine.jsonl'),
  ];
  for (const filePath of candidates) {
    const size = safeSize(filePath);
    if (size === 0) {
      continue;
    }
    if (size <= QUARANTINE_MAX_BYTES) {
      try {
        const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
        if (lines.length <= QUARANTINE_MAX_LINES) {
          return { trimmed: false, lines: lines.length };
        }
        const kept = lines.slice(-QUARANTINE_MAX_LINES);
        atomicWriteText(filePath, kept.join('\n') + '\n');
        return {
          trimmed: true,
          before: lines.length,
          after: kept.length,
          freedBytes: size - safeSize(filePath),
        };
      } catch {
        continue;
      }
    }
    // Over size cap
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
      const kept = lines.slice(-Math.floor(QUARANTINE_MAX_LINES / 2));
      atomicWriteText(filePath, kept.join('\n') + '\n');
      return {
        trimmed: true,
        before: lines.length,
        after: kept.length,
        freedBytes: size - safeSize(filePath),
      };
    } catch {
      continue;
    }
  }
  return { trimmed: false };
}

// ── Daily memory log pruning ───────────────────────────────────────────

function cleanDailyLogs() {
  const logsDir = path.join(_khyHome(), 'memory', 'logs');
  if (!fs.existsSync(logsDir)) {
    return { removed: 0, bytes: 0 };
  }
  const cutoff = Date.now() - DAILY_LOG_MAX_AGE_D * 86400000;
  let removed = 0,
    bytes = 0;

  // Walk YYYY/MM/YYYY-MM-DD.md structure
  for (const year of safeLs(logsDir)) {
    const yearDir = path.join(logsDir, year);
    try {
      if (!fs.statSync(yearDir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    for (const month of safeLs(yearDir)) {
      const monthDir = path.join(yearDir, month);
      try {
        if (!fs.statSync(monthDir).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      for (const file of safeLs(monthDir)) {
        const fp = path.join(monthDir, file);
        try {
          const st = fs.statSync(fp);
          if (st.isFile() && st.mtimeMs < cutoff) {
            bytes += st.size;
            fs.unlinkSync(fp);
            removed++;
          }
        } catch {
          /* skip */
        }
      }
      // Remove empty month dirs
      if (safeLs(monthDir).length === 0) {
        try {
          fs.rmdirSync(monthDir);
        } catch {
          /* skip */
        }
      }
    }
    // Remove empty year dirs
    if (safeLs(yearDir).length === 0) {
      try {
        fs.rmdirSync(yearDir);
      } catch {
        /* skip */
      }
    }
  }
  return { removed, bytes };
}

// ── Session file cleanup ───────────────────────────────────────────────

function cleanSessions() {
  const sessDir = path.join(_khyHome(), 'sessions');
  if (!fs.existsSync(sessDir)) {
    return { removed: 0, bytes: 0 };
  }
  const cutoff = Date.now() - SESSION_MAX_AGE_D * 86400000;
  let removed = 0,
    bytes = 0;

  for (const f of safeLs(sessDir)) {
    const fp = path.join(sessDir, f);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && st.mtimeMs < cutoff) {
        bytes += st.size;
        fs.unlinkSync(fp);
        removed++;
      }
    } catch {
      /* skip */
    }
  }
  return { removed, bytes };
}

// ── Trajectory cleanup ─────────────────────────────────────────────────
//
// 轨迹存于 project data home（<KHY-OS root>/.khy，可经 KHY_PROJECT_DATA_HOME 覆盖），
// 与 ~/.khy 下的 cleanSessions 目标是两套不同目录。此前轨迹完全没有定期清理，
// 无限堆积；这里按 TRAJECTORY_MAX_AGE_D 给出明确的定期清理时间。
//
// 清理对象（按 base 成组删除，避免删半组留孤儿）：
//   sessions/<bucket>/<base>.jsonl              transcript（append-only）
//   sessions/<bucket>/<base>.json               JSON 快照
//   sessions/<bucket>/<base>.checkpoint.json    检查点
//   sessions/<bucket>/<base>.replay-ledger.jsonl  replay 账本 sidecar
//   sessions/<bucket>/<base>.trace-chain.json     溯源链 sidecar
//   trajectory_replay/<sessionId>/              replay content store（按目录 mtime）
//
// 安全：以"组内最新 mtime"为准，只有整组都早于 cutoff 才删除；活跃会话的 .jsonl
// 持续追加 → mtime 新鲜 → 永不被回收。

// 已知的轨迹文件后缀，按"最长优先"匹配以正确还原 base。
const TRAJECTORY_SUFFIXES = [
  '.checkpoint.json',
  '.replay-ledger.jsonl',
  '.trace-chain.json',
  '.jsonl',
  '.json',
];

function _trajectoryBase(filename) {
  for (const suf of TRAJECTORY_SUFFIXES) {
    if (filename.endsWith(suf)) {
      return filename.slice(0, -suf.length);
    }
  }
  return null; // 非轨迹文件 → 不碰（例如 bucket 内的 cwd 标记文件等）
}

function cleanTrajectories() {
  // 关闭开关：保留期 <= 0 表示永久保留，不清理。
  if (!(TRAJECTORY_MAX_AGE_D > 0)) {
    return { removed: 0, bytes: 0 };
  }

  let dataHome;
  try {
    dataHome = require('../utils/dataHome');
  } catch {
    return { removed: 0, bytes: 0 };
  }

  const cutoff = Date.now() - TRAJECTORY_MAX_AGE_D * 86400000;
  let removed = 0,
    bytes = 0;

  // 1) sessions/<bucket>/ 下按 base 成组清理
  let sessRoot;
  try {
    sessRoot = dataHome.getProjectDataDir('sessions');
  } catch {
    sessRoot = null;
  }
  if (sessRoot && fs.existsSync(sessRoot)) {
    for (const bucket of safeLs(sessRoot)) {
      const bucketDir = path.join(sessRoot, bucket);
      let isDir = false;
      try {
        isDir = fs.statSync(bucketDir).isDirectory();
      } catch {
        /* skip */
      }
      if (!isDir) {
        continue;
      }

      // 按 base 归组：{ base -> [{path,size,mtime}] }
      const groups = new Map();
      for (const f of safeLs(bucketDir)) {
        const base = _trajectoryBase(f);
        if (base === null) {
          continue;
        }
        const fp = path.join(bucketDir, f);
        try {
          const st = fs.statSync(fp);
          if (!st.isFile()) {
            continue;
          }
          if (!groups.has(base)) {
            groups.set(base, []);
          }
          groups.get(base).push({ path: fp, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* skip */
        }
      }

      for (const files of groups.values()) {
        const newest = files.reduce((m, x) => Math.max(m, x.mtime), 0);
        if (newest >= cutoff) {
          continue;
        } // 组内有新鲜文件 → 整组保留
        for (const file of files) {
          try {
            fs.unlinkSync(file.path);
            bytes += file.size;
            removed++;
          } catch {
            /* skip */
          }
        }
      }
    }
  }

  // 2) trajectory_replay/<sessionId>/ content store 按目录最新 mtime 整树清理
  let replayRoot;
  try {
    replayRoot = path.join(dataHome.getProjectDataHome(), 'trajectory_replay');
  } catch {
    replayRoot = null;
  }
  if (replayRoot && fs.existsSync(replayRoot)) {
    for (const sid of safeLs(replayRoot)) {
      const sidDir = path.join(replayRoot, sid);
      try {
        const st = fs.statSync(sidDir);
        if (!st.isDirectory()) {
          continue;
        }
        // 用目录树内最新 mtime 判活，避免删到正在写入的 content store。
        const newest = _newestMtime(sidDir);
        if (newest >= cutoff) {
          continue;
        }
        const size = safeTreeSize(sidDir);
        fs.rmSync(sidDir, { recursive: true, force: true });
        bytes += size;
        removed++;
      } catch {
        /* skip */
      }
    }
  }

  return { removed, bytes };
}

// 返回目录树内最新的 mtime（毫秒）；空目录或读失败返回 0。
function _newestMtime(entryPath) {
  let newest = 0;
  const stack = [entryPath];
  while (stack.length > 0) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
    if (st.isDirectory()) {
      for (const child of safeLs(cur)) {
        stack.push(path.join(cur, child));
      }
    }
  }
  return newest;
}

// ── Task output cleanup ───────────────────────────────────────────────

function cleanTaskOutputs() {
  const taskDir = process.env.KHY_TASK_OUTPUT_DIR || path.join(_khyHome(), 'tmp', 'tasks');
  if (!fs.existsSync(taskDir)) {
    return { removed: 0, bytes: 0 };
  }
  const cutoff = Date.now() - TASK_OUTPUT_MAX_AGE_H * 3600000;
  let removed = 0,
    bytes = 0;

  for (const f of safeLs(taskDir)) {
    const fp = path.join(taskDir, f);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && st.mtimeMs < cutoff) {
        bytes += st.size;
        fs.unlinkSync(fp);
        removed++;
      }
    } catch {
      /* skip */
    }
  }
  return { removed, bytes };
}

// ── Runtime logger archives ─────────────────────────────────────────────

function _runtimeLogRoot() {
  // Same precedence as the shared resolver, so cleanup and the logger can never
  // disagree about which tree they own.
  if (process.env.KHY_LOG_HOME) return path.resolve(process.env.KHY_LOG_HOME);
  if (process.env.KHY_DATA_HOME) return path.join(path.resolve(process.env.KHY_DATA_HOME), 'logs');
  if (process.env.KHYQUANT_DATA_HOME) return path.join(path.resolve(process.env.KHYQUANT_DATA_HOME), 'logs');
  if (process.env.KHY_LOG_DIR) return path.resolve(process.env.KHY_LOG_DIR);
  return path.join(_khyHome(), 'logs');
}

// A gzip member is a 10-byte header plus an 8-byte trailer, so any gzip at or
// below 20 bytes is gzip-of-nothing (20) or a truncated header (10) — either way
// it carries no log lines. Checking only for `size === 0` let both survive every
// sweep: the live archive still holds a 10-byte `app-2026-08-17.log.gz.dup-1`.
const EMPTY_GZIP_MAX_BYTES = 20;
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * Payload-free archive residue: an empty file, or a *gzip* small enough to hold
 * no data. The gzip magic check is what makes the rule safe — the suffix cannot
 * be trusted in either direction. `.gz.dup-N` is still a gzip, and a short file
 * merely *named* `.gz` may be something else entirely; deleting it on size alone
 * would be a guess. Only the first two bytes settle it.
 */
function _isSpentArchive(filePath, size) {
  if (size === 0) return true;
  if (size > EMPTY_GZIP_MAX_BYTES) return false;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(GZIP_MAGIC.length);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return read === head.length && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* skip */ } }
  }
}

function _isRuntimeLogFile(name) {
  return /^(?:app|error)-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?(?:\.gz)?$/i.test(name);
}

function _isCurrentRuntimeLog(name) {
  const date = new Date().toISOString().slice(0, 10);
  return name === 'app-' + date + '.log' || name === 'error-' + date + '.log';
}

function _compressRuntimeLog(sourcePath, archiveDir) {
  const name = path.basename(sourcePath);
  const archiveName = name.endsWith('.gz') ? name : name + '.gz';
  let archivePath = path.join(archiveDir, archiveName);
  const collides = fs.existsSync(archivePath);
  if (collides) {
    // Same rotated name in both the legacy root and active/. Keep both payloads
    // rather than let one silently overwrite the other — but never mint a
    // .dup-N for a source that holds no data.
    if (_isSpentArchive(sourcePath, safeSize(sourcePath))) {
      fs.unlinkSync(sourcePath);
      return { moved: true, bytes: 0 };
    }
    let suffix = 1;
    do {
      archivePath = path.join(archiveDir, archiveName + '.dup-' + suffix);
      suffix++;
    } while (fs.existsSync(archivePath));
  }
  if (name.endsWith('.gz')) {
    fs.renameSync(sourcePath, archivePath);
    return { moved: true, bytes: 0 };
  }
  const content = fs.readFileSync(sourcePath);
  if (content.length === 0) {
    fs.unlinkSync(sourcePath);
    return { moved: true, bytes: 0 };
  }
  const tmp = path.join(archiveDir, '.' + archiveName + '.tmp-' + process.pid);
  fs.writeFileSync(tmp, zlib.gzipSync(content));
  fs.renameSync(tmp, archivePath);
  fs.unlinkSync(sourcePath);
  return { moved: true, bytes: content.length - safeSize(archivePath) };
}

/** Move rotated logs to archive and enforce archive retention. */
function cleanRuntimeLogs(root = _runtimeLogRoot(), policy = LOGS) {
  const archiveDir = path.join(root, 'archive');
  const activeDirs = [root, path.join(root, 'active')];
  let removed = 0;
  let bytes = 0;
  let archived = 0;

  for (const activeDir of activeDirs) {
    if (!fs.existsSync(activeDir)) continue;
    for (const name of safeLs(activeDir)) {
      const sourcePath = path.join(activeDir, name);
      let stat;
      try { stat = fs.statSync(sourcePath); } catch { continue; }
      if (!stat.isFile()) continue;
      // Ownership before deletion: only files this sweep owns are candidates, and
      // today's log is never one of them. A brand-new active log is legitimately
      // zero bytes for a moment, and the spent-archive rule must not race it.
      if (!_isRuntimeLogFile(name) || _isCurrentRuntimeLog(name)) continue;
      if (_isSpentArchive(sourcePath, stat.size)) {
        try { fs.unlinkSync(sourcePath); removed++; bytes += stat.size; } catch { /* skip */ }
        continue;
      }
      try {
        fs.mkdirSync(archiveDir, { recursive: true });
        const result = _compressRuntimeLog(sourcePath, archiveDir);
        archived += result.moved ? 1 : 0;
        bytes += Math.max(0, result.bytes || 0);
      } catch {
        /* Preserve source if compression or rename fails. */
      }
    }
  }

  const maxAgeMs = Math.max(0, policy.KEEP_DAYS) * 86400000;
  const files = [];
  for (const name of safeLs(archiveDir)) {
    const filePath = path.join(archiveDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (_isSpentArchive(filePath, stat.size) || (maxAgeMs > 0 && Date.now() - stat.mtimeMs > maxAgeMs)) {
        fs.unlinkSync(filePath);
        removed++;
        bytes += stat.size;
      } else {
        files.push({ path: filePath, size: stat.size, mtime: stat.mtimeMs });
      }
    } catch { /* skip */ }
  }
  files.sort((a, b) => a.mtime - b.mtime);
  let totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const overflow = Math.max(0, files.length - Math.max(0, policy.MAX_FILES));
  for (let index = 0; index < files.length; index++) {
    if (index >= overflow && totalSize <= policy.MAX_SIZE_BYTES) break;
    const file = files[index];
    try {
      fs.unlinkSync(file.path);
      totalSize -= file.size;
      removed++;
      bytes += file.size;
    } catch { /* skip */ }
  }
  return { removed, archived, bytes, root, archiveDir };
}

function planCheckpointStorage(maxTotalMb = CKPT_MAX_TOTAL_MB, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const ckptRoot = options.root || path.join(_baseDir(), 'checkpoints');
  let currentSize = 0;
  try { currentSize = safeTreeSize(ckptRoot); } catch { return { ok: false, currentSize: 0, selected: [], held: [], reason: 'checkpoint root unavailable' }; }
  const maxBytes = maxTotalMb * 1024 * 1024;
  const projects = [];
  let names = [];
  try { names = fsImpl.readdirSync(ckptRoot); } catch { return { ok: false, currentSize, selected: [], held: [] }; }
  const held = [];
  for (const name of names) {
    const projectDir = path.join(ckptRoot, name);
    try {
      if (!fsImpl.statSync(projectDir).isDirectory()) continue;
      const manifest = JSON.parse(fsImpl.readFileSync(path.join(projectDir, 'manifest.json'), 'utf8'));
      if (!Array.isArray(manifest.checkpoints)) throw new Error('invalid checkpoints');
      projects.push({ name, projectDir, manifest });
    } catch {
      let bytes = 0; try { bytes = safeTreeSize(projectDir); } catch {}
      held.push({ rel: name, bytes, reason: 'manifest 无法解析或数据不完整，保留不动' });
    }
  }
  const candidates = [];
  const refs = new Map();
  for (const project of projects) for (const entry of project.manifest.checkpoints) {
    const timestamp = Date.parse(entry.timestamp || '') || 0;
    let bytes = 0;
    for (const ext of ['.patch', '.tar.gz', '.stash.json']) { try { bytes += fsImpl.statSync(path.join(project.projectDir, entry.id + ext)).size; } catch {} }
    for (const object of entry.objects || []) {
      if (!object || typeof object.digest !== 'string') continue;
      refs.set(object.digest, (refs.get(object.digest) || 0) + 1);
    }
    candidates.push({ project, entry, timestamp, bytes });
  }
  candidates.sort((a,b) => a.timestamp - b.timestamp || String(a.entry.id).localeCompare(String(b.entry.id)));
  const selected = []; let projected = currentSize;
  for (const candidate of candidates) {
    if (projected <= maxBytes) break;
    let reclaim = candidate.bytes;
    for (const object of candidate.entry.objects || []) {
      const digest = object && object.digest;
      if (!digest || refs.get(digest) !== 1) continue;
      try { reclaim += fsImpl.statSync(path.join(candidate.project.projectDir, 'objects', 'sha256', digest.slice(0, 2), digest + '.gz')).size; } catch {}
    }
    selected.push({ project: candidate.project.name, id: candidate.entry.id, timestamp: candidate.entry.timestamp, bytes: reclaim });
    projected -= reclaim;
    for (const object of candidate.entry.objects || []) { if (object && refs.has(object.digest)) refs.set(object.digest, refs.get(object.digest) - 1); }
  }
  return { ok: selected.length > 0, root: ckptRoot, maxTotalMb, maxBytes, currentSize, projectedSize: Math.max(0, projected), selected, held, projects: projects.length };
}

// ── Checkpoint storage cap ─────────────────────────────────────────────

function cleanCheckpointStorage(maxTotalMb = CKPT_MAX_TOTAL_MB) {
  const ckptRoot = path.join(_baseDir(), 'checkpoints');
  if (!fs.existsSync(ckptRoot)) {
    return { removed: 0, bytes: 0 };
  }

  const maxBytes = maxTotalMb * 1024 * 1024;
  let totalSize = safeTreeSize(ckptRoot);
  if (totalSize <= maxBytes) {
    return { removed: 0, bytes: 0, currentSize: totalSize };
  }

  // CAS objects are owned by manifest entries. Never delete an object merely
  // because its mtime is old: another checkpoint may still reference it.
  const projects = [];
  for (const projectName of safeLs(ckptRoot)) {
    const projectDir = path.join(ckptRoot, projectName);
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
      const manifestPath = path.join(projectDir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(manifest.checkpoints)) {
        projects.push({ projectDir, manifest });
      }
    } catch {
      /* Legacy or incomplete project directory: leave it untouched. */
    }
  }

  const removedEntries = [];
  for (const project of projects) {
    project.manifest.checkpoints.sort((a, b) => {
      const left = Date.parse(a.timestamp || '') || 0;
      const right = Date.parse(b.timestamp || '') || 0;
      return left - right;
    });
  }

  while (totalSize > maxBytes) {
    let candidate = null;
    for (const project of projects) {
      const entry = project.manifest.checkpoints[0];
      if (!entry) continue;
      if (!candidate || (Date.parse(entry.timestamp || '') || 0) < candidate.time) {
        candidate = { project, entry, time: Date.parse(entry.timestamp || '') || 0 };
      }
    }
    if (!candidate) break;

    const { project, entry } = candidate;
    project.manifest.checkpoints.shift();
    const files = [
      path.join(project.projectDir, entry.id + '.patch'),
      path.join(project.projectDir, entry.id + '.tar.gz'),
      path.join(project.projectDir, entry.id + '.stash.json'),
    ];
    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        fs.unlinkSync(filePath);
        totalSize -= stat.size;
        removedEntries.push({ filePath, bytes: stat.size });
      } catch {
        /* CAS entries have no materialized file. */
      }
    }
    try {
      fs.writeFileSync(
        path.join(project.projectDir, 'manifest.json'),
        JSON.stringify(project.manifest, null, 2),
        'utf8'
      );
    } catch {
      /* Keep the in-memory selection; the next pass can retry safely. */
    }

    const referenced = new Set();
    for (const remaining of project.manifest.checkpoints) {
      for (const object of remaining.objects || []) {
        if (object && typeof object.digest === 'string') referenced.add(object.digest);
      }
    }
    for (const object of entry.objects || []) {
      const digest = object && object.digest;
      if (!digest || referenced.has(digest)) continue;
      const objectPath = path.join(
        project.projectDir,
        'objects',
        'sha256',
        digest.slice(0, 2),
        digest + '.gz'
      );
      try {
        const stat = fs.statSync(objectPath);
        fs.unlinkSync(objectPath);
        totalSize -= stat.size;
        removedEntries.push({ filePath: objectPath, bytes: stat.size });
      } catch {
        /* skip missing or malformed objects */
      }
    }
  }

  const bytes = removedEntries.reduce((sum, item) => sum + item.bytes, 0);
  return {
    removed: removedEntries.length,
    bytes,
    currentSize: Math.max(0, totalSize),
    checkpoints: removedEntries.filter((item) => /\.(?:patch|tar\.gz|stash\.json)$/.test(item.filePath)).length,
  };
}

function executeCheckpointPlan(plan, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const projects = new Map();
  for (const item of plan.selected || []) {
    const dir = path.join(plan.root, item.project);
    try {
      const manifestPath = path.join(dir, 'manifest.json');
      const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
      const entry = manifest.checkpoints.find((candidate) => candidate.id === item.id);
      if (!entry) continue;
      manifest.checkpoints = manifest.checkpoints.filter((candidate) => candidate.id !== item.id);
      for (const ext of ['.patch', '.tar.gz', '.stash.json']) { try { fsImpl.unlinkSync(path.join(dir, item.id + ext)); } catch {} }
      projects.set(dir, { manifestPath, manifest, dir, entry });
    } catch {}
  }
  for (const project of projects.values()) {
    const temp = project.manifestPath + '.tmp-' + process.pid;
    fsImpl.writeFileSync(temp, JSON.stringify(project.manifest, null, 2), 'utf8');
    fsImpl.renameSync(temp, project.manifestPath);
  }
  const refs = new Set();
  for (const name of fsImpl.readdirSync(plan.root)) {
    try {
      const dir = path.join(plan.root, name); const m = JSON.parse(fsImpl.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      for (const e of m.checkpoints || []) for (const o of e.objects || []) if (o && o.digest) refs.add(o.digest);
    } catch {}
  }
  let reclaimedBytes = 0;
  for (const project of projects.values()) for (const object of project.entry.objects || []) {
    if (!object || refs.has(object.digest)) continue;
    const target = path.join(project.dir, 'objects', 'sha256', object.digest.slice(0, 2), object.digest + '.gz');
    try { reclaimedBytes += fsImpl.statSync(target).size; fsImpl.unlinkSync(target); } catch {}
  }
  return { removed: projects.size, reclaimedBytes };
}

// ── Run all cleanup ─────────────────────────────────────────────────────

/**
 * Clean a backend directory by file age, count, and total size.
 */
function cleanBackendDir(
  relDir,
  { maxAgeHours = TEMP_MAX_AGE_HOURS, maxFiles = Infinity, maxSizeBytes = TEMP_MAX_SIZE_BYTES } = {}
) {
  const dirPath = path.join(BACKEND_ROOT, relDir);
  let removed = 0,
    bytes = 0;
  if (!fs.existsSync(dirPath)) {
    return { removed, bytes };
  }

  try {
    const entries = fs.readdirSync(dirPath);
    const files = [];
    for (const entry of entries) {
      if (entry === '.gitkeep' || entry === '.env') {
        continue;
      }
      const fp = path.join(dirPath, entry);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile()) {
          files.push({ path: fp, name: entry, size: stat.size, mtime: stat.mtimeMs });
        }
      } catch {
        /* skip */
      }
    }
    files.sort((a, b) => a.mtime - b.mtime); // oldest first

    // Remove old and junk files
    for (const file of files) {
      const ageH = (Date.now() - file.mtime) / (1000 * 60 * 60);
      const ext = path.extname(file.name).toLowerCase();
      if (ageH > maxAgeHours || JUNK_EXTENSIONS.has(ext)) {
        try {
          fs.unlinkSync(file.path);
          removed++;
          bytes += file.size;
        } catch {
          /* skip */
        }
      }
    }

    // Cap file count
    const remaining = files.filter((f) => fs.existsSync(f.path));
    if (remaining.length > maxFiles) {
      for (const file of remaining.slice(0, remaining.length - maxFiles)) {
        try {
          fs.unlinkSync(file.path);
          removed++;
          bytes += file.size;
        } catch {
          /* skip */
        }
      }
    }

    // Cap total size
    let currentSize = 0;
    for (const entry of safeLs(dirPath)) {
      currentSize += safeSize(path.join(dirPath, entry));
    }
    if (currentSize > maxSizeBytes) {
      const stillExist = files.filter((f) => fs.existsSync(f.path));
      for (const file of stillExist) {
        if (currentSize <= maxSizeBytes) {
          break;
        }
        try {
          fs.unlinkSync(file.path);
          currentSize -= file.size;
          removed++;
          bytes += file.size;
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* access error */
  }

  return { removed, bytes };
}

/**
 * Clean khy OS specific files from OS temp directory.
 */
function cleanOsTempFiles() {
  let removed = 0,
    bytes = 0;
  const tmpDir = process.env.KHY_OS_TEMP_DIR || os.tmpdir();
  try {
    for (const entry of fs.readdirSync(tmpDir)) {
      if (!isManagedOsTempEntry(entry)) {
        continue;
      }
      const fp = path.join(tmpDir, entry);
      try {
        const stat = fs.lstatSync(fp);
        const ageH = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
        if (ageH <= OS_TEMP_MAX_AGE_HOURS) {
          continue;
        }

        if (stat.isFile()) {
          const size = stat.size;
          fs.unlinkSync(fp);
          removed++;
          bytes += size;
          continue;
        }

        if (stat.isDirectory()) {
          const size = safeTreeSize(fp);
          fs.rmSync(fp, { recursive: true, force: true });
          removed++;
          bytes += size;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return { removed, bytes };
}

function runCleanup(options = {}) {
  const trigger = String(options.trigger || 'manual');
  const metrics = {
    startedAt: Date.now(),
    targets: [],
    failureCount: 0,
  };
  const results = {
    securityLog: recordCleanupTarget(metrics, 'security-log', () => rotateSecurityLog()),
    snapshots: recordCleanupTarget(metrics, 'growth-snapshots', () => cleanSnapshots()),
    trainingData: recordCleanupTarget(metrics, 'training-data', () => trimTrainingData()),
    telemetry: recordCleanupTarget(metrics, 'telemetry-exports', () => cleanTelemetry()),
    traceAudit: recordCleanupTarget(metrics, 'trace-audit', () => cleanTraceAudit()),
    scanLog: recordCleanupTarget(metrics, 'scan-log', () => rotateScanLog()),
    skillAudit: recordCleanupTarget(metrics, 'skill-audit', () => rotateSkillAudit()),
    telemetryAudit: recordCleanupTarget(metrics, 'telemetry-audit', () => rotateTelemetryAudit()),
    quarantine: recordCleanupTarget(metrics, 'training-quarantine', () => trimQuarantine()),
    dailyLogs: recordCleanupTarget(metrics, 'daily-logs', () => cleanDailyLogs()),
    sessions: recordCleanupTarget(metrics, 'sessions', () => cleanSessions()),
    trajectories: recordCleanupTarget(metrics, 'trajectories', () => cleanTrajectories()),
    taskOutputs: recordCleanupTarget(metrics, 'task-outputs', () => cleanTaskOutputs()),
    checkpoints: recordCleanupTarget(metrics, 'checkpoints', () => cleanCheckpointStorage()),
    runtimeLogs: recordCleanupTarget(metrics, 'runtime-logs', () => cleanRuntimeLogs()),
  };

  // Clean backend temp/intermediate directories
  const backendTargets = [
    { dir: 'temp', maxAgeHours: TEMP_MAX_AGE_HOURS, maxSizeBytes: TEMP_MAX_SIZE_BYTES },
    {
      dir: 'logs',
      maxAgeHours: LOG_MAX_AGE_HOURS,
      maxFiles: LOG_MAX_FILES,
      maxSizeBytes: LOG_MAX_SIZE_BYTES,
    },
    { dir: 'data/cache', maxAgeHours: 72, maxSizeBytes: TEMP_MAX_SIZE_BYTES },
    { dir: 'ml/data/cache', maxAgeHours: 168, maxSizeBytes: TEMP_MAX_SIZE_BYTES },
  ];

  results.backendCleanup = [];
  for (const target of backendTargets) {
    const r = recordCleanupTarget(
      metrics,
      `backend:${target.dir}`,
      () => cleanBackendDir(target.dir, target),
      { dir: target.dir }
    );
    if (r.removed > 0) {
      results.backendCleanup.push({ dir: target.dir, ...r });
    }
  }

  // Clean OS temp
  const osTmp = recordCleanupTarget(metrics, 'backend:os-temp', () => cleanOsTempFiles(), {
    dir: 'os-temp',
  });
  if (osTmp.removed > 0) {
    results.backendCleanup.push({ dir: 'os-temp', ...osTmp });
  }

  // Clean khy-tool-results 磁盘持久化目录（大工具结果）
  // 借鉴 Claude Code 的 Content Replacement Budget 清理策略
  const toolResultDir = path.join(os.tmpdir(), 'khy-tool-results');
  const toolResultCleanup = recordCleanupTarget(
    metrics,
    'backend:khy-tool-results',
    () => {
      if (!fs.existsSync(toolResultDir)) {
        return { removed: 0, bytes: 0 };
      }
      let removed = 0,
        bytes = 0;
      try {
        const entries = fs.readdirSync(toolResultDir);
        for (const entry of entries) {
          const fp = path.join(toolResultDir, entry);
          try {
            const stat = fs.statSync(fp);
            // 超过 1 小时的工具结果文件 → 清理
            if (stat.isFile() && Date.now() - stat.mtimeMs > 3600000) {
              bytes += stat.size;
              fs.unlinkSync(fp);
              removed++;
            }
          } catch {
            /* skip */
          }
        }
      } catch {
        /* dir read failed */
      }
      return { removed, bytes };
    },
    { dir: 'khy-tool-results' }
  );
  if (toolResultCleanup.removed > 0) {
    results.backendCleanup.push({ dir: 'khy-tool-results', ...toolResultCleanup });
  }

  // Calculate total freed
  let freedBytes = 0;
  if (results.securityLog.rotated) {
    freedBytes +=
      (results.securityLog.originalSize || 0) - (results.securityLog.compressedSize || 0);
  }
  freedBytes += results.snapshots.bytes || 0;
  if (results.trainingData.trimmed) {
    freedBytes += results.trainingData.freedBytes || 0;
  }
  freedBytes += results.telemetry.bytes || 0;

  results.summary = {
    freedBytes,
    freedHuman: humanSize(freedBytes),
    actions: [],
    elapsedMs: 0,
    failureCount: 0,
    targetCount: 0,
  };

  if (results.securityLog.rotated) {
    results.summary.actions.push(
      `Security log rotated (${humanSize(results.securityLog.originalSize)})`
    );
  }
  if (results.snapshots.removed > 0) {
    results.summary.actions.push(`Removed ${results.snapshots.removed} old snapshots`);
  }
  if (results.trainingData.trimmed) {
    results.summary.actions.push(
      `Training data trimmed: ${results.trainingData.before} → ${results.trainingData.after} lines`
    );
  }
  if (results.telemetry.removed > 0) {
    results.summary.actions.push(`Removed ${results.telemetry.removed} old telemetry exports`);
  }
  // Extended targets
  if (results.traceAudit.rotated || results.traceAudit.removed > 0) {
    const parts = [];
    if (results.traceAudit.rotated) {
      parts.push('events rotated');
    }
    if (results.traceAudit.removed > 0) {
      parts.push(`${results.traceAudit.removed} old files removed`);
    }
    results.summary.actions.push(`Trace audit: ${parts.join(', ')}`);
    freedBytes += results.traceAudit.bytes || 0;
  }
  if (results.scanLog.rotated) {
    results.summary.actions.push(
      `Scan log rotated (${humanSize(results.scanLog.originalSize || 0)})`
    );
    freedBytes += results.scanLog.originalSize || 0;
  }
  if (results.skillAudit.rotated) {
    results.summary.actions.push(
      `Skill audit rotated (${humanSize(results.skillAudit.originalSize || 0)})`
    );
    freedBytes += results.skillAudit.originalSize || 0;
  }
  if (results.telemetryAudit.rotated) {
    results.summary.actions.push(
      `Telemetry audit rotated (${humanSize(results.telemetryAudit.originalSize || 0)})`
    );
    freedBytes += results.telemetryAudit.originalSize || 0;
  }
  if (results.quarantine.trimmed) {
    results.summary.actions.push(
      `Quarantine trimmed: ${results.quarantine.before} → ${results.quarantine.after} lines`
    );
    freedBytes += results.quarantine.freedBytes || 0;
  }
  if (results.dailyLogs.removed > 0) {
    results.summary.actions.push(
      `Removed ${results.dailyLogs.removed} old daily logs (${humanSize(results.dailyLogs.bytes)})`
    );
    freedBytes += results.dailyLogs.bytes || 0;
  }
  if (results.sessions.removed > 0) {
    results.summary.actions.push(
      `Removed ${results.sessions.removed} old session files (${humanSize(results.sessions.bytes)})`
    );
    freedBytes += results.sessions.bytes || 0;
  }
  if (results.trajectories && results.trajectories.removed > 0) {
    results.summary.actions.push(
      `Removed ${results.trajectories.removed} old trajectory files (${humanSize(results.trajectories.bytes)})`
    );
    freedBytes += results.trajectories.bytes || 0;
  }
  if (results.taskOutputs.removed > 0) {
    results.summary.actions.push(
      `Removed ${results.taskOutputs.removed} old task outputs (${humanSize(results.taskOutputs.bytes)})`
    );
    freedBytes += results.taskOutputs.bytes || 0;
  }
  if (results.runtimeLogs.removed > 0 || results.runtimeLogs.archived > 0) {
    results.summary.actions.push(
      `Runtime logs: ${results.runtimeLogs.archived || 0} archived, ${results.runtimeLogs.removed || 0} removed`
    );
    freedBytes += results.runtimeLogs.bytes || 0;
  }
  if (results.checkpoints.removed > 0) {
    results.summary.actions.push(
      `Removed ${results.checkpoints.removed} checkpoint files (${humanSize(results.checkpoints.bytes)})`
    );
    freedBytes += results.checkpoints.bytes || 0;
  }
  for (const bc of results.backendCleanup) {
    if (bc.removed > 0) {
      results.summary.actions.push(
        `Cleaned ${bc.dir}: ${bc.removed} files (${humanSize(bc.bytes)})`
      );
      freedBytes += bc.bytes;
    }
  }
  results.summary.freedBytes = freedBytes;
  results.summary.freedHuman = humanSize(freedBytes);
  metrics.finishedAt = Date.now();
  metrics.elapsedMs = metrics.finishedAt - metrics.startedAt;
  metrics.targetCount = metrics.targets.length;
  results.metrics = metrics;
  results.summary.elapsedMs = metrics.elapsedMs;
  results.summary.failureCount = metrics.failureCount;
  results.summary.targetCount = metrics.targetCount;

  setLastCleanupReport(trigger, results);

  return results;
}

/**
 * Start periodic cleanup. Non-blocking.
 *
 * The interval scales with the machine: hardwareProfileService.applyLimits sets
 * KHY_CLEANUP_INTERVAL_MS (longer on weak machines to reduce idle churn) and may
 * set KHY_ENABLE_PERIODIC_SCAN=false to skip the recurring sweep entirely. An
 * explicit options.intervalMs > env > the 2h default.
 *
 * @param {object} [options]
 * @param {boolean} [options.skipInitial] - skip the one-shot startup cleanup
 * @param {number}  [options.intervalMs]  - explicit recurring interval
 */
function startPeriodicCleanup(options = {}) {
  if (_periodicTimer) {
    return;
  }
  const skipInitial = options && options.skipInitial === true;
  // Initial cleanup on startup
  if (!skipInitial) {
    try {
      runCleanup({ trigger: 'startup' });
    } catch {
      /* ignore */
    }
  }
  // On constrained hardware the recurring sweep is disabled; the startup cleanup
  // above still runs so disk hygiene is preserved without idle wakeups.
  if (String(process.env.KHY_ENABLE_PERIODIC_SCAN || '').toLowerCase() === 'false') {
    return;
  }
  const envInterval = parseInt(process.env.KHY_CLEANUP_INTERVAL_MS, 10);
  const intervalMs =
    options && Number.isFinite(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : Number.isFinite(envInterval) && envInterval > 0
        ? envInterval
        : 2 * 60 * 60 * 1000;
  _periodicTimer = setInterval(() => {
    try {
      runCleanup({ trigger: 'periodic' });
    } catch {
      /* ignore */
    }
  }, intervalMs);
  _periodicTimer.unref(); // Don't block process exit
}

/**
 * Stop periodic cleanup.
 */
function stopPeriodicCleanup() {
  if (_periodicTimer) {
    clearInterval(_periodicTimer);
    _periodicTimer = null;
  }
}

module.exports = {
  runCleanup,
  startPeriodicCleanup,
  stopPeriodicCleanup,
  rotateSecurityLog,
  cleanSnapshots,
  trimTrainingData,
  cleanTelemetry,
  cleanTraceAudit,
  rotateScanLog,
  rotateSkillAudit,
  rotateTelemetryAudit,
  trimQuarantine,
  cleanDailyLogs,
  cleanSessions,
  cleanTrajectories,
  cleanTaskOutputs,
  cleanCheckpointStorage,
  planCheckpointStorage,
  executeCheckpointPlan,
  cleanRuntimeLogs,
  cleanBackendDir,
  cleanOsTempFiles,
  getLastCleanupReport,
  getStorageReport,
  assessRuntimeFootprint,
  humanSize,
};
