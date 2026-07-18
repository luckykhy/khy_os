'use strict';

/**
 * proxyUriHelpers.js — 纯叶子:代理节点 URI 解析工具箱(移植 clash-verge-rev 的
 * `src/utils/uri-parser/helpers.ts`,剥去 TS 类型、`atob` 换成 `Buffer.from(x,'base64')`)。
 *
 * 背景:「代理管理」订阅组要「含每节点全字段」,需要一套与 Clash Verge 对齐的底层解析原语
 * (URL-like 拆分、查询串归一、严格端口校验、base64 文本型启发解码、cipher 归一…)。本叶子是
 * 那套原语的单一真源,由 proxyUriParsers(各协议)与 proxyNodeParse(外观)复用。
 *
 * 契约:纯叶子 —— 零 I/O(纯字符串/算术,不碰 fs / 网络 / 子进程 / 时钟 / 随机)、确定性、
 * fail-soft(**绝不抛**:仅 parseRequiredPort/parseUrlLike 在 requireAuth 时按上游语义抛,
 * 供各协议解析器 catch 后返 null;其余函数对坏输入返 undefined/原串)。**无门控**——纯函数库,
 * 由外观 proxyNodeParse 持 KHY_PROXY_SUBSCRIPTION 门。相对 require 仅 leaf→leaf(本文件零依赖)。
 *
 * @module services/proxyUriHelpers
 */

const URI_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

// 归一 URI 并取小写 scheme(未含 `scheme://` 时按 `://` 前缀猜)。
function normalizeUriAndGetScheme(input) {
  const trimmed = String(input == null ? '' : input).trim();
  const match = URI_SCHEME_RE.exec(trimmed);
  if (!match) {
    const schemeGuess = (trimmed.split('://')[0] || '').toLowerCase();
    return { uri: trimmed, scheme: schemeGuess };
  }
  const scheme = match[1].toLowerCase();
  return { uri: scheme + trimmed.slice(match[1].length), scheme };
}

// 剥去 `scheme://` 前缀;scheme 不在 expected 内则抛 errorMessage(上游语义,供协议解析器 catch)。
function stripUriScheme(uri, expectedSchemes, errorMessage) {
  const match = URI_SCHEME_RE.exec(String(uri == null ? '' : uri));
  if (!match) throw new Error(errorMessage);
  const scheme = match[1].toLowerCase();
  const expected = typeof expectedSchemes === 'string' ? [expectedSchemes] : expectedSchemes;
  if (!expected.includes(scheme)) throw new Error(errorMessage);
  return String(uri).slice(match[0].length);
}

function getIfNotBlank(value, dft) {
  return value && String(value).trim() !== '' ? value : dft;
}

function getIfPresent(value, dft) {
  return value !== null && value !== undefined ? value : dft;
}

function isPresent(value) {
  return value !== null && value !== undefined;
}

function trimStr(str) {
  return str ? String(str).trim() : str;
}

function safeDecodeURIComponent(value) {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeAndTrim(value) {
  const decoded = safeDecodeURIComponent(value);
  const trimmed = decoded == null ? undefined : String(decoded).trim();
  return trimmed ? trimmed : undefined;
}

function splitOnce(input, delimiter) {
  const s = String(input == null ? '' : input);
  const idx = s.indexOf(delimiter);
  if (idx === -1) return [s];
  return [s.slice(0, idx), s.slice(idx + delimiter.length)];
}

function parseQueryString(query) {
  const out = {};
  if (!query) return out;
  for (const part of String(query).split('&')) {
    if (!part) continue;
    const [keyRaw, valueRaw] = splitOnce(part, '=');
    const key = keyRaw.trim();
    if (!key) continue;
    out[key] = valueRaw === undefined ? undefined : (safeDecodeURIComponent(valueRaw) ?? valueRaw);
  }
  return out;
}

function normalizeQueryKey(key) {
  return key.replace(/_/g, '-');
}

// 与 parseQueryString 同,但键里的下划线归一为短横(clash 参数惯例:allowInsecure/allow-insecure)。
function parseQueryStringNormalized(query) {
  const raw = parseQueryString(query);
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    normalized[normalizeQueryKey(key)] = value;
  }
  return normalized;
}

function parseBool(value) {
  if (value === undefined) return undefined;
  return /^(?:true|1)$/i.test(String(value));
}

// 无值(键存在但无 `=value`)或空串视为 true(存在即真);否则按 true/1 判定。
function parseBoolOrPresence(value) {
  if (value === undefined) return true;
  const trimmed = String(value).trim();
  if (trimmed === '') return true;
  return /^(?:true|1)$/i.test(trimmed);
}

function parseVlessFlow(value) {
  const flow = getIfNotBlank(value);
  if (!flow) return undefined;
  if (/^none$/i.test(flow)) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(flow)) return undefined;
  return flow;
}

function parseInteger(value) {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// 严格端口:必须是纯数字且 1–65535,否则返 undefined(过滤 0 / 越界 / 非数字)。
function parsePortStrict(value) {
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) return undefined;
  return parsed;
}

// 必需端口:非法则抛(供各协议解析器 catch → 该行返 null)。
function parseRequiredPort(value, errorMessage) {
  const parsed = parsePortStrict(value);
  if (parsed === undefined) throw new Error(errorMessage);
  return parsed;
}

// 可选端口:非法/缺失则用默认(不抛)。
function parsePortOrDefault(port, dft) {
  const n = parseInteger(port);
  return n === undefined ? dft : n;
}

const IP_VERSIONS = ['dual', 'ipv4', 'ipv6', 'ipv4-prefer', 'ipv6-prefer'];

function parseIpVersion(value) {
  return value && IP_VERSIONS.includes(value) ? value : 'dual';
}

// URL-like 拆分:`auth@host:port/?query#fragment`(每段可选)。这是全字段解析的核心原语。
const URLLIKE_RE =
  /^(?:(?<auth>.*?)@)?(?<host>.*?)(?::(?<port>\d+))?\/?(?:\?(?<query>.*?))?(?:#(?<fragment>.*?))?$/;

function parseUrlLike(input, options) {
  const opts = options || {};
  const match = URLLIKE_RE.exec(String(input == null ? '' : input));
  const groups = (match && match.groups) || {};
  if (!match || groups.host === undefined) {
    throw new Error(opts.errorMessage || 'Invalid uri');
  }
  const auth = getIfNotBlank(groups.auth);
  if (opts.requireAuth && !auth) {
    throw new Error(opts.errorMessage || 'Invalid uri');
  }
  return {
    auth,
    host: groups.host,
    port: groups.port,
    query: groups.query,
    fragment: groups.fragment,
  };
}

function isIPv4(address) {
  const ipv4Regex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
  return ipv4Regex.test(String(address == null ? '' : address));
}

function isIPv6(address) {
  const ipv6Regex =
    /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::$|^::1$|^([0-9a-fA-F]{1,4}:)*::([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}$/;
  return ipv6Regex.test(String(address == null ? '' : address));
}

// base64 文本型启发解码:能解出「文本」才接受,否则原样返回(避免把恰好可解码的非 base64 串误解)。
// 控制字符(<32 或 127,除 \t\n\r)出现即判非文本,返原串。`atob` 不可用故用 Buffer(latin1 等价)。
function decodeBase64OrOriginal(str) {
  const s = String(str == null ? '' : str);
  const normalized = s.replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = normalized.length % 4;
  const padded = padLen === 0 ? normalized : normalized + '='.repeat(4 - padLen);
  try {
    // Buffer 的 latin1 解码等价浏览器 atob(逐字节 0–255),再按 UTF-8 重解得可读文本。
    const buf = Buffer.from(padded, 'base64');
    // 先按启发式在原始字节上判「文本型」(与上游 atob 结果逐码点一致)。
    const decoded = buf.toString('latin1');
    for (let i = 0; i < decoded.length; i++) {
      const code = decoded.charCodeAt(i);
      if (code === 9 || code === 10 || code === 13) continue;
      if (code < 32 || code === 127) return s;
    }
    // 通过启发式 → 返 UTF-8 文本(多字节节点名/中文备注可读)。
    return buf.toString('utf8');
  } catch {
    return s;
  }
}

const CIPHER_ALIASES = {
  'chacha20-poly1305': 'chacha20-ietf-poly1305',
};

const KNOWN_CIPHERS = new Set([
  'none',
  'auto',
  'dummy',
  'aes-128-gcm',
  'aes-192-gcm',
  'aes-256-gcm',
  'lea-128-gcm',
  'lea-192-gcm',
  'lea-256-gcm',
  'aes-128-gcm-siv',
  'aes-256-gcm-siv',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'chacha20',
  'chacha20-ietf',
  'chacha20-ietf-poly1305',
  '2022-blake3-chacha20-poly1305',
  'rabbit128-poly1305',
  'xchacha20-ietf-poly1305',
  'xchacha20',
  'aegis-128l',
  'aegis-256',
  'aez-384',
  'deoxys-ii-256-128',
  'rc4-md5',
]);

// cipher 归一:未知/非字符串 → 'auto';缺失 → 'none';别名映射到 clash 规范名。
function getCipher(value) {
  if (value === undefined) return 'none';
  if (typeof value !== 'string') return 'auto';
  const aliased = CIPHER_ALIASES[value] ?? value;
  return KNOWN_CIPHERS.has(aliased) ? aliased : 'auto';
}

// 取「第一个字符串」(数组取首元、标量转字符串),供 vmess host/path 可能为数组时归一。
function firstString(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const first = value[0];
    return first === null || first === undefined ? undefined : String(first);
  }
  return String(value);
}

module.exports = {
  normalizeUriAndGetScheme,
  stripUriScheme,
  getIfNotBlank,
  getIfPresent,
  isPresent,
  trimStr,
  safeDecodeURIComponent,
  decodeAndTrim,
  splitOnce,
  parseQueryString,
  parseQueryStringNormalized,
  parseBool,
  parseBoolOrPresence,
  parseVlessFlow,
  parseInteger,
  parsePortStrict,
  parseRequiredPort,
  parsePortOrDefault,
  parseIpVersion,
  parseUrlLike,
  isIPv4,
  isIPv6,
  decodeBase64OrOriginal,
  getCipher,
  firstString,
};
