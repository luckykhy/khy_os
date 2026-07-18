'use strict';

/**
 * accountPool / candidateDetect — 凭据来源探测与候选采集子系统。
 *
 * 从 accountPool.js(上帝文件·>2500 LOC)抽出的内聚簇:扫描本地 IDE/CLI 登录存储
 * (Windsurf/Trae/Cursor/Warp/Kiro/Nirvana 及通用 JSON/vscdb),把磁盘上的登录态归一
 * 为「候选凭据记录」。**只探测、只采集,绝不落库**——所有持久化(addAccount/
 * upsertTokenRecord 等 DB-core)留在宿主 accountPool.js;本模块对 DB-core 零回调
 * (单向 host→leaf,无循环依赖)。
 *
 * 注意:本模块 **不是** 纯零 IO 叶子——它读文件系统、起子进程解压归档(unrar/unzip)、
 * 懒加载 better-sqlite3 读 Cursor vscdb。IO 是「探测」的固有职责;纯归一化/校验/掩码
 * 逻辑已在 ./credentialHelpers。宿主按 **同名 re-import** 接回全部导出,调用点字节不变
 * (降上帝文件·范式同 queryBridgeTimeline / appHostHelpers)。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  normalizePoolType,
  safeJsonParse,
  tokenHash,
  formatIso,
  normalizeTokenValue,
  _isPlaceholderEmail,
  _isPlaceholderValue,
  isValidEmail,
  hasTokenShape,
  hasLooseTokenShape,
  coerceObject,
  decodeMaybeURIComponent,
  parseCallbackPayload,
  firstNonEmpty,
  dedupePaths,
} = require('./credentialHelpers');

const KIRO_TOKEN_PATH = path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');

/**
 * All candidate paths where Kiro tokens might exist (multi-platform).
 * Mirrors kiroAdapter.getKiroTokenCandidatePaths() for pool scanning.
 * On Windows, probes %USERPROFILE%, %HOMEDRIVE%%HOMEPATH%, %APPDATA%,
 * and %LOCALAPPDATA% to handle os.homedir() mismatch.
 */
function _getKiroTokenCandidatePaths() {
  const seen = new Set();
  const paths = [];
  const add = (p) => { const n = path.normalize(p); if (!seen.has(n)) { seen.add(n); paths.push(n); } };
  if (process.env.KIRO_TOKEN_PATH) add(process.env.KIRO_TOKEN_PATH);
  add(KIRO_TOKEN_PATH);
  const isWin = process.platform === 'win32';
  if (isWin) {
    const up = process.env.USERPROFILE || '';
    const hp = process.env.HOMEDRIVE && process.env.HOMEPATH
      ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH) : '';
    const ad = process.env.APPDATA || '';
    const la = process.env.LOCALAPPDATA || '';
    if (up) add(path.join(up, '.aws', 'sso', 'cache', 'kiro-auth-token.json'));
    if (hp) add(path.join(hp, '.aws', 'sso', 'cache', 'kiro-auth-token.json'));
    if (ad) add(path.join(ad, 'aws', 'sso', 'cache', 'kiro-auth-token.json'));
    if (la) add(path.join(la, 'aws', 'sso', 'cache', 'kiro-auth-token.json'));
    if (ad) add(path.join(ad, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'auth.json'));
    if (la) add(path.join(la, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'auth.json'));
  }
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    add(path.join(xdg, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'auth.json'));
  }
  if (process.platform === 'darwin') {
    add(path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'auth.json'));
  }
  return paths;
}
const CURSOR_STORAGE_PATHS = [
  path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'storage.json'),
];
const CURSOR_DB_PATHS = [
  path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
];
const WARP_STORAGE_PATHS = [
  path.join(os.homedir(), '.config', 'warp-terminal', 'storage.json'),
  path.join(os.homedir(), '.config', 'warp-terminal', 'auth.json'),
  path.join(os.homedir(), '.local', 'share', 'warp-terminal', 'storage.json'),
  path.join(os.homedir(), '.local', 'share', 'warp-terminal', 'auth.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'warp-terminal', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'warp-terminal', 'auth.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'warp-terminal', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'warp-terminal', 'auth.json'),
];
const NIRVANA_STORAGE_PATHS = [
  path.join(os.homedir(), '.config', 'Nirvana', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), '.config', 'nirvana', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Nirvana', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'nirvana', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Nirvana', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'nirvana', 'User', 'globalStorage', 'storage.json'),
];
const NIRVANA_DEFAULT_ROOTS = [
  path.join(os.homedir(), 'Downloads', 'nirvana'),
  path.join(os.homedir(), 'Downloads', 'Nirvana'),
  path.join(os.homedir(), '.nirvana'),
];
// Nirvana trae_local_cache.json — 包含 session_cookies (60天) + access_token (8h)
const NIRVANA_TRAE_CACHE_PATHS = [
  String(process.env.NIRVANA_TRAE_CACHE || '').trim(),
  path.join(os.homedir(), 'AppData', 'Roaming', 'nirvana', 'trae_local_cache.json'),
  path.join(os.homedir(), '.config', 'nirvana', 'trae_local_cache.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'nirvana', 'trae_local_cache.json'),
].filter(Boolean);
const NIRVANA_PRESET_LOGIN_EMAIL = String(process.env.NIRVANA_DEFAULT_LOGIN_EMAIL || '2578974124@qq.com').trim();
const NIRVANA_CALLBACK_FIELDS = [
  'refreshToken',
  'refreshExpireAt',
  'host',
  'userJwt',
  'userInfo',
];
const OBSERVED_AUTO_IMPORT_DEFAULT_SOURCE_PATH = path.join(os.homedir(), 'Downloads', 'nirvana-source.zip');
const OBSERVED_AUTO_IMPORT_DEFAULT_COOLDOWN_MS = 45 * 1000;

const KNOWN_NIRVANA_PROVIDER_SET = new Set([
  'trae', 'warp', 'cursor', 'kiro', 'windsurf',
  'openai', 'anthropic', 'deepseek', 'qwen', 'glm', 'doubao', 'wenxin', 'relay',
]);


function resolveObservedAutoImportSourcePath(options = {}) {
  const preferred = String(options.sourcePath || '').trim();
  if (preferred) return preferred;

  const candidates = [];
  if (options.includeEnvSource !== false) {
    candidates.push(
      String(process.env.KHY_POOL_AUTO_IMPORT_SOURCE || '').trim(),
      String(process.env.KHY_ACCOUNT_POOL_AUTO_IMPORT_SOURCE || '').trim(),
      String(process.env.NIRVANA_IMPORT_PATH || '').trim(),
    );
  }
  if (options.includeDefaultSource !== false) {
    candidates.push(OBSERVED_AUTO_IMPORT_DEFAULT_SOURCE_PATH);
  }
  const deduped = dedupePaths(candidates);
  if (deduped.length === 0) return '';

  for (const candidate of deduped) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore path access errors, fallback to next candidate
    }
  }
  return deduped[0];
}

function resolveObservedAutoImportCooldownMs(options = {}) {
  const raw = options.cooldownMs
    ?? process.env.KHY_POOL_AUTO_IMPORT_COOLDOWN_MS
    ?? process.env.KHY_ACCOUNT_POOL_AUTO_IMPORT_COOLDOWN_MS
    ?? OBSERVED_AUTO_IMPORT_DEFAULT_COOLDOWN_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return OBSERVED_AUTO_IMPORT_DEFAULT_COOLDOWN_MS;
  return Math.min(Math.max(Math.floor(parsed), 5000), 10 * 60 * 1000);
}

function resolveArchiveImportRoot(inputPath = '') {
  const src = String(inputPath || '').trim();
  if (!src) return null;
  let stat;
  try {
    stat = fs.statSync(src);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const ext = path.extname(src).toLowerCase();
  if (!['.rar', '.zip'].includes(ext)) return null;

  // Use stable directory name based on source path hash + file mtime.
  // This prevents creating a new temp dir on every import cycle and avoids
  // re-extracting when the archive hasn't changed.
  const mtimeMs = stat.mtimeMs || 0;
  const dirHash = crypto.createHash('sha256')
    .update(`${src}:${mtimeMs}`)
    .digest('hex')
    .slice(0, 12);
  const extractDir = path.join(os.tmpdir(), `khy_pool_import_${dirHash}`);

  // Skip extraction if the cached dir already exists and is non-empty.
  try {
    const existing = fs.readdirSync(extractDir);
    if (existing.length > 0) return extractDir;
  } catch { /* dir doesn't exist yet */ }

  fs.mkdirSync(extractDir, { recursive: true });

  let result = null;
  if (ext === '.rar') {
    result = spawnSync('unrar', ['x', '-o+', '-inul', src, extractDir], {
      stdio: 'ignore',
      timeout: 120000,
    });
  } else if (ext === '.zip') {
    result = spawnSync('unzip', ['-o', '-qq', src, '-d', extractDir], {
      stdio: 'ignore',
      timeout: 120000,
    });
  }

  if (!result || result.error || result.status !== 0) {
    cleanupArchiveExtractDirs([extractDir]);
    return null;
  }
  return extractDir;
}

function cleanupArchiveExtractDirs(dirs) {
  if (!dirs || typeof dirs[Symbol.iterator] !== 'function') return;
  for (const dir of dirs) {
    const target = String(dir || '').trim();
    if (!target) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function resolveNirvanaDefaultRoots() {
  const roots = [...NIRVANA_DEFAULT_ROOTS];

  if (process.platform === 'win32') {
    const programFilesCandidates = dedupePaths([
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env.ProgramW6432,
      'C:\\Program Files',
      'C:\\Program Files (x86)',
    ]);
    for (const base of programFilesCandidates) {
      roots.push(path.join(base, 'nirvana'));
      roots.push(path.join(base, 'Nirvana'));
    }
  }

  const isWsl = process.platform === 'linux'
    && (
      !!process.env.WSL_DISTRO_NAME
      || !!process.env.WSL_INTEROP
      || fs.existsSync('/mnt/c/Windows')
    );
  if (isWsl) {
    const wslProgramFilesCandidates = dedupePaths([
      '/mnt/c/Program Files',
      '/mnt/c/Program Files (x86)',
    ]);
    for (const base of wslProgramFilesCandidates) {
      roots.push(path.join(base, 'nirvana'));
      roots.push(path.join(base, 'Nirvana'));
    }
  }

  const downloadsDir = path.join(os.homedir(), 'Downloads');
  try {
    const entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry || !entry.name) continue;
      const name = String(entry.name).trim();
      if (!name) continue;
      if (!/^nirvana/i.test(name)) continue;
      roots.push(path.join(downloadsDir, name));
    }
  } catch {
    // ignore
  }
  return dedupePaths(roots);
}

function normalizeNirvanaProviderHint(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const direct = normalizePoolType(raw);
  if (direct) {
    if (KNOWN_NIRVANA_PROVIDER_SET.has(direct)) return direct;
    if (direct === 'claude') return 'anthropic';
    if (direct === 'codeium') return 'windsurf';
  }
  if (raw.includes('claude') || raw.includes('anthropic')) return 'anthropic';
  if (raw.includes('openai') || raw.includes('chatgpt')) return 'openai';
  if (raw.includes('deepseek')) return 'deepseek';
  if (raw.includes('dashscope') || raw.includes('tongyi') || raw.includes('qwen') || raw.includes('aliyun') || raw.includes('alibaba')) return 'qwen';
  if (raw.includes('zhipu') || raw.includes('glm')) return 'glm';
  if (raw.includes('doubao') || raw.includes('volcengine')) return 'doubao';
  if (raw.includes('wenxin') || raw.includes('ernie') || raw.includes('baidu')) return 'wenxin';
  if (raw.includes('windsurf') || raw.includes('codeium')) return 'windsurf';
  if (raw.includes('cursor')) return 'cursor';
  if (raw.includes('kiro')) return 'kiro';
  if (raw.includes('warp')) return 'warp';
  if (raw.includes('trae') || raw.includes('bytedance') || raw.includes('nirvana')) return 'trae';
  if (raw.includes('relay') || raw.includes('proxy')) return 'relay';
  return null;
}

function _scanText(value, maxLen = 3200) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, maxLen);
  try {
    const text = JSON.stringify(value);
    return text ? text.slice(0, maxLen) : '';
  } catch {
    return '';
  }
}

function detectNirvanaProvider(record = {}, callback = {}, sourcePath = '', fallbackProvider = 'trae') {
  const explicitHints = [
    record.provider,
    record.poolType,
    record.type,
    record.channel,
    record.platform,
    record.vendor,
    record.service,
    record.source,
    callback.provider,
    callback.poolType,
    callback.type,
    callback.channel,
    callback.platform,
    callback.vendor,
    callback.service,
    callback.source,
  ];
  for (const hint of explicitHints) {
    const normalized = normalizeNirvanaProviderHint(hint);
    if (normalized) return normalized;
  }

  const hostHint = firstNonEmpty([
    record.host,
    record.endpoint,
    record.baseUrl,
    record.baseURL,
    callback.host,
    callback.endpoint,
    callback.baseUrl,
    callback.baseURL,
  ]);
  const normalizedHost = normalizeNirvanaProviderHint(hostHint);
  if (normalizedHost) return normalizedHost;

  const mergedText = [
    _scanText(record),
    _scanText(callback),
    String(sourcePath || ''),
  ].join(' ').toLowerCase();

  const textRules = [
    { re: /(warp-terminal|warp\.dev|warpauth|warpAuth|warp\.auth)/i, provider: 'warp' },
    { re: /(cursorauth|cursor|cursor\.com)/i, provider: 'cursor' },
    { re: /(kiro|desktop\.kiro|kiro-auth-token)/i, provider: 'kiro' },
    { re: /(windsurf|codeium|windsurfauth)/i, provider: 'windsurf' },
    { re: /(trae|bytedance|nirvana|traeauth|nirvanaauth|userjwt)/i, provider: 'trae' },
    { re: /(anthropic|claude)/i, provider: 'anthropic' },
    { re: /(openai|chatgpt)/i, provider: 'openai' },
    { re: /(deepseek)/i, provider: 'deepseek' },
    { re: /(dashscope|qwen|tongyi|alibaba|aliyun)/i, provider: 'qwen' },
    { re: /(zhipu|glm)/i, provider: 'glm' },
    { re: /(doubao|volcengine)/i, provider: 'doubao' },
    { re: /(wenxin|ernie|baidu)/i, provider: 'wenxin' },
    { re: /(relay|proxy)/i, provider: 'relay' },
  ];
  for (const rule of textRules) {
    if (rule.re.test(mergedText)) return rule.provider;
  }

  return normalizeNirvanaProviderHint(fallbackProvider) || 'trae';
}

function walkCandidateFiles(rootPath, options = {}) {
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 6;
  const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Number(options.maxFiles) : 400;
  const out = [];
  const seen = new Set();
  const stack = [{ p: rootPath, d: 0 }];
  const exts = new Set(['.json', '.jsonl', '.log', '.txt']);

  while (stack.length > 0 && out.length < maxFiles) {
    const current = stack.pop();
    if (!current || !current.p) continue;
    if (seen.has(current.p)) continue;
    seen.add(current.p);

    let stat;
    try {
      stat = fs.statSync(current.p);
    } catch {
      continue;
    }

    if (stat.isFile()) {
      const ext = path.extname(current.p).toLowerCase();
      if (!exts.has(ext)) continue;
      if (stat.size > 5 * 1024 * 1024) continue;
      out.push(current.p);
      continue;
    }

    if (!stat.isDirectory()) continue;
    if (current.d >= maxDepth) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(current.p, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const name = String(entry?.name || '');
      if (!name || name === '.' || name === '..') continue;
      if (name === 'node_modules' || name === '.git' || name === '.cache') continue;
      const next = path.join(current.p, name);
      stack.push({ p: next, d: current.d + 1 });
    }
  }

  return out;
}

function readCursorTokenFromVscdb(dbPath) {
  let db = null;
  try {
    const Database = require('better-sqlite3');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tokenKeys = [
      'cursorAuth/accessToken',
      'cursorAuth.accessToken',
      'accessToken',
      'cursor.accessToken',
    ];
    for (const key of tokenKeys) {
      try {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
        if (row && row.value) {
          const token = typeof row.value === 'string' ? row.value : row.value.toString('utf8');
          db.close();
          db = null;
          return normalizeTokenValue(token);
        }
      } catch { /* try next key */ }
    }
    db.close();
    db = null;
  } catch {
    if (db) { try { db.close(); } catch { /* ignore */ } db = null; }
    try {
      const raw = fs.readFileSync(dbPath);
      const content = raw.toString('utf8', 0, Math.min(raw.length, 1024 * 1024));
      const patterns = [
        /cursorAuth[\/.]accessToken[^A-Za-z0-9._-]+([A-Za-z0-9._-]{20,})/,
        /accessToken[^A-Za-z0-9._-]+(eyJ[A-Za-z0-9._-]{20,})/,
      ];
      for (const re of patterns) {
        const m = content.match(re);
        if (m && hasTokenShape(m[1])) return normalizeTokenValue(m[1]);
      }
    } catch { /* ignore */ }
  }
  return null;
}

function collectNirvanaCandidatesFromRecord(record, sourcePath = '', options = {}) {
  const rec = record && typeof record === 'object' ? record : null;
  if (!rec) return null;

  const callback = parseCallbackPayload(rec.callback);
  const defaultProvider = normalizeNirvanaProviderHint(options.defaultProvider || 'trae') || 'trae';
  const filterProvider = normalizeNirvanaProviderHint(options.provider || '');
  const provider = detectNirvanaProvider(rec, callback, sourcePath, defaultProvider);
  if (filterProvider && provider !== filterProvider) return null;
  const userInfoRaw = firstNonEmpty([rec.userInfo, callback.userInfo]);
  const userInfoDecoded = typeof userInfoRaw === 'string' ? decodeMaybeURIComponent(userInfoRaw) : userInfoRaw;
  const userInfo = coerceObject(userInfoDecoded) || (userInfoDecoded && typeof userInfoDecoded === 'object' ? userInfoDecoded : null);

  const accessToken = firstNonEmpty([
    rec.accessToken,
    rec.access_token,
    callback.accessToken,
    callback.access_token,
    rec.userJwt,
    callback.userJwt,
    rec.token,
  ]);
  const refreshToken = firstNonEmpty([
    rec.refreshToken,
    rec.refresh_token,
    callback.refreshToken,
    callback.refresh_token,
  ]);
  // Only accept email-shaped values: a bare username (e.g. "john") is not an
  // identity we count, and must not shadow a real `user@domain` living in a
  // later field (userInfo.email, …).
  const detectedEmail = firstNonEmpty([
    rec.email,
    rec.userEmail,
    rec.username,
    callback.email,
    userInfo && userInfo.email,
    userInfo && userInfo.userEmail,
    userInfo && userInfo.username,
  ].filter((v) => isValidEmail(v)));
  const presetEmail = (options.usePresetEmail !== false && provider === 'trae')
    ? firstNonEmpty([options.defaultEmail, NIRVANA_PRESET_LOGIN_EMAIL])
    : null;
  const email = firstNonEmpty([detectedEmail, presetEmail]);
  const host = firstNonEmpty([rec.host, callback.host]);
  const refreshExpireAt = firstNonEmpty([rec.refreshExpireAt, callback.refreshExpireAt, rec.expiresAt, callback.expiresAt]);
  const userJwt = firstNonEmpty([rec.userJwt, callback.userJwt]);
  const password = firstNonEmpty([
    rec.password,
    rec.passwd,
    rec.pass,
    rec.loginPassword,
    callback.password,
    callback.passwd,
    callback.pass,
  ]);

  const normalizedAccess = hasTokenShape(accessToken) ? normalizeTokenValue(accessToken) : null;
  const normalizedRefresh = (hasTokenShape(refreshToken) || hasLooseTokenShape(refreshToken))
    ? normalizeTokenValue(refreshToken)
    : null;
  const callbackSnapshot = {};
  for (const key of NIRVANA_CALLBACK_FIELDS) {
    const value = firstNonEmpty([rec[key], callback[key]]);
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      callbackSnapshot[key] = value;
    }
  }
  if (email) callbackSnapshot.email = String(email).trim();
  if (!detectedEmail && presetEmail) callbackSnapshot.presetEmail = String(presetEmail).trim();

  const normalizedPassword = password ? String(password).trim() : null;

  // Reject placeholder / fake credentials (CJK field names, example.com, [object Object], etc.)
  if (email && _isPlaceholderEmail(email)) {
    // If the only credential source is email+password and the email is a placeholder, reject entirely
    if (!normalizedAccess && !normalizedRefresh) return null;
    // If tokens exist, clear the bogus email but keep the token-based credentials
  }
  if (normalizedPassword && _isPlaceholderValue(normalizedPassword)) {
    if (!normalizedAccess && !normalizedRefresh) return null;
  }

  if (!normalizedAccess && !normalizedRefresh && !(email && normalizedPassword)) return null;
  // Final guard: even if email+password passed earlier checks, reject if both are placeholders
  if (!normalizedAccess && !normalizedRefresh && (_isPlaceholderEmail(email) || _isPlaceholderValue(normalizedPassword))) return null;

  return {
    provider,
    email: email ? String(email).trim() : null,
    password: normalizedPassword || null,
    label: email
      ? `${provider}:${String(email).trim()}`
      : (normalizedPassword ? `${provider}:credentials` : `${provider}:oauth`),
    accessToken: normalizedAccess,
    refreshToken: normalizedRefresh,
    sourcePath,
    authData: {
      source: 'nirvana',
      path: sourcePath,
      refreshExpireAt: refreshExpireAt || null,
      host: host || null,
      userJwt: userJwt || null,
      userInfo: userInfo || null,
      callback: callbackSnapshot,
      callbackFields: NIRVANA_CALLBACK_FIELDS,
      expiresAt: formatIso(refreshExpireAt),
    },
    accountType: 'LOGIN',
    priority: 11,
    metadata: {
      source: 'nirvana',
      provider,
    },
  };
}

function collectGenericCandidateFromRecord(record, sourcePath = '', provider = '') {
  const rec = record && typeof record === 'object' ? record : null;
  if (!rec) return null;

  const callback = parseCallbackPayload(rec.callback);
  const auth = rec.authData && typeof rec.authData === 'object' ? rec.authData : {};
  const userInfo = rec.userInfo && typeof rec.userInfo === 'object' ? rec.userInfo : null;

  const accessToken = firstNonEmpty([
    rec.accessToken,
    rec.access_token,
    rec.apiKey,
    rec.api_key,
    rec.token,
    rec.bearerToken,
    rec.idToken,
    auth.accessToken,
    auth.access_token,
    callback.accessToken,
    callback.access_token,
    callback.token,
  ]);
  const refreshToken = firstNonEmpty([
    rec.refreshToken,
    rec.refresh_token,
    auth.refreshToken,
    auth.refresh_token,
    callback.refreshToken,
    callback.refresh_token,
  ]);
  const email = firstNonEmpty([
    rec.email,
    rec.userEmail,
    rec.username,
    rec.account,
    rec.login,
    userInfo && userInfo.email,
    userInfo && userInfo.userEmail,
    callback.email,
  ]);
  const password = firstNonEmpty([
    rec.password,
    rec.passwd,
    rec.pass,
    rec.loginPassword,
  ]);
  const endpoint = firstNonEmpty([
    rec.endpoint,
    rec.baseUrl,
    rec.baseURL,
    rec.apiBase,
    rec.host,
    auth.endpoint,
    auth.baseUrl,
    auth.baseURL,
    callback.host,
  ]);
  const expiresAt = firstNonEmpty([
    rec.expiresAt,
    rec.expireAt,
    rec.expiredAt,
    rec.refreshExpireAt,
    auth.expiresAt,
    callback.expiresAt,
    callback.refreshExpireAt,
  ]);

  const normalizedAccess = (hasTokenShape(accessToken) || hasLooseTokenShape(accessToken))
    ? normalizeTokenValue(accessToken)
    : null;
  const normalizedRefresh = (hasTokenShape(refreshToken) || hasLooseTokenShape(refreshToken))
    ? normalizeTokenValue(refreshToken)
    : null;
  const normalizedProvider = normalizeNirvanaProviderHint(provider) || normalizePoolType(provider) || 'trae';
  if (!normalizedAccess && !normalizedRefresh && !email) return null;

  return {
    provider: normalizedProvider,
    email: email ? String(email).trim() : null,
    password: password ? String(password).trim() : null,
    label: email ? `${normalizedProvider}:${String(email).trim()}` : `${normalizedProvider}:imported`,
    accessToken: normalizedAccess,
    refreshToken: normalizedRefresh,
    sourcePath,
    authData: {
      source: 'generic-import',
      path: sourcePath,
      endpoint: endpoint || null,
      expiresAt: formatIso(expiresAt),
      callback: callback && Object.keys(callback).length > 0 ? callback : null,
    },
    accountType: 'LOGIN',
    priority: 9,
    metadata: {
      source: 'generic-import',
      provider: normalizedProvider,
    },
  };
}

function importGenericCandidatesFromPath(provider, sourcePath = '') {
  const normProvider = normalizeNirvanaProviderHint(provider) || normalizePoolType(provider) || 'trae';
  const found = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate) return;
    const accessHash = candidate.accessToken ? tokenHash(candidate.accessToken) : '';
    const refreshHash = candidate.refreshToken ? tokenHash(candidate.refreshToken) : '';
    const emailKey = candidate.email ? String(candidate.email).trim().toLowerCase() : '';
    const key = accessHash || refreshHash || emailKey || `${candidate.label || ''}|${candidate.sourcePath || ''}`;
    const dedupeKey = `${normProvider}:${key}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    found.push(candidate);
  };

  const rawRoot = String(sourcePath || '').trim();
  if (!rawRoot) return found;
  const extractedRoots = new Set();
  try {
    const extractedRoot = resolveArchiveImportRoot(rawRoot);
    if (extractedRoot) extractedRoots.add(extractedRoot);
    const scanRoots = dedupePaths([rawRoot, extractedRoot]);
    if (scanRoots.length === 0) return found;

    for (const root of scanRoots) {
      let stat;
      try {
        stat = fs.statSync(root);
      } catch {
        continue;
      }
      const files = stat.isFile()
        ? [root]
        : walkCandidateFiles(root, { maxDepth: 8, maxFiles: 1200 });

      for (const file of files) {
        let raw = '';
        try {
          raw = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (!raw.trim()) continue;

        const json = safeJsonParse(raw, null);
        if (Array.isArray(json)) {
          for (const row of json) {
            add(collectGenericCandidateFromRecord(row, file, normProvider));
          }
          continue;
        }
        if (json && typeof json === 'object') {
          const queue = [json];
          let scanned = 0;
          while (queue.length > 0 && scanned < 2000) {
            const node = queue.shift();
            scanned += 1;
            if (!node || typeof node !== 'object') continue;
            add(collectGenericCandidateFromRecord(node, file, normProvider));
            for (const v of Object.values(node)) {
              if (v && typeof v === 'object') queue.push(v);
            }
          }
          continue;
        }

        for (const line of raw.split('\n')) {
          const text = String(line || '').trim();
          if (!text) continue;
          if (text.startsWith('{') && text.endsWith('}')) {
            const obj = safeJsonParse(text, null);
            if (obj && typeof obj === 'object') {
              add(collectGenericCandidateFromRecord(obj, file, normProvider));
            }
          }
        }
      }
    }

    return found;
  } finally {
    cleanupArchiveExtractDirs(extractedRoots);
  }
}

module.exports = {
  // storage-path 常量(6 个与宿主 importer 共享,按同名 re-import 回宿主)
  CURSOR_STORAGE_PATHS,
  CURSOR_DB_PATHS,
  WARP_STORAGE_PATHS,
  NIRVANA_STORAGE_PATHS,
  NIRVANA_TRAE_CACHE_PATHS,
  NIRVANA_PRESET_LOGIN_EMAIL,
  // leaf 独有常量(宿主不再引用,导出供测试)
  KIRO_TOKEN_PATH,
  NIRVANA_DEFAULT_ROOTS,
  NIRVANA_CALLBACK_FIELDS,
  OBSERVED_AUTO_IMPORT_DEFAULT_SOURCE_PATH,
  OBSERVED_AUTO_IMPORT_DEFAULT_COOLDOWN_MS,
  KNOWN_NIRVANA_PROVIDER_SET,
  // 探测 / 采集函数
  _getKiroTokenCandidatePaths,
  resolveObservedAutoImportSourcePath,
  resolveObservedAutoImportCooldownMs,
  resolveArchiveImportRoot,
  cleanupArchiveExtractDirs,
  resolveNirvanaDefaultRoots,
  normalizeNirvanaProviderHint,
  _scanText,
  detectNirvanaProvider,
  walkCandidateFiles,
  readCursorTokenFromVscdb,
  collectNirvanaCandidatesFromRecord,
  collectGenericCandidateFromRecord,
  importGenericCandidatesFromPath,
};
