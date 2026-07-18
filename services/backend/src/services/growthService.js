/**
 * Growth Service — Portable growth/learning system.
 *
 * Manages ~/.khyquant/growth/ directory containing all growth data.
 * The entire directory can be copied to another machine to transfer learning.
 *
 * Growth components:
 * - knowledge.json: user's learning progression
 * - agent_specialization.json: agent accuracy history
 * - agent_memory.json: shared agent context
 * - strategy_performance.json: strategy outcomes per symbol
 * - user_preferences.json: usage patterns
 * - analysis_patterns.json: successful analysis records
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');

const pipe = promisify(pipeline);

const GROWTH_DIR = path.join(os.homedir(), '.khyquant', 'growth');
const SNAPSHOTS_DIR = path.join(GROWTH_DIR, 'snapshots');

// ─── Default schemas ────────────────────────────────────────────────────────

const DEFAULT_MANIFEST = {
  version: 1,
  format: 'khy-growth-v1',
  createdAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
  totalInteractions: 0,
  deviceId: `${os.platform()}-${os.hostname()}-${process.pid}`,
  checksum: null,
};

const DEFAULT_KNOWLEDGE = {
  version: 1,
  level: 'beginner',
  xp: 0,
  completedTopics: [],
  lastTipTimestamp: null,
  tipDeliveryCount: 0,
  topicProgress: {
    technical_indicators: { learned: 0, total: 20 },
    risk_management: { learned: 0, total: 15 },
    position_sizing: { learned: 0, total: 10 },
    market_microstructure: { learned: 0, total: 12 },
    quant_fundamentals: { learned: 0, total: 15 },
  },
  interactionsSinceLastTip: 0,
};

const DEFAULT_AGENT_SPECIALIZATION = {
  version: 1,
  agents: {
    technical: { accuracy: 0.5, totalPredictions: 0, correctPredictions: 0, strongDomains: [], weakDomains: [] },
    fundamental: { accuracy: 0.5, totalPredictions: 0, correctPredictions: 0, strongDomains: [], weakDomains: [] },
    sentiment: { accuracy: 0.5, totalPredictions: 0, correctPredictions: 0, strongDomains: [], weakDomains: [] },
    news: { accuracy: 0.5, totalPredictions: 0, correctPredictions: 0, strongDomains: [], weakDomains: [] },
    bullResearcher: { accuracy: 0.5, totalPredictions: 0, correctPredictions: 0, strongDomains: [], weakDomains: [] },
    bearResearcher: { accuracy: 0.5, totalPredictions: 0, correctPredictions: 0, strongDomains: [], weakDomains: [] },
    trader: { accuracy: 0.5, totalPredictions: 0, correctPredictions: 0, strongDomains: [], weakDomains: [] },
    riskManager: { accuracy: 0.5, totalPredictions: 0, correctPredictions: 0, strongDomains: [], weakDomains: [] },
  },
};

const DEFAULT_AGENT_MEMORY = {
  version: 1,
  sharedContext: {
    currentMarketRegime: 'unknown',
    recentSignals: [],
    crossAgentInsights: [],
    lastUpdated: null,
  },
  agentStates: {},
};

const DEFAULT_STRATEGY_PERFORMANCE = {
  version: 1,
  records: [],
  insights: {
    bestStrategyByCondition: {},
    symbolPreferences: {},
  },
};

const DEFAULT_USER_PREFERENCES = {
  version: 1,
  frequentSymbols: [],
  frequentCommands: [],
  preferredStrategies: [],
  analysisTopics: [],
  sessionCount: 0,
  totalInteractions: 0,
};

const DEFAULT_ANALYSIS_PATTERNS = {
  version: 1,
  successfulPatterns: [],
  failedPatterns: [],
};

const FILE_DEFAULTS = {
  'manifest.json': DEFAULT_MANIFEST,
  'knowledge.json': DEFAULT_KNOWLEDGE,
  'agent_specialization.json': DEFAULT_AGENT_SPECIALIZATION,
  'agent_memory.json': DEFAULT_AGENT_MEMORY,
  'strategy_performance.json': DEFAULT_STRATEGY_PERFORMANCE,
  'user_preferences.json': DEFAULT_USER_PREFERENCES,
  'analysis_patterns.json': DEFAULT_ANALYSIS_PATTERNS,
  'habits.json': { version: 1, lastUpdated: null, timeProfile: { hourlyActivity: new Array(24).fill(0), weekdayActivity: new Array(7).fill(0), peakHours: [], averageSessionMinutes: 0, totalSessions: 0 }, workflows: {}, modelPreferences: {}, responsePreferences: { preferredLength: 'medium', detailLevel: 'balanced', codeInResponse: true, planBeforeAction: null, showCost: true, showTips: true }, topicFocus: {}, errorPatterns: { commonErrors: {}, recoveryActions: {}, selfResolvingRate: 0 }, collaboration: { modelsUsed: {}, idesUsed: {}, switchPatterns: [], bestCombinations: [] } },
  'skills_learned.json': [],
  'user_knowledge_base.json': [],
};

// ─── Core functions ─────────────────────────────────────────────────────────

/**
 * Initialize growth directory with default files if missing.
 */
function initGrowthDir() {
  try {
    fs.mkdirSync(GROWTH_DIR, { recursive: true });
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

    for (const [filename, defaultData] of Object.entries(FILE_DEFAULTS)) {
      const filePath = path.join(GROWTH_DIR, filename);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
      }
    }
  } catch (err) {
    // Non-critical — best effort
  }
}

/**
 * Load a growth component file.
 */
function loadComponent(filename) {
  try {
    const filePath = path.join(GROWTH_DIR, filename);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return FILE_DEFAULTS[filename] || {};
}

/**
 * Save a growth component file and update manifest.
 */
function saveComponent(filename, data) {
  try {
    initGrowthDir();
    const filePath = path.join(GROWTH_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    // Update manifest timestamp
    const manifest = loadComponent('manifest.json');
    manifest.lastModified = new Date().toISOString();
    const manifestPath = path.join(GROWTH_DIR, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch { /* best effort */ }
}

/**
 * Increment interaction counter.
 */
function recordInteraction() {
  try {
    const manifest = loadComponent('manifest.json');
    manifest.totalInteractions = (manifest.totalInteractions || 0) + 1;
    saveComponent('manifest.json', manifest);

    const prefs = loadComponent('user_preferences.json');
    prefs.totalInteractions = (prefs.totalInteractions || 0) + 1;
    saveComponent('user_preferences.json', prefs);
  } catch { /* best effort */ }
}

/**
 * Record strategy backtest performance.
 */
function recordStrategyPerformance(strategyId, symbol, metrics) {
  try {
    const perf = loadComponent('strategy_performance.json');
    perf.records.push({
      strategyId,
      symbol,
      returns: metrics.returns || 0,
      sharpe: metrics.sharpe || 0,
      maxDrawdown: metrics.maxDrawdown || 0,
      winRate: metrics.winRate || 0,
      marketCondition: metrics.marketCondition || 'unknown',
      timestamp: new Date().toISOString(),
    });

    // Keep last 500 records
    if (perf.records.length > 500) {
      perf.records = perf.records.slice(-500);
    }

    // Update insights
    _updateStrategyInsights(perf);
    saveComponent('strategy_performance.json', perf);
  } catch { /* best effort */ }
}

function _updateStrategyInsights(perf) {
  const byCondition = {};
  for (const rec of perf.records) {
    const key = rec.marketCondition;
    if (!byCondition[key]) byCondition[key] = {};
    if (!byCondition[key][rec.strategyId]) byCondition[key][rec.strategyId] = [];
    byCondition[key][rec.strategyId].push(rec.returns);
  }

  perf.insights.bestStrategyByCondition = {};
  for (const [condition, strategies] of Object.entries(byCondition)) {
    let best = null;
    let bestAvg = -Infinity;
    for (const [sid, returns] of Object.entries(strategies)) {
      const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
      if (avg > bestAvg) { bestAvg = avg; best = sid; }
    }
    if (best) perf.insights.bestStrategyByCondition[condition] = best;
  }
}

/**
 * Record user symbol/command preferences.
 */
function recordPreference(type, value) {
  try {
    const prefs = loadComponent('user_preferences.json');
    const key = type === 'symbol' ? 'frequentSymbols' :
                type === 'command' ? 'frequentCommands' :
                type === 'strategy' ? 'preferredStrategies' : 'analysisTopics';

    if (!prefs[key]) prefs[key] = [];
    // Move to front (most recent) and deduplicate
    prefs[key] = [value, ...prefs[key].filter(v => v !== value)].slice(0, 50);
    saveComponent('user_preferences.json', prefs);
  } catch { /* best effort */ }
}

/**
 * Record a successful analysis pattern.
 */
function recordAnalysisPattern(pattern) {
  try {
    const patterns = loadComponent('analysis_patterns.json');
    patterns.successfulPatterns.push({
      ...pattern,
      timestamp: new Date().toISOString(),
    });
    // Keep last 200
    if (patterns.successfulPatterns.length > 200) {
      patterns.successfulPatterns = patterns.successfulPatterns.slice(-200);
    }
    saveComponent('analysis_patterns.json', patterns);
  } catch { /* best effort */ }
}

// ─── Export / Import ────────────────────────────────────────────────────────

/**
 * Export growth directory as a tar.gz archive.
 */
function exportGrowth(outputPath) {
  initGrowthDir();

  if (!outputPath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    outputPath = path.join(os.homedir(), `khy-growth-${timestamp}.tar.gz`);
  }

  // Simple manual archive using Node.js builtins (JSON bundle + gzip)
  const archiveData = {};
  const files = Object.keys(FILE_DEFAULTS);

  for (const filename of files) {
    const filePath = path.join(GROWTH_DIR, filename);
    if (fs.existsSync(filePath)) {
      archiveData[filename] = fs.readFileSync(filePath, 'utf-8');
    }
  }

  // Create a JSON bundle then gzip it
  const bundle = JSON.stringify({
    format: 'khy-growth-archive-v1',
    exportedAt: new Date().toISOString(),
    deviceId: `${os.platform()}-${os.hostname()}`,
    files: archiveData,
  });

  const compressed = zlib.gzipSync(Buffer.from(bundle, 'utf-8'));
  fs.writeFileSync(outputPath, compressed);

  return outputPath;
}

/**
 * Import growth data from archive, intelligently merging.
 */
function importGrowth(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`文件不存在: ${archivePath}`);
  }

  const compressed = fs.readFileSync(archivePath);
  const raw = zlib.gunzipSync(compressed).toString('utf-8');
  const bundle = JSON.parse(raw);

  if (bundle.format !== 'khy-growth-archive-v1') {
    throw new Error('不支持的归档格式');
  }

  initGrowthDir();

  // Merge each component
  for (const [filename, incomingRaw] of Object.entries(bundle.files)) {
    const incoming = JSON.parse(incomingRaw);
    const current = loadComponent(filename);
    const merged = _mergeComponent(filename, current, incoming);
    saveComponent(filename, merged);
  }

  return { importedFrom: bundle.deviceId, exportedAt: bundle.exportedAt, filesImported: Object.keys(bundle.files).length };
}

/**
 * Intelligent merge strategies per component.
 */
function _mergeComponent(filename, current, incoming) {
  switch (filename) {
    case 'manifest.json':
      return {
        ...current,
        totalInteractions: Math.max(current.totalInteractions || 0, incoming.totalInteractions || 0),
        lastModified: new Date().toISOString(),
      };

    case 'knowledge.json':
      return {
        ...current,
        xp: Math.max(current.xp || 0, incoming.xp || 0),
        level: _higherLevel(current.level, incoming.level),
        completedTopics: [...new Set([...(current.completedTopics || []), ...(incoming.completedTopics || [])])],
        topicProgress: _mergeTopicProgress(current.topicProgress, incoming.topicProgress),
      };

    case 'agent_specialization.json': {
      const merged = { version: 1, agents: {} };
      const allAgents = new Set([...Object.keys(current.agents || {}), ...Object.keys(incoming.agents || {})]);
      for (const agentId of allAgents) {
        const c = (current.agents || {})[agentId] || {};
        const i = (incoming.agents || {})[agentId] || {};
        const totalPreds = (c.totalPredictions || 0) + (i.totalPredictions || 0);
        const correctPreds = (c.correctPredictions || 0) + (i.correctPredictions || 0);
        merged.agents[agentId] = {
          accuracy: totalPreds > 0 ? correctPreds / totalPreds : 0.5,
          totalPredictions: totalPreds,
          correctPredictions: correctPreds,
          strongDomains: [...new Set([...(c.strongDomains || []), ...(i.strongDomains || [])])],
          weakDomains: [...new Set([...(c.weakDomains || []), ...(i.weakDomains || [])])],
        };
      }
      return merged;
    }

    case 'strategy_performance.json': {
      const allRecords = [...(current.records || []), ...(incoming.records || [])];
      // Deduplicate by timestamp+symbol+strategy
      const seen = new Set();
      const unique = allRecords.filter(r => {
        const key = `${r.timestamp}-${r.symbol}-${r.strategyId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const merged = { version: 1, records: unique.slice(-500), insights: {} };
      _updateStrategyInsights(merged);
      return merged;
    }

    case 'user_preferences.json':
      return {
        version: 1,
        frequentSymbols: [...new Set([...(current.frequentSymbols || []), ...(incoming.frequentSymbols || [])])].slice(0, 50),
        frequentCommands: [...new Set([...(current.frequentCommands || []), ...(incoming.frequentCommands || [])])].slice(0, 50),
        preferredStrategies: [...new Set([...(current.preferredStrategies || []), ...(incoming.preferredStrategies || [])])].slice(0, 20),
        analysisTopics: [...new Set([...(current.analysisTopics || []), ...(incoming.analysisTopics || [])])].slice(0, 50),
        sessionCount: Math.max(current.sessionCount || 0, incoming.sessionCount || 0),
        totalInteractions: Math.max(current.totalInteractions || 0, incoming.totalInteractions || 0),
      };

    case 'analysis_patterns.json':
      return {
        version: 1,
        successfulPatterns: [...(current.successfulPatterns || []), ...(incoming.successfulPatterns || [])].slice(-200),
        failedPatterns: [...(current.failedPatterns || []), ...(incoming.failedPatterns || [])].slice(-200),
      };

    case 'agent_memory.json':
      // Keep current (most recent local state wins)
      return current;

    default:
      return { ...current, ...incoming };
  }
}

function _higherLevel(a, b) {
  const order = { beginner: 0, intermediate: 1, advanced: 2 };
  return (order[b] || 0) > (order[a] || 0) ? b : a;
}

function _mergeTopicProgress(current, incoming) {
  if (!current && !incoming) return {};
  if (!current) return incoming;
  if (!incoming) return current;
  const merged = { ...current };
  for (const [topic, data] of Object.entries(incoming)) {
    if (!merged[topic]) {
      merged[topic] = data;
    } else {
      merged[topic] = {
        learned: Math.max(merged[topic].learned || 0, data.learned || 0),
        total: Math.max(merged[topic].total || 0, data.total || 0),
      };
    }
  }
  return merged;
}

// ─── Snapshots ──────────────────────────────────────────────────────────────

/**
 * Create a versioned snapshot.
 */
function createSnapshot() {
  initGrowthDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapshotName = `${timestamp}.gz`;
  const outputPath = path.join(SNAPSHOTS_DIR, snapshotName);

  // Reuse export logic to snapshot dir
  const files = {};
  for (const filename of Object.keys(FILE_DEFAULTS)) {
    const filePath = path.join(GROWTH_DIR, filename);
    if (fs.existsSync(filePath)) {
      files[filename] = fs.readFileSync(filePath, 'utf-8');
    }
  }

  const bundle = JSON.stringify({ format: 'khy-growth-archive-v1', exportedAt: new Date().toISOString(), files });
  const compressed = zlib.gzipSync(Buffer.from(bundle, 'utf-8'));
  fs.writeFileSync(outputPath, compressed);

  return { snapshotId: snapshotName, path: outputPath };
}

/**
 * List available snapshots.
 */
function listSnapshots() {
  try {
    const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.gz'));
    return files.map(f => ({
      id: f,
      date: f.replace('.gz', '').replace(/T/g, ' ').replace(/-/g, (m, offset) => offset > 9 ? ':' : '-'),
      size: fs.statSync(path.join(SNAPSHOTS_DIR, f)).size,
    }));
  } catch { return []; }
}

/**
 * Restore from a snapshot.
 */
function restoreSnapshot(snapshotId) {
  const snapshotPath = path.join(SNAPSHOTS_DIR, snapshotId);
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`快照不存在: ${snapshotId}`);
  }

  const compressed = fs.readFileSync(snapshotPath);
  const raw = zlib.gunzipSync(compressed).toString('utf-8');
  const bundle = JSON.parse(raw);

  for (const [filename, content] of Object.entries(bundle.files)) {
    const filePath = path.join(GROWTH_DIR, filename);
    fs.writeFileSync(filePath, content);
  }

  return { restored: snapshotId, files: Object.keys(bundle.files).length };
}

// ─── Summary ────────────────────────────────────────────────────────────────

/**
 * Get growth summary for display.
 */
function getGrowthSummary() {
  const knowledge = loadComponent('knowledge.json');
  const agents = loadComponent('agent_specialization.json');
  const prefs = loadComponent('user_preferences.json');
  const perf = loadComponent('strategy_performance.json');
  const manifest = loadComponent('manifest.json');

  // Calculate overall agent accuracy
  const agentList = Object.entries(agents.agents || {});
  const avgAccuracy = agentList.length > 0
    ? agentList.reduce((sum, [, a]) => sum + (a.accuracy || 0.5), 0) / agentList.length
    : 0.5;

  return {
    level: knowledge.level || 'beginner',
    xp: knowledge.xp || 0,
    xpToNextLevel: _xpToNextLevel(knowledge.level, knowledge.xp),
    completedTopics: (knowledge.completedTopics || []).length,
    totalInteractions: manifest.totalInteractions || 0,
    avgAgentAccuracy: Math.round(avgAccuracy * 100),
    strategyRecords: (perf.records || []).length,
    topSymbols: (prefs.frequentSymbols || []).slice(0, 5),
    snapshots: listSnapshots().length,
    lastModified: manifest.lastModified,
  };
}

function _xpToNextLevel(level, xp) {
  if (level === 'beginner') return Math.max(0, 50 - (xp || 0));
  if (level === 'intermediate') return Math.max(0, 200 - (xp || 0));
  return 0; // already advanced
}

/**
 * Validate integrity of growth files.
 */
function validateIntegrity() {
  const issues = [];
  for (const filename of Object.keys(FILE_DEFAULTS)) {
    const filePath = path.join(GROWTH_DIR, filename);
    if (!fs.existsSync(filePath)) {
      issues.push({ file: filename, issue: 'missing' });
      continue;
    }
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      issues.push({ file: filename, issue: 'corrupted' });
    }
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Reset all growth data (destructive).
 */
function resetGrowth() {
  for (const [filename, defaultData] of Object.entries(FILE_DEFAULTS)) {
    const filePath = path.join(GROWTH_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
  }
}

// Initialize on first require
initGrowthDir();

module.exports = {
  initGrowthDir,
  loadComponent,
  saveComponent,
  recordInteraction,
  recordStrategyPerformance,
  recordPreference,
  recordAnalysisPattern,
  exportGrowth,
  importGrowth,
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  getGrowthSummary,
  validateIntegrity,
  resetGrowth,
  GROWTH_DIR,
};
