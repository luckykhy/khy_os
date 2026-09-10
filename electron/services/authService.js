const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.khyquant');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readConfig() {
  try {
    ensureConfigDir();
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(data) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

const state = {
  user: null,
  token: null,
  providers: [
    { id: 'github', name: 'GitHub', type: 'oauth' },
    { id: 'google', name: 'Google', type: 'oauth' },
    { id: 'apikey', name: 'API Key', type: 'apikey' },
  ],
};

// Restore persisted session on startup.
const config = readConfig();
if (config.token) {
  state.token = config.token;
  state.user = config.user || null;
}

const authService = {
  async login(credentials) {
    if (!credentials || !credentials.username) {
      throw new Error('登录失败：请提供用户名');
    }

    const user = {
      id: credentials.username,
      name: credentials.username,
      loginMethod: 'local',
    };

    state.user = user;
    state.token = `local-${Date.now()}`;

    writeConfig({ token: state.token, user: state.user });
    return { user: state.user, token: state.token };
  },

  async logout() {
    state.user = null;
    state.token = null;
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        fs.unlinkSync(CONFIG_FILE);
      }
    } catch {
      // Config file already gone — nothing to clean up.
    }
    return { success: true };
  },

  getState() {
    return {
      isAuthenticated: !!state.token,
      user: state.user,
      token: state.token,
    };
  },

  async refreshToken() {
    if (!state.token) {
      throw new Error('无法刷新：当前无有效登录状态');
    }
    state.token = `refreshed-${Date.now()}`;
    writeConfig({ token: state.token, user: state.user });
    return { token: state.token };
  },

  async oauthLogin(providerId) {
    if (!state.providers.find((p) => p.id === providerId)) {
      throw new Error(`OAuth 提供商不存在：${providerId}`);
    }
    // Real OAuth flow would open a browser window here.
    const user = {
      id: `${providerId}-user`,
      name: `${providerId} 用户`,
      loginMethod: 'oauth',
      provider: providerId,
    };
    state.user = user;
    state.token = `oauth-${providerId}-${Date.now()}`;
    writeConfig({ token: state.token, user: state.user });
    return { user: state.user, token: state.token };
  },

  async apiKeyLogin(data) {
    if (!data || !data.apiKey) {
      throw new Error('API Key 登录失败：请提供有效的 API Key');
    }
    const user = {
      id: `apikey-${data.apiKey.slice(0, 8)}`,
      name: 'API Key 用户',
      loginMethod: 'apikey',
    };
    state.user = user;
    state.token = data.apiKey;
    writeConfig({ token: state.token, user: state.user });
    return { user: state.user, token: state.token };
  },

  getProviders() {
    return state.providers;
  },

  async skipLogin() {
    const user = {
      id: 'guest',
      name: '访客',
      loginMethod: 'skip',
    };
    state.user = user;
    state.token = `guest-${Date.now()}`;
    writeConfig({ token: state.token, user: state.user });
    return { user: state.user, token: state.token };
  },
};

module.exports = authService;
