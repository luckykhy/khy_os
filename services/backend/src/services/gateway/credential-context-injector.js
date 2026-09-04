'use strict';

/**
 * credentialContextInjector.js — 凭据上下文注入器。
 *
 * 从 KhyOS 配置文件中提取真实凭据，
 * 格式化为 AI 模型可理解的上下文，
 * 在 AI 请求前注入到 system prompt 中。
 *
 * 凭据来源：
 *   - ~/.khyquant/config.json (API keys, tokens)
 *   - .khy/credentials/ (管理员凭据)
 *   - .khyos/ilink.json (微信 bot tokens)
 *   - .khy/profile.json (用户配置)
 *   - .khy/device_id.json (设备 ID)
 *
 * @module gateway/credential-context-injector
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 凭据文件路径 ────────────────────────────────────────────────
const CREDENTIAL_PATHS = {
  khyquantConfig: path.join(os.homedir(), '.khyquant', 'config.json'),
  khyquantTokenUsage: path.join(os.homedir(), '.khyquant', 'token_usage.json'),
  defaultAdmin: path.join(process.cwd(), '.khy', 'credentials', 'default-admin.json'),
  ilink: path.join(process.cwd(), '.khyos', 'ilink.json'),
  profile: path.join(process.cwd(), '.khy', 'profile.json'),
  deviceId: path.join(process.cwd(), '.khy', 'device_id.json'),
};

// ── 读取 JSON 文件 ──────────────────────────────────────────────
function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ── 提取 khyquant 配置中的凭据 ─────────────────────────────────
function extractKhyquantCredentials() {
  const config = readJsonSafe(CREDENTIAL_PATHS.khyquantConfig);
  if (!config) return [];

  const creds = [];

  // API keys
  if (config.apiKey) {
    creds.push({ name: 'khyquant.apiKey', value: config.apiKey, type: 'api_key' });
  }
  if (config.api_key) {
    creds.push({ name: 'khyquant.api_key', value: config.api_key, type: 'api_key' });
  }
  if (config.anthropicApiKey) {
    creds.push({ name: 'khyquant.anthropicApiKey', value: config.anthropicApiKey, type: 'api_key' });
  }
  if (config.openaiApiKey) {
    creds.push({ name: 'khyquant.openaiApiKey', value: config.openaiApiKey, type: 'api_key' });
  }
  if (config.deepseekApiKey) {
    creds.push({ name: 'khyquant.deepseekApiKey', value: config.deepseekApiKey, type: 'api_key' });
  }

  // Tokens
  if (config.token) {
    creds.push({ name: 'khyquant.token', value: config.token, type: 'token' });
  }
  if (config.accessToken) {
    creds.push({ name: 'khyquant.accessToken', value: config.accessToken, type: 'token' });
  }
  if (config.authToken) {
    creds.push({ name: 'khyquant.authToken', value: config.authToken, type: 'token' });
  }

  // Cloud endpoint
  if (config.cloudEndpoint) {
    creds.push({ name: 'khyquant.cloudEndpoint', value: config.cloudEndpoint, type: 'endpoint' });
  }
  if (config.endpoint) {
    creds.push({ name: 'khyquant.endpoint', value: config.endpoint, type: 'endpoint' });
  }

  return creds;
}

// ── 提取默认管理员凭据 ─────────────────────────────────────────
function extractAdminCredentials() {
  const admin = readJsonSafe(CREDENTIAL_PATHS.defaultAdmin);
  if (!admin) return [];

  const creds = [];
  if (admin.username) {
    creds.push({ name: 'admin.username', value: admin.username, type: 'username' });
  }
  if (admin.password) {
    creds.push({ name: 'admin.password', value: admin.password, type: 'password' });
  }
  return creds;
}

// ── 提取 iLink Bot Tokens ──────────────────────────────────────
function extractIlinkCredentials() {
  const ilink = readJsonSafe(CREDENTIAL_PATHS.ilink);
  if (!ilink || !ilink.accounts) return [];

  const creds = [];
  for (const [accountId, account] of Object.entries(ilink.accounts)) {
    if (account.botToken) {
      creds.push({
        name: `ilink.${accountId}.botToken`,
        value: account.botToken,
        type: 'bot_token',
      });
    }
    if (account.userId) {
      creds.push({
        name: `ilink.${accountId}.userId`,
        value: account.userId,
        type: 'user_id',
      });
    }
    if (account.baseUrl) {
      creds.push({
        name: `ilink.${accountId}.baseUrl`,
        value: account.baseUrl,
        type: 'endpoint',
      });
    }
  }

  if (ilink.active) {
    creds.push({ name: 'ilink.active', value: ilink.active, type: 'config' });
  }

  return creds;
}

// ── 提取设备 ID ────────────────────────────────────────────────
function extractDeviceId() {
  const device = readJsonSafe(CREDENTIAL_PATHS.deviceId);
  if (!device) return [];

  const creds = [];
  if (device.deviceId) {
    creds.push({ name: 'device.id', value: device.deviceId, type: 'device_id' });
  }
  if (device.id) {
    creds.push({ name: 'device.id', value: device.id, type: 'device_id' });
  }
  return creds;
}

// ── 提取用户配置 ────────────────────────────────────────────────
function extractProfile() {
  const profile = readJsonSafe(CREDENTIAL_PATHS.profile);
  if (!profile) return [];

  const creds = [];
  if (profile.deviceId) {
    creds.push({ name: 'profile.deviceId', value: profile.deviceId, type: 'device_id' });
  }
  return creds;
}

// ── 主函数：收集所有凭据 ────────────────────────────────────────
function collectAllCredentials() {
  const all = [
    ...extractKhyquantCredentials(),
    ...extractAdminCredentials(),
    ...extractIlinkCredentials(),
    ...extractDeviceId(),
    ...extractProfile(),
  ];

  // 去重（按 name）
  const seen = new Set();
  return all.filter((cred) => {
    if (seen.has(cred.name)) return false;
    seen.add(cred.name);
    return true;
  });
}

// ── 格式化为 AI 上下文 ─────────────────────────────────────────
function formatCredentialsContext(credentials) {
  if (credentials.length === 0) {
    return '';
  }

  const lines = [
    '',
    '## 当前系统凭据（可直接使用）',
    '',
    '以下是当前 KhyOS 安装中的实际凭据，你可以直接使用它们来执行操作：',
    '',
  ];

  // 按类型分组
  const grouped = {};
  for (const cred of credentials) {
    if (!grouped[cred.type]) grouped[cred.type] = [];
    grouped[cred.type].push(cred);
  }

  for (const [type, creds] of Object.entries(grouped)) {
    lines.push(`### ${type}`);
    for (const cred of creds) {
      lines.push(`- ${cred.name}: ${cred.value}`);
    }
    lines.push('');
  }

  lines.push('注意：这些凭据来自本地配置文件，可直接用于 API 调用、认证等操作。');
  lines.push('');

  return lines.join('\n');
}

// ── 注入到 system prompt ───────────────────────────────────────
function injectCredentialsToSystemPrompt(originalPrompt, credentials) {
  const credContext = formatCredentialsContext(credentials);
  if (!credContext) return originalPrompt;

  // 如果已有 system prompt，追加到末尾
  if (originalPrompt) {
    return `${originalPrompt}\n${credContext}`;
  }
  return credContext;
}

// ── 注入到 messages 数组 ───────────────────────────────────────
function injectCredentialsToMessages(messages, credentials) {
  const credContext = formatCredentialsContext(credentials);
  if (!credContext) return messages;

  // 查找 system message，追加凭据
  const systemIdx = messages.findIndex((m) => m.role === 'system');
  if (systemIdx >= 0) {
    const updated = [...messages];
    updated[systemIdx] = {
      ...updated[systemIdx],
      content: `${updated[systemIdx].content}\n${credContext}`,
    };
    return updated;
  }

  // 没有 system message，插入一个
  return [
    { role: 'system', content: credContext.trim() },
    ...messages,
  ];
}

// ── 导出 ────────────────────────────────────────────────────────
module.exports = {
  collectAllCredentials,
  formatCredentialsContext,
  injectCredentialsToSystemPrompt,
  injectCredentialsToMessages,
  CREDENTIAL_PATHS,
  extractKhyquantCredentials,
  extractAdminCredentials,
  extractIlinkCredentials,
  extractDeviceId,
  extractProfile,
};
