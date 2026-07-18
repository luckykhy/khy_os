/**
 * Vim settings persistence — read/write editorMode from ~/.khy/settings.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_DIR = path.join(os.homedir(), '.khy');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function writeSettings(settings) {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/**
 * Get the current editor mode.
 * @returns {'normal'|'vim'}
 */
function getEditorMode() {
  const settings = readSettings();
  return settings.editorMode === 'vim' ? 'vim' : 'normal';
}

/**
 * Set the editor mode and persist.
 * @param {'normal'|'vim'} mode
 */
function setEditorMode(mode) {
  const settings = readSettings();
  settings.editorMode = mode === 'vim' ? 'vim' : 'normal';
  writeSettings(settings);
}

/**
 * Check if vim mode is enabled.
 * @returns {boolean}
 */
function isVimEnabled() {
  return getEditorMode() === 'vim';
}

module.exports = {
  getEditorMode,
  setEditorMode,
  isVimEnabled,
};
