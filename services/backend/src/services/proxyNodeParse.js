'use strict';

/**
 * proxyNodeParse.js — 纯叶子:把订阅内容(已抓取、已 base64 解码的文本)解析为**代理节点对象**列表,
 * 供「代理管理」前端把订阅地址导入成订阅组、逐个列出节点(仿 Clash Verge 的代理组视图)。
 *
 * 背景:proxyConfigService 早就会抓订阅 URL、base64 解码、判 Clash / 节点链接格式,但它的解析器只
 * **计数**(parseNodeUriStats 返 {nodeCount, protocolCount}),从不返回单个节点的 name/server/port。
 * 本文件是那一层的**门控外观**:参考 clash-verge-rev 的 `uri-parser/`,把节点链接交给纯叶子
 * `proxyUriParsers.parseNodeUri` 解成**完整 clash 节点对象**(cipher/uuid/network/tls/sni/reality-opts/
 * ws-opts/alpn/reserved…),让前端能像 Clash Verge 一样展示每节点全字段;Clash YAML `proxies:` 仍走
 * 本文件内的手写逐行 best-effort 解析(见下诚实说明)。
 *
 * 诚实(clash YAML 全字段的边界):URI 参数自带,故 node-links 能拿**全字段**——这是「含每节点全字段」
 * 的主战场。clash-config YAML 的任意**嵌套** ws-opts/reality-opts 块,手写行解析器无法可靠抽取,而纯
 * 叶子零依赖不能引 YAML 库。故 clash-config 保持 best-effort **平铺字段**(name/type/server/port),
 * 不假装覆盖嵌套。node-links 若 parseNodeUri 未识别(未知 scheme/解析失败),回退旧手写平铺解析,
 * 保证不丢节点、不回归既有覆盖。
 *
 * 契约:纯叶子 —— 零 I/O(纯文本解析,不碰 fs / 网络 / 子进程)、确定性(无时钟 / 随机)、绝不抛
 * (fail-soft:任何异常输入返 {nodes:[], protocolCount:{}, format:'unknown'})。相对 require 仅 leaf→leaf
 * (proxyUriParsers/proxyUriHelpers 同为纯叶子,guard 放行)。门控 KHY_PROXY_SUBSCRIPTION:关门 →
 * parseProxyNodes 返空结果(caller 逐字节回退到 proxyConfigService 的计数语义)。
 *
 * 支持的格式(容错、best-effort):
 *  - node-links       : 每行一个 vmess:// / vless:// / trojan:// / ss:// / ssr:// … URI(全字段)
 *  - clash-config     : YAML `proxies:` 下的 flow 风格 `{name: x, type: vmess, server: h, port: 443}`
 *                       与 block 风格(`- name:` / `type:` / `server:` / `port:` 缩进项)——平铺字段
 *
 * @module services/proxyNodeParse
 */

const fullParsers = require('./proxyUriParsers');

const FLAG = 'KHY_PROXY_SUBSCRIPTION';

// 已知节点 URI 前缀(与 proxyConfigService.NODE_URI_PREFIXES 对齐 + 参考 clash-verge-rev 扩充别名)。
const NODE_URI_PREFIXES = [
  'vmess://',
  'vless://',
  'trojan://',
  'ss://',
  'ssr://',
  'hysteria://',
  'hysteria2://',
  'hy2://',
  'hy://',
  'tuic://',
  'wireguard://',
  'wg://',
  'anytls://',
  'socks://',
  'socks5://',
];

function isEnabled(env) {
  try {
    const e = env && typeof env === 'object' ? env : {};
    // 未注册时 isFlagEnabled 保守返 true,但本 flag 已在 flagRegistry 登记;门关值统一识别。
    const raw = e[FLAG];
    if (raw === undefined || raw === null || raw === '') return true; // default-on
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
  } catch {
    return true;
  }
}

function _toBase64Standard(raw) {
  let text = String(raw || '').trim().replace(/\s+/g, '');
  if (!text) return '';
  text = text.replace(/-/g, '+').replace(/_/g, '/');
  const mod = text.length % 4;
  if (mod !== 0) text += '='.repeat(4 - mod);
  return text;
}

function _decodeBase64(raw) {
  const text = _toBase64Standard(raw);
  if (!text) return '';
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    return decoded && decoded.trim() ? decoded : '';
  } catch {
    return '';
  }
}

function _safeDecodeURIComponent(raw) {
  const text = String(raw || '');
  try { return decodeURIComponent(text); } catch { return text; }
}

function _cleanName(raw, fallback) {
  const name = String(raw || '').trim();
  return name || fallback;
}

// vmess://<base64 of JSON{v, ps, add, port, id, ...}>
function _parseVmess(uri, index) {
  const payload = uri.slice('vmess://'.length).trim();
  const decoded = _decodeBase64(payload);
  if (decoded) {
    try {
      const cfg = JSON.parse(decoded);
      return {
        name: _cleanName(cfg.ps || cfg.remark || cfg.name, `vmess-${index}`),
        type: 'vmess',
        protocol: 'vmess',
        server: String(cfg.add || cfg.address || cfg.host || '').trim(),
        port: Number.parseInt(cfg.port, 10) || null,
      };
    } catch {
      // 非标准 vmess base64(有些机场用 vmess://method:pass@host:port 变体)——落到通用解析。
    }
  }
  return _parseUserinfoUri(uri, 'vmess', index);
}

// vless://uuid@host:port?params#name  /  trojan://pass@host:port?params#name
function _parseUserinfoUri(uri, protocol, index) {
  const scheme = `${protocol}://`;
  let body = uri.slice(scheme.length);
  let name = `${protocol}-${index}`;
  const hashAt = body.indexOf('#');
  if (hashAt >= 0) {
    name = _cleanName(_safeDecodeURIComponent(body.slice(hashAt + 1)), name);
    body = body.slice(0, hashAt);
  }
  const queryAt = body.indexOf('?');
  if (queryAt >= 0) body = body.slice(0, queryAt);
  // 去掉 userinfo(uuid/password@)
  const atAt = body.lastIndexOf('@');
  const hostPort = atAt >= 0 ? body.slice(atAt + 1) : body;
  const { server, port } = _splitHostPort(hostPort);
  return { name, type: protocol, protocol, server, port };
}

// ss://<base64(method:pass@host:port)>#name  或  ss://base64(method:pass)@host:port#name
function _parseShadowsocks(uri, index) {
  let body = uri.slice('ss://'.length);
  let name = `ss-${index}`;
  const hashAt = body.indexOf('#');
  if (hashAt >= 0) {
    name = _cleanName(_safeDecodeURIComponent(body.slice(hashAt + 1)), name);
    body = body.slice(0, hashAt);
  }
  const queryAt = body.indexOf('?');
  if (queryAt >= 0) body = body.slice(0, queryAt);

  // 形态 A:整段 base64(含 @host:port)
  const atAt = body.lastIndexOf('@');
  if (atAt < 0) {
    const decoded = _decodeBase64(body);
    const inner = decoded || body;
    const innerAt = inner.lastIndexOf('@');
    if (innerAt >= 0) {
      const { server, port } = _splitHostPort(inner.slice(innerAt + 1));
      return { name, type: 'ss', protocol: 'ss', server, port };
    }
    return { name, type: 'ss', protocol: 'ss', server: '', port: null };
  }
  // 形态 B:userinfo 段 base64,host:port 明文
  const { server, port } = _splitHostPort(body.slice(atAt + 1));
  return { name, type: 'ss', protocol: 'ss', server, port };
}

function _splitHostPort(raw) {
  const text = String(raw || '').trim();
  if (!text) return { server: '', port: null };
  // IPv6 字面量 [::1]:443
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close >= 0) {
      const host = text.slice(1, close);
      const rest = text.slice(close + 1);
      const portMatch = rest.match(/^:(\d{1,5})/);
      return { server: host, port: portMatch ? Number.parseInt(portMatch[1], 10) : null };
    }
  }
  const colonAt = text.lastIndexOf(':');
  if (colonAt < 0) return { server: text, port: null };
  const host = text.slice(0, colonAt);
  const portStr = text.slice(colonAt + 1).replace(/\/.*$/, '');
  const port = Number.parseInt(portStr, 10);
  return { server: host, port: Number.isFinite(port) ? port : null };
}

function _parseNodeUri(uri, index) {
  // 先走 clash-verge-rev 移植的全字段解析器(拿完整 clash 节点对象)。
  try {
    const full = fullParsers.parseNodeUri(uri);
    if (full && (full.server || full.name)) {
      // 归一:server/port/name/protocol 恒在(兼容既有前端/测试),其余全字段原样带上。
      if (!full.name) full.name = `${full.type || 'node'}-${index}`;
      if (full.server === undefined) full.server = '';
      if (full.port === undefined) full.port = null;
      if (!full.protocol && full.type) full.protocol = full.type;
      return full;
    }
  } catch {
    // 全字段解析失败 → 回退旧手写平铺解析(下方),保证不丢节点。
  }

  const lower = uri.toLowerCase();
  if (lower.startsWith('vmess://')) return _parseVmess(uri, index);
  if (lower.startsWith('vless://')) return _parseUserinfoUri(uri, 'vless', index);
  if (lower.startsWith('trojan://')) return _parseUserinfoUri(uri, 'trojan', index);
  if (lower.startsWith('ss://')) return _parseShadowsocks(uri, index);
  // 其余协议(ssr/hysteria/tuic/wireguard/socks):尽力取 host:port,协议名照记。
  const prefix = NODE_URI_PREFIXES.find((p) => lower.startsWith(p));
  if (prefix) {
    const protocol = prefix.replace('://', '');
    return _parseUserinfoUri(uri, protocol, index);
  }
  return null;
}

// ── Clash YAML proxies 解析(无 YAML 依赖,逐行 best-effort)──────────────────
// 从一行 flow 风格 `{...}` 或 block 风格片段里抽 name/type/server/port。
function _extractField(line, keys) {
  for (const key of keys) {
    // 匹配 key: value(带引号或不带),值到逗号/右花括号/行尾。
    const re = new RegExp(`${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([^,}\\n]+))`, 'i');
    const m = line.match(re);
    if (m) {
      const v = (m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]) || '').trim();
      if (v) return v;
    }
  }
  return '';
}

function _parseClashProxies(text) {
  const lines = String(text || '').split(/\r?\n/);
  const nodes = [];
  let inProxies = false;
  let proxiesIndent = -1;
  // block 风格逐项累积
  let current = null;

  const flush = () => {
    if (current && (current.server || current.name)) {
      nodes.push({
        name: _cleanName(current.name, `node-${nodes.length + 1}`),
        type: current.type || 'unknown',
        protocol: current.type || 'unknown',
        server: current.server || '',
        port: current.port != null ? current.port : null,
      });
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed) continue;

    const indent = line.length - line.trimStart().length;

    if (!inProxies) {
      if (/^proxies\s*:/i.test(trimmed)) {
        inProxies = true;
        proxiesIndent = indent;
      }
      continue;
    }

    // 离开 proxies 区块:遇到缩进 <= proxies 键、且不是列表项的新顶层键。
    if (indent <= proxiesIndent && /^[A-Za-z_-]+\s*:/.test(trimmed) && !trimmed.startsWith('-')) {
      flush();
      inProxies = false;
      continue;
    }

    const isListItem = trimmed.startsWith('-');
    // flow 风格:`- {name: x, type: vmess, server: h, port: 443}`
    if (isListItem && trimmed.includes('{')) {
      flush();
      const inner = trimmed.slice(trimmed.indexOf('{') + 1);
      const name = _extractField(inner, ['name']);
      const type = _extractField(inner, ['type']);
      const server = _extractField(inner, ['server']);
      const portStr = _extractField(inner, ['port']);
      const port = Number.parseInt(portStr, 10);
      nodes.push({
        name: _cleanName(name, `node-${nodes.length + 1}`),
        type: type || 'unknown',
        protocol: type || 'unknown',
        server,
        port: Number.isFinite(port) ? port : null,
      });
      continue;
    }

    // block 风格起始:`- name: x`(新项)
    if (isListItem) {
      flush();
      current = {};
      const afterDash = trimmed.replace(/^-\s*/, '');
      _absorbBlockField(current, afterDash);
      continue;
    }

    // block 风格续行(缩进的 `key: value`)
    if (current) {
      _absorbBlockField(current, trimmed);
    }
  }
  flush();
  return nodes;
}

function _absorbBlockField(current, fragment) {
  const nameV = _extractField(fragment, ['name']);
  if (nameV) current.name = nameV;
  const typeV = _extractField(fragment, ['type']);
  if (typeV) current.type = typeV;
  const serverV = _extractField(fragment, ['server']);
  if (serverV) current.server = serverV;
  const portV = _extractField(fragment, ['port']);
  if (portV) {
    const port = Number.parseInt(portV, 10);
    if (Number.isFinite(port)) current.port = port;
  }
}

/**
 * 把订阅内容解析为节点对象列表。
 *
 * @param {string} text  已抓取、已 base64 解码的订阅正文(node-links 或 clash-config)。
 * @param {object} [env] 环境变量(门控读取)。
 * @returns {{ nodes: Array<{name,type,protocol,server,port}>, protocolCount: object, format: string }}
 */
function parseProxyNodes(text, env) {
  const empty = { nodes: [], protocolCount: {}, format: 'unknown' };
  try {
    if (!isEnabled(env || (typeof process !== 'undefined' ? process.env : {}))) return empty;
    const raw = String(text || '').replace(/^﻿/, '').trim();
    if (!raw) return empty;

    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const uriLines = lines.filter((l) => {
      const lower = l.toLowerCase();
      return NODE_URI_PREFIXES.some((p) => lower.startsWith(p));
    });

    let nodes = [];
    let format = 'unknown';

    if (uriLines.length > 0) {
      format = 'node-links';
      uriLines.forEach((uri, i) => {
        const node = _parseNodeUri(uri, i + 1);
        if (node) nodes.push(node);
      });
    } else if (/^proxies\s*:/im.test(raw) || /^\s*-\s*\{?\s*name\s*:/im.test(raw)) {
      format = 'clash-config';
      nodes = _parseClashProxies(raw);
    }

    const protocolCount = {};
    for (const node of nodes) {
      const key = String(node.protocol || node.type || 'unknown');
      protocolCount[key] = (protocolCount[key] || 0) + 1;
    }

    return { nodes, protocolCount, format: nodes.length > 0 ? format : 'unknown' };
  } catch {
    return empty;
  }
}

module.exports = {
  parseProxyNodes,
  isEnabled,
  NODE_URI_PREFIXES,
};
