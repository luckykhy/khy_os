// webauthn.js — 生物识别（WebAuthn）前端接线 + 纯编码工具。
//
// 后端真源是 services/backend/src/routes/webauthn.js，挂载在 /api/webauthn：
//   GET  /status            { bound }                          已登录
//   POST /register-options  { options }                        已登录
//   POST /register-verify   { credential }                     已登录
//   POST /unbind                                   { }         已登录
//   POST /login-options     { userId, options }                公开
//   POST /login-verify      { userId, credential }             公开
//
// 后端用 @simplewebauthn/server 校验，期望 credential.response 里的二进制字段是
// base64url 字符串。浏览器给的是 ArrayBuffer，所以本页必须做一层编码——这层是
// 纯函数（bufferToBase64Url / formatCredentialResponse），单独可测，不掺入
// axios 调用，便于在 Node 下用 vitest 断言。
//
// 登录页的无密码登录走 /login-options + /login-verify，不在此文件；这里只覆盖
// 已登录账号在「安全」页里绑定/解绑凭据的三条路径。

import request from '@/api/request';

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * ArrayBuffer / Uint8Array -> base64url（无填充）。
 *
 * 纯函数：只依赖 String.fromCharCode 与 btoa（Node >=16 也提供），所以可以在
 * 无浏览器的测试环境里直接断言输出。
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {string}
 */
export function bufferToBase64Url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || new ArrayBuffer(0));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url -> Uint8Array，bufferToBase64Url 的逆运算。
 *
 * 服务端只要求上行 base64url，但保留解码方向以便本地回读 rawId 做展示与比对。
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64UrlToBuffer(text) {
  const value = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 把 navigator.credentials.create() 返回的 PublicKeyCredential 转成后端可校验的
 * 纯 JSON（二进制字段全部 base64url）。
 *
 * 只取校验需要的字段：id / rawId / type / response{clientDataJSON,
 * attestationObject}。多带 collectedClientData 与 transport 只会让载荷变大，
 * 对 verifyRegistrationResponse 没有增益。
 *
 * @param {Object} credential navigator.credentials.create() 的返回值
 * @returns {Object} 可直接 JSON.stringify 的凭据载荷
 */
export function formatCredentialResponse(credential) {
  const response = (credential && credential.response) || {};
  return {
    id: credential.id,
    rawId: bufferToBase64Url(response.rawId || credential.rawId),
    type: credential.type || 'public-key',
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
    },
  };
}

/**
 * 浏览器是否具备 WebAuthn 前提：安全上下文 + PublicKeyCredentials 构造器。
 *
 * 不满足时页面直接给出「不可用 + 原因」而不是渲染一个点了必失败的按钮。
 *
 * @returns {boolean}
 */
export function isWebAuthnAvailable() {
  if (typeof window === 'undefined') return false;
  if (!window.isSecureContext) return false;
  return typeof window.PublicKeyCredentials === 'function';
}

/**
 * @returns {Promise<boolean>} 账号是否已绑定生物识别凭据
 */
export function getWebAuthnStatus() {
  return request.get('/api/webauthn/status', { silent: true }).then(({ data }) => {
    const payload = data && typeof data.data === 'object' && data.data ? data.data : data;
    return !!payload?.bound;
  });
}

/**
 * @returns {Promise<Object>} PublicKeyCredentialCreationOptions
 */
export function requestRegistrationOptions() {
  return request.post('/api/webauthn/register-options', {}, { silent: true }).then(({ data }) => {
    const payload = data && typeof data.data === 'object' && data.data ? data.data : data;
    return payload?.options || {};
  });
}

/**
 * @param {Object} formattedCredential formatCredentialResponse 的输出
 * @returns {Promise<void>}
 */
export function verifyRegistrationResponse(formattedCredential) {
  return request.post('/api/webauthn/register-verify', { credential: formattedCredential }, {
    silent: true,
  });
}

/**
 * @returns {Promise<void>}
 */
export function unbindWebAuthn() {
  return request.post('/api/webauthn/unbind', {}, { silent: true });
}
