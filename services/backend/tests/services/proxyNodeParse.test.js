'use strict';

/**
 * proxyNodeParse — 行为锁:订阅内容 → 代理节点对象列表的纯叶子解析(node:test)。
 *
 * 该叶子把「代理管理」订阅组导入所需的节点解析单一真源化:门开(KHY_PROXY_SUBSCRIPTION,默认 on)时
 * parseProxyNodes 把 vmess/vless/trojan/ss 节点 URI 与 Clash YAML proxies 解成
 * {name,type,protocol,server,port} 对象;门关时返空结果(caller 逐字节回退到 proxyConfigService 计数)。
 * 本套锁定:各协议解析、Clash flow/block 两风格、协议计数、门控三态、fail-soft 绝不抛、纯叶子零 I/O。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MOD = '../../src/services/proxyNodeParse';

function vmessUri(obj) {
  return 'vmess://' + Buffer.from(JSON.stringify(obj)).toString('base64');
}

// 节点现携完整 clash 字段(经 proxyUriParsers)——严格全等会破,故只比核心字段子集。
function coreOf(node) {
  return {
    name: node.name,
    type: node.type,
    protocol: node.protocol,
    server: node.server,
    port: node.port,
  };
}

test('isEnabled:缺省 → true(default-on)', () => {
  const d = require(MOD);
  assert.strictEqual(d.isEnabled({}), true);
});

test('isEnabled:门关值(0/off/false/no) → false', () => {
  const d = require(MOD);
  for (const v of ['0', 'off', 'false', 'no']) {
    assert.strictEqual(d.isEnabled({ KHY_PROXY_SUBSCRIPTION: v }), false, `值 ${v} 应关`);
  }
});

test('vmess:// base64 JSON → {name,server,port}', () => {
  const d = require(MOD);
  const uri = vmessUri({ ps: 'Tokyo-01', add: '1.2.3.4', port: '443', id: 'abc' });
  const { nodes, format } = d.parseProxyNodes(uri, {});
  assert.strictEqual(format, 'node-links');
  assert.strictEqual(nodes.length, 1);
  assert.deepStrictEqual(coreOf(nodes[0]), { name: 'Tokyo-01', type: 'vmess', protocol: 'vmess', server: '1.2.3.4', port: 443 });
});

test('vless:// / trojan:// userinfo URI → host:port + fragment 名', () => {
  const d = require(MOD);
  const text = [
    'vless://11111111-2222-3333-4444-555555555555@5.6.7.8:443?type=ws&security=tls#Osaka-VLESS',
    'trojan://password123@9.9.9.9:8443?sni=example.com#HK-Trojan',
  ].join('\n');
  const { nodes } = d.parseProxyNodes(text, {});
  assert.strictEqual(nodes.length, 2);
  assert.deepStrictEqual(coreOf(nodes[0]), { name: 'Osaka-VLESS', type: 'vless', protocol: 'vless', server: '5.6.7.8', port: 443 });
  assert.deepStrictEqual(coreOf(nodes[1]), { name: 'HK-Trojan', type: 'trojan', protocol: 'trojan', server: '9.9.9.9', port: 8443 });
});

test('ss:// base64 userinfo(明文 host:port)→ server/port', () => {
  const d = require(MOD);
  const uri = 'ss://' + Buffer.from('aes-256-gcm:pw').toString('base64') + '@2.2.2.2:8388#SS-Node';
  const { nodes } = d.parseProxyNodes(uri, {});
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(nodes[0].server, '2.2.2.2');
  assert.strictEqual(nodes[0].port, 8388);
  assert.strictEqual(nodes[0].protocol, 'ss');
  assert.strictEqual(nodes[0].name, 'SS-Node');
});

test('ss:// 整段 base64(含 @host:port)→ server/port', () => {
  const d = require(MOD);
  const uri = 'ss://' + Buffer.from('aes-256-gcm:pw@3.3.3.3:8388').toString('base64') + '#SS-Full';
  const { nodes } = d.parseProxyNodes(uri, {});
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(nodes[0].server, '3.3.3.3');
  assert.strictEqual(nodes[0].port, 8388);
});

test('Clash YAML flow 风格 {name,type,server,port}', () => {
  const d = require(MOD);
  const yaml = [
    'proxies:',
    '  - {name: "CN-vmess", type: vmess, server: a.example.com, port: 443}',
    '  - {name: "US-ss", type: ss, server: b.example.com, port: 8388}',
    'proxy-groups:',
    '  - name: PROXY',
  ].join('\n');
  const { nodes, format, protocolCount } = d.parseProxyNodes(yaml, {});
  assert.strictEqual(format, 'clash-config');
  assert.strictEqual(nodes.length, 2);
  assert.strictEqual(nodes[0].name, 'CN-vmess');
  assert.strictEqual(nodes[0].server, 'a.example.com');
  assert.strictEqual(nodes[0].port, 443);
  assert.strictEqual(nodes[1].type, 'ss');
  assert.deepStrictEqual(protocolCount, { vmess: 1, ss: 1 });
});

test('Clash YAML block 风格(缩进 key: value)', () => {
  const d = require(MOD);
  const yaml = [
    'proxies:',
    '  - name: JP-trojan',
    '    type: trojan',
    '    server: jp.example.com',
    '    port: 8443',
    '  - name: SG-vless',
    '    type: vless',
    '    server: sg.example.com',
    '    port: 443',
  ].join('\n');
  const { nodes } = d.parseProxyNodes(yaml, {});
  assert.strictEqual(nodes.length, 2);
  assert.deepStrictEqual(nodes[0], { name: 'JP-trojan', type: 'trojan', protocol: 'trojan', server: 'jp.example.com', port: 8443 });
  assert.deepStrictEqual(nodes[1], { name: 'SG-vless', type: 'vless', protocol: 'vless', server: 'sg.example.com', port: 443 });
});

test('协议计数正确聚合', () => {
  const d = require(MOD);
  const text = [
    vmessUri({ ps: 'a', add: '1.1.1.1', port: 1 }),
    vmessUri({ ps: 'b', add: '2.2.2.2', port: 2 }),
    'trojan://x@3.3.3.3:443#c',
  ].join('\n');
  const { protocolCount } = d.parseProxyNodes(text, {});
  assert.deepStrictEqual(protocolCount, { vmess: 2, trojan: 1 });
});

test('门关 → 空结果(逐字节回退)', () => {
  const d = require(MOD);
  const uri = vmessUri({ ps: 'x', add: '1.1.1.1', port: 1 });
  assert.deepStrictEqual(d.parseProxyNodes(uri, { KHY_PROXY_SUBSCRIPTION: '0' }), { nodes: [], protocolCount: {}, format: 'unknown' });
});

test('无法识别的文本 → 空 nodes、format unknown', () => {
  const d = require(MOD);
  const { nodes, format } = d.parseProxyNodes('this is just prose, not a subscription', {});
  assert.strictEqual(nodes.length, 0);
  assert.strictEqual(format, 'unknown');
});

test('fail-soft:异常输入不抛,返回空结构', () => {
  const d = require(MOD);
  assert.doesNotThrow(() => d.parseProxyNodes(null, {}));
  assert.doesNotThrow(() => d.parseProxyNodes(undefined, null));
  assert.deepStrictEqual(d.parseProxyNodes(null, {}), { nodes: [], protocolCount: {}, format: 'unknown' });
});

test('全字段贯通:node-links 携完整 clash 字段(vmess ws-opts/tls、vless reality)', () => {
  const d = require(MOD);
  const vmess = vmessUri({ ps: 'FF', add: '1.2.3.4', port: '443', id: 'uuid', net: 'ws', host: 'h.com', path: '/p', tls: 'tls' });
  const vless = 'vless://uuid-2@5.6.7.8:443?security=reality&pbk=PK&sid=SID&flow=xtls-rprx-vision&type=grpc#V';
  const { nodes } = d.parseProxyNodes([vmess, vless].join('\n'), {});
  assert.strictEqual(nodes.length, 2);
  // vmess 全字段
  assert.strictEqual(nodes[0].network, 'ws');
  assert.deepStrictEqual(nodes[0]['ws-opts'], { path: '/p', headers: { Host: 'h.com' } });
  assert.strictEqual(nodes[0].tls, true);
  // vless reality 全字段
  assert.deepStrictEqual(nodes[1]['reality-opts'], { 'public-key': 'PK', 'short-id': 'SID' });
  assert.strictEqual(nodes[1].flow, 'xtls-rprx-vision');
  assert.strictEqual(nodes[1].network, 'grpc');
});

test('扩充协议前缀:wireguard/hysteria2/anytls 被识别为 node-links', () => {
  const d = require(MOD);
  const text = [
    'wireguard://PRIV@3.3.3.3:51820?publickey=PUB&reserved=1,2,3#WG',
    'hysteria2://pw@1.1.1.1:443?sni=hy.com&obfs=salamander#HY2',
    'anytls://u:mypw@4.4.4.4:8443?sni=a.com#ANY',
  ].join('\n');
  const { nodes, format, protocolCount } = d.parseProxyNodes(text, {});
  assert.strictEqual(format, 'node-links');
  assert.strictEqual(nodes.length, 3);
  assert.deepStrictEqual(protocolCount, { wireguard: 1, hysteria2: 1, anytls: 1 });
  assert.deepStrictEqual(nodes[0].reserved, [1, 2, 3]);
  assert.strictEqual(nodes[1].obfs, 'salamander');
  assert.strictEqual(nodes[2].password, 'mypw');
});

test('纯叶子:源级零 I/O(不 require fs / net / http / 子进程 / 上层服务)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/proxyNodeParse.js'), 'utf8');
  for (const forbidden of ['fs', 'net', 'http', 'https', 'child_process', 'proxyConfigService', 'proxySubscriptionStore', 'ssrfGuard']) {
    assert.strictEqual(
      new RegExp(`require\\(\\s*['"]\\.?\\.?/?${forbidden}['"]`).test(src),
      false,
      `纯叶子不得 require ${forbidden}`,
    );
  }
  assert.ok(/纯叶子/.test(src) && /零 I\/O/.test(src) && /绝不抛/.test(src), 'docstring 应含纯叶子契约措辞');
});
