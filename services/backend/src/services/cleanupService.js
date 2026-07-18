/**
 * Centralized auto-cleanup service for ~/.khyquant/ persistent data.
 *
 * Manages:
 *  - Security log rotation (5 MB cap, gzip, keep 2 archives)
 *  - Growth snapshots pruning (max 10)
 *  - Training interaction records trimming (10 000 lines / 50 MB)
 *  - Telemetry export pruning (max 5 files)
 *  - Trace audit logs rotation (trace-events.jsonl, sessions/, summaries/, exports/)
 *  - Antivirus scan log rotation (scan.log)
 *  - Skill ledger audit rotation (skill-ledger/audit.jsonl)
 *  - Telemetry audit log rotation (~/.khy/audit.log)
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
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

const BASE_DIR = path.join(os.homedir(), '.khyquant');
const BACKEND_ROOT = process.env.KHYQUANT_ROOT || path.resolve(__dirname, '..', '..');

// ── Limits ──────────────────────────────────────────────────────────────
const SECURITY_LOG_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB
const SECURITY_LOG_KEEP_ARCHIVES = 2;
const SNAPSHOTS_MAX_KEEP = 10;
const TRAINING_MAX_LINES = 10_000;
const TRAINING_MAX_BYTES = 50 * 1024 * 1024;       // 50 MB
const TELEMETRY_MAX_FILES = 5;
const TEMP_MAX_AGE_HOURS = 24;
const LOG_MAX_AGE_HOURS = 168;  // 7 days
const LOG_MAX_FILES = 20;
const TEMP_MAX_SIZE_BYTES = 100 * 1024 * 1024;  // 100 MB
const LOG_MAX_SIZE_BYTES = 50 * 1024 * 1024;     // 50 MB
// OS-temp khy- 前缀残留的销毁年龄（小时）。这是 kill -9 / 崩溃退出（不触发任何
// 进程钩子）后会话临时目录被回收的明确上限。可经 KHY_OS_TEMP_MAX_AGE_HOURS 覆盖。
// 实际最坏回收延迟 = 此年龄 + 扫描周期（KHY_CLEANUP_INTERVAL_MS，默认 2h）。
const OS_TEMP_MAX_AGE_HOURS = (() => {
  const v = parseFloat(process.env.KHY_OS_TEMP_MAX_AGE_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

// ── Extended coverage limits ───────────────────────────────────────────
const TRACE_EVENTS_MAX_BYTES  = 10 * 1024 * 1024;   // 10 MB
const TRACE_SESSION_MAX_AGE_D = 7;                   // 7 days
const TRACE_SUMMARY_MAX_FILES = 50;
const TRACE_EXPORT_MAX_FILES  = 10;
const SCAN_LOG_MAX_BYTES      = 5 * 1024 * 1024;     // 5 MB
const SKILL_AUDIT_MAX_BYTES   = 5 * 1024 * 1024;     // 5 MB
const TELEM_AUDIT_MAX_BYTES   = 5 * 1024 * 1024;     // 5 MB
const QUARANTINE_MAX_LINES    = 5000;
const QUARANTINE_MAX_BYTES    = 20 * 1024 * 1024;     // 20 MB
const DAILY_LOG_MAX_AGE_D     = 90;
const SESSION_MAX_AGE_D       = 7;
// 轨迹（project data home 下的 sessions transcript + replay-ledger + trace-chain
// sidecar + trajectory_replay content store）的定期清理保留期（天）。轨迹原本
// 从不被清理、无限堆积；此处给出明确的定期清理时间。可经 KHY_TRAJECTORY_MAX_AGE_D
// 覆盖；设为 0 或负数则关闭轨迹清理（永久保留）。清理在 cleanupService 周期内执行
// （KHY_CLEANUP_INTERVAL_MS，默认 2h），活跃会话因 mtime 持续刷新天然不被回收。
const TRAJECTORY_MAX_AGE_D    = (() => {
  const v = parseFloat(process.env.KHY_TRAJECTORY_MAX_AGE_D);
  if (process.env.KHY_TRAJECTORY_MAX_AGE_D !== undefined) return Number.isFinite(v) ? v : 30;
  return 30;
})();
const TASK_OUTPUT_MAX_AGE_H   = 24;
const CKPT_MAX_TOTAL_MB       = 500;

// Paths derived from well-known locations
const KHY_HOME = path.join(os.homedir(), '.khy');

// Only managed prefixes are eligible for OS-temp cleanup.
// Keep this explicit to avoid touching unrelated third-party temp files.
const OS_TEMP_PREFIXES = [
  'khy_',
  'khy-',
  'khyquant_',
  'khyquant-',
];

// File extensions that are always safe to clean
const JUNK_EXTENSIONS = new Set([
  '.tmp', '.temp', '.bak', '.swp', '.swo', '.pid',
  '.log.1', '.log.2', '.log.3', '.log.4', '.log.5',
]);

let _periodicTimer = null;
let _lastCleanupReport = null;

// ── Helpers ─────────────────────────────────────────────────────────────

function safeSize(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function safeLs(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function atomicWriteText(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.tmp.${process.pid}.${Date.now()}`
  );
  fs.writeFileSync(tmpPath, content, 'utf-8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

function safeTreeSize(entryPath) {
  try {
    const stat = fs.lstatSync(entryPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
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
      } catch { /* skip broken nodes */ }
    }
  }
  return total;
}

function isManagedOsTempEntry(name) {
  return OS_TEMP_PREFIXES.some(prefix => name.startsWith(prefix));
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

  if (typeof result?.removed === 'number') metric.removed = result.removed;
  if (typeof result?.bytes === 'number') metric.bytes = result.bytes;
  if (typeof result?.kept === 'number') metric.kept = result.kept;
  if (typeof result?.rotated === 'boolean') metric.rotated = result.rotated;
  if (typeof result?.trimmed === 'boolean') metric.trimmed = result.trimmed;
  if (!metric.ok) metric.error = String(result.error || 'unknown error').slice(0, 200);

  metrics.targets.push(metric);
  if (!metric.ok) metrics.failureCount += 1;
  return result;
}

function setLastCleanupReport(trigger, results) {
  const summary = results?.summary || {};
  const metrics = results?.metrics || {};
  const targets = Array.isArray(metrics.targets)
    ? metrics.targets.map(t => ({ ...t }))
    : [];

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
  if (!_lastCleanupReport) return null;
  return {
    ..._lastCleanupReport,
    actions: [...(_lastCleanupReport.actions || [])],
    targets: Array.isArray(_lastCleanupReport.targets)
      ? _lastCleanupReport.targets.map(t => ({ ...t }))
      : [],
  };
}

// ── Security log rotation ───────────────────────────────────────────────

function rotateSecurityLog() {
  const logPath = path.join(BASE_DIR, 'security.log');
  const size = safeSize(logPath);
  if (size <= SECURITY_LOG_MAX_BYTES) return { rotated: false, size };

  try {
    // Shift existing archives: .2.gz → delete, .1.gz → .2.gz
    for (let i = SECURITY_LOG_KEEP_ARCHIVES; i >= 1; i--) {
      const src = path.join(BASE_DIR, `security.log.${i}.gz`);
      if (i === SECURITY_LOG_KEEP_ARCHIVES) {
        try { fs.unlinkSync(src); } catch { /* OK */ }
      } else {
        const dst = path.join(BASE_DIR, `security.log.${i + 1}.gz`);
        try { fs.renameSync(src, dst); } catch { /* OK */ }
      }
    }

    // Compress current log → .1.gz
    const raw = fs.readFileSync(logPath);
    const compressed = zlib.gzipSync(raw);
    fs.writeFileSync(path.join(BASE_DIR, 'security.log.1.gz'), compressed);
    fs.writeFileSync(logPath, ''); // truncate
    return { rotated: true, originalSize: size, compressedSize: compressed.length };
  } catch (err) {
    return { rotated: false, error: err.message };
  }
}

// ── Growth snapshots pruning ────────────────────────────────────────────

function cleanSnapshots(maxKeep = SNAPSHOTS_MAX_KEEP) {
  const dir = path.join(BASE_DIR, 'growth', 'snapshots');
  const files = safeLs(dir).filter(f => f.endsWith('.json')).sort();

  if (files.length <= maxKeep) return { removed: 0, kept: files.length };

  const toRemove = files.slice(0, files.length - maxKeep);
  let removed = 0, bytes = 0;
  for (const f of toRemove) {
    const fp = path.join(dir, f);
    try {
      bytes += safeSize(fp);
      fs.unlinkSync(fp);
      removed++;
    } catch { /* skip */ }
  }
  return { removed, kept: files.length - removed, bytes };
}

// ── Training data trimming ──────────────────────────────────────────────

function trimTrainingData(maxLines = TRAINING_MAX_LINES) {
  const filePath = path.join(BASE_DIR, 'training', 'interaction_records.jsonl');
  const size = safeSize(filePath);
  if (size === 0) return { trimmed: false, lines: 0, size: 0 };

  // If under size cap, only trim by line count
  if (size <= TRAINING_MAX_BYTES) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length <= maxLines) return { trimmed: false, lines: lines.length, size };

      const kept = lines.slice(-maxLines);
      atomicWriteText(filePath, kept.join('\n') + '\n');
      return { trimmed: true, before: lines.length, after: kept.length, freedBytes: size - safeSize(filePath) };
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
    return { trimmed: true, before: lines.length, after: kept.length, freedBytes: size - safeSize(filePath) };
  } catch (err) {
    return { trimmed: false, error: err.message };
  }
}

// ── Telemetry exports pruning ───────────────────────────────────────────

function cleanTelemetry(maxFiles = TELEMETRY_MAX_FILES) {
  const dir = path.join(BASE_DIR, 'telemetry');
  const files = safeLs(dir).sort();

  if (files.length <= maxFiles) return { removed: 0, kept: files.length };

  const toRemove = files.slice(0, files.length - maxFiles);
  let removed = 0, bytes = 0;
  for (const f of toRemove) {
    const fp = path.join(dir, f);
    try {
      bytes += safeSize(fp);
      fs.unlinkSync(fp);
      removed++;
    } catch { /* skip */ }
  }
  return { removed, kept: files.length - removed, bytes };
}

// ── Storage report ──────────────────────────────────────────────────────

function getStorageReport() {
  const report = {};

  // Security log
  const logPath = path.join(BASE_DIR, 'security.log');
  report.securityLog = { size: safeSize(logPath), path: logPath };

  // Security log archives
  let archiveSize = 0;
  for (let i = 1; i <= SECURITY_LOG_KEEP_ARCHIVES; i++) {
    archiveSize += safeSize(path.join(BASE_DIR, `security.log.${i}.gz`));
  }
  report.securityLogArchives = { size: archiveSize };

  // Growth snapshots
  const snapDir = path.join(BASE_DIR, 'growth', 'snapshots');
  const snapFiles = safeLs(snapDir);
  let snapSize = 0;
  for (const f of snapFiles) snapSize += safeSize(path.join(snapDir, f));
  report.growthSnapshots = { count: snapFiles.length, size: snapSize, path: snapDir };

  // Training data
  const trainPath = path.join(BASE_DIR, 'training', 'interaction_records.jsonl');
  report.trainingData = { size: safeSize(trainPath), path: trainPath };

  // Telemetry
  const telDir = path.join(BASE_DIR, 'telemetry');
  const telFiles = safeLs(telDir);
  let telSize = 0;
  for (const f of telFiles) telSize += safeSize(path.join(telDir, f));
  report.telemetry = { count: telFiles.length, size: telSize, path: telDir };

  // Conversations
  const convoDir = path.join(BASE_DIR, 'conversations');
  const convoFiles = safeLs(convoDir);
  let convoSize = 0;
  for (const f of convoFiles) convoSize += safeSize(path.join(convoDir, f));
  report.conversations = { count: convoFiles.length, size: convoSize };

  // Trace audit (~/.khy/audit/)
  const auditRoot = path.join(KHY_HOME, 'audit');
  report.traceAudit = { size: safeTreeSize(auditRoot), path: auditRoot };

  // Scan log
  report.scanLog = { size: safeSize(path.join(BASE_DIR, 'scan.log')) };

  // Skill ledger
  report.skillAudit = { size: safeSize(path.join(BASE_DIR, 'skill-ledger', 'audit.jsonl')) };

  // Telemetry audit
  report.telemetryAudit = { size: safeSize(path.join(KHY_HOME, 'audit.log')) };

  // Sessions
  const sessDir = path.join(KHY_HOME, 'sessions');
  report.sessions = { size: safeTreeSize(sessDir), count: safeLs(sessDir).length };

  // Checkpoints
  const ckptRoot = path.join(BASE_DIR, 'checkpoints');
  report.checkpoints = { size: safeTreeSize(ckptRoot) };

  // Task outputs
  const taskDir = path.join(KHY_HOME, 'tmp', 'tasks');
  report.taskOutputs = { size: safeTreeSize(taskDir) };

  // Daily logs
  const dailyLogDir = path.join(KHY_HOME, 'memory', 'logs');
  report.dailyLogs = { size: safeTreeSize(dailyLogDir) };

  // Total
  report.total = Object.values(report).reduce((acc, v) => acc + (v.size || 0), 0);
  report.totalHuman = humanSize(report.total);

  return report;
}

// ── Trace audit cleanup ────────────────────────────────────────────────

function _rotateAppendLog(filePath, maxBytes, label) {
  const size = safeSize(filePath);
  if (size <= maxBytes) return { rotated: false, size };
  try {
    const archivePath = `${filePath}.1.gz`;
    try { fs.unlinkSync(`${filePath}.2.gz`); } catch { /* OK */ }
    try { fs.renameSync(archivePath, `${filePath}.2.gz`); } catch { /* OK */ }
    const raw = fs.readFileSync(filePath);
    fs.writeFileSync(archivePath, zlib.gzipSync(raw));
    fs.writeFileSync(filePath, '');
    return { rotated: true, originalSize: size };
  } catch (err) {
    return { rotated: false, error: err.message };
  }
}

function cleanTraceAudit() {
  const auditRoot = path.join(KHY_HOME, 'audit');
  let removed = 0, bytes = 0;

  // 1. Rotate trace-events.jsonl
  const eventsFile = path.join(auditRoot, 'trace-events.jsonl');
  const rot = _rotateAppendLog(eventsFile, TRACE_EVENTS_MAX_BYTES, 'trace-events');
  if (rot.rotated) bytes += rot.originalSize || 0;

  // 2. Clean old session files (> 7 days)
  const sessionDir = path.join(auditRoot, 'sessions');
  const cutoff = Date.now() - TRACE_SESSION_MAX_AGE_D * 86400000;
  for (const f of safeLs(sessionDir)) {
    const fp = path.join(sessionDir, f);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && st.mtimeMs < cutoff) {
        bytes += st.size; fs.unlinkSync(fp); removed++;
      }
    } catch { /* skip */ }
  }

  // 3. Cap summaries
  const summaryDir = path.join(auditRoot, 'summaries');
  const summaryFiles = safeLs(summaryDir).sort();
  if (summaryFiles.length > TRACE_SUMMARY_MAX_FILES) {
    for (const f of summaryFiles.slice(0, summaryFiles.length - TRACE_SUMMARY_MAX_FILES)) {
      const fp = path.join(summaryDir, f);
      try { bytes += safeSize(fp); fs.unlinkSync(fp); removed++; } catch { /* skip */ }
    }
  }

  // 4. Cap exports
  const exportDir = path.join(auditRoot, 'exports');
  const exportFiles = safeLs(exportDir).sort();
  if (exportFiles.length > TRACE_EXPORT_MAX_FILES) {
    for (const f of exportFiles.slice(0, exportFiles.length - TRACE_EXPORT_MAX_FILES)) {
      const fp = path.join(exportDir, f);
      try { bytes += safeSize(fp); fs.unlinkSync(fp); removed++; } catch { /* skip */ }
    }
  }

  return { removed, bytes, rotated: rot.rotated };
}

// ── Scan log rotation ──────────────────────────────────────────────────

function rotateScanLog() {
  return _rotateAppendLog(path.join(BASE_DIR, 'scan.log'), SCAN_LOG_MAX_BYTES, 'scan');
}

// ── Skill ledger audit rotation ────────────────────────────────────────

function rotateSkillAudit() {
  return _rotateAppendLog(path.join(BASE_DIR, 'skill-ledger', 'audit.jsonl'), SKILL_AUDIT_MAX_BYTES, 'skill-audit');
}

// ── Telemetry audit.log rotation ───────────────────────────────────────

function rotateTelemetryAudit() {
  return _rotateAppendLog(path.join(KHY_HOME, 'audit.log'), TELEM_AUDIT_MAX_BYTES, 'telemetry-audit');
}

// ── Training quarantine trimming ───────────────────────────────────────

function trimQuarantine() {
  // Try both possible locations
  const candidates = [
    path.join(KHY_HOME, 'training', 'interaction_quarantine.jsonl'),
    path.join(BASE_DIR, 'training', 'interaction_quarantine.jsonl'),
  ];
  for (const filePath of candidates) {
    const size = safeSize(filePath);
    if (size === 0) continue;
    if (size <= QUARANTINE_MAX_BYTES) {
      try {
        const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
        if (lines.length <= QUARANTINE_MAX_LINES) return { trimmed: false, lines: lines.length };
        const kept = lines.slice(-QUARANTINE_MAX_LINES);
        atomicWriteText(filePath, kept.join('\n') + '\n');
        return { trimmed: true, before: lines.length, after: kept.length, freedBytes: size - safeSize(filePath) };
      } catch { continue; }
    }
    // Over size cap
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
      const kept = lines.slice(-Math.floor(QUARANTINE_MAX_LINES / 2));
      atomicWriteText(filePath, kept.join('\n') + '\n');
      return { trimmed: true, before: lines.length, after: kept.length, freedBytes: size - safeSize(filePath) };
    } catch { continue; }
  }
  return { trimmed: false };
}

// ── Daily memory log pruning ───────────────────────────────────────────

function cleanDailyLogs() {
  const logsDir = path.join(KHY_HOME, 'memory', 'logs');
  if (!fs.existsSync(logsDir)) return { removed: 0, bytes: 0 };
  const cutoff = Date.now() - DAILY_LOG_MAX_AGE_D * 86400000;
  let removed = 0, bytes = 0;

  // Walk YYYY/MM/YYYY-MM-DD.md structure
  for (const year of safeLs(logsDir)) {
    const yearDir = path.join(logsDir, year);
    try { if (!fs.statSync(yearDir).isDirectory()) continue; } catch { continue; }
    for (const month of safeLs(yearDir)) {
      const monthDir = path.join(yearDir, month);
      try { if (!fs.statSync(monthDir).isDirectory()) continue; } catch { continue; }
      for (const file of safeLs(monthDir)) {
        const fp = path.join(monthDir, file);
        try {
          const st = fs.statSync(fp);
          if (st.isFile() && st.mtimeMs < cutoff) {
            bytes += st.size; fs.unlinkSync(fp); removed++;
          }
        } catch { /* skip */ }
      }
      // Remove empty month dirs
      if (safeLs(monthDir).length === 0) {
        try { fs.rmdirSync(monthDir); } catch { /* skip */ }
      }
    }
    // Remove empty year dirs
    if (safeLs(yearDir).length === 0) {
      try { fs.rmdirSync(yearDir); } catch { /* skip */ }
    }
  }
  return { removed, bytes };
}

// ── Session file cleanup ───────────────────────────────────────────────

function cleanSessions() {
  const sessDir = path.join(KHY_HOME, 'sessions');
  if (!fs.existsSync(sessDir)) return { removed: 0, bytes: 0 };
  const cutoff = Date.now() - SESSION_MAX_AGE_D * 86400000;
  let removed = 0, bytes = 0;

  for (const f of safeLs(sessDir)) {
    const fp = path.join(sessDir, f);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && st.mtimeMs < cutoff) {
        bytes += st.size; fs.unlinkSync(fp); removed++;
      }
    } catch { /* skip */ }
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
    if (filename.endsWith(suf)) return filename.slice(0, -suf.length);
  }
  return null; // 非轨迹文件 → 不碰（例如 bucket 内的 cwd 标记文件等）
}

function cleanTrajectories() {
  // 关闭开关：保留期 <= 0 表示永久保留，不清理。
  if (!(TRAJECTORY_MAX_AGE_D > 0)) return { removed: 0, bytes: 0 };

  let dataHome;
  try { dataHome = require('../utils/dataHome'); } catch { return { removed: 0, bytes: 0 }; }

  const cutoff = Date.now() - TRAJECTORY_MAX_AGE_D * 86400000;
  let removed = 0, bytes = 0;

  // 1) sessions/<bucket>/ 下按 base 成组清理
  let sessRoot;
  try { sessRoot = dataHome.getProjectDataDir('sessions'); } catch { sessRoot = null; }
  if (sessRoot && fs.existsSync(sessRoot)) {
    for (const bucket of safeLs(sessRoot)) {
      const bucketDir = path.join(sessRoot, bucket);
      let isDir = false;
      try { isDir = fs.statSync(bucketDir).isDirectory(); } catch { /* skip */ }
      if (!isDir) continue;

      // 按 base 归组：{ base -> [{path,size,mtime}] }
      const groups = new Map();
      for (const f of safeLs(bucketDir)) {
        const base = _trajectoryBase(f);
        if (base === null) continue;
        const fp = path.join(bucketDir, f);
        try {
          const st = fs.statSync(fp);
          if (!st.isFile()) continue;
          if (!groups.has(base)) groups.set(base, []);
          groups.get(base).push({ path: fp, size: st.size, mtime: st.mtimeMs });
        } catch { /* skip */ }
      }

      for (const files of groups.values()) {
        const newest = files.reduce((m, x) => Math.max(m, x.mtime), 0);
        if (newest >= cutoff) continue; // 组内有新鲜文件 → 整组保留
        for (const file of files) {
          try { fs.unlinkSync(file.path); bytes += file.size; removed++; } catch { /* skip */ }
        }
      }
    }
  }

  // 2) trajectory_replay/<sessionId>/ content store 按目录最新 mtime 整树清理
  let replayRoot;
  try { replayRoot = path.join(dataHome.getProjectDataHome(), 'trajectory_replay'); } catch { replayRoot = null; }
  if (replayRoot && fs.existsSync(replayRoot)) {
    for (const sid of safeLs(replayRoot)) {
      const sidDir = path.join(replayRoot, sid);
      try {
        const st = fs.statSync(sidDir);
        if (!st.isDirectory()) continue;
        // 用目录树内最新 mtime 判活，避免删到正在写入的 content store。
        const newest = _newestMtime(sidDir);
        if (newest >= cutoff) continue;
        const size = safeTreeSize(sidDir);
        fs.rmSync(sidDir, { recursive: true, force: true });
        bytes += size; removed++;
      } catch { /* skip */ }
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
    try { st = fs.lstatSync(cur); } catch { continue; }
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    if (st.isDirectory()) {
      for (const child of safeLs(cur)) stack.push(path.join(cur, child));
    }
  }
  return newest;
}

// ── Task output cleanup ───────────────────────────────────────────────

function cleanTaskOutputs() {
  const taskDir = process.env.KHY_TASK_OUTPUT_DIR || path.join(KHY_HOME, 'tmp', 'tasks');
  if (!fs.existsSync(taskDir)) return { removed: 0, bytes: 0 };
  const cutoff = Date.now() - TASK_OUTPUT_MAX_AGE_H * 3600000;
  let removed = 0, bytes = 0;

  for (const f of safeLs(taskDir)) {
    const fp = path.join(taskDir, f);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && st.mtimeMs < cutoff) {
        bytes += st.size; fs.unlinkSync(fp); removed++;
      }
    } catch { /* skip */ }
  }
  return { removed, bytes };
}

// ── Checkpoint storage cap ─────────────────────────────────────────────

function cleanCheckpointStorage() {
  const ckptRoot = path.join(os.homedir(), '.khyquant', 'checkpoints');
  if (!fs.existsSync(ckptRoot)) return { removed: 0, bytes: 0 };

  const maxBytes = CKPT_MAX_TOTAL_MB * 1024 * 1024;
  let totalSize = safeTreeSize(ckptRoot);
  if (totalSize <= maxBytes) return { removed: 0, bytes: 0, currentSize: totalSize };

  // Collect all checkpoint data files across all projects, sorted oldest first
  let removed = 0, bytes = 0;
  const allFiles = [];
  for (const projDir of safeLs(ckptRoot)) {
    const projPath = path.join(ckptRoot, projDir);
    try { if (!fs.statSync(projPath).isDirectory()) continue; } catch { continue; }
    for (const f of safeLs(projPath)) {
      if (f === 'manifest.json') continue;
      const fp = path.join(projPath, f);
      try {
        const st = fs.statSync(fp);
        if (st.isFile()) allFiles.push({ path: fp, size: st.size, mtime: st.mtimeMs });
      } catch { /* skip */ }
    }
  }
  allFiles.sort((a, b) => a.mtime - b.mtime);

  for (const file of allFiles) {
    if (totalSize <= maxBytes) break;
    try {
      fs.unlinkSync(file.path);
      totalSize -= file.size;
      bytes += file.size;
      removed++;
    } catch { /* skip */ }
  }
  return { removed, bytes };
}

// ── Run all cleanup ─────────────────────────────────────────────────────

/**
 * Clean a backend directory by file age, count, and total size.
 */
function cleanBackendDir(relDir, { maxAgeHours = TEMP_MAX_AGE_HOURS, maxFiles = Infinity, maxSizeBytes = TEMP_MAX_SIZE_BYTES } = {}) {
  const dirPath = path.join(BACKEND_ROOT, relDir);
  let removed = 0, bytes = 0;
  if (!fs.existsSync(dirPath)) return { removed, bytes };

  try {
    const entries = fs.readdirSync(dirPath);
    const files = [];
    for (const entry of entries) {
      if (entry === '.gitkeep' || entry === '.env') continue;
      const fp = path.join(dirPath, entry);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile()) files.push({ path: fp, name: entry, size: stat.size, mtime: stat.mtimeMs });
      } catch { /* skip */ }
    }
    files.sort((a, b) => a.mtime - b.mtime); // oldest first

    // Remove old and junk files
    for (const file of files) {
      const ageH = (Date.now() - file.mtime) / (1000 * 60 * 60);
      const ext = path.extname(file.name).toLowerCase();
      if (ageH > maxAgeHours || JUNK_EXTENSIONS.has(ext)) {
        try { fs.unlinkSync(file.path); removed++; bytes += file.size; } catch { /* skip */ }
      }
    }

    // Cap file count
    const remaining = files.filter(f => fs.existsSync(f.path));
    if (remaining.length > maxFiles) {
      for (const file of remaining.slice(0, remaining.length - maxFiles)) {
        try { fs.unlinkSync(file.path); removed++; bytes += file.size; } catch { /* skip */ }
      }
    }

    // Cap total size
    let currentSize = 0;
    for (const entry of safeLs(dirPath)) {
      currentSize += safeSize(path.join(dirPath, entry));
    }
    if (currentSize > maxSizeBytes) {
      const stillExist = files.filter(f => fs.existsSync(f.path));
      for (const file of stillExist) {
        if (currentSize <= maxSizeBytes) break;
        try { fs.unlinkSync(file.path); currentSize -= file.size; removed++; bytes += file.size; } catch { /* skip */ }
      }
    }
  } catch { /* access error */ }

  return { removed, bytes };
}

/**
 * Clean khy OS specific files from OS temp directory.
 */
function cleanOsTempFiles() {
  let removed = 0, bytes = 0;
  const tmpDir = process.env.KHY_OS_TEMP_DIR || os.tmpdir();
  try {
    for (const entry of fs.readdirSync(tmpDir)) {
      if (!isManagedOsTempEntry(entry)) continue;
      const fp = path.join(tmpDir, entry);
      try {
        const stat = fs.lstatSync(fp);
        const ageH = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
        if (ageH <= OS_TEMP_MAX_AGE_HOURS) continue;

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
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
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
  };

  // Clean backend temp/intermediate directories
  const backendTargets = [
    { dir: 'temp', maxAgeHours: TEMP_MAX_AGE_HOURS, maxSizeBytes: TEMP_MAX_SIZE_BYTES },
    { dir: 'logs', maxAgeHours: LOG_MAX_AGE_HOURS, maxFiles: LOG_MAX_FILES, maxSizeBytes: LOG_MAX_SIZE_BYTES },
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
    if (r.removed > 0) results.backendCleanup.push({ dir: target.dir, ...r });
  }

  // Clean OS temp
  const osTmp = recordCleanupTarget(
    metrics,
    'backend:os-temp',
    () => cleanOsTempFiles(),
    { dir: 'os-temp' }
  );
  if (osTmp.removed > 0) results.backendCleanup.push({ dir: 'os-temp', ...osTmp });

  // Clean khy-tool-results 磁盘持久化目录（大工具结果）
  // 借鉴 Claude Code 的 Content Replacement Budget 清理策略
  const toolResultDir = path.join(os.tmpdir(), 'khy-tool-results');
  const toolResultCleanup = recordCleanupTarget(
    metrics,
    'backend:khy-tool-results',
    () => {
      if (!fs.existsSync(toolResultDir)) return { removed: 0, bytes: 0 };
      let removed = 0, bytes = 0;
      try {
        const entries = fs.readdirSync(toolResultDir);
        for (const entry of entries) {
          const fp = path.join(toolResultDir, entry);
          try {
            const stat = fs.statSync(fp);
            // 超过 1 小时的工具结果文件 → 清理
            if (stat.isFile() && (Date.now() - stat.mtimeMs) > 3600000) {
              bytes += stat.size;
              fs.unlinkSync(fp);
              removed++;
            }
          } catch { /* skip */ }
        }
      } catch { /* dir read failed */ }
      return { removed, bytes };
    },
    { dir: 'khy-tool-results' }
  );
  if (toolResultCleanup.removed > 0) results.backendCleanup.push({ dir: 'khy-tool-results', ...toolResultCleanup });

  // Calculate total freed
  let freedBytes = 0;
  if (results.securityLog.rotated) {
    freedBytes += (results.securityLog.originalSize || 0) - (results.securityLog.compressedSize || 0);
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
    results.summary.actions.push(`Security log rotated (${humanSize(results.securityLog.originalSize)})`);
  }
  if (results.snapshots.removed > 0) {
    results.summary.actions.push(`Removed ${results.snapshots.removed} old snapshots`);
  }
  if (results.trainingData.trimmed) {
    results.summary.actions.push(`Training data trimmed: ${results.trainingData.before} → ${results.trainingData.after} lines`);
  }
  if (results.telemetry.removed > 0) {
    results.summary.actions.push(`Removed ${results.telemetry.removed} old telemetry exports`);
  }
  // Extended targets
  if (results.traceAudit.rotated || results.traceAudit.removed > 0) {
    const parts = [];
    if (results.traceAudit.rotated) parts.push('events rotated');
    if (results.traceAudit.removed > 0) parts.push(`${results.traceAudit.removed} old files removed`);
    results.summary.actions.push(`Trace audit: ${parts.join(', ')}`);
    freedBytes += results.traceAudit.bytes || 0;
  }
  if (results.scanLog.rotated) {
    results.summary.actions.push(`Scan log rotated (${humanSize(results.scanLog.originalSize || 0)})`);
    freedBytes += results.scanLog.originalSize || 0;
  }
  if (results.skillAudit.rotated) {
    results.summary.actions.push(`Skill audit rotated (${humanSize(results.skillAudit.originalSize || 0)})`);
    freedBytes += results.skillAudit.originalSize || 0;
  }
  if (results.telemetryAudit.rotated) {
    results.summary.actions.push(`Telemetry audit rotated (${humanSize(results.telemetryAudit.originalSize || 0)})`);
    freedBytes += results.telemetryAudit.originalSize || 0;
  }
  if (results.quarantine.trimmed) {
    results.summary.actions.push(`Quarantine trimmed: ${results.quarantine.before} → ${results.quarantine.after} lines`);
    freedBytes += results.quarantine.freedBytes || 0;
  }
  if (results.dailyLogs.removed > 0) {
    results.summary.actions.push(`Removed ${results.dailyLogs.removed} old daily logs (${humanSize(results.dailyLogs.bytes)})`);
    freedBytes += results.dailyLogs.bytes || 0;
  }
  if (results.sessions.removed > 0) {
    results.summary.actions.push(`Removed ${results.sessions.removed} old session files (${humanSize(results.sessions.bytes)})`);
    freedBytes += results.sessions.bytes || 0;
  }
  if (results.trajectories && results.trajectories.removed > 0) {
    results.summary.actions.push(`Removed ${results.trajectories.removed} old trajectory files (${humanSize(results.trajectories.bytes)})`);
    freedBytes += results.trajectories.bytes || 0;
  }
  if (results.taskOutputs.removed > 0) {
    results.summary.actions.push(`Removed ${results.taskOutputs.removed} old task outputs (${humanSize(results.taskOutputs.bytes)})`);
    freedBytes += results.taskOutputs.bytes || 0;
  }
  if (results.checkpoints.removed > 0) {
    results.summary.actions.push(`Removed ${results.checkpoints.removed} checkpoint files (${humanSize(results.checkpoints.bytes)})`);
    freedBytes += results.checkpoints.bytes || 0;
  }
  for (const bc of results.backendCleanup) {
    if (bc.removed > 0) {
      results.summary.actions.push(`Cleaned ${bc.dir}: ${bc.removed} files (${humanSize(bc.bytes)})`);
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
  if (_periodicTimer) return;
  const skipInitial = options && options.skipInitial === true;
  // Initial cleanup on startup
  if (!skipInitial) {
    try { runCleanup({ trigger: 'startup' }); } catch { /* ignore */ }
  }
  // On constrained hardware the recurring sweep is disabled; the startup cleanup
  // above still runs so disk hygiene is preserved without idle wakeups.
  if (String(process.env.KHY_ENABLE_PERIODIC_SCAN || '').toLowerCase() === 'false') {
    return;
  }
  const envInterval = parseInt(process.env.KHY_CLEANUP_INTERVAL_MS, 10);
  const intervalMs = (options && Number.isFinite(options.intervalMs) && options.intervalMs > 0)
    ? options.intervalMs
    : (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : 2 * 60 * 60 * 1000);
  _periodicTimer = setInterval(() => {
    try { runCleanup({ trigger: 'periodic' }); } catch { /* ignore */ }
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
  cleanBackendDir,
  cleanOsTempFiles,
  getLastCleanupReport,
  getStorageReport,
  humanSize,
};
