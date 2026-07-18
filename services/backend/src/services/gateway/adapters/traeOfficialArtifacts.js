/**
 * traeOfficialArtifacts.js
 *
 * 官方 Trae IDE 登录态扫描、iCube 痕迹提取、凭据聚合、会话验证。
 * 不依赖 Nirvana，直接读取 Trae/Trae CN 自身的 storage.json 和 state.vscdb。
 * 支持 icube.marscode AuthenticationProvider 桥接扩展 token 提取。
 *
 * 导出 (函数):
 *   resolveTraeOfficialStoragePaths()
 *   resolveTraeOfficialDbPaths()
 *   readTraeOfficialStorageSnapshots()
 *   readTraeOfficialDbSnapshots()
 *   extractTraeOfficialArtifactsFromStorage(data, sourcePath)
 *   extractTraeOfficialArtifactsFromDb(dbPath)
 *   collectTraeOfficialArtifacts()
 *   decodeTraeOfficialAuthBlob(raw)
 *   resolveTraeOfficialCredential(options)
 *   verifyTraeOfficialSession(credential, requestJsonFn)
 *   resolveNativeHostByRegion(regionHint)
 *   readMarsCodeAuthProviderToken()
 *
 * 导出 (常量):
 *   TRAE_NATIVE_API_PATHS   — 已知原生 API 路径 (逆向确认 2026-05-25)
 *   TRAE_KNOWN_NATIVE_HOSTS — 已知原生 API 主机 (含 product.json 第三轮确认)
 *   TRAE_REGION_HOST_MAP    — 区域 → 主机映射 (product.json ugApi)
 *   BRIDGE_EXTENSION_ID     — 桥接扩展 ID
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 路径解析 ──────────────────────────────────────────

// 官方 Trae 的应用名称（不包含 Nirvana）
const OFFICIAL_APP_NAMES = ['Trae CN', 'Trae'];

// ── 已知 Trae 原生 API 路径常量表 ─────────────────────
// 来源: Windows 端 main.js 逆向 (2026-05-25)
// 这些路径使用 x-cloudide-token 鉴权，非 OpenAI 兼容格式

const TRAE_NATIVE_API_PATHS = {
  // 第三方平台 token 换取 (飞书/Lark) — 非 AI 模型 token
  getThirdPartyToken: '/cloudide/api/v3/trae/GetThirdPartyToken',
  // 配置详情拉取 — 返回 config_info_list[].extra_config
  getDetailParam: '/api/ide/v1/get_detail_param',
  // CW 协议: AI 对话生成
  generateAssistantResponse: '/generateAssistantResponse',
  // CW 协议: 模型列表
  listAvailableModels: '/ListAvailableModels',
};

// 已知 Trae 原生 API 主机 (运行日志 + 代码逆向确认)
// 实际 host 由 iCubeAuthInfo.host 或 getApi(Kc.ugApi, path) 动态拼接
const TRAE_KNOWN_NATIVE_HOSTS = [
  // ── product.json 确认的区域主机 (第三轮 2026-05-25) ──
  'grow-normal.trae.ai',      // CN normal (默认)
  'growsg-normal.trae.ai',    // SG (新加坡)
  'growva-normal.trae.ai',    // US Virginia
  'grow-normal.traeapi.us',   // USTTP (美国 TTP)
  // ── 日志/逆向确认的主机 ──
  'core-normal.trae.ai',
  'api-us-east.trae.ai',
  'api-eu-west.trae.ai',
  'api-ap.trae.ai',
  'api-cn.trae.ai',
  'api.trae.cn',
  'api-cn-east.trae.ai',
  'adaptive-api.trae.ai',
];

// iCubeAuthInfo 解密后的 JSON 结构 (safeStorage.decryptString → JSON.parse)
// 仅作文档常量，不在运行时使用
// {
//   token: string,           // 用于 x-cloudide-token 请求头
//   refreshToken: string,
//   expiredAt: number,
//   refreshExpiredAt: number,
//   tokenReleaseAt: number,
//   userId: string,
//   host: string,            // 真实 API 基础主机 — 动态拼接自 product.json (ugApi)
//   userRegion: string,
//   account: {
//     username, email, avatar_url, description, scope, loginScope,
//     storeCountryCode, storeCountrySrc, storeRegion, userTag, migrateToSG
//   }
// }

// ── 区域 → 主机映射 (来源: product.json ugApi 字段, 第三轮调查 2026-05-25) ──
// iCubeAuthInfo.host 的值就是 product.json 中 ugApi 对应的主机
// 当无法从 blob 解密获取 host 时，根据 region hint 推断
const TRAE_REGION_HOST_MAP = {
  cn:    'grow-normal.trae.ai',       // CN normal (默认)
  sg:    'growsg-normal.trae.ai',     // SG (新加坡)
  va:    'growva-normal.trae.ai',     // US Virginia
  usttp: 'grow-normal.traeapi.us',    // USTTP (美国 TTP)
};

/**
 * 根据区域 hint 推断原生协议主机
 * @param {string|null} regionHint - 来自 iCubeServerData 的 region 或 userRegion 字段
 * @returns {string} 最佳匹配主机
 */
function resolveNativeHostByRegion(regionHint) {
  if (!regionHint) return TRAE_REGION_HOST_MAP.cn;
  const r = String(regionHint).toLowerCase().replace(/[^a-z]/g, '');
  if (r.includes('sg') || r.includes('singapore')) return TRAE_REGION_HOST_MAP.sg;
  if (r.includes('va') || r.includes('virginia') || r.includes('useast')) return TRAE_REGION_HOST_MAP.va;
  if (r.includes('usttp') || r.includes('ttp')) return TRAE_REGION_HOST_MAP.usttp;
  // cn-east, cn-north, cn 等全部走 CN normal
  return TRAE_REGION_HOST_MAP.cn;
}

// ── icube.marscode AuthenticationProvider 桥接读取 ────
// Trae 注册 AuthenticationProvider 'icube.marscode' 到 sandbox —
// 扩展可通过 vscode.authentication.getSession('icube.marscode', [])
// 获取 session.accessToken（即 iCubeAuthInfo 解密后的 token）。
//
// KHY 不在 Trae sandbox 内运行，无法直接调用 vscode API。
// 方案: 一个轻量桥接扩展将 token 写到约定位置，KHY 读取该文件。
// 约定路径: <globalStorage>/khy-trae-bridge/auth.json
// 内容格式: { "accessToken": "...", "refreshToken": "...", "expiresAt": "...", "host": "...", "userId": "...", "ts": <ms> }

const BRIDGE_EXTENSION_ID = 'khy-trae-bridge';
const BRIDGE_AUTH_FILENAME = 'auth.json';
const BRIDGE_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — 超过此值视为过期

/**
 * 扫描 Trae globalStorage 中的桥接扩展 token 文件
 * @returns {{ token: string|null, refreshToken: string|null, expiresAt: string|null, host: string|null, userId: string|null, bridgePath: string|null, stale: boolean }}
 */
function readMarsCodeAuthProviderToken() {
  const result = { token: null, refreshToken: null, expiresAt: null, host: null, userId: null, region: null, bridgePath: null, stale: false };
  const dirs = _globalStorageDirs();
  for (const dir of dirs) {
    const bridgePath = path.join(dir, BRIDGE_EXTENSION_ID, BRIDGE_AUTH_FILENAME);
    try {
      if (!fs.existsSync(bridgePath)) continue;
      const raw = fs.readFileSync(bridgePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.accessToken) continue;
      // 有效性检查: ts 存在时检查时效
      if (parsed.ts && (Date.now() - parsed.ts) > BRIDGE_TOKEN_MAX_AGE_MS) {
        result.bridgePath = bridgePath;
        result.stale = true;
        continue; // 过期但记录路径，后续可提示用户刷新
      }
      result.token = String(parsed.accessToken);
      result.refreshToken = parsed.refreshToken || null;
      result.expiresAt = parsed.expiresAt || null;
      result.host = parsed.host || null;
      result.userId = parsed.userId || null;
      result.region = parsed.region || null;
      result.bridgePath = bridgePath;
      return result;
    } catch {
      // JSON 解析失败 / 权限不足 → 跳过
    }
  }
  return result;
}

/**
 * 将刷新后的 token 写回 bridge auth.json（确保下次启动有效）
 * 只写入已存在 khy-trae-bridge/ 目录的路径（不会凭空创建新位置）
 * @param {object} tokenData - 含 accessToken, refreshToken, expiresAt, host, userId, region
 * @returns {string|null} 写入的路径，或 null（无可写位置）
 */
function writeBridgeAuthToken(tokenData) {
  if (!tokenData || !tokenData.accessToken) return null;
  const dirs = _globalStorageDirs();
  for (const dir of dirs) {
    const bridgeDir = path.join(dir, BRIDGE_EXTENSION_ID);
    try {
      if (!fs.existsSync(bridgeDir)) continue;
      const bridgePath = path.join(bridgeDir, BRIDGE_AUTH_FILENAME);
      const data = {
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken || null,
        expiresAt: tokenData.expiresAt || null,
        host: tokenData.nativeHost || tokenData.host || null,
        userId: tokenData.userId || null,
        region: tokenData.region || tokenData.regionHint || null,
        ts: Date.now(),
      };
      fs.writeFileSync(bridgePath, JSON.stringify(data, null, 2), 'utf8');
      return bridgePath;
    } catch { /* 写入失败 → 尝试下一个目录 */ }
  }
  return null;
}

// 各平台的 globalStorage 根目录模板
function _globalStorageDirs() {
  const home = os.homedir();
  const dirs = [];
  for (const app of OFFICIAL_APP_NAMES) {
    // Linux
    dirs.push(path.join(home, '.config', app, 'User', 'globalStorage'));
    // macOS
    dirs.push(path.join(home, 'Library', 'Application Support', app, 'User', 'globalStorage'));
    // Windows
    dirs.push(path.join(home, 'AppData', 'Roaming', app, 'User', 'globalStorage'));
  }
  return dirs;
}

/**
 * 官方 Trae storage.json 路径列表（不含 Nirvana）
 */
function resolveTraeOfficialStoragePaths() {
  return _globalStorageDirs().map(d => path.join(d, 'storage.json'));
}

/**
 * 官方 Trae state.vscdb / state-global.vscdb 路径列表
 */
function resolveTraeOfficialDbPaths() {
  const out = [];
  for (const d of _globalStorageDirs()) {
    out.push(path.join(d, 'state.vscdb'));
    out.push(path.join(d, 'state-global.vscdb'));
  }
  return out;
}

// ── storage.json 读取 ────────────────────────────────

/**
 * 读取所有存在的官方 Trae storage.json
 * @returns {Array<{path: string, data: object}>}
 */
function readTraeOfficialStorageSnapshots() {
  const out = [];
  for (const p of resolveTraeOfficialStoragePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && typeof data === 'object') out.push({ path: p, data });
    } catch { /* 忽略格式错误 */ }
  }
  return out;
}

// ── state.vscdb 读取 ─────────────────────────────────

/**
 * 读取所有存在的官方 Trae vscdb，返回 {path, rows[]} 快照
 * rows 只取和 iCube/traeAuth 相关的 key，避免全量扫描
 * @returns {Array<{path: string, rows: Array<{key: string, value: string}>}>}
 */
function readTraeOfficialDbSnapshots() {
  const out = [];
  for (const dbPath of resolveTraeOfficialDbPaths()) {
    try {
      if (!fs.existsSync(dbPath)) continue;
    } catch { continue; }

    const rows = _readRelevantRowsFromVscdb(dbPath);
    if (rows.length > 0) out.push({ path: dbPath, rows });
  }
  return out;
}

/**
 * 从单个 vscdb 中读出与 Trae 登录相关的 key-value 行
 */
function _readRelevantRowsFromVscdb(dbPath) {
  // Tier 1: better-sqlite3
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const tables = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table');
      const tableName = (
        tables.find(t => String(t.name || '') === 'ItemTable')
        || tables.find(t => String(t.name || '').toLowerCase() === 'itemtable')
        || tables.find(t => /itemtable/i.test(String(t.name || '')))
      )?.name;
      if (!tableName || !/^[A-Za-z0-9_]+$/.test(String(tableName))) return [];

      // 精确 + 模糊查找
      const rows = [];
      try {
        const found = db.prepare(
          `SELECT key, value FROM "${tableName}" WHERE ` +
          `key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? ` +
          `OR key LIKE ? OR key LIKE ? OR key LIKE ? LIMIT 500`
        ).all(
          '%iCubeAuthInfo%', '%iCubeServerData%', '%traeAuth%',
          '%bytedance%', '%usertag%', '%region%', '%accessToken%',
          'secret://%trae%'
        );
        for (const r of found) {
          rows.push({ key: String(r.key || ''), value: _safeStringify(r.value) });
        }
      } catch { /* 查询失败 */ }
      return rows;
    } finally {
      db.close();
    }
  } catch { /* better-sqlite3 不可用 */ }

  // Tier 2: 二进制 grep (4MB cap)
  try {
    const buf = fs.readFileSync(dbPath);
    const text = buf.toString('utf8', 0, Math.min(buf.length, 4 * 1024 * 1024));
    const rows = [];
    // 用正则提取可能的 key-value 对
    const keyPatterns = [/iCubeAuthInfo:\/\/[^\x00\n"]+/g, /iCubeServerData:\/\/[^\x00\n"]+/g];
    for (const pat of keyPatterns) {
      let m;
      while ((m = pat.exec(text)) !== null) {
        rows.push({ key: m[0], value: '<binary-scan>' });
      }
    }
    // 检查存在性
    if (/iCubeAuthInfo|iCubeServerData|traeAuth|usertag/i.test(text)) {
      if (rows.length === 0) rows.push({ key: '__binary_artifact_detected', value: '' });
    }
    return rows;
  } catch { /* ignore */ }

  return [];
}

// ── iCube 痕迹提取 ──────────────────────────────────

// vscdb 中 value 可能是 Buffer (Chromium v10/v11 加密)，安全转字符串
// 大 blob 只取前 32 字节做前缀判断 + 截断 base64，避免对 MB 级数据全量编码
const _SAFE_STRINGIFY_MAX_B64 = 512; // base64 输出最大字符数

function _safeStringify(val) {
  if (val == null) return '';
  if (Buffer.isBuffer(val)) {
    // v10/v11 Chromium 加密 blob
    const prefix = val.toString('utf8', 0, Math.min(3, val.length));
    if (prefix === 'v10' || prefix === 'v11') {
      const b64 = val.length > 384 ? val.subarray(0, 384).toString('base64') + '...' : val.toString('base64');
      return `<chromium-encrypted:${prefix}:${b64}>`;
    }
    // Trae 自定义加密 (tc\x05\x10)
    if (val.length >= 6 && val[0] === 0x74 && val[1] === 0x63 && val[2] === 0x05 && val[3] === 0x10) {
      const b64 = val.length > 384 ? val.subarray(0, 384).toString('base64') + '...' : val.toString('base64');
      return `<trae-encrypted:${b64}>`;
    }
    // 普通 Buffer — 只取前 4KB 防止爆内存
    return val.toString('utf8', 0, Math.min(val.length, 4096));
  }
  return String(val);
}

// secret:// 前缀模式 — state.vscdb 中的 Electron SecretStorage entry
const SECRET_KEY_PATTERN = /^secret:\/\//;

// iCube 相关 key 模式
const ICUBE_AUTH_KEY = /^iCubeAuthInfo:\/\/icube\.cloudide$/i;
const ICUBE_USERTAG_KEY = /^iCubeAuthInfo:\/\/usertag$/i;
const ICUBE_SERVER_KEY = /^iCubeServerData:\/\/icube\.cloudide$/i;

/**
 * 从 storage.json 数据中提取官方登录痕迹
 * @param {object} data - storage.json 解析后的对象
 * @param {string} sourcePath - 文件路径
 * @returns {object} 标准化的 artifact 对象
 */
function extractTraeOfficialArtifactsFromStorage(data, sourcePath) {
  const result = _emptyArtifactResult(sourcePath, 'storage.json');

  if (!data || typeof data !== 'object') return result;

  for (const [key, value] of Object.entries(data)) {
    if (ICUBE_AUTH_KEY.test(key)) {
      result.authBlobPresent = true;
      result.authBlobRaw = typeof value === 'string' ? value : null;
      result.officialArtifactsDetected = true;
    } else if (ICUBE_USERTAG_KEY.test(key)) {
      result.userTagBlobPresent = true;
      result.userTagBlobRaw = typeof value === 'string' ? value : null;
      result.officialArtifactsDetected = true;
    } else if (ICUBE_SERVER_KEY.test(key)) {
      result.serverDataPresent = true;
      result.officialArtifactsDetected = true;
      // iCubeServerData 是明文 JSON
      _tryParseServerData(value, result);
    } else if (/^traeAuth/i.test(key) || /^bytedance\.auth/i.test(key)) {
      result.officialArtifactsDetected = true;
      // 尝试提取明文 token
      _tryExtractTokenFromEntry(key, value, result);
    }
  }

  _resolveCredentialMode(result);
  return result;
}

/**
 * 从 vscdb 的 rows 中提取官方登录痕迹
 * @param {string} dbPath - vscdb 文件路径
 * @returns {object} 标准化的 artifact 对象
 */
function extractTraeOfficialArtifactsFromDb(dbPath) {
  const result = _emptyArtifactResult(dbPath, 'vscdb');

  let rows;
  try {
    const snapshots = readTraeOfficialDbSnapshots();
    const match = snapshots.find(s => s.path === dbPath);
    rows = match ? match.rows : _readRelevantRowsFromVscdb(dbPath);
  } catch {
    rows = _readRelevantRowsFromVscdb(dbPath);
  }

  for (const { key, value } of rows) {
    if (ICUBE_AUTH_KEY.test(key)) {
      result.authBlobPresent = true;
      result.authBlobRaw = value !== '<binary-scan>' ? value : null;
      result.officialArtifactsDetected = true;
    } else if (ICUBE_USERTAG_KEY.test(key)) {
      result.userTagBlobPresent = true;
      result.userTagBlobRaw = value !== '<binary-scan>' ? value : null;
      result.officialArtifactsDetected = true;
    } else if (ICUBE_SERVER_KEY.test(key)) {
      result.serverDataPresent = true;
      result.officialArtifactsDetected = true;
      if (value !== '<binary-scan>') _tryParseServerData(value, result);
    } else if (/traeAuth|bytedance|accessToken/i.test(key)) {
      result.officialArtifactsDetected = true;
      if (value !== '<binary-scan>') _tryExtractTokenFromEntry(key, value, result);
    } else if (key === '__binary_artifact_detected') {
      result.officialArtifactsDetected = true;
    } else if (SECRET_KEY_PATTERN.test(key)) {
      // state.vscdb 中的 Electron SecretStorage entry (如 secret://{"extensionId":"trae.ai-code-completion","key":"isActivated"})
      // value 通常是 v10/v11 Chromium 加密 blob
      result.officialArtifactsDetected = true;
      if (!result.secretEntries) result.secretEntries = [];
      const isEncrypted = /^<chromium-encrypted:|^<trae-encrypted:/.test(value) || value === '<binary-scan>';
      result.secretEntries.push({ key, encrypted: isEncrypted });
    }
  }

  _resolveCredentialMode(result);
  return result;
}

/**
 * 汇聚所有官方 Trae 来源的 artifact 信息
 * @returns {object} 综合 artifact 结果
 */
function collectTraeOfficialArtifacts() {
  const merged = _emptyArtifactResult(null, 'merged');
  merged.sourcePaths = [];

  // 1) storage.json 来源
  const storageSnaps = readTraeOfficialStorageSnapshots();
  for (const snap of storageSnaps) {
    const r = extractTraeOfficialArtifactsFromStorage(snap.data, snap.path);
    _mergeArtifact(merged, r);
  }

  // 2) vscdb 来源
  for (const dbPath of resolveTraeOfficialDbPaths()) {
    try { if (!fs.existsSync(dbPath)) continue; } catch { continue; }
    const r = extractTraeOfficialArtifactsFromDb(dbPath);
    _mergeArtifact(merged, r);
  }

  _resolveCredentialMode(merged);
  return merged;
}

// ── auth blob 结构解码 ───────────────────────────────

/**
 * 分析 iCubeAuthInfo blob 的结构（不要求成功解密）
 * @param {string} raw - iCubeAuthInfo 的原始值
 * @returns {object} 结构识别结果
 */
function decodeTraeOfficialAuthBlob(raw) {
  const result = {
    encoding: 'unknown',
    schemeHint: 'unknown',
    encryptionService: null,   // 'electron-safeStorage' | null
    decryptable: false,
    tokenCandidate: null,
    blobLength: 0,
    analysisNotes: [],
  };

  if (!raw || typeof raw !== 'string') {
    result.analysisNotes.push('输入为空或非字符串');
    return result;
  }

  const trimmed = raw.trim();
  result.blobLength = trimmed.length;

  // 1) 先尝试直接 JSON 解析 — 有些版本可能是明文 JSON
  try {
    const obj = JSON.parse(trimmed);
    result.encoding = 'json-plaintext';
    result.schemeHint = 'plaintext';
    const token = obj.accessToken || obj.access_token || obj.token || obj.jwt;
    if (token && typeof token === 'string' && token.length >= 20) {
      result.decryptable = true;
      result.tokenCandidate = token;
      result.analysisNotes.push('明文 JSON，提取到 token');
    } else {
      result.analysisNotes.push('JSON 格式但未找到 token 字段');
    }
    return result;
  } catch { /* 非 JSON */ }

  // 2) 检查 base64 编码
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 20) {
    result.encoding = 'base64';
    try {
      const decoded = Buffer.from(trimmed, 'base64');

      // 检查解码后是否为 JSON
      try {
        const inner = JSON.parse(decoded.toString('utf8'));
        result.schemeHint = 'base64-json';
        const token = inner.accessToken || inner.access_token || inner.token || inner.jwt;
        if (token && typeof token === 'string' && token.length >= 20) {
          result.decryptable = true;
          result.tokenCandidate = token;
          result.analysisNotes.push('base64 → JSON，提取到 token');
        } else {
          result.analysisNotes.push('base64 → JSON 但无 token 字段');
        }
        return result;
      } catch { /* 非 JSON */ }

      // 检查首字节判断加密方案
      if (decoded.length >= 4) {
        const header = decoded.slice(0, 6);
        // Trae 自定义加密封装: 前缀 74 63 05 10 00 00 ("tc" + 0x05 0x10 0x00 0x00)
        // 由 Electron 主进程 EncryptionMainService (safeStorage) 生成，外部无法直接解密
        if (decoded.length >= 6
          && header[0] === 0x74 && header[1] === 0x63
          && header[2] === 0x05 && header[3] === 0x10
          && header[4] === 0x00 && header[5] === 0x00) {
          result.schemeHint = 'trae-custom-encrypted';
          result.encryptionService = 'electron-safeStorage';
          result.analysisNotes.push(
            '检测到 Trae 自定义加密前缀 (74 63 05 10 00 00)，' +
            '由 Electron safeStorage (EncryptionMainService) 加密，外部无法直接解密'
          );
        }
        // Windows DPAPI: 通常以 01 00 00 00 开头
        else if (header[0] === 0x01 && header[1] === 0x00 && header[2] === 0x00 && header[3] === 0x00) {
          result.schemeHint = 'dpapi';
          result.analysisNotes.push('检测到 DPAPI 头部签名 (01 00 00 00)');
        }
        // v10/v11 前缀 (Chromium Safe Storage)
        else if (decoded.toString('utf8', 0, 3) === 'v10' || decoded.toString('utf8', 0, 3) === 'v11') {
          result.schemeHint = `chromium-safe-storage-${decoded.toString('utf8', 0, 3)}`;
          result.analysisNotes.push(`检测到 Chromium Safe Storage 前缀: ${decoded.toString('utf8', 0, 3)}`);
        }
        else {
          result.schemeHint = 'base64-binary';
          result.analysisNotes.push(`base64 解码后为二进制 blob (${decoded.length} bytes)`);
        }
      }
    } catch {
      result.analysisNotes.push('base64 解码失败');
    }
    return result;
  }

  // 3) JWT 格式检测
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(trimmed)) {
    result.encoding = 'jwt';
    result.schemeHint = 'plaintext';
    result.decryptable = true;
    result.tokenCandidate = trimmed;
    result.analysisNotes.push('JWT 格式明文 token');
    return result;
  }

  // 4) 其他长字符串 — 可能是十六进制编码的加密数据
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length >= 40) {
    result.encoding = 'hex';
    result.schemeHint = 'hex-binary';
    result.analysisNotes.push(`十六进制编码 (${trimmed.length / 2} bytes)`);
    return result;
  }

  // 5) 无法识别
  result.encoding = 'opaque';
  result.schemeHint = 'unknown';
  result.analysisNotes.push(`无法识别的编码格式 (长度: ${trimmed.length})`);
  return result;
}

// ── 凭据聚合 ─────────────────────────────────────────

/**
 * 聚合所有可用的 Trae 官方凭据来源，输出统一凭据结构
 * @param {object} [options]
 * @param {object} [options.artifacts] - 可选，预先收集好的 artifacts（避免重复扫描）
 * @returns {object} 凭据结果
 */
function resolveTraeOfficialCredential(options = {}) {
  const artifacts = options.artifacts || collectTraeOfficialArtifacts();

  const result = {
    source: 'official-trae',
    officialArtifactsDetected: artifacts.officialArtifactsDetected,
    credentialMode: artifacts.credentialMode, // 'none' | 'encrypted' | 'plaintext'
    token: artifacts.plainTextToken || null,
    refreshToken: null,
    expiresAt: null,
    endpoint: null,
    nativeHost: null,            // 原生协议主机（从桥接或 blob 解出）
    regionHint: artifacts.regionHint || null,
    userIdHint: artifacts.userIdHint || null,
    endpointHints: artifacts.endpointHints || [],
    sourcePaths: artifacts.sourcePaths || [],
    authBlobPresent: artifacts.authBlobPresent,
    userTagBlobPresent: artifacts.userTagBlobPresent,
    serverDataPresent: artifacts.serverDataPresent,
    authBlobAnalysis: null,
    bridgePath: null,            // 桥接扩展 token 文件路径
    bridgeStale: false,          // 桥接 token 是否过期
  };

  // 0) 桥接扩展 token (最高优先级 — icube.marscode AuthenticationProvider 导出)
  const bridge = readMarsCodeAuthProviderToken();
  if (bridge.token) {
    result.token = bridge.token;
    result.refreshToken = bridge.refreshToken || null;
    result.expiresAt = bridge.expiresAt || null;
    // bridge.region 传递到 regionHint，供 _isTraeCN 等判断使用
    if (bridge.region) result.regionHint = bridge.region;
    result.nativeHost = bridge.host || resolveNativeHostByRegion(result.regionHint);
    result.credentialMode = 'plaintext';
    result.bridgePath = bridge.bridgePath;
    result.officialArtifactsDetected = true;
    if (bridge.userId) result.userIdHint = bridge.userId;
    if (result.endpointHints.length > 0) {
      result.endpoint = result.endpointHints[0];
    }
    result.sourcePaths = [bridge.bridgePath, ...result.sourcePaths];
    return result;
  }
  if (bridge.stale) {
    result.bridgePath = bridge.bridgePath;
    result.bridgeStale = true;
  }

  // 如果找到明文 token → credentialMode=plaintext
  if (result.token) {
    result.credentialMode = 'plaintext';
    if (result.endpointHints.length > 0) {
      result.endpoint = result.endpointHints[0];
    }
    return result;
  }

  // 分析 authBlob 结构（即使不能解密也保留结构信息）
  if (artifacts.authBlobPresent && artifacts.authBlobRaw) {
    const blobAnalysis = decodeTraeOfficialAuthBlob(artifacts.authBlobRaw);
    result.authBlobAnalysis = blobAnalysis;

    if (blobAnalysis.decryptable && blobAnalysis.tokenCandidate) {
      result.token = blobAnalysis.tokenCandidate;
      result.credentialMode = 'plaintext';
      if (result.endpointHints.length > 0) {
        result.endpoint = result.endpointHints[0];
      }
      return result;
    }
  }

  // 有 artifact 但没拿到明文 → encrypted
  if (artifacts.officialArtifactsDetected && !result.token) {
    result.credentialMode = 'encrypted';
  }

  if (result.endpointHints.length > 0) {
    result.endpoint = result.endpointHints[0];
  }

  return result;
}

// ── 会话验证 ─────────────────────────────────────────

/**
 * 验证官方 Trae 凭据是否能成功调用 API
 * @param {object} credential - resolveTraeOfficialCredential() 返回值
 * @param {Function} requestJsonFn - 外部传入的 requestJson 函数（避免循环依赖）
 * @returns {Promise<object>} 验证结果
 */
async function verifyTraeOfficialSession(credential, requestJsonFn) {
  if (!credential || !credential.token) {
    return {
      sessionVerified: false,
      reason: credential?.credentialMode === 'encrypted' ? 'encrypted_only' : 'no_token',
      detail: credential?.credentialMode === 'encrypted'
        ? '检测到加密登录态，尚未还原为可用 token'
        : '未找到可用 token',
    };
  }

  // 尝试端点验证
  const endpoints = [
    credential.endpoint,
    ...(credential.endpointHints || []),
  ].filter(Boolean);

  if (endpoints.length === 0) {
    return {
      sessionVerified: false,
      reason: 'no_endpoint',
      detail: '有 token 但无可探活的端点',
    };
  }

  for (const ep of endpoints) {
    const modelsUrl = `${String(ep).replace(/\/+$/, '')}/models`;
    try {
      const res = await requestJsonFn(modelsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${credential.token}`,
          'Accept': 'application/json',
        },
        timeout: 8000,
        maxRetries: 0,
      });
      const body = res?.body || res?.data || res;
      if (Array.isArray(body?.data) || Array.isArray(body?.models)) {
        return {
          sessionVerified: true,
          reason: 'ok',
          detail: `端点 ${ep} 验证通过`,
          verifiedEndpoint: ep,
        };
      }
    } catch { /* 尝试下一个端点 */ }
  }

  return {
    sessionVerified: false,
    reason: 'probe_failed',
    detail: `所有端点 (${endpoints.length}) 探活失败`,
  };
}

// ── 内部工具函数 ─────────────────────────────────────

function _emptyArtifactResult(sourcePath, sourceType) {
  return {
    source: 'official-trae',
    sourceType,
    officialArtifactsDetected: false,
    credentialMode: 'none',
    authBlobPresent: false,
    authBlobRaw: null,
    userTagBlobPresent: false,
    userTagBlobRaw: null,
    serverDataPresent: false,
    serverData: null,
    regionHint: null,
    userIdHint: null,
    endpointHints: [],
    plainTextToken: null,
    sourcePaths: sourcePath ? [sourcePath] : [],
  };
}

function _tryParseServerData(value, result) {
  if (!value) return;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    const obj = typeof value === 'object' ? value : JSON.parse(raw);
    result.serverData = obj;
    // 提取 region hint
    if (obj.region) result.regionHint = String(obj.region);
    if (obj.area) result.regionHint = result.regionHint || String(obj.area);
    // 提取 userId hint
    if (obj.userId || obj.user_id) result.userIdHint = String(obj.userId || obj.user_id);
    // 提取 endpoint hints — 直接字段
    if (obj.apiHost || obj.api_host) {
      const ep = String(obj.apiHost || obj.api_host).trim();
      if (ep && !result.endpointHints.includes(ep)) result.endpointHints.push(ep);
    }
    if (obj.endpoint) {
      const ep = String(obj.endpoint).trim();
      if (ep && !result.endpointHints.includes(ep)) result.endpointHints.push(ep);
    }
    // 深层遍历 — iCubeServerData 的实际结构以 entitlementInfo/commercialActivityInfo
    // 为主，通常不含 apiHost/endpoint 字段。从 serverData 整体扫描 URL 形态的值
    _extractUrlHintsFromObject(obj, result, 0);
  } catch { /* 不是 JSON，忽略 */ }
}

/**
 * 从 serverData 对象中递归提取看起来像 API URL 的值
 * 写入 result.endpointHints（浅层 3 级限制，防止死循环）
 */
function _extractUrlHintsFromObject(obj, result, depth) {
  if (!obj || typeof obj !== 'object' || depth > 3) return;
  for (const [, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (/^https?:\/\/[a-z0-9.-]+\.trae\.(ai|cn)/i.test(trimmed)) {
        if (!result.endpointHints.includes(trimmed)) result.endpointHints.push(trimmed);
      }
    } else if (typeof v === 'object' && v !== null) {
      _extractUrlHintsFromObject(v, result, depth + 1);
    }
  }
}

function _tryExtractTokenFromEntry(key, value, result) {
  if (!value) return;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return;

  // 尝试 JSON
  try {
    const obj = JSON.parse(raw);
    const candidates = [obj.accessToken, obj.access_token, obj.token, obj.jwt];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length >= 20 && /^[A-Za-z0-9._\-+/=~:]+$/.test(c)) {
        result.plainTextToken = c;
        result.credentialMode = 'plaintext';
        return;
      }
    }
    // 有 JSON 但没 token → 可能是包含其他信息的对象
    return;
  } catch { /* 非 JSON */ }

  // 直接判断裸 token
  if (raw.length >= 20 && raw.length <= 4096 && /^[A-Za-z0-9._\-+/=~:]+$/.test(raw)) {
    if (/^(eyJ|sk-|rk-|rt_|atk-)/i.test(raw) || /^[A-Za-z0-9]{20,}$/i.test(raw)) {
      result.plainTextToken = raw;
      result.credentialMode = 'plaintext';
    }
  }
}

function _resolveCredentialMode(result) {
  if (result.plainTextToken) {
    result.credentialMode = 'plaintext';
  } else if (result.officialArtifactsDetected && result.credentialMode !== 'plaintext') {
    result.credentialMode = 'encrypted';
  }
}

function _mergeArtifact(merged, incoming) {
  if (incoming.officialArtifactsDetected) merged.officialArtifactsDetected = true;
  if (incoming.authBlobPresent) {
    merged.authBlobPresent = true;
    if (!merged.authBlobRaw && incoming.authBlobRaw) merged.authBlobRaw = incoming.authBlobRaw;
  }
  if (incoming.userTagBlobPresent) {
    merged.userTagBlobPresent = true;
    if (!merged.userTagBlobRaw && incoming.userTagBlobRaw) merged.userTagBlobRaw = incoming.userTagBlobRaw;
  }
  if (incoming.serverDataPresent) {
    merged.serverDataPresent = true;
    if (!merged.serverData && incoming.serverData) merged.serverData = incoming.serverData;
  }
  if (incoming.regionHint && !merged.regionHint) merged.regionHint = incoming.regionHint;
  if (incoming.userIdHint && !merged.userIdHint) merged.userIdHint = incoming.userIdHint;
  for (const ep of (incoming.endpointHints || [])) {
    if (!merged.endpointHints.includes(ep)) merged.endpointHints.push(ep);
  }
  if (incoming.plainTextToken && !merged.plainTextToken) {
    merged.plainTextToken = incoming.plainTextToken;
  }
  for (const p of (incoming.sourcePaths || [])) {
    if (!merged.sourcePaths.includes(p)) merged.sourcePaths.push(p);
  }
}

module.exports = {
  resolveTraeOfficialStoragePaths,
  resolveTraeOfficialDbPaths,
  readTraeOfficialStorageSnapshots,
  readTraeOfficialDbSnapshots,
  extractTraeOfficialArtifactsFromStorage,
  extractTraeOfficialArtifactsFromDb,
  collectTraeOfficialArtifacts,
  decodeTraeOfficialAuthBlob,
  resolveTraeOfficialCredential,
  verifyTraeOfficialSession,
  resolveNativeHostByRegion,
  readMarsCodeAuthProviderToken,
  writeBridgeAuthToken,
  // 常量表 (供 traeAdapter / 测试 / 调试工具使用)
  TRAE_NATIVE_API_PATHS,
  TRAE_KNOWN_NATIVE_HOSTS,
  TRAE_REGION_HOST_MAP,
  BRIDGE_EXTENSION_ID,
};
