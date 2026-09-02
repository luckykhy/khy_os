package com.khyos.companion;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.lang.reflect.Method;

/**
 * OverlayPlugin —— AI Agent 悬浮窗的 JS ↔ Java 桥。
 *
 * 用法（前端 src/api/overlay.js）：
 *   const r = await Overlay.show({ phase: 'planner', tool: 'khy.local.lookScreen', steps: 3 })
 *   await Overlay.update({ phase: 'executor', tool: 'khy.local.tap', steps: 4 })
 *   await Overlay.hide()
 *   await Overlay.addListener('userStop', () => { ... })
 *
 * 权限与生命周期（v3 完整化）：
 *   1) SYSTEM_ALERT_WINDOW（系统设置）—— canShow/requestPermission 检查
 *   2) POST_NOTIFICATIONS（Android 13+ 动态）—— @Permission 注解 + 自动 request
 *   3) userStop 广播 → notifyListeners 推到前端
 *   4) 监听 handleOnResume —— App 回前台时重新注册 receiver（防系统清掉）
 *
 * 悬浮窗由 OverlayService 渲染；本 plugin 是 JS ↔ Java 桥。
 */
@CapacitorPlugin(
    name = "Overlay",
    permissions = {
        @Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class OverlayPlugin extends Plugin {

    private static final String TAG = "OverlayPlugin";
    private static final String ACTION_USER_STOP = "com.khyos.companion.OVERLAY_USER_STOP";
    // Capacitor 6 不允许用 String 传 requestCode，必须用 int
    private static final int REQ_CODE_NOTIF = 9301;
    private PluginCall pendingNotifCall;

    @Override
    public void load() {
        super.load();
        registerUserStopReceiver();
    }

    @Override
    public void handleOnResume() {
        super.handleOnResume();
        // App 从后台回前台：receiver 可能被系统清掉，重新注册
        registerUserStopReceiver();
    }

    @Override
    public void handleOnDestroy() {
        try { getContext().unregisterReceiver(userStopReceiver); } catch (Throwable ignored) {}
        super.handleOnDestroy();
    }

    private void registerUserStopReceiver() {
        try {
            // 先 unregister 防止重复
            try { getContext().unregisterReceiver(userStopReceiver); } catch (Throwable ignored) {}
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                getContext().registerReceiver(userStopReceiver,
                        new android.content.IntentFilter(ACTION_USER_STOP),
                        android.content.Context.RECEIVER_NOT_EXPORTED);
            } else {
                getContext().registerReceiver(userStopReceiver,
                        new android.content.IntentFilter(ACTION_USER_STOP));
            }
        } catch (Throwable t) {
            Log.w(TAG, "注册 userStop 接收器失败: " + t.getMessage());
        }
    }

    private final android.content.BroadcastReceiver userStopReceiver = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(android.content.Context context, Intent intent) {
            if (!ACTION_USER_STOP.equals(intent.getAction())) return;
            Log.i(TAG, "收到 userStop 广播 → notifyListeners");
            notifyListeners("userStop", new JSObject());
        }
    };

    // ============ 权限方法 ============

    @PluginMethod
    public void canShow(PluginCall call) {
        boolean overlay = canDrawOverlays();
        boolean notif = hasNotificationPermission();
        JSObject ret = new JSObject();
        ret.put("ok", overlay); // 主开关：能不能拉起悬浮窗
        ret.put("overlay", overlay);
        ret.put("notifications", notif);
        ret.put("androidVersion", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        // 默认行为：先跳 SYSTEM_ALERT_WINDOW 设置；POST_NOTIFICATIONS 由 Capacitor 权限系统拉起
        boolean overlay = canDrawOverlays();
        if (!overlay) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getContext().getPackageName()));
                i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } catch (Throwable t) {
                Log.w(TAG, "requestPermission(SYSTEM_ALERT_WINDOW) 失败: " + t.getMessage());
            }
        }
        // POST_NOTIFICATIONS（Android 13+）：走 Capacitor 的权限注解
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (!hasNotificationPermission()) {
                requestPermissionForAlias("notifications", call, "permissionCallback");
                return; // 等 callback 后再 resolve
            }
        }
        JSObject ret = new JSObject();
        ret.put("granted", overlay);
        ret.put("overlay", overlay);
        ret.put("notifications", hasNotificationPermission());
        call.resolve(ret);
    }

    /**
     * Capacitor @Permission 注解要求的回调方法。名字必须匹配 requestPermissionForAlias
     * 的第二个参数（"permissionCallback"）。
     * 如果用 Java 反射找方法名失败，Capacitor 会 fallback 调用同名 method。
     */
    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        boolean overlay = canDrawOverlays();
        boolean notif = hasNotificationPermission();
        JSObject ret = new JSObject();
        ret.put("granted", overlay);
        ret.put("overlay", overlay);
        ret.put("notifications", notif);
        if (call != null) call.resolve(ret);
    }

    private boolean canDrawOverlays() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return Settings.canDrawOverlays(getContext());
        }
        return true;
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(getContext(),
                    Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        }
        // Android 12 及以下：通知无需运行时权限
        return true;
    }

    // ============ 悬浮窗控制方法 ============

    @PluginMethod
    public void show(PluginCall call) {
        if (!canDrawOverlays()) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("reason", "未授 SYSTEM_ALERT_WINDOW 权限");
            call.resolve(ret);
            return;
        }
        Intent i = new Intent(getContext(), OverlayService.class);
        i.setAction(OverlayService.ACTION_SHOW);
        i.putExtra(OverlayService.EXTRA_PHASE, call.getString("phase", ""));
        i.putExtra(OverlayService.EXTRA_TOOL, call.getString("tool", ""));
        i.putExtra(OverlayService.EXTRA_SUMMARY, call.getString("summary", ""));
        i.putExtra(OverlayService.EXTRA_STEPS, call.getInt("steps", 0));
        i.putExtra(OverlayService.EXTRA_EXPANDED, call.getBoolean("expanded", true));
        try {
            getContext().startService(i);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Throwable t) {
            Log.e(TAG, "show 失败: " + t.getMessage());
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("reason", t.getMessage());
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        Intent i = new Intent(getContext(), OverlayService.class);
        i.setAction(OverlayService.ACTION_UPDATE);
        i.putExtra(OverlayService.EXTRA_PHASE, call.getString("phase", ""));
        i.putExtra(OverlayService.EXTRA_TOOL, call.getString("tool", ""));
        i.putExtra(OverlayService.EXTRA_SUMMARY, call.getString("summary", ""));
        i.putExtra(OverlayService.EXTRA_STEPS, call.getInt("steps", 0));
        i.putExtra(OverlayService.EXTRA_EXPANDED, call.getBoolean("expanded", true));
        try {
            getContext().startService(i);
            call.resolve();
        } catch (Throwable t) {
            Log.e(TAG, "update 失败: " + t.getMessage());
            call.reject(t.getMessage());
        }
    }

    @PluginMethod
    public void hide(PluginCall call) {
        Intent i = new Intent(getContext(), OverlayService.class);
        i.setAction(OverlayService.ACTION_HIDE);
        try {
            getContext().startService(i);
            call.resolve();
        } catch (Throwable t) {
            call.reject(t.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        broadcastUserStop();
        Intent i = new Intent(getContext(), OverlayService.class);
        i.setAction(OverlayService.ACTION_HIDE);
        try { getContext().startService(i); } catch (Throwable ignored) {}
        call.resolve();
    }

    private void broadcastUserStop() {
        try {
            Intent stop = new Intent(ACTION_USER_STOP);
            getContext().sendBroadcast(stop);
        } catch (Throwable t) {
            Log.w(TAG, "broadcastUserStop 失败: " + t.getMessage());
        }
    }
}
