'use strict';

/**
 * proxyUriParsers.js — 纯叶子:12 种代理节点 URI → **完整 clash 节点对象** 解析器 + 注册表
 * (移植 clash-verge-rev `src/utils/uri-parser/{vmess,vless,trojan,ss,ssr,hysteria,hysteria2,
 * tuic,wireguard,anytls,socks,http}.ts` + `index.ts` 的 URI_PARSERS 派发)。
 *
 * 背景:旧 proxyNodeParse 每节点只取 {name,type,server,port}。用户要「含每节点全字段」,故把
 * Clash Verge 的各协议解析器搬来,产出携带 cipher/uuid/password/network/tls/sni/reality-opts/
 * ws-opts/grpc-opts/alpn/reserved… 的完整 clash 节点对象。为控文件爆炸,把 12 个模块合进本**一个**
 * parsers 叶子(而非上游 14 文件),职责仍单一:每协议一个 URI_* 函数 + URI_PARSERS 映射。
 *
 * 契约:纯叶子 —— 零 I/O(纯字符串/算术,不碰 fs / 网络 / 子进程 / 时钟 / 随机)、确定性、
 * fail-soft(**绝不整体抛**:parseNodeUri 对未知 scheme / 单条解析抛错 → 返 null,上层跳过该行)。
 * **无门控**——纯函数库,由外观 proxyNodeParse 持 KHY_PROXY_SUBSCRIPTION 门。相对 require 仅
 * leaf→leaf(依赖 proxyUriHelpers,同为纯叶子,leafContractGuard 放行)。
 *
 * @module services/proxyUriParsers
 */

const H = require('./proxyUriHelpers');

// ── VMess ────────────────────────────────────────────────────────────────────
function parseVmessShadowrocketParams(raw) {
  const match = /(^[^?]+?)\/?\?(.*)$/.exec(raw);
  if (!match) return {};
  const [, base64Line, qs] = match;
  const content = H.decodeBase64OrOriginal(base64Line);
  const params = {};
  for (const addon of qs.split('&')) {
    if (!addon) continue;
    const [keyRaw, valueRaw] = H.splitOnce(addon, '=');
    const key = keyRaw.trim();
    if (!key) continue;
    if (valueRaw === undefined) {
      params[key] = true;
      continue;
    }
    const value = H.safeDecodeURIComponent(valueRaw) ?? valueRaw;
    params[key] = value.includes(',') ? value.split(',') : value;
  }
  const contentMatch = /(^[^:]+?):([^:]+?)@(.*):(\d+)$/.exec(content);
  if (!contentMatch) return params;
  const [, cipher, uuid, server, port] = contentMatch;
  params.scy = cipher;
  params.id = uuid;
  params.port = port;
  params.add = server;
  return params;
}

function parseVmessParams(decoded, raw) {
  try {
    // V2rayN URI 格式(base64 JSON)。
    return JSON.parse(decoded);
  } catch {
    // Shadowrocket URI 格式回退。
    return parseVmessShadowrocketParams(raw);
  }
}

function parseVmessQuantumult(content) {
  const partitions = content.split(',').map((p) => p.trim());
  const params = {};
  for (const part of partitions) {
    if (part.indexOf('=') !== -1) {
      const [key, val] = H.splitOnce(part, '=');
      params[key.trim()] = (val && val.trim()) || '';
    }
  }
  const proxy = {
    name: partitions[0].split('=')[0].trim(),
    type: 'vmess',
    server: partitions[1],
    port: H.parseRequiredPort(partitions[2], 'Invalid vmess uri: invalid port'),
    cipher: H.getCipher(H.getIfNotBlank(partitions[3], 'auto')),
    uuid: (partitions[4].match(/^"(.*)"$/) || [])[1] || '',
    tls: params.obfs === 'wss',
    udp: H.parseBool(params['udp-relay']),
    tfo: H.parseBool(params['fast-open']),
    'skip-cert-verify':
      params['tls-verification'] === undefined ? undefined : !H.parseBool(params['tls-verification']),
  };
  if (H.isPresent(params.obfs)) {
    if (params.obfs === 'ws' || params.obfs === 'wss') {
      proxy.network = 'ws';
      proxy['ws-opts'] = {
        path: ((H.getIfNotBlank(params['obfs-path']) || '"/"').match(/^"(.*)"$/) || [])[1] || '/',
        headers: {
          Host: (params['obfs-header'] && params['obfs-header'].match(/Host:\s*([a-zA-Z0-9-.]*)/) || [])[1] || '',
        },
      };
    } else {
      throw new Error(`Unsupported obfs: ${params.obfs}`);
    }
  }
  return proxy;
}

function URI_VMESS(line) {
  const afterScheme = H.stripUriScheme(line, 'vmess', 'Invalid vmess uri');
  if (!afterScheme) throw new Error('Invalid vmess uri');
  const raw = afterScheme;
  const content = H.decodeBase64OrOriginal(raw);
  if (/=\s*vmess/.test(content)) {
    return parseVmessQuantumult(content);
  }

  const params = parseVmessParams(content, raw);
  const server = params.add;
  const port = H.parseRequiredPort(params.port, 'Invalid vmess uri: invalid port');
  const tlsValue = params.tls;
  const proxy = {
    name:
      H.trimStr(params.ps) ??
      H.trimStr(params.remarks) ??
      H.trimStr(params.remark) ??
      `VMess ${server}:${port}`,
    type: 'vmess',
    server,
    port,
    cipher: H.getCipher(H.getIfPresent(params.scy, 'auto')),
    uuid: params.id,
    tls:
      tlsValue === 'tls' ||
      tlsValue === true ||
      tlsValue === 1 ||
      tlsValue === '1' ||
      tlsValue === 'true',
    'skip-cert-verify': H.isPresent(params.verify_cert)
      ? !H.parseBool(params.verify_cert.toString())
      : undefined,
  };

  proxy.alterId = parseInt(H.getIfPresent(params.aid ?? params.alterId, 0), 10);

  if (proxy.tls && params.sni) {
    proxy.servername = params.sni;
  }

  let httpupgrade = false;
  if (params.net === 'ws' || params.obfs === 'websocket') {
    proxy.network = 'ws';
  } else if (
    ['http'].includes(params.net) ||
    ['http'].includes(params.obfs) ||
    ['http'].includes(params.type)
  ) {
    proxy.network = 'http';
  } else if (['grpc'].includes(params.net)) {
    proxy.network = 'grpc';
  } else if (params.net === 'httpupgrade') {
    proxy.network = 'ws';
    httpupgrade = true;
  } else if (params.net === 'h2' || proxy.network === 'h2') {
    proxy.network = 'h2';
  }

  if (proxy.network) {
    let transportHost = params.host ?? params.obfsParam;
    if (typeof transportHost === 'string') {
      try {
        const parsedObfs = JSON.parse(transportHost);
        const parsedHost = parsedObfs && parsedObfs.Host;
        if (parsedHost) transportHost = parsedHost;
      } catch {
        // 非 JSON transportHost — 原样用。
      }
    }

    const transportPath = params.path;
    const hostFirst = H.getIfNotBlank(H.firstString(transportHost));
    const pathFirst = H.getIfNotBlank(H.firstString(transportPath));

    switch (proxy.network) {
      case 'grpc': {
        if (!hostFirst && !pathFirst) {
          delete proxy.network;
          break;
        }
        const serviceName = H.getIfNotBlank(pathFirst);
        if (serviceName) proxy['grpc-opts'] = { 'grpc-service-name': serviceName };
        break;
      }
      case 'h2': {
        if (!hostFirst && !pathFirst) {
          delete proxy.network;
          break;
        }
        const h2Opts = {};
        if (hostFirst) h2Opts.host = hostFirst;
        if (pathFirst) h2Opts.path = pathFirst;
        if (Object.keys(h2Opts).length > 0) proxy['h2-opts'] = h2Opts;
        break;
      }
      case 'http': {
        const hosts = Array.isArray(transportHost)
          ? transportHost.map((h) => String(h).trim()).filter((h) => h)
          : hostFirst
            ? [hostFirst]
            : undefined;
        let paths = Array.isArray(transportPath)
          ? transportPath.map((p) => String(p).trim()).filter((p) => p)
          : pathFirst
            ? [pathFirst]
            : [];
        if (paths.length === 0) paths = ['/'];
        const httpOpts = { path: paths };
        if (hosts && hosts.length > 0) httpOpts.headers = { Host: hosts };
        proxy['http-opts'] = httpOpts;
        break;
      }
      case 'ws': {
        if (!hostFirst && !pathFirst && !httpupgrade) {
          delete proxy.network;
          break;
        }
        const wsOpts = {
          path: pathFirst,
          headers: hostFirst ? { Host: hostFirst } : undefined,
        };
        if (httpupgrade) {
          wsOpts['v2ray-http-upgrade'] = true;
          wsOpts['v2ray-http-upgrade-fast-open'] = true;
        }
        proxy['ws-opts'] = wsOpts;
        break;
      }
      default:
        break;
    }

    if (proxy.tls && !proxy.servername && hostFirst) {
      proxy.servername = hostFirst;
    }
  }

  return proxy;
}

// ── VLESS ────────────────────────────────────────────────────────────────────
function URI_VLESS(line) {
  const afterScheme = H.stripUriScheme(line, 'vless', 'Invalid vless uri');
  if (!afterScheme) throw new Error('Invalid vless uri');

  let rest = afterScheme;
  let isShadowrocket = false;

  const parseVlessRest = (input) => {
    const parsed = H.parseUrlLike(input, { requireAuth: true, errorMessage: 'Invalid vless uri' });
    if (!parsed.port) throw new Error('Invalid vless uri: missing port');
    const port = H.parseRequiredPort(parsed.port, 'Invalid vless uri: invalid port');
    return {
      uuidRaw: parsed.auth,
      server: parsed.host,
      port,
      addons: parsed.query,
      nameRaw: parsed.fragment,
    };
  };

  let parsed;
  try {
    parsed = parseVlessRest(rest);
  } catch {
    const shadowMatch = /^(.*?)(\?.*?$)/.exec(rest);
    if (!shadowMatch) throw new Error('Invalid vless uri');
    const [, base64Part, other] = shadowMatch;
    rest = `${H.decodeBase64OrOriginal(base64Part)}${other}`;
    parsed = parseVlessRest(rest);
    isShadowrocket = true;
  }

  const { uuidRaw, server, port, addons = '', nameRaw } = parsed;

  let uuid = uuidRaw;
  if (isShadowrocket) uuid = uuid.replace(/^.*?:/g, '');
  uuid = H.safeDecodeURIComponent(uuid) ?? uuid;

  const params = H.parseQueryStringNormalized(addons);
  const name =
    H.decodeAndTrim(nameRaw) ??
    H.trimStr(params.remarks) ??
    H.trimStr(params.remark) ??
    `VLESS ${server}:${port}`;

  const proxy = { type: 'vless', name, server, port, uuid };

  proxy.tls = (params.security && params.security !== 'none') || undefined;
  if (isShadowrocket && H.parseBool(params.tls) === true) {
    proxy.tls = true;
    params.security = params.security ?? 'reality';
  }

  proxy.servername = params.sni || params.peer;
  proxy.flow = H.parseVlessFlow(params.flow);

  proxy['client-fingerprint'] = params.fp;
  proxy.alpn = params.alpn ? params.alpn.split(',') : undefined;
  if (Object.prototype.hasOwnProperty.call(params, 'allowInsecure')) {
    proxy['skip-cert-verify'] = H.parseBoolOrPresence(params.allowInsecure);
  }

  if (params.security === 'reality') {
    const opts = {};
    if (params.pbk) opts['public-key'] = params.pbk;
    if (params.sid) opts['short-id'] = params.sid;
    if (Object.keys(opts).length > 0) proxy['reality-opts'] = opts;
  }

  let httpupgrade = false;
  let network;

  if (params.headerType === 'http') {
    network = 'http';
  } else {
    let type = params.type;
    if (type === 'websocket') type = 'ws';
    if (isShadowrocket && type === 'sw') type = 'ws';
    if (type === 'httpupgrade') {
      network = 'ws';
      httpupgrade = true;
    } else if (type && ['tcp', 'ws', 'http', 'grpc', 'h2'].includes(type)) {
      network = type;
    } else {
      network = 'tcp';
    }
    // NOTE: `httpupgrade` is set ONLY by the dedicated `httpupgrade` transport
    // above. A plain `type=ws` node is a DISTINCT clash transport — forcing
    // `httpupgrade=true` here (as an earlier revision did) injected
    // `v2ray-http-upgrade`/`-fast-open: true` into every WebSocket node, changing
    // its wire protocol and breaking it (clash-verge-rev #3388). The sibling
    // VMess parser sets httpupgrade only for `net==='httpupgrade'`, matching this.
  }

  proxy.network = network;

  if (proxy.network && !['tcp', 'none'].includes(proxy.network)) {
    const host = params.host ?? params.obfsParam;
    const path = params.path;

    switch (proxy.network) {
      case 'grpc': {
        const serviceName = H.getIfNotBlank(path);
        if (serviceName) proxy['grpc-opts'] = { 'grpc-service-name': serviceName };
        break;
      }
      case 'h2': {
        const h2Opts = {};
        const hostVal = H.getIfNotBlank(host);
        const pathVal = H.getIfNotBlank(path);
        if (hostVal) h2Opts.host = hostVal;
        if (pathVal) h2Opts.path = pathVal;
        if (Object.keys(h2Opts).length > 0) proxy['h2-opts'] = h2Opts;
        break;
      }
      case 'http': {
        const httpOpts = {};
        const hostVal = H.getIfNotBlank(host);
        const pathVal = H.getIfNotBlank(path);
        if (pathVal) httpOpts.path = [pathVal];
        if (hostVal) httpOpts.headers = { Host: [hostVal] };
        if (Object.keys(httpOpts).length > 0) proxy['http-opts'] = httpOpts;
        break;
      }
      case 'ws': {
        const wsOpts = {};
        if (host) {
          if (params.obfsParam) {
            try {
              wsOpts.headers = JSON.parse(host);
            } catch {
              wsOpts.headers = { Host: host };
            }
          } else {
            wsOpts.headers = { Host: host };
          }
        }
        if (path) wsOpts.path = path;
        if (httpupgrade) {
          wsOpts['v2ray-http-upgrade'] = true;
          wsOpts['v2ray-http-upgrade-fast-open'] = true;
        }
        if (Object.keys(wsOpts).length > 0) proxy['ws-opts'] = wsOpts;
        break;
      }
      default:
        break;
    }
  }

  if (proxy.tls && !proxy.servername) {
    if (proxy.network === 'ws') {
      proxy.servername = proxy['ws-opts'] && proxy['ws-opts'].headers && proxy['ws-opts'].headers.Host;
    } else if (proxy.network === 'http') {
      proxy.servername =
        proxy['http-opts'] && proxy['http-opts'].headers && proxy['http-opts'].headers.Host && proxy['http-opts'].headers.Host[0];
    } else if (proxy.network === 'h2') {
      proxy.servername = proxy['h2-opts'] && proxy['h2-opts'].host;
    }
  }

  return proxy;
}

// ── Trojan ───────────────────────────────────────────────────────────────────
function URI_Trojan(line) {
  const afterScheme = H.stripUriScheme(line, 'trojan', 'Invalid trojan uri');
  if (!afterScheme) throw new Error('Invalid trojan uri');
  const {
    auth: passwordRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = H.parseUrlLike(afterScheme, { requireAuth: true, errorMessage: 'Invalid trojan uri' });
  const portNum = H.parsePortOrDefault(port, 443);
  const password = H.safeDecodeURIComponent(passwordRaw) ?? passwordRaw;
  const name = H.decodeAndTrim(nameRaw) ?? `Trojan ${server}:${portNum}`;
  const proxy = { type: 'trojan', name, server, port: portNum, password };

  const params = H.parseQueryStringNormalized(addons);

  const network = params.type;
  if (network && ['ws', 'grpc', 'h2', 'tcp'].includes(network)) {
    proxy.network = network;
  }

  const host = H.getIfNotBlank(params.host);
  const path = H.getIfNotBlank(params.path);

  if (params.alpn) proxy.alpn = params.alpn.split(',');
  if (params.sni) proxy.sni = params.sni;
  if (Object.prototype.hasOwnProperty.call(params, 'skip-cert-verify')) {
    proxy['skip-cert-verify'] = H.parseBoolOrPresence(params['skip-cert-verify']);
  }

  proxy.fingerprint = params.fingerprint ?? params.fp;

  if (params.encryption) {
    const encryption = params.encryption.split(';');
    if (encryption.length === 3) {
      proxy['ss-opts'] = { enabled: true, method: encryption[1], password: encryption[2] };
    }
  }

  if (params['client-fingerprint']) {
    proxy['client-fingerprint'] = params['client-fingerprint'];
  }

  if (proxy.network === 'ws') {
    const wsOpts = {};
    if (host) wsOpts.headers = { Host: host };
    if (path) wsOpts.path = path;
    if (Object.keys(wsOpts).length > 0) proxy['ws-opts'] = wsOpts;
  } else if (proxy.network === 'grpc') {
    const serviceName = H.getIfNotBlank(path);
    if (serviceName) proxy['grpc-opts'] = { 'grpc-service-name': serviceName };
  }

  return proxy;
}

// ── Shadowsocks ──────────────────────────────────────────────────────────────
function URI_SS(line) {
  const afterScheme = H.stripUriScheme(line, 'ss', 'Invalid ss uri');
  if (!afterScheme) throw new Error('Invalid ss uri');

  const [withoutHash, hashRaw] = H.splitOnce(afterScheme, '#');
  const nameFromHash = H.decodeAndTrim(hashRaw);

  const [mainRaw, queryRaw] = H.splitOnce(withoutHash, '?');
  const queryParams = H.parseQueryString(queryRaw);

  const main = mainRaw.includes('@') ? mainRaw : H.decodeBase64OrOriginal(mainRaw);
  const atIdx = main.lastIndexOf('@');
  if (atIdx === -1) throw new Error("Invalid ss uri: missing '@'");

  const userInfoStr = H.decodeBase64OrOriginal(main.slice(0, atIdx));
  const serverAndPortWithPath = main.slice(atIdx + 1);
  const serverAndPort = serverAndPortWithPath.split('/')[0];

  const portIdx = serverAndPort.lastIndexOf(':');
  if (portIdx === -1) throw new Error('Invalid ss uri: missing port');
  const server = serverAndPort.slice(0, portIdx);
  const portRaw = serverAndPort.slice(portIdx + 1);
  const port = H.parseRequiredPort(portRaw, 'Invalid ss uri: invalid port');

  const userInfo = userInfoStr.match(/(^.*?):(.*$)/);

  const proxy = {
    name: nameFromHash ?? `SS ${server}:${port}`,
    type: 'ss',
    server,
    port,
    cipher: H.getCipher(userInfo && userInfo[1]),
    password: userInfo && userInfo[2],
  };

  const pluginParam = queryParams.plugin;
  if (pluginParam) {
    const pluginParts = pluginParam.split(';');
    const pluginName = pluginParts[0];
    const pluginOptions = { plugin: pluginName };
    for (const raw of pluginParts.slice(1)) {
      if (!raw) continue;
      const [key, val] = H.splitOnce(raw, '=');
      if (!key) continue;
      pluginOptions[key] = val === undefined || val === '' ? true : val;
    }
    switch (pluginOptions.plugin) {
      case 'obfs-local':
      case 'simple-obfs':
        proxy.plugin = 'obfs';
        proxy['plugin-opts'] = { mode: pluginOptions.obfs, host: H.getIfNotBlank(pluginOptions['obfs-host']) };
        break;
      case 'v2ray-plugin':
        proxy.plugin = 'v2ray-plugin';
        proxy['plugin-opts'] = {
          mode: 'websocket',
          host: H.getIfNotBlank(pluginOptions['obfs-host'] ?? pluginOptions.host),
          path: H.getIfNotBlank(pluginOptions.path),
          tls: H.getIfPresent(pluginOptions.tls),
        };
        break;
      default:
        throw new Error(`Unsupported plugin option: ${pluginOptions.plugin}`);
    }
  }

  const v2rayPluginParam = queryParams['v2ray-plugin'];
  if (!proxy.plugin && v2rayPluginParam) {
    proxy.plugin = 'v2ray-plugin';
    try {
      proxy['plugin-opts'] = JSON.parse(H.decodeBase64OrOriginal(v2rayPluginParam));
    } catch {
      proxy['plugin-opts'] = {};
    }
  }

  if (Object.prototype.hasOwnProperty.call(queryParams, 'uot') && H.parseBoolOrPresence(queryParams.uot)) {
    proxy['udp-over-tcp'] = true;
  }
  if (Object.prototype.hasOwnProperty.call(queryParams, 'tfo') && H.parseBoolOrPresence(queryParams.tfo)) {
    proxy.tfo = true;
  }

  return proxy;
}

// ── ShadowsocksR ─────────────────────────────────────────────────────────────
function URI_SSR(uri) {
  const afterScheme = H.stripUriScheme(uri, 'ssr', 'Invalid ssr uri');
  if (!afterScheme) throw new Error('Invalid ssr uri');
  const line = H.decodeBase64OrOriginal(afterScheme);

  let splitIdx = line.indexOf(':origin');
  if (splitIdx === -1) splitIdx = line.indexOf(':auth_');
  if (splitIdx === -1) throw new Error('Invalid ssr uri');
  const serverAndPort = line.substring(0, splitIdx);
  const portIdx = serverAndPort.lastIndexOf(':');
  if (portIdx === -1) throw new Error('Invalid ssr uri: missing port');
  const server = serverAndPort.substring(0, portIdx);
  const port = H.parseRequiredPort(serverAndPort.substring(portIdx + 1), 'Invalid ssr uri: invalid port');

  const params = line.substring(splitIdx + 1).split('/?')[0].split(':');
  let proxy = {
    name: 'SSR',
    type: 'ssr',
    server,
    port,
    protocol: params[0],
    cipher: H.getCipher(params[1]),
    obfs: params[2],
    password: H.decodeBase64OrOriginal(params[3]),
  };

  const otherParams = {};
  const rawOtherParams = H.parseQueryString(line.split('/?')[1]);
  for (const [key, value] of Object.entries(rawOtherParams)) {
    const trimmed = value && value.trim();
    if (trimmed) otherParams[key] = trimmed;
  }

  proxy = {
    ...proxy,
    name: otherParams.remarks
      ? H.decodeBase64OrOriginal(otherParams.remarks).trim()
      : (proxy.server ?? ''),
    'protocol-param': H.getIfNotBlank(H.decodeBase64OrOriginal(otherParams.protoparam || '').replace(/\s/g, '')),
    'obfs-param': H.getIfNotBlank(H.decodeBase64OrOriginal(otherParams.obfsparam || '').replace(/\s/g, '')),
  };
  return proxy;
}

// ── Hysteria2 ────────────────────────────────────────────────────────────────
function URI_Hysteria2(line) {
  const afterScheme = H.stripUriScheme(line, ['hysteria2', 'hy2'], 'Invalid hysteria2 uri');
  if (!afterScheme) throw new Error('Invalid hysteria2 uri');
  const {
    auth: passwordRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = H.parseUrlLike(afterScheme, { requireAuth: true, errorMessage: 'Invalid hysteria2 uri' });
  const portNum = H.parsePortOrDefault(port, 443);
  const password = H.safeDecodeURIComponent(passwordRaw) ?? passwordRaw;
  const decodedName = H.decodeAndTrim(nameRaw);
  const name = decodedName ?? `Hysteria2 ${server}:${portNum}`;

  const proxy = { type: 'hysteria2', name, server, port: portNum, password };

  const params = H.parseQueryStringNormalized(addons);
  proxy.sni = params.sni;
  if (!proxy.sni && params.peer) proxy.sni = params.peer;
  if (params.obfs && params.obfs !== 'none') proxy.obfs = params.obfs;

  proxy.ports = params.mport;
  proxy['obfs-password'] = params['obfs-password'];
  if (Object.prototype.hasOwnProperty.call(params, 'insecure')) {
    proxy['skip-cert-verify'] = H.parseBoolOrPresence(params.insecure);
  }
  if (Object.prototype.hasOwnProperty.call(params, 'fastopen')) {
    proxy.tfo = H.parseBoolOrPresence(params.fastopen);
  }
  proxy.fingerprint = params.pinSHA256;

  return proxy;
}

// ── Hysteria (v1) ────────────────────────────────────────────────────────────
function URI_Hysteria(line) {
  const afterScheme = H.stripUriScheme(line, ['hysteria', 'hy'], 'Invalid hysteria uri');
  if (!afterScheme) throw new Error('Invalid hysteria uri');
  const {
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = H.parseUrlLike(afterScheme, { errorMessage: 'Invalid hysteria uri' });
  const portNum = H.parsePortOrDefault(port, 443);
  const name = H.decodeAndTrim(nameRaw) ?? `Hysteria ${server}:${portNum}`;

  const proxy = { type: 'hysteria', name, server, port: portNum };

  const params = H.parseQueryStringNormalized(addons);
  for (const [key, value] of Object.entries(params)) {
    switch (key) {
      case 'alpn':
        proxy.alpn = value ? value.split(',') : undefined;
        break;
      case 'insecure':
        proxy['skip-cert-verify'] = H.parseBoolOrPresence(value);
        break;
      case 'auth':
        if (value) proxy['auth-str'] = value;
        break;
      case 'mport':
        if (value) proxy.ports = value;
        break;
      case 'obfsParam':
        if (value) proxy.obfs = value;
        break;
      case 'upmbps':
        if (value) proxy.up = value;
        break;
      case 'downmbps':
        if (value) proxy.down = value;
        break;
      case 'obfs':
        if (value !== undefined) proxy.obfs = value || '';
        break;
      case 'fast-open':
        proxy['fast-open'] = H.parseBoolOrPresence(value);
        break;
      case 'peer':
        if (!proxy.sni && value) proxy.sni = value;
        break;
      case 'recv-window-conn':
        proxy['recv-window-conn'] = H.parseInteger(value);
        break;
      case 'recv-window':
        proxy['recv-window'] = H.parseInteger(value);
        break;
      case 'ca':
        if (value) proxy.ca = value;
        break;
      case 'ca-str':
        if (value) proxy['ca-str'] = value;
        break;
      case 'disable-mtu-discovery':
        proxy['disable-mtu-discovery'] = H.parseBoolOrPresence(value);
        break;
      case 'fingerprint':
        if (value) proxy.fingerprint = value;
        break;
      case 'protocol':
        if (value) proxy.protocol = value;
        break;
      case 'sni':
        if (value) proxy.sni = value;
        break;
      default:
        break;
    }
  }

  if (!proxy.protocol) proxy.protocol = 'udp';

  return proxy;
}

// ── TUIC ─────────────────────────────────────────────────────────────────────
function URI_TUIC(line) {
  const afterScheme = H.stripUriScheme(line, 'tuic', 'Invalid tuic uri');
  if (!afterScheme) throw new Error('Invalid tuic uri');
  const {
    auth,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = H.parseUrlLike(afterScheme, { requireAuth: true, errorMessage: 'Invalid tuic uri' });
  const [uuid, passwordRaw] = H.splitOnce(auth, ':');
  if (passwordRaw === undefined) throw new Error('Invalid tuic uri');

  const portNum = H.parsePortOrDefault(port, 443);
  const password = H.safeDecodeURIComponent(passwordRaw) ?? passwordRaw;
  const decodedName = H.decodeAndTrim(nameRaw);
  const name = decodedName ?? `TUIC ${server}:${portNum}`;

  const proxy = { type: 'tuic', name, server, port: portNum, password, uuid };

  const params = H.parseQueryStringNormalized(addons);
  for (const [key, value] of Object.entries(params)) {
    switch (key) {
      case 'token':
        proxy.token = value;
        break;
      case 'ip':
        proxy.ip = value;
        break;
      case 'heartbeat-interval':
        proxy['heartbeat-interval'] = H.parseInteger(value);
        break;
      case 'alpn':
        proxy.alpn = value ? value.split(',') : undefined;
        break;
      case 'disable-sni':
        proxy['disable-sni'] = H.parseBoolOrPresence(value);
        break;
      case 'reduce-rtt':
        proxy['reduce-rtt'] = H.parseBoolOrPresence(value);
        break;
      case 'request-timeout':
        proxy['request-timeout'] = H.parseInteger(value);
        break;
      case 'udp-relay-mode':
        proxy['udp-relay-mode'] = value;
        break;
      case 'congestion-controller':
        proxy['congestion-controller'] = value;
        break;
      case 'max-udp-relay-packet-size':
        proxy['max-udp-relay-packet-size'] = H.parseInteger(value);
        break;
      case 'fast-open':
        proxy['fast-open'] = H.parseBoolOrPresence(value);
        break;
      case 'skip-cert-verify':
      case 'allow-insecure':
        proxy['skip-cert-verify'] = H.parseBoolOrPresence(value);
        break;
      case 'max-open-streams':
        proxy['max-open-streams'] = H.parseInteger(value);
        break;
      case 'sni':
        proxy.sni = value;
        break;
      default:
        break;
    }
  }

  return proxy;
}

// ── WireGuard ────────────────────────────────────────────────────────────────
function URI_Wireguard(line) {
  const afterScheme = H.stripUriScheme(line, ['wireguard', 'wg'], 'Invalid wireguard uri');
  if (!afterScheme) throw new Error('Invalid wireguard uri');
  const {
    auth: privateKeyRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = H.parseUrlLike(afterScheme, { errorMessage: 'Invalid wireguard uri' });
  const portNum = H.parsePortOrDefault(port, 443);
  const privateKey = H.safeDecodeURIComponent(privateKeyRaw) ?? privateKeyRaw;
  const decodedName = H.decodeAndTrim(nameRaw);
  const name = decodedName ?? `WireGuard ${server}:${portNum}`;
  const proxy = { type: 'wireguard', name, server, port: portNum, 'private-key': privateKey, udp: true };

  const params = H.parseQueryStringNormalized(addons);
  for (const [key, value] of Object.entries(params)) {
    switch (key) {
      case 'address':
      case 'ip':
        if (!value) break;
        value.split(',').forEach((i) => {
          const ip = i.trim().replace(/\/\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
          if (H.isIPv4(ip)) proxy.ip = ip;
          else if (H.isIPv6(ip)) proxy.ipv6 = ip;
        });
        break;
      case 'publickey':
      case 'public-key':
        if (!value) break;
        proxy['public-key'] = value;
        break;
      case 'allowed-ips':
        if (!value) break;
        proxy['allowed-ips'] = value.split(',');
        break;
      case 'pre-shared-key':
        if (!value) break;
        proxy['pre-shared-key'] = value;
        break;
      case 'reserved': {
        if (!value) break;
        const parsed = value
          .split(',')
          .map((i) => H.parseInteger(i.trim()))
          .filter((i) => Number.isInteger(i));
        if (parsed.length === 3) proxy['reserved'] = parsed;
        break;
      }
      case 'udp':
        proxy.udp = H.parseBoolOrPresence(value);
        break;
      case 'mtu':
        proxy.mtu = H.parseInteger(value && value.trim());
        break;
      case 'dialer-proxy':
        proxy['dialer-proxy'] = value;
        break;
      case 'remote-dns-resolve':
        proxy['remote-dns-resolve'] = H.parseBoolOrPresence(value);
        break;
      case 'dns':
        if (!value) break;
        proxy.dns = value.split(',');
        break;
      default:
        break;
    }
  }

  return proxy;
}

// ── AnyTLS ───────────────────────────────────────────────────────────────────
function URI_AnyTLS(line) {
  const afterScheme = H.stripUriScheme(line, 'anytls', 'Invalid anytls uri');
  if (!afterScheme) throw new Error('Invalid anytls uri');
  const {
    auth: authRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = H.parseUrlLike(afterScheme, { errorMessage: 'Invalid anytls uri' });
  if (!server) throw new Error('Invalid anytls uri');
  const portNum = H.parsePortOrDefault(port, 443);
  const auth = H.safeDecodeURIComponent(authRaw) ?? authRaw;
  const decodedName = H.decodeAndTrim(nameRaw);
  const name = decodedName ?? `AnyTLS ${server}:${portNum}`;
  const proxy = { type: 'anytls', name, server, port: portNum, udp: true };

  if (auth) {
    const [username, password] = H.splitOnce(auth, ':');
    proxy.password = password ?? username;
  }

  const params = H.parseQueryStringNormalized(addons);
  if (params.sni) proxy.sni = params.sni;
  if (params.alpn) {
    const alpn = params.alpn.split(',').map((item) => item.trim()).filter(Boolean);
    if (alpn.length > 0) proxy.alpn = alpn;
  }

  const fingerprint = params.fingerprint ?? params.hpkp;
  if (fingerprint) proxy.fingerprint = fingerprint;
  const clientFingerprint = params['client-fingerprint'] ?? params.fp;
  if (clientFingerprint) proxy['client-fingerprint'] = clientFingerprint;

  if (Object.prototype.hasOwnProperty.call(params, 'skip-cert-verify')) {
    proxy['skip-cert-verify'] = H.parseBoolOrPresence(params['skip-cert-verify']);
  } else if (Object.prototype.hasOwnProperty.call(params, 'insecure')) {
    proxy['skip-cert-verify'] = H.parseBoolOrPresence(params.insecure);
  }

  if (Object.prototype.hasOwnProperty.call(params, 'udp')) {
    proxy.udp = H.parseBoolOrPresence(params.udp);
  }

  const idleCheck = H.parseInteger(params['idle-session-check-interval']);
  if (idleCheck !== undefined) proxy['idle-session-check-interval'] = idleCheck;
  const idleTimeout = H.parseInteger(params['idle-session-timeout']);
  if (idleTimeout !== undefined) proxy['idle-session-timeout'] = idleTimeout;
  const minIdle = H.parseInteger(params['min-idle-session']);
  if (minIdle !== undefined) proxy['min-idle-session'] = minIdle;

  return proxy;
}

// ── SOCKS5 ───────────────────────────────────────────────────────────────────
function URI_SOCKS(line) {
  const afterScheme = H.stripUriScheme(line, ['socks5', 'socks'], 'Invalid socks uri');
  if (!afterScheme) throw new Error('Invalid socks uri');
  const {
    auth: authRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = H.parseUrlLike(afterScheme, { errorMessage: 'Invalid socks uri' });
  const portNum = H.parsePortOrDefault(port, 443);
  const auth = H.safeDecodeURIComponent(authRaw) ?? authRaw;
  const decodedName = H.decodeAndTrim(nameRaw);
  const name = decodedName ?? `SOCKS5 ${server}:${portNum}`;
  const proxy = { type: 'socks5', name, server, port: portNum };
  if (auth) {
    const [username, password] = H.splitOnce(auth, ':');
    proxy.username = username;
    proxy.password = password;
  }

  const params = H.parseQueryStringNormalized(addons);
  for (const [key, value] of Object.entries(params)) {
    switch (key) {
      case 'tls':
        proxy.tls = H.parseBoolOrPresence(value);
        break;
      case 'fingerprint':
        proxy.fingerprint = value;
        break;
      case 'skip-cert-verify':
        proxy['skip-cert-verify'] = H.parseBoolOrPresence(value);
        break;
      case 'udp':
        proxy.udp = H.parseBoolOrPresence(value);
        break;
      case 'ip-version':
        proxy['ip-version'] = H.parseIpVersion(value);
        break;
      default:
        break;
    }
  }

  return proxy;
}

// ── HTTP(S) ──────────────────────────────────────────────────────────────────
function URI_HTTP(line) {
  const afterScheme = H.stripUriScheme(line, ['http', 'https'], 'Invalid http uri');
  if (!afterScheme) throw new Error('Invalid http uri');
  const {
    auth: authRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = H.parseUrlLike(afterScheme, { errorMessage: 'Invalid http uri' });
  const portNum = H.parsePortOrDefault(port, 443);
  const auth = H.safeDecodeURIComponent(authRaw) ?? authRaw;
  const decodedName = H.decodeAndTrim(nameRaw);
  const name = decodedName ?? `HTTP ${server}:${portNum}`;
  const proxy = { type: 'http', name, server, port: portNum };
  if (auth) {
    const [username, password] = H.splitOnce(auth, ':');
    proxy.username = username;
    proxy.password = password;
  }

  const params = H.parseQueryStringNormalized(addons);
  for (const [key, value] of Object.entries(params)) {
    switch (key) {
      case 'tls':
        proxy.tls = H.parseBoolOrPresence(value);
        break;
      case 'fingerprint':
        proxy.fingerprint = value;
        break;
      case 'skip-cert-verify':
        proxy['skip-cert-verify'] = H.parseBoolOrPresence(value);
        break;
      case 'ip-version':
        proxy['ip-version'] = H.parseIpVersion(value);
        break;
      default:
        break;
    }
  }

  return proxy;
}

// scheme → parser 派发映射(含别名 hy/hy2/wg/https/socks5,与上游 index.ts 对齐)。
const URI_PARSERS = {
  ss: URI_SS,
  ssr: URI_SSR,
  vmess: URI_VMESS,
  vless: URI_VLESS,
  trojan: URI_Trojan,
  anytls: URI_AnyTLS,
  hysteria2: URI_Hysteria2,
  hy2: URI_Hysteria2,
  hysteria: URI_Hysteria,
  hy: URI_Hysteria,
  tuic: URI_TUIC,
  wireguard: URI_Wireguard,
  wg: URI_Wireguard,
  http: URI_HTTP,
  https: URI_HTTP,
  socks5: URI_SOCKS,
  socks: URI_SOCKS,
};

/**
 * 把单条节点 URI 解析为完整 clash 节点对象。
 *
 * @param {string} uri  形如 `vmess://...` / `vless://...` 的单条节点链接。
 * @returns {object|null} 完整 clash 节点对象;未知 scheme / 解析抛错 / 坏输入 → null(上层跳过)。
 */
function parseNodeUri(uri) {
  try {
    const { uri: normalized, scheme } = H.normalizeUriAndGetScheme(uri);
    const parser = URI_PARSERS[scheme];
    if (!parser) return null;
    const node = parser(normalized);
    // 归一:server/port/name 必在,附 protocol 兼容既有前端/测试(与 type 同值)。
    if (!node || typeof node !== 'object') return null;
    if (!node.protocol && node.type) node.protocol = node.type;
    return node;
  } catch {
    return null;
  }
}

module.exports = {
  URI_PARSERS,
  parseNodeUri,
  // 各协议解析器单独导出,供细粒度测试。
  URI_VMESS,
  URI_VLESS,
  URI_Trojan,
  URI_SS,
  URI_SSR,
  URI_Hysteria2,
  URI_Hysteria,
  URI_TUIC,
  URI_Wireguard,
  URI_AnyTLS,
  URI_SOCKS,
  URI_HTTP,
};
