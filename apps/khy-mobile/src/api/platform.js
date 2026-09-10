// khy.platform —— 多平台检测与适配
//
// 支持平台：
// - Android (API 26-36, Android 8.0-16)
// - HarmonyOS (鸿蒙, 含 HDB 调试)
// - HarmonyOS NEXT (纯鸿蒙)
//
// 功能：
// 1. 平台检测（Android / HarmonyOS / HarmonyOS NEXT）
// 2. 能力检测（Shizuku、HDB、无障碍等）
// 3. 平台特定适配

import { Capacitor } from '@capacitor/core';

/**
 * 平台类型
 */
export const PlatformType = {
  ANDROID: 'android',
  HARMONYOS: 'harmonyos',
  HARMONYOS_NEXT: 'harmonyos_next',
  UNKNOWN: 'unknown',
};

/**
 * 检测当前平台
 */
export function detectPlatform() {
  const platform = Capacitor.getPlatform();

  if (platform === 'android') {
    // 进一步检测是否为鸿蒙系统
    return detectHarmonyOS();
  }

  return PlatformType.ANDROID;
}

/**
 * 检测鸿蒙系统
 * 通过 user-agent 和系统属性判断
 */
function detectHarmonyOS() {
  if (typeof navigator === 'undefined') return PlatformType.ANDROID;

  const ua = navigator.userAgent || '';

  // HarmonyOS NEXT 检测
  if (ua.includes('HarmonyOS') || ua.includes('OpenHarmony')) {
    // 检查是否为纯鸿蒙（无 Android 兼容层）
    if (typeof window !== 'undefined' && window.harmony) {
      return PlatformType.HARMONYOS_NEXT;
    }
    // 有 Android 兼容层的鸿蒙
    return PlatformType.HARMONYOS;
  }

  // 通过鸿蒙特有 API 检测
  if (typeof window !== 'undefined') {
    // HarmonyOS 特有全局对象
    if (window.hmos || window.HarmonyOS) {
      return PlatformType.HARMONYOS;
    }
  }

  return PlatformType.ANDROID;
}

/**
 * 获取平台能力
 */
export async function getPlatformCapabilities() {
  const platform = detectPlatform();

  const capabilities = {
    platform,
    isAndroid: platform === PlatformType.ANDROID,
    isHarmonyOS: platform === PlatformType.HARMONYOS,
    isHarmonyOSNext: platform === PlatformType.HARMONYOS_NEXT,

    // 调试能力
    adb: platform === PlatformType.ANDROID,
    hdb: platform === PlatformType.HARMONYOS || platform === PlatformType.HARMONYOS_NEXT,

    // 设备控制能力
    shizuku: false,
    accessibility: false,
    root: false,

    // 文件操作
    scopedStorage: true,
    linux: false,

    // 网络
    websocket: true,
    http: true,
  };

  // 检测 Shizuku（仅 Android）
  if (platform === PlatformType.ANDROID) {
    try {
      const { isShizukuReady } = await import('./deviceControl.js');
      const shizukuStatus = await isShizukuReady();
      capabilities.shizuku = shizukuStatus.ready;
    } catch { /* 忽略 */ }
  }

  // 检测无障碍服务
  try {
    const { getCapability } = await import('./deviceControl.js');
    const cap = await getCapability();
    capabilities.accessibility = cap.accessibilityReady;
  } catch { /* 忽略 */ }

  // 检测 Linux 环境
  try {
    const { getLinuxStatus } = await import('./linux.js');
    const linuxStatus = await getLinuxStatus();
    capabilities.linux = linuxStatus.ready;
  } catch { /* 忽略 */ }

  return capabilities;
}

/**
 * 获取平台特定配置
 */
export function getPlatformConfig() {
  const platform = detectPlatform();

  const configs = {
    [PlatformType.ANDROID]: {
      name: 'Android',
      debugTool: 'adb',
      shellCmd: 'sh',
      supportsShizuku: true,
      supportsHDB: false,
    },
    [PlatformType.HARMONYOS]: {
      name: 'HarmonyOS',
      debugTool: 'hdb',
      shellCmd: 'sh',
      supportsShizuku: false,
      supportsHDB: true,
    },
    [PlatformType.HARMONYOS_NEXT]: {
      name: 'HarmonyOS NEXT',
      debugTool: 'hdb',
      shellCmd: 'hdc',
      supportsShizuku: false,
      supportsHDB: true,
    },
  };

  return configs[platform] || configs[PlatformType.ANDROID];
}

/**
 * 检查 API 级别兼容性
 */
export function checkAPILevelCompatibility(minApi = 26, targetApi = 36) {
  // 在 WebView 中运行时，无法直接获取 Android API 级别
  // 通过 user-agent 推断
  const ua = navigator.userAgent || '';
  const match = ua.match(/Android\s+(\d+)/);

  if (match) {
    const apiLevel = parseInt(match[1], 10);
    return {
      apiLevel,
      compatible: apiLevel >= minApi,
      needsUpgrade: apiLevel < minApi,
      targetApi,
    };
  }

  // 默认假设兼容
  return {
    apiLevel: targetApi,
    compatible: true,
    needsUpgrade: false,
    targetApi,
  };
}

export default {
  PlatformType,
  detectPlatform,
  getPlatformCapabilities,
  getPlatformConfig,
  checkAPILevelCompatibility,
};
