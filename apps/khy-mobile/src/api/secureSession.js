import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

const SESSION_KEY = 'khy_mobile_session_v1';

const browserStorage = {
  async get() {
    const value = sessionStorage.getItem(SESSION_KEY);
    return value ? JSON.parse(value) : null;
  },
  async set(value) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); },
  async clear() { sessionStorage.removeItem(SESSION_KEY); },
};

export async function getSession() {
  if (!Capacitor.isNativePlatform()) return browserStorage.get();
  try {
    const result = await SecureStoragePlugin.get({ key: SESSION_KEY });
    return JSON.parse(result.value);
  } catch {
    return null;
  }
}

export async function setSession(value) {
  if (!Capacitor.isNativePlatform()) return browserStorage.set(value);
  await SecureStoragePlugin.set({ key: SESSION_KEY, value: JSON.stringify(value) });
  await Preferences.set({ key: 'khy_mobile_has_session', value: '1' });
}

export async function clearSession() {
  if (!Capacitor.isNativePlatform()) return browserStorage.clear();
  try { await SecureStoragePlugin.remove({ key: SESSION_KEY }); } catch { /* already absent */ }
  await Preferences.remove({ key: 'khy_mobile_has_session' });
}
