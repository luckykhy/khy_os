// khy.overlay —— AI Agent 悬浮窗的 JS 入口。
//
// 配合 AgentView 用：Agent 启动时 show + 每次 phase 变更时 update + 任务完成时 hide。
// "用户点悬浮窗停止按钮"通过 broadcast 返回 promise，AgentView 监听后 stop 当前 run。
//
// 权限（v3）：
//   - SYSTEM_ALERT_WINDOW（系统设置）—— 拉起悬浮窗必需
//   - POST_NOTIFICATIONS（Android 13+ 动态）—— 后台通知显示必需
// 第一次 requestPermission() 会同时弹两个权限弹窗（前者跳设置，后者系统 dialog）。

import { registerPlugin, Capacitor } from '@capacitor/core';

const Overlay = registerPlugin('Overlay', {
  web: () => ({
    canShow: async () => ({ ok: false, reason: 'web 平台不支持' }),
    requestPermission: async () => ({ granted: false }),
    show: async () => ({ ok: false, reason: 'web 平台不支持' }),
    update: async () => undefined,
    hide: async () => undefined,
    stop: async () => undefined,
  }),
});

/**
 * 检查悬浮窗就绪状态。返回 { overlay, notifications, ok, androidVersion }。
 * - overlay: SYSTEM_ALERT_WINDOW 权限
 * - notifications: POST_NOTIFICATIONS 权限（Android 13+）
 * - ok: 两个权限都齐（悬浮窗 + 通知都 OK）
 */
export async function checkOverlayStatus() {
  if (!Capacitor.isNativePlatform()) {
    return { ok: false, overlay: false, notifications: false, androidVersion: 0 };
  }
  const r = await Overlay.canShow();
  return {
    ok: !!r?.ok,
    overlay: !!r?.overlay,
    notifications: !!r?.notifications,
    androidVersion: r?.androidVersion || 0,
  };
}

export async function canShowOverlay() {
  const s = await checkOverlayStatus();
  return s.ok;
}

/**
 * 一次性申请两个权限（SYSTEM_ALERT_WINDOW + POST_NOTIFICATIONS）。
 * 返回最终状态。
 */
export async function requestOverlayPermission() {
  if (!Capacitor.isNativePlatform()) return { granted: false, overlay: false, notifications: false };
  const r = await Overlay.requestPermission();
  return {
    granted: !!r?.granted,
    overlay: !!r?.overlay,
    notifications: !!r?.notifications,
  };
}

// 启动悬浮窗
export async function showOverlay({ phase = '', tool = '', summary = '', steps = 0, expanded = true } = {}) {
  if (!Capacitor.isNativePlatform()) return { ok: false, reason: 'web 平台不支持悬浮窗' };
  const status = await checkOverlayStatus();
  if (!status.overlay) {
    await requestOverlayPermission();
    return { ok: false, reason: '未授 SYSTEM_ALERT_WINDOW 权限，已尝试跳系统设置' };
  }
  try {
    const r = await Overlay.show({ phase, tool, summary, steps, expanded });
    return r || { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause.message || String(cause) };
  }
}

// 更新内容（不会重复拉起 service，只是发 Intent）
export async function updateOverlay(payload) {
  if (!Capacitor.isNativePlatform()) return;
  try { await Overlay.update(payload); } catch { /* 忽略 */ }
}

// 隐藏悬浮窗
export async function hideOverlay() {
  if (!Capacitor.isNativePlatform()) return;
  try { await Overlay.hide(); } catch { /* 忽略 */ }
}

// 监听"用户在悬浮窗点停止按钮"事件
// 事件由 OverlayPlugin.notifyListeners('userStop') 推过来
// 返回 unsubscribe 函数
export function onOverlayUserStop(handler) {
  if (!Capacitor.isNativePlatform()) return () => {};
  if (typeof Overlay.addListener === 'function') {
    const handle = Overlay.addListener('userStop', handler);
    return () => { try { handle.remove(); } catch { /* */ } };
  }
  return () => {};
}

export default Overlay;

