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

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { safeReadJsonSync, safeWriteJsonSync } = require('./configGuard');

// Lazily resolve the app home (portable-aware); fallback to legacy path.
// No local caching: preserves getAppHome() live-resolve semantics.
function _khyDir() {
  try {
    const { getAppHome } = require('../utils/dataHome');
    return getAppHome();
  } catch {
    return path.join(os.homedir(), '.khyquant');
  }
}

function _credentialsFile() {
  return path.join(_khyDir(), 'credentials.json');
}

function _sessionFile() {
  return path.join(_khyDir(), 'session.json');
}

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
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function _verifyPassword(password, storedHash, storedSalt) {
  const { hash } = _hashPassword(password, storedSalt);
  return hash === storedHash;
}

// ─── Credential & Session Storage ──────────────────────────────────────────

function _ensureDir() {
  const dir = _khyDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function _loadCredentials() {
  try {
    if (fs.existsSync(_credentialsFile())) {
      const raw = JSON.parse(fs.readFileSync(_credentialsFile(), 'utf-8'));
      // ARCH-074: 软校验 aliases 字段。非数组/含非字符串元素 → 视为空。
      if (raw && typeof raw === 'object') {
        if (!Array.isArray(raw.aliases)) {
          raw.aliases = [];
        } else {
          raw.aliases = raw.aliases.filter((a) => typeof a === 'string');
        }
      }
      return raw;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function _saveCredentials(creds) {
  _ensureDir();
  fs.writeFileSync(_credentialsFile(), JSON.stringify(creds, null, 2));
  try {
    fs.chmodSync(_credentialsFile(), 0o600);
  } catch {
    /* Windows */
  }
}

function _loadSession() {
  const { data } = safeReadJsonSync(_sessionFile(), { schema: null, silent: true });
  return data || null;
}

function _clearSessionFile() {
  try {
    if (fs.existsSync(_sessionFile())) {
      fs.unlinkSync(_sessionFile());
    }
  } catch {
    /* ignore */
  }
}

function _isExpiredTimestamp(value) {
  if (!value) {
    return false;
  }
  const expiresAtMs = new Date(value).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }
  return expiresAtMs <= Date.now();
}

function _loadActiveSession() {
  const session = _loadSession();
  if (!session) {
    return null;
  }
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
      if (expiresAt) {
        session.expiresAt = expiresAt;
      }
    }
  } catch {
    /* best-effort;派生失败则退化为无 expiresAt */
  }
  if (serverToken) {
    session.serverToken = serverToken;
  }
  if (options.refreshToken) {
    session.serverRefreshToken = options.refreshToken;
  }
  if (options.serverTokenExpiresAt) {
    session.serverTokenExpiresAt = options.serverTokenExpiresAt;
  }
  if (options.serverRefreshExpiresAt) {
    session.serverRefreshExpiresAt = options.serverRefreshExpiresAt;
  }
  safeWriteJsonSync(_sessionFile(), session, { mode: 0o600 });
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
      const req = http.request(
        {
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
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    } catch {
      resolve(null);
    }
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
  if (!session) {
    return '';
  }
  const token = String(session.serverToken || '').trim();
  return token || '';
}

/**
 * Register a new account.
 * Tries server first (shared with frontend), falls back to local.
 *
 * ARCH-074: 第六个可选参数 `aliases` (string[])：登录别名集合（不含 username/email）。
 * 跨账号唯一性由 aio backend /api/auth/register 保证；本机兜底时直接落进 credentials.json。
 */
async function register(username, password, email, securityQuestion, securityAnswer, aliases) {
  if (!username || username.length < 2) {
    return { success: false, error: '用户名至少 2 个字符' };
  }
  if (!password || password.length < 6) {
    return { success: false, error: '密码至少 6 个字符' };
  }

  const existing = _loadCredentials();
  if (existing) {
    return {
      success: false,
      error: '本机已有注册账号。如需重置请删除 ~/.khyquant/credentials.json',
    };
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
  // ARCH-074: 透传别名到 aio backend register 端点；服务端负责跨账号唯一性校验。
  if (Array.isArray(aliases) && aliases.length > 0) {
    serverData.aliases = aliases.filter((a) => typeof a === 'string' && a.trim().length > 0);
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
  // ARCH-074: alias 镜像到本机（离线登录也按 alias 查找）。server 返回的 aliases 优先。
  if (serverAuthData && serverAuthData.user && Array.isArray(serverAuthData.user.aliases)) {
    creds.aliases = serverAuthData.user.aliases.filter((a) => typeof a === 'string');
  } else if (Array.isArray(aliases)) {
    creds.aliases = aliases.filter((a) => typeof a === 'string' && a.trim().length > 0);
  }

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
// Built-in fallback accounts — loaded from environment variables only.
// Set CLI_BUILTIN_ACCOUNTS="user1:pass1:role1,user2:pass2:role2" to override.
// When the env var is absent, the offline fallback is the auto-generated
// default admin persisted at .khy/credentials/default-admin.json (created by
// the unified credentialGenerator during first seeding). No credentials file
// → no builtin fallback: login must go through the server or local register.
//
// ARCH-074: 每次调用前先异步触发 ensureDefaultAdminPassword（fire-and-forget，
// 不阻塞离线 fallback），保证 aio backend User 表里的默认管理员密码
// 与本机 default-admin.json 同步。该调用是幂等的且 fail-soft（数据库不可用时
// 静默返回），不抛错、不影响 CLI 登录。
function _loadBuiltinAccounts() {
  const raw = String(process.env.CLI_BUILTIN_ACCOUNTS || '').trim();
  if (!raw) {
    try {
      const credentialGenerator = require('./credentialGenerator');
      // fire-and-forget: 不 await CLI 启动；失败仅 stderr
      if (typeof credentialGenerator.ensureDefaultAdminPassword === 'function') {
        credentialGenerator
          .ensureDefaultAdminPassword()
          .then((result) => {
            if (result && result.ok && result.updated) {
              console.log(
                `[cliAuthService] 默认管理员密码已在数据库中更新为新随机密码，username=${result.username}`
              );
            }
          })
          .catch(() => {
            /* best-effort */
          });
      }
      const creds = credentialGenerator.readDefaultAdminCredentials();
      if (creds) {
        return [{ username: creds.username, password: creds.password, role: 'admin' }];
      }
    } catch {
      /* credentials file unavailable — no builtin fallback */
    }
    return [];
  }
  return raw
    .split(',')
    .map((entry, idx) => {
      const parts = entry
        .split(':')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length < 3) {
        console.warn(`[cliAuthService] skipping malformed builtin account entry #${idx}: ${entry}`);
        return null;
      }
      return { username: parts[0], password: parts[1], role: parts[2] };
    })
    .filter(Boolean);
}

async function login(username, password, timeoutMs) {
  // Built-in admin: bypass server/local, create session directly.
  // Loaded lazily on each attempt so a credentials file generated after
  // process start (first seeding) is picked up without a restart.
  const builtinMatch = _loadBuiltinAccounts().find(
    (a) => a.username === username && a.password === password
  );
  if (builtinMatch) {
    _saveSession(username, null, builtinMatch.role);
    return { success: true, username, role: builtinMatch.role, source: 'builtin' };
  }

  // Try server login first (accounts shared with frontend)
  const serverResult = await _serverRequest(
    'POST',
    '/api/auth/login',
    { username, password },
    timeoutMs
  );

  if (serverResult && serverResult.success && serverResult.data) {
    const serverAuthData = serverResult.data;
    const serverToken = serverAuthData.token;
    const serverUser = serverAuthData.user;

    // Update local credentials to match server (keeps offline fallback in sync)
    const { hash, salt } = _hashPassword(password);
    const existing = _loadCredentials() || {};
    // ARCH-074: 镜像 server 返回的 aliases（应用层保证 username 不在 aliases 里）
    const serverAliases = Array.isArray(serverUser.aliases)
      ? serverUser.aliases.filter((a) => typeof a === 'string')
      : [];
    const creds = {
      ...existing,
      username: serverUser.username || username,
      email: serverUser.email || existing.email || '',
      passwordHash: hash,
      passwordSalt: salt,
      serverSynced: true,
      aliases: serverAliases,
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

    return {
      success: true,
      username: creds.username,
      matchedBy: serverAuthData.matchedBy || 'username',
      source: 'server',
    };
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

  // ARCH-074: 本机按 username / email / aliases 任一查找
  const credAliases = Array.isArray(creds.aliases) ? creds.aliases : [];
  const localMatchedBy = (() => {
    if (creds.username === username) return 'username';
    if (creds.email && creds.email === username) return 'email';
    if (credAliases.includes(username)) return 'alias';
    return null;
  })();
  if (!localMatchedBy) {
    return { success: false, error: '用户名不匹配' };
  }

  if (!_verifyPassword(password, creds.passwordHash, creds.passwordSalt)) {
    return { success: false, error: '密码错误' };
  }

  _saveSession(username, null);
  return { success: true, username, matchedBy: localMatchedBy, source: 'local' };
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
  if (!session || !creds) {
    return null;
  }
  // 向后兼容:历史 session.json 无 expiresAt(旧 _saveSession 从不写),从 loginAt + 7 天派生,
  // 使 whoami 面板对既有登录也能显示合理到期时间而非缺失。门控关 → 派生返回原 undefined。绝不抛。
  let sessionExpires = session.expiresAt;
  try {
    const authTime = require('./authTimeFormat');
    if (authTime.isEnabled()) {
      sessionExpires = authTime.deriveSessionExpiry(
        session.expiresAt,
        session.loginAt,
        SESSION_MAX_AGE_MS
      );
    }
  } catch {
    /* best-effort;退化为原始 session.expiresAt */
  }
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
  if (!creds) {
    return { success: false, error: '未注册' };
  }

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
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/auth/change-password',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
              Authorization: `Bearer ${session.serverToken}`,
            },
            timeout: 5000,
          },
          () => resolve()
        );
        req.on('error', () => resolve());
        req.on('timeout', () => {
          req.destroy();
          resolve();
        });
        req.write(data);
        req.end();
      } catch {
        resolve();
      }
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
  if (!creds) {
    return { success: false, error: '未注册' };
  }

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
  const serverResult = await _serverRequest('POST', '/api/password-reset/get-question', {
    username,
  });
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
    return {
      success: false,
      error: '未设置密保问题。请联系管理员或删除 ~/.khyquant/credentials.json 重新注册',
    };
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
  if (!creds) {
    return { success: false, error: '未注册' };
  }

  if (!_verifyPassword(currentPassword, creds.passwordHash, creds.passwordSalt)) {
    return { success: false, error: '密码错误' };
  }

  if (phone) {
    creds.phone = phone.trim();
  }
  if (email) {
    creds.email = email.trim();
  }
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
