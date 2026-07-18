/**
 * User Profile & Adaptive Learning System.
 *
 * Tracks user behavior and adapts the CLI experience over time:
 * - Command frequency → suggest frequent commands, optimize menu order
 * - Symbol history → auto-complete with favorites
 * - Strategy preferences → default strategy selection
 * - Time patterns → greet differently at different times
 * - Error patterns → proactively offer help for repeated mistakes
 *
 * Data is stored in ~/.khyquant/profile.json (portable across devices).
 * Export/import via `khy profile export` / `khy profile import`.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROFILE_DIR = path.join(os.homedir(), '.khyquant');
const PROFILE_PATH = path.join(PROFILE_DIR, 'profile.json');
const MAX_HISTORY_ITEMS = 200;
const MAX_FREQUENT_ITEMS = 20;

// Default profile structure
function createDefaultProfile() {
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deviceId: generateDeviceId(),

    // ── User Preferences (explicit settings) ────────────────────
    preferences: {
      language: 'zh-CN',
      theme: 'auto',
      defaultCapital: 100000,
      defaultPeriod: '1y',
      aiMode: false,          // remember AI mode preference
      favoriteSymbols: [],    // user-pinned symbols
      favoriteStrategies: [], // user-pinned strategies
    },

    // ── Behavioral Data (auto-learned) ──────────────────────────
    behavior: {
      commandFrequency: {},    // { "quote": 45, "backtest": 12, ... }
      symbolHistory: [],       // recent symbols queried (deduped, ordered by recency)
      strategyHistory: [],     // recent strategy IDs used
      sessionCount: 0,         // total sessions started
      totalCommands: 0,        // total commands executed
      lastSession: null,       // ISO timestamp of last session
      errorPatterns: {},       // { "error_type": count } for proactive help
      timeOfDayUsage: {},      // { "morning": 5, "afternoon": 12, ... }
    },

    // ── Adaptive State (computed from behavior) ─────────────────
    adaptive: {
      suggestedSymbols: [],    // top N most queried symbols
      suggestedCommands: [],   // top N most used commands
      skillLevel: 'beginner',  // beginner → intermediate → advanced
      contextHints: true,      // show contextual tips (disable once experienced)
    },

    // ── Sync Metadata ───────────────────────────────────────────
    sync: {
      lastExport: null,
      lastImport: null,
      mergeHistory: [],
    },
  };
}

function generateDeviceId() {
  const hostname = os.hostname();
  const platform = os.platform();
  return `${platform}-${hostname}-${Date.now().toString(36)}`;
}

// ── Profile I/O ─────────────────────────────────────────────────────────

let _profile = null;

function ensureDir() {
  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }
}

function load() {
  if (_profile) return _profile;

  ensureDir();

  try {
    if (fs.existsSync(PROFILE_PATH)) {
      const raw = fs.readFileSync(PROFILE_PATH, 'utf-8');
      _profile = JSON.parse(raw);
      // Migrate older versions
      if (!_profile.version || _profile.version < 2) {
        _profile = { ...createDefaultProfile(), ..._profile, version: 2 };
      }
    } else {
      _profile = createDefaultProfile();
      save();
    }
  } catch {
    _profile = createDefaultProfile();
  }

  return _profile;
}

function save() {
  if (!_profile) return;
  _profile.updatedAt = new Date().toISOString();
  ensureDir();
  try {
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(_profile, null, 2), 'utf-8');
  } catch { /* ignore write errors on readonly FS */ }
}

// ── Behavior Tracking ───────────────────────────────────────────────────

function trackCommand(command) {
  const profile = load();
  const freq = profile.behavior.commandFrequency;
  freq[command] = (freq[command] || 0) + 1;
  profile.behavior.totalCommands++;
  updateAdaptiveState();
  save();
}

function trackSymbol(symbol) {
  const profile = load();
  const history = profile.behavior.symbolHistory;

  // Move to front (most recent first), deduplicate
  const idx = history.indexOf(symbol);
  if (idx !== -1) history.splice(idx, 1);
  history.unshift(symbol);

  // Cap history size
  if (history.length > MAX_HISTORY_ITEMS) {
    history.length = MAX_HISTORY_ITEMS;
  }

  updateAdaptiveState();
  save();
}

function trackStrategy(strategyId) {
  const profile = load();
  const history = profile.behavior.strategyHistory;

  const idx = history.indexOf(strategyId);
  if (idx !== -1) history.splice(idx, 1);
  history.unshift(strategyId);

  if (history.length > 50) history.length = 50;
  save();
}

function trackError(errorType) {
  const profile = load();
  const errors = profile.behavior.errorPatterns;
  errors[errorType] = (errors[errorType] || 0) + 1;
  save();
}

function trackSessionStart() {
  const profile = load();
  profile.behavior.sessionCount++;
  profile.behavior.lastSession = new Date().toISOString();

  // Track time of day usage
  const hour = new Date().getHours();
  let period;
  if (hour < 6) period = 'night';
  else if (hour < 12) period = 'morning';
  else if (hour < 18) period = 'afternoon';
  else period = 'evening';

  const tod = profile.behavior.timeOfDayUsage;
  tod[period] = (tod[period] || 0) + 1;

  save();
}

// ── Adaptive Intelligence ───────────────────────────────────────────────

function updateAdaptiveState() {
  const profile = load();
  const { commandFrequency, symbolHistory, totalCommands } = profile.behavior;

  // Top commands
  const sortedCmds = Object.entries(commandFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FREQUENT_ITEMS)
    .map(([cmd]) => cmd);
  profile.adaptive.suggestedCommands = sortedCmds;

  // Top symbols (by frequency in history)
  const symbolCounts = {};
  symbolHistory.forEach((s, i) => {
    // Weight by recency: more recent = higher weight
    symbolCounts[s] = (symbolCounts[s] || 0) + Math.max(1, MAX_HISTORY_ITEMS - i);
  });
  profile.adaptive.suggestedSymbols = Object.entries(symbolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([sym]) => sym);

  // Skill level assessment
  if (totalCommands > 500) {
    profile.adaptive.skillLevel = 'advanced';
    profile.adaptive.contextHints = false;
  } else if (totalCommands > 50) {
    profile.adaptive.skillLevel = 'intermediate';
  } else {
    profile.adaptive.skillLevel = 'beginner';
  }
}

// ── Query API (for other modules to use) ────────────────────────────────

/**
 * Get the most likely symbols the user wants (for auto-complete).
 */
function getSuggestedSymbols(limit = 5) {
  const profile = load();
  const pinned = profile.preferences.favoriteSymbols || [];
  const suggested = profile.adaptive.suggestedSymbols || [];
  // Pinned first, then suggested, deduped
  const merged = [...new Set([...pinned, ...suggested])];
  return merged.slice(0, limit);
}

/**
 * Get default backtest capital based on user history.
 */
function getDefaultCapital() {
  const profile = load();
  return profile.preferences.defaultCapital || 100000;
}

/**
 * Get user skill level for adjusting verbosity.
 */
function getSkillLevel() {
  const profile = load();
  return profile.adaptive.skillLevel;
}

/**
 * Should we show contextual hints?
 */
function shouldShowHints() {
  const profile = load();
  return profile.adaptive.contextHints !== false;
}

/**
 * Get a contextual greeting based on time and usage patterns.
 */
function getGreeting() {
  const hour = new Date().getHours();
  const profile = load();
  const sessions = profile.behavior.sessionCount;

  let timeGreeting;
  if (hour < 6) timeGreeting = '夜深了，注意休息';
  else if (hour < 9) timeGreeting = '早上好';
  else if (hour < 12) timeGreeting = '上午好';
  else if (hour < 14) timeGreeting = '中午好';
  else if (hour < 18) timeGreeting = '下午好';
  else timeGreeting = '晚上好';

  if (sessions <= 1) return `${timeGreeting}，欢迎使用 khy OS！输入 docs 查看新手教程`;
  if (sessions <= 5) return `${timeGreeting}，正在熟悉中...试试 menu 打开菜单`;
  if (sessions <= 20) return timeGreeting;

  // For experienced users, show relevant market info
  const topSymbol = profile.adaptive.suggestedSymbols[0];
  if (topSymbol) return `${timeGreeting} · 输入 hq ${topSymbol} 查看最新行情`;
  return timeGreeting;
}

/**
 * Get AI mode preference.
 */
function getAiModePreference() {
  const profile = load();
  return profile.preferences.aiMode || false;
}

/**
 * Save AI mode preference.
 */
function setAiModePreference(enabled) {
  const profile = load();
  profile.preferences.aiMode = enabled;
  save();
}

/**
 * Add a symbol to favorites.
 */
function addFavoriteSymbol(symbol) {
  const profile = load();
  const favs = profile.preferences.favoriteSymbols;
  if (!favs.includes(symbol)) {
    favs.push(symbol);
    save();
  }
}

/**
 * Remove a symbol from favorites.
 */
function removeFavoriteSymbol(symbol) {
  const profile = load();
  const favs = profile.preferences.favoriteSymbols;
  const idx = favs.indexOf(symbol);
  if (idx !== -1) {
    favs.splice(idx, 1);
    save();
  }
}

// ── Export / Import (cross-device sync) ─────────────────────────────────

/**
 * Export profile to a portable JSON string.
 */
function exportProfile() {
  const profile = load();
  profile.sync.lastExport = new Date().toISOString();
  save();
  return JSON.stringify(profile, null, 2);
}

/**
 * Import profile from JSON string, merging with current.
 * Behavioral data is merged (additive), preferences use latest.
 */
function importProfile(jsonStr) {
  const incoming = JSON.parse(jsonStr);
  const current = load();

  // Merge preferences (incoming wins)
  current.preferences = { ...current.preferences, ...incoming.preferences };

  // Merge behavioral data (additive)
  const inFreq = incoming.behavior?.commandFrequency || {};
  for (const [cmd, count] of Object.entries(inFreq)) {
    current.behavior.commandFrequency[cmd] = Math.max(
      current.behavior.commandFrequency[cmd] || 0,
      count
    );
  }

  // Merge symbol history (union, recent first)
  const inSymbols = incoming.behavior?.symbolHistory || [];
  const merged = [...new Set([...inSymbols, ...current.behavior.symbolHistory])];
  current.behavior.symbolHistory = merged.slice(0, MAX_HISTORY_ITEMS);

  // Merge strategy history
  const inStrats = incoming.behavior?.strategyHistory || [];
  const mergedStrats = [...new Set([...inStrats, ...current.behavior.strategyHistory])];
  current.behavior.strategyHistory = mergedStrats.slice(0, 50);

  // Take max session count
  current.behavior.sessionCount = Math.max(
    current.behavior.sessionCount,
    incoming.behavior?.sessionCount || 0
  );
  current.behavior.totalCommands = Math.max(
    current.behavior.totalCommands,
    incoming.behavior?.totalCommands || 0
  );

  // Record merge
  current.sync.lastImport = new Date().toISOString();
  current.sync.mergeHistory.push({
    from: incoming.deviceId || 'unknown',
    at: new Date().toISOString(),
  });

  // Recalculate adaptive state
  _profile = current;
  updateAdaptiveState();
  save();

  return current;
}

/**
 * Get profile summary for display.
 */
function getProfileSummary() {
  const profile = load();
  return {
    sessions: profile.behavior.sessionCount,
    totalCommands: profile.behavior.totalCommands,
    skillLevel: profile.adaptive.skillLevel,
    topSymbols: profile.adaptive.suggestedSymbols.slice(0, 5),
    topCommands: profile.adaptive.suggestedCommands.slice(0, 5),
    favoriteSymbols: profile.preferences.favoriteSymbols,
    createdAt: profile.createdAt,
    deviceId: profile.deviceId,
  };
}

/**
 * Reset profile (for testing or fresh start).
 */
function resetProfile() {
  _profile = createDefaultProfile();
  save();
  return _profile;
}

module.exports = {
  // Tracking
  trackCommand,
  trackSymbol,
  trackStrategy,
  trackError,
  trackSessionStart,

  // Queries
  getSuggestedSymbols,
  getDefaultCapital,
  getSkillLevel,
  shouldShowHints,
  getGreeting,
  getAiModePreference,
  setAiModePreference,
  getProfileSummary,

  // Favorites
  addFavoriteSymbol,
  removeFavoriteSymbol,

  // Sync
  exportProfile,
  importProfile,
  resetProfile,

  // Constants
  PROFILE_DIR,
  PROFILE_PATH,
};
