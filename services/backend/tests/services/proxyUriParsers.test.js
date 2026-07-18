'use strict';

/**
 * proxyUriParsers.test.js — 12 协议 URI → 完整 clash 节点对象解析器 + 注册表(node:test)。
 *
 * 覆盖:每协议 ≥1 真实样本断言全字段;未知 scheme → null;坏输入不抛;别名 scheme(hy/hy2/wg/
 * https/socks5)派发;parseNodeUri 归一(附 protocol 兼容字段、server/port/name 恒在)。
 */

const test = require('node:test');
const assert = require('node:assert');

const P = require('../../src/services/proxyUriParsers');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('vmess: V2rayN base64 JSON → ws-opts / tls / alterId 全字段', () => {
  const uri =
    'vmess://' +
    b64(
      JSON.stringify({
        v: '2',
        ps: '香港节点',
        add: '1.2.3.4',
        port: '443',
        id: 'uuid-1',
        aid: '0',
        scy: 'auto',
        net: 'ws',
        host: 'h.example.com',
        path: '/ray',
        tls: 'tls',
        sni: 's.example.com',
      }),
    );
  const node = P.parseNodeUri(uri);
  assert.strictEqual(node.type, 'vmess');
  assert.strictEqual(node.name, '香港节点');
  assert.strictEqual(node.server, '1.2.3.4');
  assert.strictEqual(node.port, 443);
  assert.strictEqual(node.uuid, 'uuid-1');
  assert.strictEqual(node.cipher, 'auto');
  assert.strictEqual(node.tls, true);
  assert.strictEqual(node.alterId, 0);
  assert.strictEqual(node.servername, 's.example.com');
  assert.strictEqual(node.network, 'ws');
  assert.deepStrictEqual(node['ws-opts'], { path: '/ray', headers: { Host: 'h.example.com' } });
});

test('vless: reality pbk→public-key / sid→short-id / flow / network', () => {
  const uri =
    'vless://uuid-2@5.6.7.8:443?security=reality&pbk=PUBKEY&sid=SHORTID&flow=xtls-rprx-vision&sni=x.com&type=grpc#VLESS';
  const node = P.parseNodeUri(uri);
  assert.strictEqual(node.type, 'vless');
  assert.strictEqual(node.uuid, 'uuid-2');
  assert.strictEqual(node.server, '5.6.7.8');
  assert.strictEqual(node.port, 443);
  assert.strictEqual(node.tls, true);
  assert.strictEqual(node.flow, 'xtls-rprx-vision');
  assert.strictEqual(node.servername, 'x.com');
  assert.deepStrictEqual(node['reality-opts'], { 'public-key': 'PUBKEY', 'short-id': 'SHORTID' });
  assert.strictEqual(node.network, 'grpc');
});

test('vless: flow=none → 归一为 undefined(不误带)', () => {
  const node = P.parseNodeUri('vless://u@1.1.1.1:443?flow=none&security=tls#V');
  assert.strictEqual(node.flow, undefined);
});

test('vless: 纯 type=ws 节点 NOT 被标记 http-upgrade(#3388 回归)', () => {
  // 普通 WebSocket 与 httpupgrade 是不同 clash 传输;误标 v2ray-http-upgrade 会改变线路协议破坏节点。
  const node = P.parseNodeUri('vless://u@example.com:443?type=ws&security=tls&host=cdn.example.com&path=%2Fws#N');
  assert.strictEqual(node.network, 'ws');
  assert.deepStrictEqual(node['ws-opts'], { headers: { Host: 'cdn.example.com' }, path: '/ws' });
  assert.strictEqual('v2ray-http-upgrade' in node['ws-opts'], false);
});

test('vless: type=websocket(归一为 ws)同样不被标记 http-upgrade', () => {
  const node = P.parseNodeUri('vless://u@example.com:443?type=websocket&security=tls&host=cdn.example.com&path=%2Fws#N');
  assert.strictEqual(node.network, 'ws');
  assert.strictEqual('v2ray-http-upgrade' in node['ws-opts'], false);
});

test('vless: 专用 type=httpupgrade 传输 DOES 设置 http-upgrade 标记', () => {
  const node = P.parseNodeUri('vless://u@example.com:443?type=httpupgrade&security=tls&host=cdn.example.com&path=%2Fws#N');
  assert.strictEqual(node.network, 'ws');
  assert.strictEqual(node['ws-opts']['v2ray-http-upgrade'], true);
  assert.strictEqual(node['ws-opts']['v2ray-http-upgrade-fast-open'], true);
});

test('trojan: 默认无端口时按 443 / ws-opts / sni', () => {
  const node = P.parseNodeUri('trojan://secret@9.9.9.9?sni=t.com&type=ws&host=w.com&path=/wp#T');
  assert.strictEqual(node.type, 'trojan');
  assert.strictEqual(node.password, 'secret');
  assert.strictEqual(node.port, 443);
  assert.strictEqual(node.sni, 't.com');
  assert.strictEqual(node.network, 'ws');
  assert.deepStrictEqual(node['ws-opts'], { headers: { Host: 'w.com' }, path: '/wp' });
});

test('ss: base64 userinfo → cipher/password', () => {
  const node = P.parseNodeUri('ss://' + b64('aes-256-gcm:mypassword') + '@10.0.0.1:8388#SS');
  assert.strictEqual(node.type, 'ss');
  assert.strictEqual(node.cipher, 'aes-256-gcm');
  assert.strictEqual(node.password, 'mypassword');
  assert.strictEqual(node.server, '10.0.0.1');
  assert.strictEqual(node.port, 8388);
});

test('ss: obfs 插件 → plugin/plugin-opts', () => {
  const node = P.parseNodeUri(
    'ss://' + b64('aes-128-gcm:pw') + '@1.2.3.4:8388?plugin=obfs-local;obfs=http;obfs-host=o.com#S',
  );
  assert.strictEqual(node.plugin, 'obfs');
  assert.deepStrictEqual(node['plugin-opts'], { mode: 'http', host: 'o.com' });
});

test('ssr: 整段 base64 → protocol/cipher/obfs/password + 参数', () => {
  const inner =
    '1.2.3.4:1234:auth_aes128_md5:aes-128-cfb:plain:' +
    b64('ssrpass') +
    '/?remarks=' +
    b64('SSR节点') +
    '&obfsparam=' +
    b64('o.com');
  const node = P.parseNodeUri('ssr://' + b64(inner));
  assert.strictEqual(node.type, 'ssr');
  assert.strictEqual(node.server, '1.2.3.4');
  assert.strictEqual(node.port, 1234);
  assert.strictEqual(node.protocol, 'auth_aes128_md5');
  assert.strictEqual(node.cipher, 'aes-128-cfb');
  assert.strictEqual(node.obfs, 'plain');
  assert.strictEqual(node.password, 'ssrpass');
  assert.strictEqual(node.name, 'SSR节点');
  assert.strictEqual(node['obfs-param'], 'o.com');
});

test('hysteria2: hy2 别名 / obfs / obfs-password / skip-cert-verify', () => {
  const node = P.parseNodeUri('hy2://pw@1.1.1.1:443?sni=hy.com&obfs=salamander&obfs-password=xyz&insecure=1#HY2');
  assert.strictEqual(node.type, 'hysteria2');
  assert.strictEqual(node.password, 'pw');
  assert.strictEqual(node.sni, 'hy.com');
  assert.strictEqual(node.obfs, 'salamander');
  assert.strictEqual(node['obfs-password'], 'xyz');
  assert.strictEqual(node['skip-cert-verify'], true);
});

test('hysteria: hy 别名 / protocol 默认 udp / alpn 数组', () => {
  const node = P.parseNodeUri('hy://1.2.3.4:443?auth=mytoken&alpn=h3,h2&peer=p.com#HY');
  assert.strictEqual(node.type, 'hysteria');
  assert.strictEqual(node.protocol, 'udp');
  assert.strictEqual(node['auth-str'], 'mytoken');
  assert.deepStrictEqual(node.alpn, ['h3', 'h2']);
  assert.strictEqual(node.sni, 'p.com');
});

test('tuic: auth=uuid:password 拆分 / 参数', () => {
  const node = P.parseNodeUri('tuic://uuid-3:tpass@2.2.2.2:443?alpn=h3&congestion-controller=bbr&udp-relay-mode=native#TUIC');
  assert.strictEqual(node.type, 'tuic');
  assert.strictEqual(node.uuid, 'uuid-3');
  assert.strictEqual(node.password, 'tpass');
  assert.deepStrictEqual(node.alpn, ['h3']);
  assert.strictEqual(node['congestion-controller'], 'bbr');
  assert.strictEqual(node['udp-relay-mode'], 'native');
});

test('wireguard: wg 别名 / private-key / public-key / reserved 三元组 / ip', () => {
  const node = P.parseNodeUri('wg://PRIVKEY@3.3.3.3:51820?publickey=PUBK&address=10.0.0.2/32&reserved=1,2,3&mtu=1420#WG');
  assert.strictEqual(node.type, 'wireguard');
  assert.strictEqual(node['private-key'], 'PRIVKEY');
  assert.strictEqual(node['public-key'], 'PUBK');
  assert.strictEqual(node.ip, '10.0.0.2');
  assert.deepStrictEqual(node.reserved, [1, 2, 3]);
  assert.strictEqual(node.mtu, 1420);
  assert.strictEqual(node.udp, true);
});

test('anytls: password / sni / udp 默认 true', () => {
  const node = P.parseNodeUri('anytls://user:mypw@4.4.4.4:8443?sni=a.com#ANY');
  assert.strictEqual(node.type, 'anytls');
  assert.strictEqual(node.password, 'mypw');
  assert.strictEqual(node.sni, 'a.com');
  assert.strictEqual(node.udp, true);
});

test('socks: socks5 别名 / username / password', () => {
  const node = P.parseNodeUri('socks5://user:pw@4.4.4.4:1080?tls=1#SOCKS');
  assert.strictEqual(node.type, 'socks5');
  assert.strictEqual(node.username, 'user');
  assert.strictEqual(node.password, 'pw');
  assert.strictEqual(node.tls, true);
});

test('http: https 别名 / auth / 默认端口 443', () => {
  const node = P.parseNodeUri('https://user:pw@5.5.5.5?tls=1#HTTP');
  assert.strictEqual(node.type, 'http');
  assert.strictEqual(node.username, 'user');
  assert.strictEqual(node.password, 'pw');
  assert.strictEqual(node.port, 443);
  assert.strictEqual(node.tls, true);
});

test('parseNodeUri: 附 protocol 兼容字段(== type)', () => {
  const node = P.parseNodeUri('trojan://p@1.2.3.4:443#T');
  assert.strictEqual(node.protocol, node.type);
  assert.strictEqual(node.protocol, 'trojan');
});

test('未知 scheme → null;坏输入不抛且 → null', () => {
  assert.strictEqual(P.parseNodeUri('foobar://whatever'), null);
  assert.strictEqual(P.parseNodeUri('not a uri'), null);
  assert.strictEqual(P.parseNodeUri(''), null);
  assert.doesNotThrow(() => P.parseNodeUri(null));
  assert.strictEqual(P.parseNodeUri(null), null);
  assert.doesNotThrow(() => P.parseNodeUri(undefined));
  assert.strictEqual(P.parseNodeUri(undefined), null);
  assert.doesNotThrow(() => P.parseNodeUri(12345));
});

test('端口越界 → 该行返 null(不抛)', () => {
  assert.strictEqual(P.parseNodeUri('vless://u@1.2.3.4:99999?security=tls#V'), null);
  assert.strictEqual(P.parseNodeUri('vless://u@1.2.3.4:0?security=tls#V'), null);
});

test('URI_PARSERS 注册表含 12 协议 + 别名', () => {
  for (const scheme of ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'anytls', 'hysteria2', 'hy2', 'hysteria', 'hy', 'tuic', 'wireguard', 'wg', 'http', 'https', 'socks5', 'socks']) {
    assert.strictEqual(typeof P.URI_PARSERS[scheme], 'function', scheme);
  }
});
