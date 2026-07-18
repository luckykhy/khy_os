/**
 * CLI Auth Service — Unified authentication for terminal usage.
 *
 * **Server-first**: When the backend server is running, all auth operations
 * hit /api/auth (same database as the frontend web UI). This means CLI and
 * web share the same user accounts, security questions, and sessions.
 *
 * **Local fallback**: If the server is unreachable, credentials are stored
 * locally in ~/.khyquant/credentials.json (PBKDF2 hashed) so the CLI
 * remains usable offline.
 *
 * Sessions are persisted to ~/.khyquant/session.json (auto-login within 7 days).
 *
 * Security questions are stored alongside credentials (locally) and also
 * synced to the server when available (same as frontend Register.vue).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const KHY_DIR = path.join(os.homedir(), '.khyquant');
const CREDENTIALS_FILE = path.join(KHY_DIR, 'credentials.json');
const SESSION_FILE = path.join(KHY_DIR, 'session.json');
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Pre-defined security questions (same as frontend Register.vue)
const SECURITY_QUESTIONS = [
  '你的出生地是哪里？',
  '你母亲的姓名是什么？',
  '你的第一所学校叫什么？',
  '你最喜欢的颜色是什么？',
  '你的第一只宠物叫什么？',
  '你最喜欢的电影是什么？',
];

// ─── Password Hashing (PBKDF2, no external deps) ──────────────────────────

function _hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function _verifyPassword(password, storedHash, storedSalt) {
  const { hash } = _hashPassword(password, storedSalt);
  return hash === storedHash;
}

// ─── Credential & Session Storage ──────────────────────────────────────────

function _ensureDir() {
  if (!fs.existsSync(KHY_DIR)) fs.mkdirSync(KHY_DIR, { recursive: true });
}

function _loadCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

function _saveCredentials(creds) {
  _ensureDir();
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
  try { fs.chmodSync(CREDENTIALS_FILE, 0o600); } catch { /* Windows */ }
}

function _loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

function _clearSessionFile() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch { /* ignore */ }
}

function _isExpiredTimestamp(value) {
  if (!value) return false;
  const expiresAtMs = new Date(value).getTime();
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs <= Date.now();
}

function _loadActiveSession() {
  const session = _loadSession();
  if (!session) return null;
  if (_isExpiredTimestamp(session.expiresAt)) {
    _clearSessionFile();
    return null;
  }
  return session;
}

function _saveSession(username, serverToken, role, options = {}) {
  _ensureDir();
  const loginAt = new Date().toISOString();
  const session = {
    username,
    role: role || 'user',
    loginAt,
    deviceId: `${os.platform()}-${os.hostname()}`,
  };
  // 会话到期合理管理(门控 KHY_AUTH_DATE_SANE 默认开):把此前定义却未使用的 SESSION_MAX_AGE_MS
  // 落成显式 expiresAt = loginAt + 7 天,从源头消除 whoami 面板「会话到期: Invalid Date」。
  // 门控关 → 不写该字段,session.json 逐字节回退旧结构。绝不因格式化叶子异常而阻断登录。
  try {
    const authTime = require('./authTimeFormat');
    if (authTime.isEnabled()) {
      const expiresAt = authTime.deriveSessionExpiry(null, loginAt, SESSION_MAX_AGE_MS);
      if (expiresAt) session.expiresAt = expiresAt;
    }
  } catch { /* best-effort;派生失败则退化为无 expiresAt */ }
  if (serverToken) session.serverToken = serverToken;
  if (options.refreshToken) session.serverRefreshToken = options.refreshToken;
  if (options.serverTokenExpiresAt) session.serverTokenExpiresAt = options.serverTokenExpiresAt;
  if (options.serverRefreshExpiresAt) session.serverRefreshExpiresAt = options.serverRefreshExpiresAt;
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  try { fs.chmodSync(SESSION_FILE, 0o600); } catch { /* Windows */ }
  return session;
}

// ─── Server Communication (blocking, with timeout) ─────────────────────────

/**
 * Make a synchronous-style HTTP request to the backend server.
 * Returns a promise that resolves to the JSON body or null on failure.
 */
function _serverRequest(method, endpoint, data, timeoutMs = 5000, extraHeaders = {}) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const payload = data ? JSON.stringify(data) : null;

  return new Promise((resolve) => {
    try {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: endpoint,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...extraHeaders,
        },
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });

      if (payload) req.write(payload);
      req.end();
    } catch { resolve(null); }
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Check if user has ever registered (locally or on server).
 */
function isRegistered() {
  return true; // built-in admin5 always available; users can also /register their own
}

/**
 * Check if there is a valid (non-expired) session.
 */
function checkSession() {
  const session = _loadActiveSession();
  if (session) {
    return { loggedIn: true, username: session.username, role: session.role || 'user' };
  }
  return { loggedIn: false };
}

/**
 * Get current valid server auth token from CLI session (if available).
 * Returns empty string when user is not logged in or session is local-only.
 */
function getSessionAuthToken() {
  const session = _loadActiveSession();
  if (!session) return '';
  const token = String(session.serverToken || '').trim();
  return token || '';
}

/**
 * Register a new account.
 * Tries server first (shared with frontend), falls back to local.
 */
async function register(username, password, email, securityQuestion, securityAnswer) {
  if (!username || username.length < 2) {
    return { success: false, error: '用户名至少 2 个字符' };
  }
  if (!password || password.length < 6) {
    return { success: false, error: '密码至少 6 个字符' };
  }

  const existing = _loadCredentials();
  if (existing) {
    return { success: false, error: '本机已有注册账号。如需重置请删除 ~/.khyquant/credentials.json' };
  }

  // Try server registration first (same DB as frontend)
  const serverData = {
    username,
    password,
    email: email || `${username}@cli.local`,
  };
  if (securityQuestion && securityAnswer) {
    serverData.securityQuestion = securityQuestion;
    serverData.securityAnswer = securityAnswer;
  }

  const serverResult = await _serverRequest('POST', '/api/auth/register', serverData);
  let serverToken = null;
  let serverAuthData = null;

  if (serverResult && serverResult.success && serverResult.data) {
    serverToken = serverResult.data.token;
    serverAuthData = serverResult.data;
  }

  // Always save local credentials (offline fallback)
  const { hash, salt } = _hashPassword(password);
  const creds = {
    username,
    email: email || '',
    passwordHash: hash,
    passwordSalt: salt,
    registeredAt: new Date().toISOString(),
    deviceId: `${os.platform()}-${os.hostname()}`,
    serverSynced: !!serverToken,
  };

  // Store security question locally too
  if (securityQuestion && securityAnswer) {
    creds.securityQuestion = securityQuestion;
    const sq = _hashPassword(securityAnswer.trim().toLowerCase());
    creds.securityAnswerHash = sq.hash;
    creds.securityAnswerSalt = sq.salt;
  }

  _saveCredentials(creds);
  _saveSession(username, serverToken, 'user', {
    refreshToken: serverAuthData?.refreshToken || '',
    serverTokenExpiresAt: serverAuthData?.expiresAt || '',
    serverRefreshExpiresAt: serverAuthData?.refreshExpiresAt || '',
  });

  return {
    success: true,
    username,
    serverSynced: !!serverToken,
  };
}

/**
 * Login with credentials.
 * Tries server first (shared with frontend), falls back to local.
 */
// Built-in accounts — always available regardless of local/server state
const _BUILTIN_ACCOUNTS = [
  { username: 'admin05', password: '012003', role: 'admin' },
  { username: 'youke5', password: 'youke123', role: 'user' },
];

async function login(username, password) {
  // Built-in admin: bypass server/local, create session directly
  const builtinMatch = _BUILTIN_ACCOUNTS.find(a => a.username === username && a.password === password);
  if (builtinMatch) {
    _saveSession(username, null, builtinMatch.role);
    return { success: true, username, role: builtinMatch.role, source: 'builtin' };
  }

  // Try server login first (accounts shared with frontend)
  const serverResult = await _serverRequest('POST', '/api/auth/login', { username, password });

  if (serverResult && serverResult.success && serverResult.data) {
    const serverAuthData = serverResult.data;
    const serverToken = serverAuthData.token;
    const serverUser = serverAuthData.user;

    // Update local credentials to match server (keeps offline fallback in sync)
    const { hash, salt } = _hashPassword(password);
    const existing = _loadCredentials() || {};
    const creds = {
      ...existing,
      username: serverUser.username || username,
      email: serverUser.email || existing.email || '',
      passwordHash: hash,
      passwordSalt: salt,
      serverSynced: true,
    };
    // Sync security question from server if available
    if (serverUser.securityQuestion && !creds.securityQuestion) {
      creds.securityQuestion = serverUser.securityQuestion;
    }
    _saveCredentials(creds);
    _saveSession(creds.username, serverToken, serverUser.role || 'user', {
      refreshToken: serverAuthData.refreshToken || '',
      serverTokenExpiresAt: serverAuthData.expiresAt || '',
      serverRefreshExpiresAt: serverAuthData.refreshExpiresAt || '',
    });

    return { success: true, username: creds.username, source: 'server' };
  }

  // Server unreachable or login failed on server — try local
  const creds = _loadCredentials();
  if (!creds) {
    // No local credentials either
    if (serverResult && serverResult.message) {
      // Server returned an error (user exists on server but wrong password)
      return { success: false, error: serverResult.message };
    }
    return { success: false, error: '本机尚未注册。请先使用 register 命令注册' };
  }

  if (creds.username !== username) {
    return { success: false, error: '用户名不匹配' };
  }

  if (!_verifyPassword(password, creds.passwordHash, creds.passwordSalt)) {
    return { success: false, error: '密码错误' };
  }

  _saveSession(username, null);
  return { success: true, username, source: 'local' };
}

/**
 * Logout — clear session.
 */
function logout() {
  _clearSessionFile();
  return { success: true };
}

/**
 * Get current user info (from credentials + session).
 */
function getCurrentUser() {
  const session = _loadActiveSession();
  const creds = _loadCredentials();
  if (!session || !creds) return null;
  // 向后兼容:历史 session.json 无 expiresAt(旧 _saveSession 从不写),从 loginAt + 7 天派生,
  // 使 whoami 面板对既有登录也能显示合理到期时间而非缺失。门控关 → 派生返回原 undefined。绝不抛。
  let sessionExpires = session.expiresAt;
  try {
    const authTime = require('./authTimeFormat');
    if (authTime.isEnabled()) {
      sessionExpires = authTime.deriveSessionExpiry(session.expiresAt, session.loginAt, SESSION_MAX_AGE_MS);
    }
  } catch { /* best-effort;退化为原始 session.expiresAt */ }
  return {
    username: creds.username,
    email: creds.email,
    registeredAt: creds.registeredAt,
    loginAt: session.loginAt,
    sessionExpires,
    hasSecurityQuestion: !!creds.securityQuestion,
    securityQuestion: creds.securityQuestion || null,
    serverSynced: !!creds.serverSynced,
  };
}

/**
 * Change password.
 * Updates both server (if available) and local credentials.
 */
async function changePassword(oldPassword, newPassword) {
  const creds = _loadCredentials();
  if (!creds) return { success: false, error: '未注册' };

  if (!_verifyPassword(oldPassword, creds.passwordHash, creds.passwordSalt)) {
    return { success: false, error: '旧密码错误' };
  }

  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: '新密码至少 6 个字符' };
  }

  // Try server-side password change
  const session = _loadActiveSession();
  if (session && session.serverToken) {
    // Server has /api/auth/change-password requiring auth
    const port = parseInt(process.env.PORT || '3000', 10);
    await new Promise((resolve) => {
      try {
        const data = JSON.stringify({
          currentPassword: oldPassword,
          newPassword,
          confirmPassword: newPassword,
        });
        const req = http.request({
          hostname: '127.0.0.1', port,
          path: '/api/auth/change-password', method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'Authorization': `Bearer ${session.serverToken}`,
          },
          timeout: 5000,
        }, () => resolve());
        req.on('error', () => resolve());
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.write(data);
        req.end();
      } catch { resolve(); }
    });
  }

  // Update local
  const { hash, salt } = _hashPassword(newPassword);
  creds.passwordHash = hash;
  creds.passwordSalt = salt;
  _saveCredentials(creds);

  return { success: true };
}

// ─── Security Question Management ──────────────────────────────────────────

/**
 * Set or update security question (for password recovery).
 */
async function setSecurityQuestion(currentPassword, question, answer) {
  const creds = _loadCredentials();
  if (!creds) return { success: false, error: '未注册' };

  if (!_verifyPassword(currentPassword, creds.passwordHash, creds.passwordSalt)) {
    return { success: false, error: '密码错误' };
  }

  if (!question || !answer || answer.trim().length < 1) {
    return { success: false, error: '密保问题和答案不能为空' };
  }

  // Update local
  creds.securityQuestion = question;
  const sq = _hashPassword(answer.trim().toLowerCase());
  creds.securityAnswerHash = sq.hash;
  creds.securityAnswerSalt = sq.salt;
  _saveCredentials(creds);

  // Sync to server if session exists
  const session = _loadActiveSession();
  if (session && session.serverToken) {
    _serverRequest(
      'POST',
      '/api/password-reset/set-security',
      {
        securityQuestion: question,
        securityAnswer: answer.trim(),
        currentPassword,
      },
      5000,
      { Authorization: `Bearer ${session.serverToken}` }
    ).catch(() => {});
  }

  return { success: true };
}

/**
 * Get security question for a username (for forgot-password flow).
 * Tries server first, falls back to local.
 */
async function getSecurityQuestion(username) {
  // Try server
  const serverResult = await _serverRequest('POST', '/api/password-reset/get-question', { username });
  if (serverResult && serverResult.success && serverResult.data) {
    return {
      success: true,
      question: serverResult.data.securityQuestion,
      source: 'server',
    };
  }

  // Fall back to local
  const creds = _loadCredentials();
  if (!creds) {
    return { success: false, error: '本机无此用户' };
  }
  if (creds.username !== username) {
    return { success: false, error: '用户名不匹配' };
  }
  if (!creds.securityQuestion) {
    return { success: false, error: '未设置密保问题。请联系管理员或删除 ~/.khyquant/credentials.json 重新注册' };
  }

  return {
    success: true,
    question: creds.securityQuestion,
    source: 'local',
  };
}

/**
 * Reset password via security answer.
 * Tries server first, falls back to local.
 */
async function resetPasswordWithSecurityAnswer(username, answer, newPassword) {
  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: '新密码至少 6 个字符' };
  }

  // Try server reset
  const serverResult = await _serverRequest('POST', '/api/password-reset/reset', {
    username,
    securityAnswer: answer.trim(),
    newPassword,
  });

  if (serverResult && serverResult.success) {
    // Server reset succeeded — update local credentials too
    const creds = _loadCredentials();
    if (creds && creds.username === username) {
      const { hash, salt } = _hashPassword(newPassword);
      creds.passwordHash = hash;
      creds.passwordSalt = salt;
      _saveCredentials(creds);
    }
    _saveSession(username, null);
    return { success: true, source: 'server' };
  }

  // Fall back to local reset
  const creds = _loadCredentials();
  if (!creds || creds.username !== username) {
    if (serverResult && serverResult.message) {
      return { success: false, error: serverResult.message };
    }
    return { success: false, error: '本机无此用户' };
  }

  if (!creds.securityAnswerHash) {
    return { success: false, error: '未设置密保问题' };
  }

  // Verify answer locally
  const normalizedAnswer = answer.trim().toLowerCase();
  if (!_verifyPassword(normalizedAnswer, creds.securityAnswerHash, creds.securityAnswerSalt)) {
    return { success: false, error: '密保答案错误' };
  }

  // Update password
  const { hash, salt } = _hashPassword(newPassword);
  creds.passwordHash = hash;
  creds.passwordSalt = salt;
  _saveCredentials(creds);
  _saveSession(username, null);

  return { success: true, source: 'local' };
}

// ─── Verification Code Recovery (phone / email — reserved) ─────────────────

/**
 * Request a verification code to be sent to the user's phone or email.
 * Requires the backend server to be running (delegates to /api/password-reset/send-code).
 * @param {'phone'|'email'} channel - Delivery channel
 * @param {string} target - Phone number or email address
 * @returns {Promise<{success: boolean, error?: string, message?: string}>}
 */
async function requestVerificationCode(channel, target) {
  if (!channel || !['phone', 'email'].includes(channel)) {
    return { success: false, error: '无效的验证方式，仅支持 phone 或 email' };
  }
  if (!target || target.trim().length < 3) {
    return { success: false, error: channel === 'phone' ? '请输入有效手机号' : '请输入有效邮箱' };
  }

  const serverResult = await _serverRequest('POST', '/api/password-reset/send-code', {
    channel,
    target: target.trim(),
  });

  if (serverResult && serverResult.success) {
    return { success: true, message: serverResult.message || `验证码已发送到 ${target}` };
  }

  if (serverResult && serverResult.message) {
    return { success: false, error: serverResult.message };
  }

  return {
    success: false,
    error: '验证码发送功能需要后端服务支持。请确保服务已启动，或使用密保问题找回密码',
  };
}

/**
 * Reset password using a verification code received via phone or email.
 * Requires the backend server to be running.
 * @param {'phone'|'email'} channel
 * @param {string} target - Phone number or email
 * @param {string} code - Verification code
 * @param {string} newPassword
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function resetPasswordWithVerificationCode(channel, target, code, newPassword) {
  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: '新密码至少 6 个字符' };
  }
  if (!code || code.trim().length < 4) {
    return { success: false, error: '请输入有效的验证码' };
  }

  const serverResult = await _serverRequest('POST', '/api/password-reset/verify-code', {
    channel,
    target: target.trim(),
    code: code.trim(),
    newPassword,
  });

  if (serverResult && serverResult.success) {
    // Sync to local credentials
    const creds = _loadCredentials();
    if (creds) {
      const { hash, salt } = _hashPassword(newPassword);
      creds.passwordHash = hash;
      creds.passwordSalt = salt;
      _saveCredentials(creds);
    }
    return { success: true, message: serverResult.message || '密码重置成功' };
  }

  if (serverResult && serverResult.message) {
    return { success: false, error: serverResult.message };
  }

  return {
    success: false,
    error: '验证码重置功能需要后端服务支持。请确保服务已启动',
  };
}

/**
 * Update user's phone number or email (for future verification code recovery).
 * Stored locally and synced to server when available.
 */
async function updateContactInfo(currentPassword, phone, email) {
  const creds = _loadCredentials();
  if (!creds) return { success: false, error: '未注册' };

  if (!_verifyPassword(currentPassword, creds.passwordHash, creds.passwordSalt)) {
    return { success: false, error: '密码错误' };
  }

  if (phone) creds.phone = phone.trim();
  if (email) creds.email = email.trim();
  _saveCredentials(creds);

  return { success: true };
}

module.exports = {
  // Core auth
  isRegistered,
  checkSession,
  getSessionAuthToken,
  register,
  login,
  logout,
  getCurrentUser,
  changePassword,
  // Security question recovery
  setSecurityQuestion,
  getSecurityQuestion,
  resetPasswordWithSecurityAnswer,
  // Verification code recovery (phone / email)
  requestVerificationCode,
  resetPasswordWithVerificationCode,
  updateContactInfo,
  // Constants
  SECURITY_QUESTIONS,
};
