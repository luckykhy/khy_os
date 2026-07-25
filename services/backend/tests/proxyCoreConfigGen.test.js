'use strict';

/**
 * proxyCoreConfigGen 纯叶子测试(node:test,零依赖)。
 *   node --test services/backend/tests/proxyCoreConfigGen.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const gen = require('../src/services/proxy/proxyCoreConfigGen');

test('classifyNodeEgress: http/https 型 → direct-connect', () => {
  assert.equal(gen.classifyNodeEgress({ type: 'http', server: 'h', port: 8080 }), 'direct-connect');
  assert.equal(gen.classifyNodeEgress({ type: 'https', server: 'h', port: 443 }), 'direct-connect');
  // protocol 别名也认。
  assert.equal(gen.classifyNodeEgress({ protocol: 'http', server: 'h', port: 8080 }), 'direct-connect');
});

test('classifyNodeEgress: vmess/vless/trojan/ss/ssr + hysteria/hysteria2/tuic → core-required', () => {
  // mihomo 原生承载:机场协议 + QUIC 三件套(修复「hysteria2 节点无法选择」)。
  for (const t of ['vmess', 'vless', 'trojan', 'ss', 'ssr', 'hysteria2', 'hysteria', 'tuic']) {
    assert.equal(gen.classifyNodeEgress({ type: t, server: 'h', port: 443 }), 'core-required', t);
  }
});

test('classifyNodeEgress: socks5/wireguard/anytls/未知 → unsupported', () => {
  for (const t of ['socks5', 'wireguard', 'anytls', 'weird', '']) {
    assert.equal(gen.classifyNodeEgress({ type: t }), 'unsupported', t);
  }
  assert.equal(gen.classifyNodeEgress(null), 'unsupported');
  assert.equal(gen.classifyNodeEgress({}), 'unsupported');
});

test('buildMihomoConfig: vmess 全字段 → 合法 mihomo 骨架', () => {
  const node = {
    name: '🇭🇰 HK-01', type: 'vmess', server: 'a.example.com', port: 443,
    uuid: 'u-1234', cipher: 'auto', alterId: 0, tls: true, servername: 'a.example.com',
    network: 'ws', protocol: 'vmess', // 展示别名应被丢弃
  };
  const r = gen.buildMihomoConfig(node, { mixedPort: 7899 });
  assert.equal(r.ok, true);
  assert.equal(r.config['mixed-port'], 7899);
  assert.equal(r.config.mode, 'global');
  assert.equal(r.config['allow-lan'], false);
  assert.equal(r.config.proxies.length, 1);
  const ob = r.config.proxies[0];
  assert.equal(ob.type, 'vmess');
  assert.equal(ob.server, 'a.example.com');
  assert.equal(ob.port, 443);
  assert.equal(ob.uuid, 'u-1234');
  assert.equal(ob.network, 'ws');
  // 展示别名 protocol 不得进 outbound。
  assert.equal(ob.protocol, undefined);
  // proxy-group 引用节点名,rule 收敛到 KHY。
  assert.equal(r.config['proxy-groups'][0].proxies[0], r.nodeName);
  assert.deepEqual(r.config.rules, ['MATCH,KHY']);
});

test('buildMihomoConfig: trojan/ss 必填字段映射', () => {
  const trojan = gen.buildMihomoConfig({ name: 't', type: 'trojan', server: 'h', port: 443, password: 'p' });
  assert.equal(trojan.ok, true);
  assert.equal(trojan.config.proxies[0].password, 'p');

  const ss = gen.buildMihomoConfig({ name: 's', type: 'ss', server: 'h', port: 8388, cipher: 'aes-256-gcm', password: 'p' });
  assert.equal(ss.ok, true);
  assert.equal(ss.config.proxies[0].cipher, 'aes-256-gcm');
});

test('buildMihomoConfig: hysteria2 带密码 → 合法 outbound,QUIC 字段透传', () => {
  const node = {
    name: '🇸🇬 hy2', type: 'hysteria2', server: 'h.example.com', port: 443,
    password: 'pw', sni: 'h.example.com', 'skip-cert-verify': true,
    up: '50 Mbps', down: '200 Mbps', obfs: 'salamander', 'obfs-password': 'ob',
  };
  const r = gen.buildMihomoConfig(node);
  assert.equal(r.ok, true);
  const ob = r.config.proxies[0];
  assert.equal(ob.type, 'hysteria2');
  assert.equal(ob.password, 'pw');
  assert.equal(ob.up, '50 Mbps');
  assert.equal(ob.down, '200 Mbps');
  assert.equal(ob['obfs-password'], 'ob');
});

test('buildMihomoConfig: hysteria(v1) protocol 传输字段仅对 hysteria 透传', () => {
  const node = {
    name: 'hy1', type: 'hysteria', server: 'h', port: 443,
    'auth-str': 'a', protocol: 'udp', up: '20', down: '100',
  };
  const r = gen.buildMihomoConfig(node);
  assert.equal(r.ok, true);
  const ob = r.config.proxies[0];
  assert.equal(ob.type, 'hysteria');
  // hysteria 的 protocol 是真实传输字段(udp/faketcp),必须保留。
  assert.equal(ob.protocol, 'udp');
  assert.equal(ob['auth-str'], 'a');
});

test('buildMihomoConfig: tuic uuid+password → 合法 outbound', () => {
  const node = {
    name: 'tu', type: 'tuic', server: 'h', port: 443,
    uuid: 'u-1', password: 'p-1', 'congestion-controller': 'bbr',
  };
  const r = gen.buildMihomoConfig(node);
  assert.equal(r.ok, true);
  const ob = r.config.proxies[0];
  assert.equal(ob.type, 'tuic');
  assert.equal(ob.uuid, 'u-1');
  assert.equal(ob.password, 'p-1');
  assert.equal(ob['congestion-controller'], 'bbr');
});

test('buildMihomoConfig: hysteria2 缺 password → 结构化报错,列出 missing', () => {
  const r = gen.buildMihomoConfig({ name: 'x', type: 'hysteria2', server: 'h', port: 443 });
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.missing));
  assert.ok(r.missing.includes('password'));
});

test('buildMihomoConfig: 缺 uuid 的 vmess → 结构化报错,列出 missing', () => {
  const r = gen.buildMihomoConfig({ name: 'x', type: 'vmess', server: 'h', port: 443 });
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.missing));
  assert.ok(r.missing.includes('uuid'));
});

test('buildMihomoConfig: 缺 port → missing 含 port(非法端口也算缺)', () => {
  const r = gen.buildMihomoConfig({ name: 'x', type: 'trojan', server: 'h', port: 'not-a-port', password: 'p' });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('port'));
});

test('buildMihomoConfig: direct-connect / unsupported 节点走错分类 → 明确错误不生成', () => {
  const direct = gen.buildMihomoConfig({ name: 'd', type: 'http', server: 'h', port: 8080 });
  assert.equal(direct.ok, false);
  assert.match(direct.error, /直连|applyProxy/);

  const unsup = gen.buildMihomoConfig({ name: 'w', type: 'wireguard', server: 'h', port: 51820 });
  assert.equal(unsup.ok, false);
  assert.match(unsup.error, /暂不支持|wireguard/);
});

test('buildMihomoConfig: 默认 mixedPort(未传)稳定为 7899', () => {
  const r = gen.buildMihomoConfig({ name: 'v', type: 'vmess', server: 'h', port: 443, uuid: 'u' });
  assert.equal(r.ok, true);
  assert.equal(r.config['mixed-port'], 7899);
});

test('纯性:不 mutate 入参,重复调用稳定', () => {
  const node = Object.freeze({ name: 'v', type: 'vmess', server: 'h', port: 443, uuid: 'u', cipher: 'auto' });
  const a = gen.buildMihomoConfig(node, { mixedPort: 7900 });
  const b = gen.buildMihomoConfig(node, { mixedPort: 7900 });
  assert.deepEqual(a.config, b.config);
  // 冻结入参未抛 = 未 mutate。
  assert.equal(a.ok, true);
});
