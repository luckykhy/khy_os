'use strict';

/**
 * Base Self-Check Service
 *
 * Periodically checks runtime health and records trend data.
 * Designed to never crash the host process.
 */
const fs = require('fs');
const path = require('path');
const { getDataHome } = require('../utils/dataHome');
const resourceGuard = require('./resourceGuard');
const securityGuard = require('./securityGuardService');

const DEFAULT_INTERVAL_MS = _toInt(process.env.KHY_SELF_CHECK_INTERVAL_MS, 300000);
const MIN_INTERVAL_MS = 15000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = Math.max(20, _toInt(process.env.KHY_SELF_CHECK_MAX_HISTORY, 180));
const SERVICE_HEALTH_TIMEOUT_MS = _toInt(process.env.KHY_SELF_CHECK_SERVICE_TIMEOUT_MS, 8000);
const THREAT_SCAN_EVERY = Math.max(1, _toInt(process.env.KHY_SELF_CHECK_THREAT_SCAN_EVERY, 6));
const PLUGIN_DOCTOR_EVERY = Math.max(1, _toInt(process.env.KHY_SELF_CHECK_PLUGIN_DOCTOR_EVERY, 12));
const PLUGIN_DOCTOR_TIMEOUT_MS = _toInt(process.env.KHY_SELF_CHECK_PLUGIN_DOCTOR_TIMEOUT_MS, 5000);
const PLUGIN_DOCTOR_MAX = Math.max(1, _toInt(process.env.KHY_SELF_CHECK_PLUGIN_DOCTOR_MAX, 8));
const STRICT_MODE = _envBool(process.env.KHY_SELF_CHECK_STRICT, false);
const DEFAULT_LOG_FILE = path.join(getDataHome(), 'selfcheck.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_BACKUPS = 2;
const SELF_CHECK_AUTO_REPAIR_PREFERRED = _envBool(process.env.KHY_SELF_CHECK_AUTO_REPAIR_PREFERRED, true);

let _timer = null;
let _intervalMs = 0;
let _startedAt = 0;
let _runCount = 0;
let _running = false;
let _history = [];
let _lastResult = null;
let _logFile = process.env.KHY_SELF_CHECK_LOG_FILE || DEFAULT_LOG_FILE;
let _logWriteError = null;

function _toInt(value, fallback) {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function _envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return !!fallback;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes' || s === 'y';
}

function _normalizeInterval(intervalMs) {
  const n = _toInt(intervalMs, DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, n));
}

function _pushHistory(item) {
  _history.push(item);
  if (_history.length > MAX_HISTORY) {
    _history = _history.slice(_history.length - MAX_HISTORY);
  }
}

function _summarizeStates(entries, key = 'state') {
  const out = {};
  for (const item of entries) {
    const k = String(item?.[key] || 'unknown');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function _severityRank(s) {
  if (s === 'critical') return 3;
  if (s === 'high') return 2;
  if (s === 'warning') return 1;
  return 0;
}

function _fallbackLogFile() {
  return path.join(process.cwd(), '.tmp', 'selfcheck.log');
}

function _readLogFilePath() {
  const fallback = _fallbackLogFile();
  if (fs.existsSync(_logFile)) return _logFile;
  if (_logFile !== fallback && fs.existsSync(fallback)) return fallback;
  return _logFile;
}

function _rotateLogIfNeeded() {
  try {
    if (!fs.existsSync(_logFile)) return;
    const stat = fs.statSync(_logFile);
    if (stat.size <= MAX_LOG_SIZE) return;

    for (let i = MAX_LOG_BACKUPS - 1; i >= 1; i--) {
      const from = `${_logFile}.${i}`;
      const to = `${_logFile}.${i + 1}`;
      if (fs.existsSync(from)) {
        if (i + 1 > MAX_LOG_BACKUPS) fs.unlinkSync(from);
        else fs.renameSync(from, to);
      }
    }
    fs.renameSync(_logFile, `${_logFile}.1`);
  } catch { /* best effort */ }
}

const _resolveGatewayEnvPaths = require('../utils/resolveGatewayEnvPaths');

const _patchEnvContent = require('../utils/patchEnvContent');

function _writeGatewayEnvPatch(envMap = {}, unsetKeys = []) {
  const resolved = _resolveGatewayEnvPaths();
  for (const targetPath of resolved.targets) {
    let content = '';
    try { content = fs.readFileSync(targetPath, 'utf-8'); } catch { /* no .env yet */ }
    const patched = _patchEnvContent(content, envMap, unsetKeys);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, patched, 'utf-8');
  }

  for (const [key, value] of Object.entries(envMap)) {
    process.env[key] = String(value);
  }
  for (const key of unsetKeys) {
    delete process.env[key];
  }

  return resolved.canonicalPath;
}

function _writeLog(record) {
  fs.mkdirSync(path.dirname(_logFile), { recursive: true });
  _rotateLogIfNeeded();
  fs.appendFileSync(_logFile, JSON.stringify(record) + '\n', 'utf-8');
}

function _appendLog(record) {
  try {
    _writeLog(record);
    _logWriteError = null;
  } catch (err) {
    _logWriteError = err?.message || String(err);
    const fallback = _fallbackLogFile();
    if (_logFile !== fallback) {
      _logFile = fallback;
      try {
        _writeLog(record);
        _logWriteError = null;
      } catch (fallbackErr) {
        _logWriteError = fallbackErr?.message || String(fallbackErr);
      }
    }
  }
}

function _classifySeverity(score, issues) {
  const maxIssueRank = issues.reduce((m, i) => Math.max(m, _severityRank(i?.severity)), 0);
  if (score < 45 || maxIssueRank >= 3) return 'critical';
  if (score < 75 || maxIssueRank >= 2) return 'degraded';
  return 'healthy';
}

function _shouldRunPeriodic(runSeq, everyN) {
  return runSeq === 1 || runSeq % everyN === 0;
}

async function _checkServices(result, issues, scoreRef) {
  try {
    const registry = require('./serviceRegistry');
    const checks = await resourceGuard.withTimeout(
      Promise.resolve(registry.healthCheck()),
      SERVICE_HEALTH_TIMEOUT_MS,
      'serviceRegistry.healthCheck'
    );

    const unhealthy = checks.filter(c => c.healthy === false);
    const unknown = checks.filter(c => c.healthy === null);

    result.checks.services = {
      healthy: unhealthy.length === 0,
      total: checks.length,
      unhealthy: unhealthy.map(i => ({ name: i.name, error: i.error || null })),
      unknownCount: unknown.length,
    };

    if (unhealthy.length > 0) {
      scoreRef.value -= Math.min(40, unhealthy.length * 8);
    } else if (unknown.length > 0) {
      // Unknown usually means "service not loaded yet", lower confidence but not failure.
      scoreRef.value -= Math.min(6, unknown.length);
    }
    for (const item of unhealthy.slice(0, 10)) {
      issues.push({
        source: 'service',
        severity: 'high',
        message: `${item.name}: ${item.error || 'health check failed'}`,
      });
    }
  } catch (err) {
    scoreRef.value -= 25;
    result.checks.services = {
      healthy: false,
      total: 0,
      unhealthy: [],
      unknownCount: 0,
      error: err?.message || String(err),
    };
    issues.push({
      source: 'service',
      severity: 'high',
      message: `service health check failed: ${err?.message || err}`,
    });
  }
}

async function _checkPlugins(result, issues, scoreRef, opts = {}) {
  const out = {
    total: 0,
    runtimeBad: 0,
    runtimeWarn: 0,
    states: {},
    doctor: {
      ran: false,
      pluginCount: 0,
      failed: 0,
      errorCount: 0,
      warningCount: 0,
      sample: [],
    },
  };

  try {
    const pluginLoader = require('../plugin-loader');
    let runtime = [];
    const loaded = pluginLoader.getAllPlugins ? pluginLoader.getAllPlugins() : [];

    if (Array.isArray(loaded) && loaded.length > 0) {
      runtime = loaded.map(p => ({
        name: p?.manifest?.name || p?.namespace || 'unknown',
        displayName: p?.manifest?.displayName || p?.manifest?.name || p?.namespace || 'unknown',
        namespace: p?.namespace || '',
        state: p?.state || 'unknown',
        path: p?.path || '',
      }));
    } else {
      const discovered = pluginLoader.discoverPlugins
        ? pluginLoader.discoverPlugins({ info() {}, warn() {}, error() {} })
        : [];
      runtime = discovered.map(d => ({
        name: d?.manifestData?.name || path.basename(d?.pluginPath || ''),
        displayName: d?.manifestData?.displayName || d?.manifestData?.name || path.basename(d?.pluginPath || ''),
        namespace: d?.manifestData?.namespace || '',
        state: 'discovered',
        path: d?.pluginPath || '',
      }));
    }

    out.total = runtime.length;
    out.states = _summarizeStates(runtime, 'state');

    const runtimeBad = runtime.filter(r => String(r.state || '').startsWith('disabled'));
    const runtimeWarn = runtime.filter(r => ['loading', 'unknown', 'discovered'].includes(String(r.state || '')));
    out.runtimeBad = runtimeBad.length;
    out.runtimeWarn = runtimeWarn.length;

    if (runtimeBad.length > 0) {
      scoreRef.value -= Math.min(35, runtimeBad.length * 10);
    }
    if (STRICT_MODE && runtimeWarn.length > 0) {
      scoreRef.value -= Math.min(6, runtimeWarn.length);
    }

    for (const b of runtimeBad.slice(0, 10)) {
      issues.push({
        source: 'plugin',
        severity: 'high',
        message: `${b.displayName || b.name}: runtime state = ${b.state}`,
      });
    }

    if (opts.runDoctor && runtime.length > 0) {
      // Resolve the plugin-doctor runner via the neutral port instead of
      // requiring cli/handlers/plugin-dev back (DESIGN-ARCH-021, Batch 2). The
      // CLI handler self-registers on load; if it was never loaded, the doctor
      // sub-check degrades to skipped — same as the prior require failure path.
      const runPluginDoctorForDir = require('./pluginDoctorPort').getPluginDoctor();

      if (typeof runPluginDoctorForDir === 'function') {
        out.doctor.ran = true;
        const seen = new Set();
        const targets = [];
        for (const p of runtime) {
          if (!p.path || seen.has(p.path)) continue;
          seen.add(p.path);
          targets.push(p.path);
          if (targets.length >= PLUGIN_DOCTOR_MAX) break;
        }

        out.doctor.pluginCount = targets.length;
        for (const pluginPath of targets) {
          try {
            const report = await resourceGuard.withTimeout(
              Promise.resolve(runPluginDoctorForDir(pluginPath, {
                deep: !!opts.doctorDeep,
                strict: false,
                fast: !opts.doctorDeep,
              })),
              PLUGIN_DOCTOR_TIMEOUT_MS,
              `plugin doctor timeout: ${path.basename(pluginPath)}`
            );
            const eCount = Array.isArray(report?.errors) ? report.errors.length : 0;
            const wCount = Array.isArray(report?.warnings) ? report.warnings.length : 0;
            out.doctor.errorCount += eCount;
            out.doctor.warningCount += wCount;
            if (eCount > 0) {
              out.doctor.failed++;
              out.doctor.sample.push({
                plugin: report?.displayName || report?.namespace || path.basename(pluginPath),
                errors: eCount,
                warnings: wCount,
              });
              issues.push({
                source: 'plugin',
                severity: 'critical',
                message: `${report?.displayName || path.basename(pluginPath)} doctor errors: ${eCount}`,
              });
            } else if (STRICT_MODE && wCount > 0) {
              issues.push({
                source: 'plugin',
                severity: 'high',
                message: `${report?.displayName || path.basename(pluginPath)} doctor warnings: ${wCount}`,
              });
            }
          } catch (err) {
            out.doctor.failed++;
            out.doctor.errorCount++;
            out.doctor.sample.push({
              plugin: path.basename(pluginPath),
              errors: 1,
              warnings: 0,
              error: err?.message || String(err),
            });
            issues.push({
              source: 'plugin',
              severity: 'high',
              message: `plugin doctor failed for ${path.basename(pluginPath)}: ${err?.message || err}`,
            });
          }
        }

        if (out.doctor.errorCount > 0) {
          scoreRef.value -= Math.min(45, 15 + out.doctor.errorCount * 3);
        }
        if (STRICT_MODE && out.doctor.warningCount > 0) {
          scoreRef.value -= Math.min(15, out.doctor.warningCount);
        }
      } else {
        out.doctor.ran = false;
        issues.push({
          source: 'plugin',
          severity: 'warning',
          message: 'plugin doctor hook unavailable; skipped code-level plugin QA',
        });
      }
    }
  } catch (err) {
    scoreRef.value -= 12;
    issues.push({
      source: 'plugin',
      severity: 'warning',
      message: `plugin health check failed: ${err?.message || err}`,
    });
  }

  result.checks.plugins = out;
}

async function _checkGatewayPreferred(result, issues, scoreRef, opts = {}) {
  const configuredRaw = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim();
  const configured = configuredRaw.toLowerCase();
  const autoRepair = opts.autoRepairPreferred !== false;
  const checkOut = {
    configured: configuredRaw || 'auto',
    healthy: true,
    autoRepaired: false,
    repairedTo: null,
    envPath: null,
  };

  if (!configured || configured === 'auto') {
    result.checks.gateway = checkOut;
    return;
  }

  try {
    const gateway = require('./gateway/aiGateway');
    await resourceGuard.withTimeout(
      (async () => {
        if (!gateway._initialized && typeof gateway.init === 'function') {
          await gateway.init();
        }
      })(),
      SERVICE_HEALTH_TIMEOUT_MS,
      'gateway.init'
    );

    const statuses = await resourceGuard.withTimeout(
      Promise.resolve(typeof gateway.getStatus === 'function' ? gateway.getStatus() : []),
      SERVICE_HEALTH_TIMEOUT_MS,
      'gateway.getStatus'
    );
    const list = Array.isArray(statuses) ? statuses : [];
    const matched = list.find((s) => String(s?.type || '').trim().toLowerCase() === configured);

    if (matched && matched.enabled !== false) {
      const available = matched.available !== false;
      checkOut.healthy = available;
      if (!available) {
        scoreRef.value -= 8;
        issues.push({
          source: 'gateway',
          severity: 'warning',
          message: `首选通道当前不可用: ${configuredRaw}`,
        });
      }
      result.checks.gateway = checkOut;
      return;
    }

    checkOut.healthy = false;
    scoreRef.value -= 14;

    if (!autoRepair) {
      issues.push({
        source: 'gateway',
        severity: 'high',
        message: `首选通道配置无效: "${configuredRaw}" 未注册或已禁用`,
      });
      result.checks.gateway = checkOut;
      return;
    }

    const fallback = list.find((s) =>
      s && s.enabled && s.available && String(s.type || '').toLowerCase() !== 'clipboard'
    );
    const nextAdapter = fallback ? String(fallback.type || '').trim() : 'auto';
    const envPath = _writeGatewayEnvPatch(
      { GATEWAY_PREFERRED_ADAPTER: nextAdapter },
      ['GATEWAY_PREFERRED_MODEL']
    );
    scoreRef.value += 8;
    checkOut.autoRepaired = true;
    checkOut.repairedTo = nextAdapter;
    checkOut.envPath = envPath;
    checkOut.healthy = true;

    if (Array.isArray(result.repairs)) {
      result.repairs.push({
        source: 'gateway',
        action: 'reset_preferred_adapter',
        from: configuredRaw,
        to: nextAdapter,
        envPath,
        message: `已自动修复首选通道: ${configuredRaw} -> ${nextAdapter}`,
      });
    }

    issues.push({
      source: 'gateway',
      severity: 'warning',
      message: `检测到首选通道配置无效，已自动修复为: ${nextAdapter}`,
    });

    try {
      if (typeof gateway.refreshAdapters === 'function') {
        await gateway.refreshAdapters();
      }
    } catch { /* best effort */ }

    result.checks.gateway = checkOut;
  } catch (err) {
    scoreRef.value -= 6;
    result.checks.gateway = {
      ...checkOut,
      healthy: false,
      error: err?.message || String(err),
    };
    issues.push({
      source: 'gateway',
      severity: 'warning',
      message: `gateway 首选通道自检失败: ${err?.message || err}`,
    });
  }
}

async function runOnce(options = {}) {
  if (_running) {
    return {
      skipped: true,
      reason: 'already_running',
      at: new Date().toISOString(),
      status: status(),
    };
  }

  _running = true;
  const startedAt = Date.now();
  const runSeq = ++_runCount;
  const trigger = options.trigger || 'manual';
  const includeThreatScan = options.forceThreatScan === true
    || _shouldRunPeriodic(runSeq, THREAT_SCAN_EVERY);
  const includeDoctor = options.forcePluginDoctor === true
    || _shouldRunPeriodic(runSeq, PLUGIN_DOCTOR_EVERY);

  const result = {
    id: `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date(startedAt).toISOString(),
    trigger,
    runSeq,
    durationMs: 0,
    score: 100,
    severity: 'healthy',
    checks: {
      resource: null,
      integrity: null,
      threats: { ran: false, clean: true, threatCount: 0, bySeverity: {} },
      services: null,
      plugins: null,
      gateway: null,
    },
    issues: [],
    repairs: [],
  };

  const issues = [];
  const scoreRef = { value: 100 };

  try {
    // 1) System resource pressure
    try {
      const h = resourceGuard.systemHealthCheck();
      const warnings = Array.isArray(h?.warnings) ? h.warnings : [];
      result.checks.resource = {
        healthy: !!h?.healthy,
        memPercent: Number.isFinite(h?.memPercent) ? h.memPercent : null,
        loadPercent: Number.isFinite(h?.loadPercent) ? h.loadPercent : null,
        warningCount: warnings.length,
        warnings: warnings.slice(0, 8),
      };
      if (!h?.healthy) {
        scoreRef.value -= Math.min(35, 12 + warnings.length * 6);
      }
      for (const w of warnings.slice(0, 10)) {
        issues.push({ source: 'resource', severity: 'warning', message: w });
      }
    } catch (err) {
      scoreRef.value -= 20;
      result.checks.resource = {
        healthy: false,
        memPercent: null,
        loadPercent: null,
        warningCount: 0,
        warnings: [],
        error: err?.message || String(err),
      };
      issues.push({
        source: 'resource',
        severity: 'warning',
        message: `resource check failed: ${err?.message || err}`,
      });
    }

    // 2) Process integrity
    try {
      const integrity = securityGuard.checkProcessIntegrity();
      const suspicious = Array.isArray(integrity?.suspicious) ? integrity.suspicious : [];
      result.checks.integrity = {
        clean: !!integrity?.clean,
        childCount: Number.isFinite(integrity?.childCount) ? integrity.childCount : 0,
        suspiciousCount: suspicious.length,
      };
      if (!integrity?.clean) {
        scoreRef.value -= Math.min(40, 20 + suspicious.length * 10);
      }
      for (const s of suspicious.slice(0, 8)) {
        issues.push({
          source: 'integrity',
          severity: 'high',
          message: `suspicious child process pid=${s.pid || '?'} cmd=${String(s.cmd || '').slice(0, 80)}`,
        });
      }
    } catch (err) {
      scoreRef.value -= 18;
      result.checks.integrity = {
        clean: false,
        childCount: 0,
        suspiciousCount: 0,
        error: err?.message || String(err),
      };
      issues.push({
        source: 'integrity',
        severity: 'high',
        message: `integrity check failed: ${err?.message || err}`,
      });
    }

    // 3) Threat scan (periodic, heavier)
    if (includeThreatScan) {
      try {
        const scan = securityGuard.scanForThreats();
        const threats = Array.isArray(scan?.threats) ? scan.threats : [];
        const bySeverity = _summarizeStates(threats, 'severity');
        result.checks.threats = {
          ran: true,
          clean: !!scan?.clean,
          threatCount: threats.length,
          bySeverity,
        };

        if (!scan?.clean) {
          const critical = bySeverity.critical || 0;
          const high = bySeverity.high || 0;
          const warning = bySeverity.warning || 0;
          scoreRef.value -= Math.min(70, critical * 25 + high * 15 + warning * 6);
        }

        for (const t of threats.slice(0, 10)) {
          issues.push({
            source: 'threat',
            severity: t?.severity || 'high',
            message: `${t?.type || 'unknown'}: ${t?.detail || 'threat detected'}`,
          });
        }
      } catch (err) {
        scoreRef.value -= 12;
        result.checks.threats = {
          ran: true,
          clean: false,
          threatCount: 0,
          bySeverity: {},
          error: err?.message || String(err),
        };
        issues.push({
          source: 'threat',
          severity: 'warning',
          message: `threat scan failed: ${err?.message || err}`,
        });
      }
    } else {
      result.checks.threats = {
        ran: false,
        clean: true,
        threatCount: 0,
        bySeverity: {},
      };
    }

    // 4) Service health
    await _checkServices(result, issues, scoreRef);

    // 5) Plugin quality
    await _checkPlugins(result, issues, scoreRef, {
      runDoctor: includeDoctor,
      doctorDeep: options.pluginDoctorDeep === true,
    });

    // 6) Gateway preferred adapter correctness + optional auto-repair
    await _checkGatewayPreferred(result, issues, scoreRef, {
      autoRepairPreferred: options.autoRepairPreferred !== false && SELF_CHECK_AUTO_REPAIR_PREFERRED,
    });
  } finally {
    const durationMs = Date.now() - startedAt;
    result.durationMs = durationMs;
    result.score = Math.max(0, Math.min(100, Math.round(scoreRef.value)));
    result.severity = _classifySeverity(result.score, issues);
    result.issues = issues.slice(0, 30);
    _lastResult = result;
    _pushHistory(result);

    // Persist compact record for long-term trend
    _appendLog({
      timestamp: result.timestamp,
      id: result.id,
      trigger: result.trigger,
      runSeq: result.runSeq,
      durationMs: result.durationMs,
      score: result.score,
      severity: result.severity,
      issueCount: result.issues.length,
      repairCount: Array.isArray(result.repairs) ? result.repairs.length : 0,
      issues: result.issues.slice(0, 12),
      repairs: Array.isArray(result.repairs) ? result.repairs.slice(0, 12) : [],
      checks: {
        resource: result.checks.resource,
        integrity: result.checks.integrity,
        threats: result.checks.threats,
        services: result.checks.services,
        plugins: result.checks.plugins,
        gateway: result.checks.gateway,
      },
    });
    _running = false;
  }

  return result;
}

function start(intervalMs = DEFAULT_INTERVAL_MS, options = {}) {
  const normalized = _normalizeInterval(intervalMs);

  if (_timer) {
    if (_intervalMs === normalized) {
      return { changed: false, ...status() };
    }
    stop();
  }

  _intervalMs = normalized;
  _startedAt = Date.now();

  _timer = setInterval(() => {
    runOnce({ trigger: 'loop' }).catch(() => {});
  }, _intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref();

  if (options.runImmediately !== false) {
    runOnce({
      trigger: 'start',
      forceThreatScan: options.forceThreatScan === true,
      forcePluginDoctor: options.forcePluginDoctor === true,
      pluginDoctorDeep: options.pluginDoctorDeep === true,
    }).catch(() => {});
  }

  return { changed: true, ...status() };
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  return status();
}

function status() {
  const logFile = _readLogFilePath();
  if (!fs.existsSync(_logFile) && fs.existsSync(logFile)) {
    _logFile = logFile;
  }

  let lastResult = _lastResult;
  if (!lastResult) {
    const recent = tail(1)[0];
    if (recent) {
      lastResult = {
        timestamp: recent.timestamp,
        severity: recent.severity,
        score: recent.score,
        durationMs: recent.durationMs,
        issues: Array.isArray(recent.issues) ? recent.issues : [],
        runSeq: recent.runSeq,
        trigger: recent.trigger,
      };
    }
  }

  return {
    running: !!_timer,
    intervalMs: _intervalMs || DEFAULT_INTERVAL_MS,
    runCount: _runCount,
    startedAt: _startedAt ? new Date(_startedAt).toISOString() : null,
    uptimeMs: _startedAt ? Math.max(0, Date.now() - _startedAt) : 0,
    logFile,
    logWriteError: _logWriteError,
    lastResult: lastResult
      ? {
          timestamp: lastResult.timestamp,
          severity: lastResult.severity,
          score: lastResult.score,
          durationMs: lastResult.durationMs,
          issueCount: lastResult.issues?.length || 0,
          repairCount: Array.isArray(lastResult.repairs) ? lastResult.repairs.length : 0,
          runSeq: lastResult.runSeq,
          trigger: lastResult.trigger,
        }
      : null,
  };
}

function history(limit = 20) {
  const n = Math.max(1, _toInt(limit, 20));
  return _history.slice(-n).reverse();
}

function tail(limit = 20) {
  const n = Math.max(1, _toInt(limit, 20));
  const logFile = _readLogFilePath();
  if (!fs.existsSync(logFile)) return [];

  try {
    const lines = fs.readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter(Boolean);

    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch { /* skip malformed line */ }
    }
    return out;
  } catch {
    return [];
  }
}

function autoStartFromEnv() {
  const enabled = _envBool(process.env.KHY_SELF_CHECK_ENABLED, true);
  if (!enabled) return status();
  return start(_normalizeInterval(process.env.KHY_SELF_CHECK_INTERVAL_MS), {
    runImmediately: true,
  });
}

async function healthCheck() {
  if (!_lastResult) return { healthy: true, note: 'no self-check run yet' };
  return {
    healthy: _lastResult.severity !== 'critical',
    score: _lastResult.score,
    severity: _lastResult.severity,
    timestamp: _lastResult.timestamp,
  };
}

module.exports = {
  runOnce,
  start,
  stop,
  status,
  history,
  tail,
  autoStartFromEnv,
  healthCheck,
  constants: {
    DEFAULT_INTERVAL_MS,
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
    LOG_FILE: DEFAULT_LOG_FILE,
    THREAT_SCAN_EVERY,
    PLUGIN_DOCTOR_EVERY,
  },
};
