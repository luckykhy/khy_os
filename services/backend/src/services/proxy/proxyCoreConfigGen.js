'use strict';

/**
 * proxyCoreConfigGen.js — 纯叶子:把一个**已解析的代理节点对象**(proxyNodeParse / proxyUriParsers
 * 的产出:clash-native `{name,type,server,port,uuid,cipher,password,servername,network,...}`)
 * 分类到某条出站通道,并为需要内核的协议生成**最小 mihomo(clash-meta)配置对象**。
 *
 * 背景:仓库里**没有代理内核**(clash/mihomo/xray)。一个 vmess/ss/trojan 节点的解析对象本身
 * 不能承载流量——只有 HTTP CONNECT 端点能真正代理。故出站按节点协议分三条路:
 *   - direct-connect : http/https 类型节点自身就是 CONNECT 代理 → 调用方直接 applyProxy,无需内核。
 *   - core-required  : vmess/vless/trojan/ss/ssr + hysteria/hysteria2/tuic 需本机 mihomo 生成配置
 *                      + spawn 暴露本地混合端口(mihomo/clash-meta 原生承载这些出站)。
 *   - unsupported    : socks5-only / wireguard / anytls 等首版不接,明确返 reason。
 *
 * 契约:纯叶子 —— 零 I/O(不碰 fs / 网络 / 子进程 / 时钟 / 随机)、确定性、绝不抛、不 mutate 入参。
 * 无 g 标志正则。本文件不读任何环境门控(门控 KHY_PROXY_CORE 由 proxyCoreManager 这层 IO 服务掌管;
 * 配置生成是纯变换,始终可跑、始终可单测)。
 *
 * @module services/proxy/proxyCoreConfigGen
 */

// 直连通道:节点自身即 HTTP CONNECT 代理,无需内核。
const DIRECT_CONNECT_TYPES = new Set(['http', 'https']);
// 需内核通道:mihomo(clash-meta)原生承载的机场协议。
// 说明:早先只放行 vmess/vless/trojan/ss/ssr 五种,导致机场常见的 hysteria2/hysteria/tuic 节点
// 被误判 unsupported、前端弹「未能启用该节点」。mihomo 对这三种 QUIC 协议同样原生支持,且
// proxyUriParsers 已产出 clash-native 字段,故一并放行(修复「节点无法选择」)。
const CORE_REQUIRED_TYPES = new Set([
  'vmess', 'vless', 'trojan', 'ss', 'ssr',
  'hysteria2', 'hysteria', 'tuic',
]);

// 每协议的必填字段(缺失即无法生成合法 mihomo outbound → 结构化报错,绝不臆造)。
const REQUIRED_FIELDS = {
  vmess: ['server', 'port', 'uuid'],
  vless: ['server', 'port', 'uuid'],
  trojan: ['server', 'port', 'password'],
  ss: ['server', 'port', 'cipher', 'password'],
  ssr: ['server', 'port', 'cipher', 'password'],
  // QUIC 系:hysteria2 必须有密码;hysteria(v1)/tuic 认证形态多样(auth-str / uuid+password /
  // token),仅硬性要求 server+port,其余交由 mihomo 校验,避免误伤合法变体。
  hysteria2: ['server', 'port', 'password'],
  hysteria: ['server', 'port'],
  tuic: ['server', 'port'],
};

function _type(node) {
  const raw = node && (node.type || node.protocol);
  return String(raw || '').trim().toLowerCase();
}

/**
 * 把节点分类到出站通道。
 * @param {object} node 已解析节点对象。
 * @returns {'direct-connect'|'core-required'|'unsupported'}
 */
function classifyNodeEgress(node) {
  const t = _type(node);
  if (!t) return 'unsupported';
  if (DIRECT_CONNECT_TYPES.has(t)) return 'direct-connect';
  if (CORE_REQUIRED_TYPES.has(t)) return 'core-required';
  return 'unsupported';
}

// 人类可读的 unsupported 原因(供上层原样透传给前端,不谎报能用)。
function describeUnsupported(node) {
  const t = _type(node) || '(未知)';
  return `暂不支持经内核承载协议 "${t}"。首版内核出站支持 `
    + `vmess/vless/trojan/ss/ssr/hysteria/hysteria2/tuic;`
    + `socks5/wireguard/anytls 等请改用本机 Clash 混合端口,或选 http 类型节点。`;
}

// 从节点对象里挑出 mihomo outbound 认得的字段(白名单透传,丢弃展示用别名 protocol)。
// 逐字节保留 clash-native 字段名(uuid/cipher/password/servername/network/ws-opts/...)。
const _PASSTHROUGH_KEYS = [
  'uuid', 'cipher', 'password', 'alterId', 'tls', 'servername', 'sni',
  'network', 'flow', 'udp', 'skip-cert-verify', 'client-fingerprint',
  'ws-opts', 'grpc-opts', 'h2-opts', 'http-opts', 'reality-opts', 'alpn',
  'obfs', 'obfs-param', 'protocol-param', 'plugin', 'plugin-opts',
  // QUIC 系(hysteria2 / hysteria / tuic)mihomo-native 字段。均为合法 outbound 字段,
  // 对不含它们的 vmess/ss 节点自然缺省(白名单透传,零副作用)。
  'up', 'down', 'ports', 'obfs-password', 'fingerprint', 'tfo', 'fast-open',
  'auth-str', 'recv-window-conn', 'recv-window', 'ca', 'ca-str', 'disable-mtu-discovery',
  'token', 'ip', 'heartbeat-interval', 'disable-sni', 'reduce-rtt', 'request-timeout',
  'udp-relay-mode', 'congestion-controller', 'max-udp-relay-packet-size',
];

// 仅特定协议才透传的字段。`protocol` 对 hysteria(v1)是真实传输字段(udp/faketcp/wechat-video),
// 但对 vmess 等是「展示别名」必须丢弃,故不能进共用白名单——按类型精确放行。
const _TYPE_EXTRA_KEYS = {
  hysteria: ['protocol'],
};

function _buildOutbound(node, name) {
  const t = _type(node);
  const out = {
    name,
    type: t,
    server: String(node.server || '').trim(),
    port: Number.parseInt(node.port, 10),
  };
  const keys = _PASSTHROUGH_KEYS.concat(_TYPE_EXTRA_KEYS[t] || []);
  for (const key of keys) {
    if (node[key] !== undefined && node[key] !== null && node[key] !== '') {
      out[key] = node[key];
    }
  }
  return out;
}

function _missingFields(node) {
  const t = _type(node);
  const required = REQUIRED_FIELDS[t] || [];
  const missing = [];
  for (const field of required) {
    const v = node ? node[field] : undefined;
    if (field === 'port') {
      if (!Number.isFinite(Number.parseInt(v, 10))) missing.push(field);
    } else if (v === undefined || v === null || String(v).trim() === '') {
      missing.push(field);
    }
  }
  return missing;
}

/**
 * 为一个 core-required 节点生成最小 mihomo(clash-meta)配置对象。
 * @param {object} node 已解析节点对象(clash-native 字段)。
 * @param {object} [options] { mixedPort?:number }
 * @returns {{ ok:true, config:object, nodeName:string } | { ok:false, error:string, missing?:string[] }}
 */
function buildMihomoConfig(node, options = {}) {
  const kind = classifyNodeEgress(node);
  if (kind !== 'core-required') {
    return {
      ok: false,
      error: kind === 'direct-connect'
        ? '直连型节点(http/https)无需内核配置,应由调用方直接 applyProxy。'
        : describeUnsupported(node),
    };
  }

  const missing = _missingFields(node);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `节点缺少必填字段: ${missing.join(', ')}(协议 ${_type(node)})。无法生成内核配置。`,
      missing,
    };
  }

  const mixedPort = Number.parseInt(options.mixedPort, 10);
  const port = Number.isFinite(mixedPort) && mixedPort > 0 ? mixedPort : 7899;
  // 节点名可能带空格/emoji;mihomo 允许,但保证非空且稳定。
  const nodeName = String(node.name || '').trim() || `${_type(node)}-node`;
  const outbound = _buildOutbound(node, nodeName);

  const config = {
    'mixed-port': port,
    'allow-lan': false,
    mode: 'global',
    'log-level': 'warning',
    proxies: [outbound],
    'proxy-groups': [
      { name: 'KHY', type: 'select', proxies: [nodeName] },
    ],
    rules: ['MATCH,KHY'],
  };

  return { ok: true, config, nodeName };
}

module.exports = {
  classifyNodeEgress,
  buildMihomoConfig,
  describeUnsupported,
  DIRECT_CONNECT_TYPES,
  CORE_REQUIRED_TYPES,
  REQUIRED_FIELDS,
};
