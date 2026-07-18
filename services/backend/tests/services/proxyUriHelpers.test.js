'use strict';

/**
 * proxyUriHelpers.test.js — 代理 URI 解析工具箱纯叶子单测(node:test)。
 *
 * 覆盖:parseUrlLike 各分支(auth/host/port/query/fragment、requireAuth 抛)、decodeBase64OrOriginal
 * 文本型启发(合法解 / 含控制字符返原串)、parsePortStrict 越界拒、getCipher 别名/未知→auto、
 * parseQueryStringNormalized 下划线归一、parseBoolOrPresence、isIPv4/isIPv6。
 */

const test = require('node:test');
const assert = require('node:assert');

const H = require('../../src/services/proxyUriHelpers');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('normalizeUriAndGetScheme: 取小写 scheme', () => {
  assert.deepStrictEqual(H.normalizeUriAndGetScheme('VMESS://abc'), { uri: 'vmess://abc', scheme: 'vmess' });
  assert.strictEqual(H.normalizeUriAndGetScheme('hy2://x').scheme, 'hy2');
  assert.doesNotThrow(() => H.normalizeUriAndGetScheme(null));
});

test('parseUrlLike: auth@host:port/?query#fragment 全段', () => {
  const r = H.parseUrlLike('user:pw@1.2.3.4:443?a=1&b=2#Name');
  assert.strictEqual(r.auth, 'user:pw');
  assert.strictEqual(r.host, '1.2.3.4');
  assert.strictEqual(r.port, '443');
  assert.strictEqual(r.query, 'a=1&b=2');
  assert.strictEqual(r.fragment, 'Name');
});

test('parseUrlLike: 无 auth 时 auth=undefined;requireAuth 缺失则抛', () => {
  const r = H.parseUrlLike('1.2.3.4:443#N');
  assert.strictEqual(r.auth, undefined);
  assert.strictEqual(r.host, '1.2.3.4');
  assert.throws(() => H.parseUrlLike('1.2.3.4:443#N', { requireAuth: true, errorMessage: 'boom' }), /boom/);
});

test('decodeBase64OrOriginal: 合法 base64 → 解码文本', () => {
  assert.strictEqual(H.decodeBase64OrOriginal(b64('hello world')), 'hello world');
  assert.strictEqual(H.decodeBase64OrOriginal(b64('中文备注')), '中文备注');
});

test('decodeBase64OrOriginal: 含控制字符 → 原串(文本型启发拒解)', () => {
  // 随机二进制多半含控制字节 → 应返原串
  const binary = Buffer.from([0, 1, 2, 255, 254]).toString('base64');
  assert.strictEqual(H.decodeBase64OrOriginal(binary), binary);
  // 非 base64 普通串原样返回
  assert.strictEqual(H.decodeBase64OrOriginal('plain@host:443'), 'plain@host:443');
});

test('parsePortStrict: 1–65535 合法,越界/非数字 → undefined', () => {
  assert.strictEqual(H.parsePortStrict('443'), 443);
  assert.strictEqual(H.parsePortStrict('1'), 1);
  assert.strictEqual(H.parsePortStrict('65535'), 65535);
  assert.strictEqual(H.parsePortStrict('0'), undefined);
  assert.strictEqual(H.parsePortStrict('65536'), undefined);
  assert.strictEqual(H.parsePortStrict('abc'), undefined);
  assert.strictEqual(H.parsePortStrict(''), undefined);
});

test('parseRequiredPort 抛 / parsePortOrDefault 回退', () => {
  assert.throws(() => H.parseRequiredPort('x', 'bad port'), /bad port/);
  assert.strictEqual(H.parsePortOrDefault('', 443), 443);
  assert.strictEqual(H.parsePortOrDefault('8080', 443), 8080);
});

test('getCipher: 别名映射 / 未知→auto / 缺失→none', () => {
  assert.strictEqual(H.getCipher('chacha20-poly1305'), 'chacha20-ietf-poly1305');
  assert.strictEqual(H.getCipher('aes-256-gcm'), 'aes-256-gcm');
  assert.strictEqual(H.getCipher('made-up-cipher'), 'auto');
  assert.strictEqual(H.getCipher(undefined), 'none');
});

test('parseQueryStringNormalized: 下划线归一为短横', () => {
  const q = H.parseQueryStringNormalized('allow_insecure=1&obfs_param=x');
  assert.strictEqual(q['allow-insecure'], '1');
  assert.strictEqual(q['obfs-param'], 'x');
});

test('parseBoolOrPresence: 存在即真 / 显式 0 假', () => {
  assert.strictEqual(H.parseBoolOrPresence(undefined), true);
  assert.strictEqual(H.parseBoolOrPresence(''), true);
  assert.strictEqual(H.parseBoolOrPresence('1'), true);
  assert.strictEqual(H.parseBoolOrPresence('true'), true);
  assert.strictEqual(H.parseBoolOrPresence('0'), false);
  assert.strictEqual(H.parseBoolOrPresence('false'), false);
});

test('isIPv4 / isIPv6', () => {
  assert.strictEqual(H.isIPv4('1.2.3.4'), true);
  assert.strictEqual(H.isIPv4('::1'), false);
  // 移植上游 helpers.ts 的宽松匹配器:`::1` / `::` / 完整 8 组命中;
  // 折叠中段 `::`(如 fe80::1)上游本就不匹配 —— 忠实保留其行为(wireguard 里仅影响 ip/ipv6 归位)。
  assert.strictEqual(H.isIPv6('::1'), true);
  assert.strictEqual(H.isIPv6('::'), true);
  assert.strictEqual(H.isIPv6('2001:0db8:0000:0000:0000:0000:0000:0001'), true);
  assert.strictEqual(H.isIPv6('1.2.3.4'), false);
});

test('splitOnce: 只切第一个分隔符', () => {
  assert.deepStrictEqual(H.splitOnce('uuid:pass:extra', ':'), ['uuid', 'pass:extra']);
  assert.deepStrictEqual(H.splitOnce('nodelim', ':'), ['nodelim']);
});

test('parseVlessFlow: none/坏值→undefined,合法保留', () => {
  assert.strictEqual(H.parseVlessFlow('none'), undefined);
  assert.strictEqual(H.parseVlessFlow(''), undefined);
  assert.strictEqual(H.parseVlessFlow('xtls-rprx-vision'), 'xtls-rprx-vision');
});

test('绝不抛:全部原语对 null/undefined 安全', () => {
  assert.doesNotThrow(() => {
    H.getIfNotBlank(null);
    H.trimStr(null);
    H.safeDecodeURIComponent(undefined);
    H.decodeAndTrim(null);
    H.parseInteger(undefined);
    H.parseQueryString(null);
    H.firstString(null);
    H.isIPv4(null);
    H.isIPv6(null);
  });
});
