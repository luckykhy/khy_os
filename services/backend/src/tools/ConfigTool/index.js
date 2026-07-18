const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_FILE = path.join(os.homedir(), '.khy', 'settings.json');

const SUPPORTED_SETTINGS = {
  theme: { type: 'string', options: ['dark', 'light', 'auto'], default: 'dark' },
  editorMode: { type: 'string', options: ['normal', 'vim'], default: 'normal' },
  voiceEnabled: { type: 'boolean', default: false },
  'permissions.defaultMode': { type: 'string', options: ['auto', 'confirm', 'deny'], default: 'confirm' },
  verbose: { type: 'boolean', default: false },
  language: { type: 'string', default: 'en' },
  maxTokens: { type: 'number', default: 4096 },
};

class ConfigTool extends BaseTool {
  static toolName = 'Config';
  static category = 'system';
  static risk = 'low';
  static aliases = ['config', 'settings'];
  static searchHint = 'get set khy ui preference theme editor verbose language voice maxTokens';
  static shouldDefer = true;

  isReadOnly(input) { return !input || !input.value; }
  isConcurrencySafe() { return false; }

  prompt() {
    const settingsList = Object.entries(SUPPORTED_SETTINGS)
      .map(([k, v]) => `- ${k}: ${v.type}${v.options ? ` (${v.options.join('|')})` : ''} default=${v.default}`)
      .join('\n');
    return `Get or set Khy OS UI/CLI preference settings.

Supported settings:
${settingsList}

Omit value to read current setting. Provide value to update.

NOTE: This tool ONLY handles the UI/CLI preferences listed above. It does NOT configure model API keys, providers, or the AI gateway. For model key / provider / gateway setup, tell the user to run \`khy gateway config\` (or the \`/apikey\` slash command) — never call this tool to "configure model keys".`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        setting: { type: 'string', description: 'The setting key' },
        value: { description: 'The new value. Omit to get current value.' },
      },
      required: ['setting'],
    };
  }

  async execute(params) {
    const { setting, value } = params;

    if (!SUPPORTED_SETTINGS[setting]) {
      return { success: false, error: `Unknown setting: ${setting}. Supported: ${Object.keys(SUPPORTED_SETTINGS).join(', ')}` };
    }

    let config = {};
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        config = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      }
    } catch { /* ignore */ }

    // GET
    if (value === undefined || value === null) {
      const currentValue = config[setting] !== undefined ? config[setting] : SUPPORTED_SETTINGS[setting].default;
      return { success: true, operation: 'get', setting, value: currentValue };
    }

    // SET
    const previousValue = config[setting] !== undefined ? config[setting] : SUPPORTED_SETTINGS[setting].default;
    const meta = SUPPORTED_SETTINGS[setting];
    if (meta.options && !meta.options.includes(value)) {
      return { success: false, error: `Invalid value for ${setting}. Options: ${meta.options.join(', ')}` };
    }

    config[setting] = value;
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(config, null, 2), 'utf-8');

    return { success: true, operation: 'set', setting, previousValue, newValue: value };
  }

  getActivityDescription(input) {
    return input.value !== undefined ? `设置配置：${input.setting}` : `读取配置：${input.setting}`;
  }
}

module.exports = ConfigTool;
