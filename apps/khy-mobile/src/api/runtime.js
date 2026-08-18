import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const RUNTIME_KEY = 'khy_mobile_runtime_v1';

function storage() {
  return Capacitor.isNativePlatform()
    ? Preferences
    : {
        async get({ key }) { return { value: localStorage.getItem(key) }; },
        async set({ key, value }) { localStorage.setItem(key, value); },
        async remove({ key }) { localStorage.removeItem(key); },
      };
}

export function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('请输入后端地址');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('后端地址必须使用 HTTP 或 HTTPS');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('后端地址不能包含凭据、查询参数或片段');
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
}

export function parsePairingPayload(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('二维码内容为空');
  try {
    const data = JSON.parse(raw);
    return {
      apiBaseUrl: normalizeBaseUrl(data.apiBaseUrl || data.api_base_url),
      managementWsUrl: String(data.managementWsUrl || data.management_ws_url || '').trim(),
      bridgeBaseUrl: String(data.bridgeBaseUrl || data.bridge_base_url || '').trim(),
      source: 'qr',
    };
  } catch (error) {
    if (error instanceof SyntaxError) return { apiBaseUrl: normalizeBaseUrl(raw), source: 'qr' };
    throw error;
  }
}

export async function loadRuntime() {
  const { value } = await storage().get({ key: RUNTIME_KEY });
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function saveRuntime(config) {
  const value = {
    apiBaseUrl: normalizeBaseUrl(config.apiBaseUrl),
    managementWsUrl: String(config.managementWsUrl || '').trim(),
    bridgeBaseUrl: String(config.bridgeBaseUrl || '').trim(),
    source: String(config.source || 'manual'),
    lastVerifiedAt: config.lastVerifiedAt || null,
  };
  await storage().set({ key: RUNTIME_KEY, value: JSON.stringify(value) });
  return value;
}

export async function clearRuntime() {
  await storage().remove({ key: RUNTIME_KEY });
}
