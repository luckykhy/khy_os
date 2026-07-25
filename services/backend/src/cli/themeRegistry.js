'use strict';

/**
 * Theme Registry — loadable, switchable theme system.
 *
 * Loads JSON theme files from the `themes/` directory and optional
 * user custom theme from `~/.khyquant/theme.json`.
 * Exposes a pull-model API: getTheme() returns the active theme.
 *
 * @module themeRegistry
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getColorDepth, adaptColor } = require('./palette');

const THEMES_DIR = path.join(__dirname, 'themes');
const PREFS_FILE = path.join(os.homedir(), '.khyquant', 'preferences.json');
const CUSTOM_THEME_FILE = path.join(os.homedir(), '.khyquant', 'theme.json');

// ── State ──

const _themes = new Map(); // name → theme object
let _activeName = 'default';
let _initialized = false;

// ── Default fallback (embedded, never missing) ──

let _defaultTheme = null;

function _getDefaultTheme() {
  if (_defaultTheme) return _defaultTheme;
  try {
    _defaultTheme = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, 'default.json'), 'utf8'));
  } catch {
    // Absolute fallback if even the JSON file is missing
    _defaultTheme = {
      meta: { name: 'default', label: 'Default', description: 'Built-in fallback' },
      colors: {
        claude: '#D77757', success: '#4EBA65', error: '#FF6B80', warning: '#FFC107',
        text: '#FFFFFF', secondaryText: '#A9A9A9', subtle: '#505050', bashBorder: '#6B7280', bashBg: '#2A2A2A',
        permission: '#FFC107', link: '#6495ED', diffAdded: '#225C2B', diffRemoved: '#7A2936',
        diffAddedDimmed: '#475E4A', diffRemovedDimmed: '#69484D', diffAddedWord: '#38A660',
        diffRemovedWord: '#B3596B', permissionPurple: '#B388FF', userMessageBg: '#262626',
      },
      spinnerChars: { darwin: ['●','✢','✳','✶','✻','✽'], fallback: ['●','*','+','×','+','*'] },
      thinkingVerbs: ['Thinking','Reasoning','Inferring','Analyzing','Considering','Evaluating','Reflecting','Pondering','Processing','Pollinating'],
      phaseLabels: { init:'Initializing', security:'Security check', preprocess:'Preprocessing', request:'Thinking', thinking:'Thinking', analyzing:'Analyzing', generating:'Generating', tools:'Running tools', explore:'Searching', reading:'Reading', writing:'Writing', tool:'Running tool', done:'Done' },
      toolDisplayNames: { bash:'Bash', shell:'Bash', shellcommand:'Bash', command:'Bash', read:'Read', readfile:'Read', write:'Write', writefile:'Write', createfile:'Write', edit:'Update', editfile:'Update', multiedit:'Update', notebookedit:'Update', glob:'Search', grep:'Search', find:'Search', findfiles:'Search', search:'Search', searchcontent:'Search', websearch:'Search', webfetch:'Fetch', todowrite:'Todo', notebookread:'Read', agent:'Agent', task:'Task', ls:'Search' },
    };
  }
  return _defaultTheme;
}

// ── Public API ──

/**
 * Load all .json theme files from the themes/ directory.
 * Also loads custom theme from ~/.khyquant/theme.json if present.
 * Reads saved preference for active theme.
 */
function init() {
  if (_initialized) return;
  _initialized = true;

  // Load built-in themes
  try {
    const files = fs.readdirSync(THEMES_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const theme = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, file), 'utf8'));
        if (theme.meta && theme.meta.name) {
          _themes.set(theme.meta.name, theme);
        }
      } catch { /* skip corrupt theme files */ }
    }
  } catch { /* themes dir missing */ }

  // Load custom user theme
  try {
    if (fs.existsSync(CUSTOM_THEME_FILE)) {
      const custom = JSON.parse(fs.readFileSync(CUSTOM_THEME_FILE, 'utf8'));
      if (custom.meta && custom.meta.name) {
        _themes.set(custom.meta.name, custom);
      }
    }
  } catch { /* ignore */ }

  // Ensure default always exists
  if (!_themes.has('default')) {
    _themes.set('default', _getDefaultTheme());
  }

  // Load saved preference
  try {
    if (fs.existsSync(PREFS_FILE)) {
      const prefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
      if (prefs.theme && _themes.has(prefs.theme)) {
        _activeName = prefs.theme;
      }
    }
  } catch { /* ignore */ }
}

/**
 * Get the currently active theme object.
 * Auto-initializes if needed.
 * @returns {object} Theme with { meta, colors, spinnerChars, thinkingVerbs, phaseLabels, toolDisplayNames }
 */
function getTheme() {
  if (!_initialized) init();
  return _themes.get(_activeName) || _getDefaultTheme();
}

/**
 * Switch the active theme by name.
 * Persists choice to ~/.khyquant/preferences.json.
 * @param {string} name - Theme name (e.g. 'default', 'mono')
 * @returns {boolean} true if switched successfully
 */
function setTheme(name) {
  if (!_initialized) init();
  if (!_themes.has(name)) return false;

  _activeName = name;

  // Persist preference
  try {
    const dir = path.dirname(PREFS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { /* new file */ }
    prefs.theme = name;
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf8');
  } catch { /* persistence is best-effort */ }

  return true;
}

/**
 * List all available themes.
 * @returns {Array<{ name: string, label: string, description: string, active: boolean }>}
 */
function listThemes() {
  if (!_initialized) init();
  const result = [];
  for (const [name, theme] of _themes) {
    result.push({
      name,
      label: theme.meta?.label || name,
      description: theme.meta?.description || '',
      active: name === _activeName,
    });
  }
  return result;
}

/**
 * Get a specific color from the active theme.
 * Falls back to default theme if key is missing.
 * G4: 自动根据终端色深降级颜色
 * @param {string} key - Color key (e.g. 'claude', 'success')
 * @returns {string} Hex color string (or adapted format)
 */
function color(key) {
  const theme = getTheme();
  const hex = (theme.colors && theme.colors[key]) || (() => {
    const def = _getDefaultTheme();
    return (def.colors && def.colors[key]) || '#FFFFFF';
  })();
  return hex;
}

/**
 * G4: 获取色深感知的颜色信息
 * @param {string} key
 * @returns {{ type: string, value: string|number }}
 */
function colorAdapted(key) {
  const hex = color(key);
  return adaptColor(hex, getColorDepth());
}

/**
 * Get the active theme name.
 * @returns {string}
 */
function getActiveName() {
  if (!_initialized) init();
  return _activeName;
}

/** @internal Reset for testing */
function _resetForTest() {
  _themes.clear();
  _activeName = 'default';
  _initialized = false;
  _defaultTheme = null;
}

module.exports = {
  init,
  getTheme,
  setTheme,
  listThemes,
  color,
  colorAdapted,
  getActiveName,
  _resetForTest,
  THEMES_DIR,
  PREFS_FILE,
};
