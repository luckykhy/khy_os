'use strict';

/**
 * localBrainEnvOptimize.js — Tier-1 "打造最佳环境" natural-language handler.
 *
 * Turns the free-text request "打造当前系统最佳环境" (and close variants) into a
 * single deterministic action: run the base self-check + self-heal pipeline
 * (baseSelfCheckService.runOnce) with auto-repair enabled, run a SAFE
 * create-missing-only self-repair sweep (envRepair.js — the "缺失损坏 ... 修复"
 * layer), fold in a read-only junk-pollution scan and an extensible health-probe
 * sweep (envProbes.js — the "situations you may not have recognized" layer), then
 * format the combined report for the input box. This makes the whole doctor →
 * self-check → auto-heal → repair-missing flow, plus disk/memory/load/temp
 * hazards and reclaimable junk, reachable by typing one sentence instead of
 * memorizing `khy monitor selfcheck run`.
 *
 * Extracted from localBrainService.js (mirrors localBrainTextOps.js /
 * localBrainCalc.js lineage) to keep that god file under the 2500-LOC budget.
 * This module is intentionally NOT a pure leaf: its executor calls the
 * self-check service, which reads live system/service/plugin state (IO by
 * design, exactly like the inline sysinfo/weather handlers). It stays fail-soft
 * — any error degrades to a plain "could not run" result, never throws.
 *
 * localBrainService re-imports these under `_`-prefixed names so the Tier-1
 * handler registry wiring matches the existing convention.
 *
 * Gate: KHY_ENV_OPTIMIZE (default on). When off, isEnvOptimizeIntent returns
 * false → byte-identical fallback (request flows to the model as before).
 */

let _fmt = null;
try { _fmt = require('./localFormat'); } catch { /* degrade to plain text */ }

function _gateOn() {
  return String(process.env.KHY_ENV_OPTIMIZE || 'true').toLowerCase() !== 'false';
}

// Sub-gate for the read-only junk-pollution scan folded into env_optimize. On by
// default; set KHY_ENV_OPTIMIZE_JUNK_SCAN=false to skip it (byte-identical to the
// self-check-only behavior). Kept separate from the master gate so the junk probe
// can be disabled without turning off the whole "build best environment" intent.
function _junkScanOn() {
  return String(process.env.KHY_ENV_OPTIMIZE_JUNK_SCAN || 'true').toLowerCase() !== 'false';
}

/**
 * Read-only junk-pollution probe. Runs diskCleanup.plan() — which NEVER deletes
 * (plan is pure-read; only executor.execute under an explicit `apply` mutates,
 * and that path is guarded by DiskCleanupTool's isDestructive → riskGate human
 * gate). We deliberately do NOT auto-delete here: "打造最佳环境" surfaces the
 * pollution and the exact safe command, but destructive removal always stays
 * behind the human confirmation gate. Fail-soft: any error returns null and the
 * caller simply omits the junk section (byte-identical to the pre-junk report).
 *
 * @returns {{selectedCount:number, selectedHuman:string, selectedBytes:number,
 *   reviewCount:number, reviewHuman:string, byCategory:object, driveRoots:string[]}|null}
 */
function _scanJunk() {
  if (!_junkScanOn()) return null;
  let dc;
  try { dc = require('./diskCleanup'); }
  catch { return null; }
  try {
    // includeReview:false → recycle-bin / update caches (recoverable data) are
    // reported as "review" but never selected for removal. keepRecentHours left
    // at engine default so freshly-written temp files are not counted as junk.
    const plan = dc.plan({ includeReview: false });
    const t = (plan && plan.totals) || {};
    return {
      selectedCount: t.selectedCount || 0,
      selectedBytes: t.selectedBytes || 0,
      selectedHuman: t.selectedHuman || '0 B',
      reviewCount: t.reviewCount || 0,
      reviewHuman: t.reviewHuman || '0 B',
      byCategory: plan.byCategory || {},
      driveRoots: Array.isArray(plan.driveRoots) ? plan.driveRoots : [],
    };
  } catch { return null; }
}

/**
 * Run the extensible read-only health-probe sweep (envProbes.js). This is the
 * open-ended "situations you may not have recognized" layer: new environment
 * dimensions are added by registering a probe there, not by editing this handler.
 * Fail-soft — returns [] when the module is unavailable so the report degrades
 * cleanly to the self-check + junk sections only.
 *
 * @returns {Array<{key,label,severity,detail,hint}>}
 */
function _runProbes() {
  let mod;
  try { mod = require('./envProbes'); }
  catch { return []; }
  try {
    const out = mod.runProbes();
    return Array.isArray(out) ? out : [];
  } catch { return []; }
}

/**
 * Run the SAFE self-repair sweep (envRepair.js). This is the "缺失损坏 ... 修复"
 * layer: the mutating counterpart to the read-only probe sweep. It only creates
 * missing scaffolding (e.g. a missing ~/.khy config home) — never deletes or
 * overwrites — and is idempotent, so re-running "打造最佳环境" never churns the
 * filesystem. Destructive cleanup stays behind riskGate. Fail-soft: returns []
 * when the module is unavailable so the report degrades to detection-only.
 *
 * @returns {Array<{key,label,ok,changed,detail}>}
 */
function _runRepairs() {
  let mod;
  try { mod = require('./envRepair'); }
  catch { return []; }
  try {
    const out = mod.runRepairs();
    return Array.isArray(out) ? out : [];
  } catch { return []; }
}

/**
 * Resolve the current platform context (linux/windows/macos/android/ios/harmonyos)
 * for the report header. This is the "注意 …系统的区分" surface: the probe and
 * repair sweeps already scope themselves per-OS internally; here we simply name
 * the detected OS so the user sees which platform's rules were applied. Fail-soft:
 * returns null when envPlatform is unavailable (report omits the platform line).
 *
 * @returns {{id,label,sandboxed,hasLoadAvg,source}|null}
 */
function _detectPlatform() {
  try {
    return require('./envPlatform').detectPlatform();
  } catch { return null; }
}

// Intent match: the sentence must name BOTH an "environment/system" target AND a
// "build/optimize/tune to best" action, so ordinary chit-chat about the system
// (e.g. "看看系统信息") never trips this heavier handler. Anchored on the user's
// own phrasing "打造当前系统最佳环境" plus natural paraphrases in zh/en.
const _TARGET_RE = /(系统|环境|environment|system|底座|运行环境|操作系统|\bos\b)/i;
const _ACTION_RE = /(打造|优化|调优|自检|自愈|修复|体检|调到最佳|最佳(化|状态|环境)?|最棒|最好|tune|optimi[sz]e|self[-\s]?check|self[-\s]?heal|diagnose|make.*best)/i;

function isEnvOptimizeIntent(text) {
  if (!_gateOn()) return false;
  const t = String(text || '');
  if (t.length > 80) return false; // a directive, not a long paragraph
  return _TARGET_RE.test(t) && _ACTION_RE.test(t);
}

function detectEnvOptimize(text) {
  if (!isEnvOptimizeIntent(text)) return null;
  return { type: 'env_optimize', category: '环境优化', label: '打造最佳环境' };
}

/**
 * Execute the self-check + self-heal pipeline. Async — the Tier-1 dispatcher
 * wraps executors in Promise.resolve(), so returning a Promise is supported.
 */
async function executeEnvOptimize() {
  let selfCheck;
  try {
    selfCheck = require('./baseSelfCheckService');
  } catch (err) {
    return { type: 'env_optimize', success: false, error: `self-check unavailable: ${err && err.message}` };
  }

  try {
    const report = await selfCheck.runOnce({
      trigger: 'env_optimize',
      forceThreatScan: true,
      forcePluginDoctor: true,
      // auto-repair is on by default in runOnce; keep it explicit here so the
      // "build best environment" intent always heals what it safely can.
      autoRepairPreferred: true,
    });

    if (report && report.skipped) {
      return { type: 'env_optimize', success: false, skipped: true, reason: report.reason || 'already_running' };
    }

    const issues = Array.isArray(report.issues) ? report.issues : [];
    const repairs = Array.isArray(report.repairs) ? report.repairs : [];
    // Fold in a read-only junk-pollution probe. Non-destructive; null when the
    // sub-gate is off or the engine is unavailable (report then omits the block).
    const junk = _scanJunk();
    // Run the SAFE self-repair sweep FIRST (create-missing-only, idempotent) so
    // the probe sweep below observes the just-repaired state — e.g. a freshly
    // created ~/.khy no longer trips the config-home probe. This is the
    // "缺失损坏 ... 修复" layer; destructive removal stays behind riskGate.
    const envRepairs = _runRepairs();
    // Fold in the extensible read-only health-probe sweep — this is the "还有我没
    // 认识到的情况" layer: disk/memory/load/temp and whatever future probes are
    // registered in envProbes.js. Fail-soft → [] when the sub-gate is off or the
    // module is unavailable.
    const probes = _runProbes();
    return {
      type: 'env_optimize',
      success: true,
      score: report.score,
      severity: report.severity,
      durationMs: report.durationMs,
      issues,
      repairs,
      checks: report.checks || {},
      junk,
      envRepairs,
      probes,
      platform: _detectPlatform(),
    };
  } catch (err) {
    return { type: 'env_optimize', success: false, error: (err && err.message) || String(err) };
  }
}

function _severityZh(sev) {
  if (sev === 'critical') return '严重';
  if (sev === 'degraded') return '降级';
  return '健康';
}

// Human bullet lines for the junk-pollution block. Returns [] when there is
// nothing reclaimable (so the caller omits the whole section). The last line is
// always the exact, non-destructive command the user can run to actually clean —
// deletion stays behind DiskCleanupTool's human confirmation gate, never here.
function _humanBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function _junkLines(junk) {
  if (!junk || (junk.selectedCount || 0) === 0) return [];
  const lines = [];
  const drives = junk.driveRoots.length ? junk.driveRoots.join(' ') : '默认盘';
  lines.push(`可回收 ${junk.selectedHuman}（${junk.selectedCount} 项 · ${drives}）`);
  const cats = Object.entries(junk.byCategory || {}).slice(0, 5);
  for (const [cat, v] of cats) {
    lines.push(`· ${cat}: ${v.count} 项 ${_humanBytes(v.bytes)}`);
  }
  if (junk.reviewCount) {
    lines.push(`另有 ${junk.reviewHuman}（${junk.reviewCount} 项）涉可恢复数据，需确认`);
  }
  lines.push('清理请运行:  磁盘清理  (删除前经人工确认，绝不误删用户数据)');
  return lines;
}

// Severity glyph for a probe finding, so critical items stand out in the bullet
// list without needing colour. Keeps the plain-text and rich branches identical.
function _probeGlyph(sev) {
  if (sev === 'critical') return '✗';
  if (sev === 'high') return '▲';
  if (sev === 'warning') return '⚠';
  return '·';
}

// Human bullet lines for the extensible health-probe findings. Returns [] when
// nothing was flagged (healthy machine), so the caller omits the whole section.
function _probeLines(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return [];
  return probes.slice(0, 12).map((p) => {
    const glyph = _probeGlyph(p.severity);
    const hint = p.hint ? ` — ${p.hint}` : '';
    return `${glyph} [${p.label}] ${p.detail}${hint}`;
  });
}

// Human bullet lines for the SAFE self-repair sweep. Returns [] when nothing was
// repaired (healthy machine — the common quiet case), so the caller omits the
// section. A ✓ marks something actually created/fixed this run; a ! marks a
// dimension that needs the human (e.g. a corrupt path we refuse to delete).
function _envRepairLines(envRepairs) {
  if (!Array.isArray(envRepairs) || envRepairs.length === 0) return [];
  return envRepairs.slice(0, 12).map((r) => {
    const glyph = r.changed ? '✓' : (r.ok ? '·' : '!');
    return `${glyph} [${r.label}] ${r.detail}`;
  });
}

function formatEnvOptimize(result) {
  if (!result || result.success !== true) {
    if (result && result.skipped) return '已有自检任务在运行，请稍候重试。';
    return `打造最佳环境失败：${(result && result.error) || '未知错误'}`;
  }

  const issues = result.issues || [];
  const repairs = result.repairs || [];
  const junk = result.junk || null;
  const junkLines = _junkLines(junk);
  const junkReclaim = junkLines.length ? (junk.selectedHuman || '') : '';
  const probeLines = _probeLines(result.probes);
  const probeCount = probeLines.length;
  const envRepairLines = _envRepairLines(result.envRepairs);
  // Platform identity for the report header. May be absent on older results.
  const platform = result.platform || null;
  const platformLabel = platform && platform.label ? platform.label : '';
  // Count of dimensions we actually fixed this run (created missing scaffolding).
  const envFixedCount = Array.isArray(result.envRepairs)
    ? result.envRepairs.filter((r) => r && r.changed).length
    : 0;
  // Total issue surface = self-check issues + probe findings. Probes are the
  // "situations you may not have recognized" — they count toward the verdict so a
  // healthy self-check with e.g. a full disk is not falsely reported as perfect.
  const flagged = issues.length + probeCount;
  let verdict;
  if (flagged === 0 && !junkReclaim && envFixedCount === 0) {
    verdict = '当前环境已是最佳状态，无需修复。';
  } else if (flagged === 0 && !junkReclaim) {
    // Nothing left to worry about, but we DID repair something this run.
    verdict = `已修复 ${envFixedCount} 项环境缺失，当前环境已恢复最佳状态。`;
  } else if (flagged === 0) {
    verdict = envFixedCount
      ? `已修复 ${envFixedCount} 项环境缺失，环境健康，另有 ${junkReclaim} 垃圾可回收。`
      : `环境健康，另有 ${junkReclaim} 垃圾可回收。`;
  } else {
    const parts = [];
    if (envFixedCount) parts.push(`已修复 ${envFixedCount} 项环境缺失`);
    if (issues.length) parts.push(`${issues.length} 项自检问题（已自动修复 ${repairs.length} 项）`);
    if (probeCount) parts.push(`${probeCount} 项环境隐患`);
    if (junkReclaim) parts.push(`${junkReclaim} 垃圾可回收`);
    verdict = `发现 ${parts.join('，')}。`;
  }

  if (_fmt && _fmt.isEnabled()) {
    const sections = [];
    const kv = [
      ['评分', `${result.score}/100`],
      ['级别', _severityZh(result.severity)],
      ['耗时', `${result.durationMs}ms`],
    ];
    if (platformLabel) kv.push(['平台', platformLabel]);
    kv.push(['结论', verdict]);
    sections.push({ lines: _fmt.keyValues(kv) });
    if (repairs.length) {
      sections.push({
        heading: '已自动修复',
        lines: _fmt.bullets(repairs.slice(0, 8).map(r => {
          const act = r.action ? `[${r.action}] ` : '';
          const from = r.from ? `${r.from} ` : '';
          const to = r.to ? `→ ${r.to}` : '';
          return `${act}${from}${to}`.trim() || '(repair)';
        })),
      });
    }
    if (envRepairLines.length) {
      sections.push({
        heading: '环境修复（缺失损坏）',
        lines: _fmt.bullets(envRepairLines),
      });
    }
    if (issues.length) {
      sections.push({
        heading: '仍需关注',
        lines: _fmt.bullets(issues.slice(0, 8).map(i => `[${i.source || '系统'}] ${i.message}`)),
      });
    }
    if (probeLines.length) {
      sections.push({
        heading: '环境隐患（自动排查）',
        lines: _fmt.bullets(probeLines),
      });
    }
    if (junkLines.length) {
      sections.push({
        heading: '垃圾文件污染',
        lines: _fmt.bullets(junkLines),
      });
    }
    return _fmt.compose({
      title: '打造最佳环境',
      sections,
      meta: ['底座自检 + 自愈', '缺失修复', '隐患排查', '垃圾扫描(只读)', '一句话触发'],
    });
  }

  const lines = [
    '打造最佳环境',
    `评分: ${result.score}/100  级别: ${_severityZh(result.severity)}  耗时: ${result.durationMs}ms${platformLabel ? `  平台: ${platformLabel}` : ''}`,
    verdict,
  ];
  if (repairs.length) {
    lines.push('已自动修复:');
    for (const r of repairs.slice(0, 8)) {
      const act = r.action ? `[${r.action}] ` : '';
      const from = r.from ? `${r.from} ` : '';
      const to = r.to ? `→ ${r.to}` : '';
      lines.push(`  - ${(act + from + to).trim() || '(repair)'}`);
    }
  }
  if (envRepairLines.length) {
    lines.push('环境修复（缺失损坏）:');
    for (const el of envRepairLines) {
      lines.push(`  - ${el}`);
    }
  }
  if (issues.length) {
    lines.push('仍需关注:');
    for (const i of issues.slice(0, 8)) {
      lines.push(`  - [${i.source || '系统'}] ${i.message}`);
    }
  }
  if (probeLines.length) {
    lines.push('环境隐患（自动排查）:');
    for (const pl of probeLines) {
      lines.push(`  - ${pl}`);
    }
  }
  if (junkLines.length) {
    lines.push('垃圾文件污染:');
    for (const jl of junkLines) {
      lines.push(`  - ${jl}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  isEnvOptimizeIntent,
  detectEnvOptimize,
  executeEnvOptimize,
  formatEnvOptimize,
  // exported for tests
  _scanJunk,
  _junkLines,
  _runProbes,
  _probeLines,
  _runRepairs,
  _envRepairLines,
  _detectPlatform,
};
