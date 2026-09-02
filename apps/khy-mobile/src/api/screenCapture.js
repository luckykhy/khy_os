// khy.screenCapture —— ScreenCapturePlugin JS 包装
// 插件：apps/khy-mobile/android/app/src/main/java/.../ScreenCapturePlugin.java
// 用法：
//   await startShare()         — 弹一次授权窗，启前台服务
//   await captureFrame()       — 服务在线时静默截屏（不再弹窗）
//   await captureFrames(n, ms) — 多帧，每 ms 一张，共 n 张；用于"操作回放"
//   await stopShare()          — 关停前台服务
//   await captureOnce()        — 一次性截屏（每次都弹窗；兼容旧行为）

import { registerPlugin } from '@capacitor/core';

const ScreenCapture = registerPlugin('ScreenCapture', {
  web: () => ({
    capture: () => Promise.reject(new Error('ScreenCapture 仅在 Android 设备上可用')),
    startService: () => Promise.reject(new Error('ScreenCapture 仅在 Android 设备上可用')),
    captureFrame: () => Promise.resolve({ dataUrl: null, ready: false }),
    captureFrames: () => Promise.resolve({ frames: '[]', ready: false }),
    stopService: () => Promise.resolve({ stopped: true }),
    isReady: () => Promise.resolve({ ready: false }),
  }),
});

export async function captureOnce() {
  const res = await ScreenCapture.capture();
  return res?.dataUrl || null;
}

export async function startShare() {
  return ScreenCapture.startService();
}

export async function captureFrame() {
  return ScreenCapture.captureFrame();
}

/**
 * 多帧截屏：intervalMs 间隔，count 张。
 * 返回 { frames: ['data:image/jpeg;base64,...', ...], count, intervalMs, ready }
 */
export async function captureFrames(count = 3, intervalMs = 1000) {
  const res = await ScreenCapture.captureFrames({ count, intervalMs });
  if (!res?.ready) return { frames: [], count: 0, intervalMs, ready: false };
  let frames;
  try { frames = JSON.parse(res.frames || '[]'); } catch { frames = []; }
  return { frames, count: res.count, intervalMs: res.intervalMs, ready: true };
}

export async function stopShare() {
  return ScreenCapture.stopService();
}

export async function isShareReady() {
  const r = await ScreenCapture.isReady();
  return Boolean(r?.ready);
}
