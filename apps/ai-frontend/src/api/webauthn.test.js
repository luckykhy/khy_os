/**
 * webauthn.js — base64url 编码与凭据载荷整形的纯逻辑测试。
 *
 * 后端 @simplewebauthn/server 要求 credential.response 的二进制字段是 base64url
 * 字符串；编码错了整条注册链会在服务端 400，而页面只会拿到一句通用错误。这里把
 * 最容易写错的一层钉住。零依赖，用 Node 内置的 btoa/atob。
 *   npx vitest run src/api/webauthn.test.js
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  base64UrlToBuffer,
  bufferToBase64Url,
  formatCredentialResponse,
  isWebAuthnAvailable,
} from '@/api/webauthn';

function toArray(bytes) {
  const buf = new Uint8Array(bytes.length).buffer;
  new Uint8Array(buf).set(bytes);
  return buf;
}

test('bufferToBase64Url 输出 canonical base64url 且无填充', () => {
  // 三个字节专门命中字母表末尾两格（'-' 与 '_'），即标准 base64 里 '+' '/'
  // 被替换的那两个字符。
  const one = bufferToBase64Url(toArray([0xfb, 0xff, 0xbf]));
  assert.equal(one, '-_-_');

  // 单字节：标准 base64 是 'AA=='，base64url 去填充后应只剩 'AA'。
  assert.equal(bufferToBase64Url(toArray([0x00])), 'AA');
});

test('bufferToBase64Url 容忍空输入与裸 ArrayBuffer', () => {
  assert.equal(bufferToBase64Url(new Uint8Array(0)), '');
  assert.equal(bufferToBase64Url(new ArrayBuffer(0)), '');
  assert.equal(bufferToBase64Url(undefined), '');
});

test('base64UrlToBuffer 与 bufferToBase64Url 互逆', () => {
  const original = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfb, 0xff, 0xbf, 0xfe]);
  const roundTripped = base64UrlToBuffer(bufferToBase64Url(original));
  assert.deepEqual([...roundTripped], [...original]);
});

test('base64UrlToBuffer 补齐缺失的填充再解码', () => {
  // 'TQ' 是 2 字符 base64url，缺 2 位填充；解码后应为 [0x4d]。
  assert.deepEqual([...base64UrlToBuffer('TQ')], [0x4d]);
  assert.deepEqual([...base64UrlToBuffer('')], []);
});

test('formatCredentialResponse 把二进制字段编码成 base64url', () => {
  const credential = {
    id: 'cred-1',
    rawId: toArray([0xfb, 0xff, 0xbf]),
    type: 'public-key',
    response: {
      rawId: toArray([0xfb, 0xff, 0xbf]),
      clientDataJSON: toArray([0x7b, 0x7d]), // '{}'
      attestationObject: toArray([0x01, 0x02, 0x03]),
      collectedClientData: 'ignored',
      transport: ['internal'],
    },
  };

  const formatted = formatCredentialResponse(credential);
  assert.equal(formatted.id, 'cred-1');
  assert.equal(formatted.type, 'public-key');
  assert.equal(formatted.rawId, '-_-_');
  assert.equal(formatted.response.clientDataJSON, 'e30');
  assert.equal(formatted.response.attestationObject, 'AQID');

  // 只保留校验需要的字段，避免把 collectedClientData/transport 发上行。
  assert.equal(Object.keys(formatted.response).sort().join(','), 'attestationObject,clientDataJSON');
});

test('formatCredentialResponse 对残缺输入降级而不抛错', () => {
  const formatted = formatCredentialResponse({ id: 'x' });
  assert.equal(formatted.id, 'x');
  assert.equal(formatted.type, 'public-key');
  assert.equal(formatted.rawId, '');
  assert.equal(formatted.response.clientDataJSON, '');
  assert.equal(formatted.response.attestationObject, '');
});

test('isWebAuthnAvailable 在无 window 的环境返回 false', () => {
  // vitest 默认 jsdom 之外仍是 Node 环境；即使有 jsdom，它也不会是安全上下文。
  assert.equal(isWebAuthnAvailable(), false);
});
