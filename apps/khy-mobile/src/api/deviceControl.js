// khy.deviceControl —— 设备控制层（无障碍服务 + Shizuku + execShell 三种能力来源）。
//
// 用法：所有方法在无障碍服务未授权时会 reject 一个明确错误，UI 端给出"去授权"引导。
//   - getCapability() → { accessibilityReady, shizukuInstalled }
//   - openAccessibilitySettings() → 跳系统设置授权无障碍
//   - inputTap / inputSwipe / inputText → 优先无障碍；fallback Shizuku shell
//   - findAndClick / findAndLongClick / dumpUi → 必须无障碍
//   - listApps / startActivity → 用 PackageManager（普通 App 权限）
//   - execShell → 白名单（input / am start / pm list 等允许；rm -rf / / shutdown 拒绝）

import { registerPlugin } from '@capacitor/core';

const DeviceControl = registerPlugin('DeviceControl', {
  web: () => ({
    getCapability: () => Promise.resolve({ accessibilityReady: false, shizukuInstalled: false }),
    openAccessibilitySettings: () => Promise.resolve({ opened: false }),
    isShizukuReady: () => Promise.resolve({ ready: false, reason: 'web' }),
    execShell: () => Promise.reject(new Error('仅 Android 设备可用')),
    startActivity: () => Promise.reject(new Error('仅 Android 设备可用')),
    listApps: () => Promise.reject(new Error('仅 Android 设备可用')),
    inputTap: () => Promise.reject(new Error('仅 Android 设备可用')),
    inputSwipe: () => Promise.reject(new Error('仅 Android 设备可用')),
    inputText: () => Promise.reject(new Error('仅 Android 设备可用')),
    findAndClick: () => Promise.reject(new Error('仅 Android 设备可用')),
    findAndLongClick: () => Promise.reject(new Error('仅 Android 设备可用')),
    findWithBounds: () => Promise.reject(new Error('仅 Android 设备可用')),
    listClickable: () => Promise.reject(new Error('仅 Android 设备可用')),
    dumpUi: () => Promise.reject(new Error('仅 Android 设备可用')),
    globalAction: () => Promise.reject(new Error('仅 Android 设备可用')),
  }),
});

export async function getCapability() {
  const r = await DeviceControl.getCapability();
  return {
    accessibilityReady: Boolean(r?.accessibilityReady),
    shizukuInstalled: Boolean(r?.shizukuInstalled),
  };
}

export async function openAccessibilitySettings() {
  return DeviceControl.openAccessibilitySettings();
}

export async function isShizukuReady() {
  const r = await DeviceControl.isShizukuReady();
  return { ready: Boolean(r?.ready), reason: r?.reason || '' };
}

export async function execShell(command) {
  const r = await DeviceControl.execShell({ command });
  return { stdout: r?.stdout || '', stderr: r?.stderr || '', exitCode: r?.exitCode ?? -1 };
}

export async function startActivity(target) {
  return DeviceControl.startActivity({ target });
}

export async function inputTap(x, y) {
  return DeviceControl.inputTap({ x, y });
}

export async function inputSwipe(x1, y1, x2, y2, durationMs = 300) {
  return DeviceControl.inputSwipe({ x1, y1, x2, y2, durationMs });
}

export async function inputText(text) {
  return DeviceControl.inputText({ text });
}

export async function findAndClick(query) {
  return DeviceControl.findAndClick({ query });
}

export async function findAndLongClick(query) {
  return DeviceControl.findAndLongClick({ query });
}

// 找元素 → 返回屏幕中心坐标 + 边界。Agent "混合模式" 桥。
export async function findWithBounds(query) {
  return DeviceControl.findWithBounds({ query });
}

// 列出当前所有可点击节点。供 Agent "我有哪些按钮可以点" 决策。
export async function listClickable() {
  const r = await DeviceControl.listClickable();
  return r?.items || [];
}

export async function dumpUi() {
  const r = await DeviceControl.dumpUi();
  return r?.dump || '';
}

export async function globalAction(action) {
  return DeviceControl.globalAction({ action });
}

export async function listApps(query = '') {
  return DeviceControl.listApps({ query });
}
