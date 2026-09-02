package com.khyos.companion;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import rikka.shizuku.Shizuku;
import rikka.shizuku.ShizukuRemoteProcess;

/**
 * DeviceControlPlugin —— AI 助手的"动手"层。
 *
 * 优先级：AccessibilityService > Shizuku > execShell
 *   - AccessibilityService：用户授权一次，永久有效，是 Roubao / 肉包"无 Shizuku 也能 tap" 的方案
 *   - Shizuku：adb shell 身份执行（仅当 Shizuku 库 + 服务可用）
 *   - execShell：当前进程权限，能跑 `am start` / `dumpsys` 等，input / screencap 会 SELinux 拒
 *
 * tap/swipe/typeText 三种操作：先尝试 AccessibilityService（无 root 通用），
 * 失败再尝试 Shizuku `input` 命令（需要 Shizuku 授权）。
 */
@CapacitorPlugin(name = "DeviceControl")
public class DeviceControlPlugin extends Plugin {

    private static final String TAG = "DeviceControlPlugin";
    private static final String A11Y_SVC = "com.khyos.companion/.KhyAccessibilityService";

    // execShell 白名单：只允许这些前缀
    private static final String[] SHELL_ALLOW = {
        "am start ", "am force-stop ", "am kill ",
        "wm size", "wm density",
        "dumpsys ",
        "pm list packages", "pm path ", "pm dump ",
        "settings get ", "settings put ",
        "input tap ", "input swipe ", "input text ", "input keyevent ",
        "screencap ",
        "ls ", "cat ", "echo ", "mkdir ", "rm ", "mv ", "cp ",
        "ps ", "kill ",
    };
    private static final String[] SHELL_DENY = {
        "rm -rf /", "rm -rf /*", "rm /system", "rm /data",
        "shutdown", "reboot", "stop", "restart",
        "format", "mkfs", "dd if=",
        "iptables", "mount ", "umount ",
    };

    private final ExecutorService exec = Executors.newCachedThreadPool();

    // --- 状态探测 ---

    @PluginMethod
    public void getCapability(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("accessibilityReady", KhyAccessibilityService.isReady());
        ret.put("shizukuInstalled", isShizukuInstalled());
        ret.put("package", getContext().getPackageName());
        call.resolve(ret);
    }

    /** 引导用户去系统设置授权 AccessibilityService */
    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject(t.getMessage());
        }
    }

    @PluginMethod
    public void isShizukuReady(PluginCall call) {
        try {
            // 必须先检查 Shizuku App 装没装（用 PackageManager 可靠），
            // 再用 Shizuku.isGranted() 检查授权（依赖 Shizuku App binder）。
            boolean installed = isShizukuInstalled();
            boolean granted = false;
            String detail = "未安装 Shizuku App";
            if (installed) {
                try {
                    // Shizuku 13.1.0 公开 API：checkSelfPermission() == 0 表示已授权
                    granted = Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED;
                    detail = granted ? "已授权" : "Shizuku 已装但未授权本 App（请在 Shizuku App 列表里授权）";
                } catch (Throwable t) {
                    detail = "Shizuku 服务未运行（请在 Shizuku App 里点「启动」）: " + t.getMessage();
                }
            } else {
                detail = "未安装 Shizuku App。下载：https://shizuku.rikka.app/";
            }
            JSObject ret = new JSObject();
            ret.put("ready", granted);
            ret.put("installed", installed);
            ret.put("granted", granted);
            ret.put("reason", detail);
            call.resolve(ret);
        } catch (Throwable t) {
            JSObject ret = new JSObject();
            ret.put("ready", false);
            ret.put("reason", "Shizuku 检测失败: " + t.getMessage());
            call.resolve(ret);
        }
    }

    // --- App / Intent ---

    @PluginMethod
    public void startActivity(PluginCall call) {
        String target = call.getString("target", "");
        if (target.isEmpty()) { call.reject("缺 target（包名 / deep link）"); return; }
        try {
            Intent intent;
            PackageManager pm = getContext().getPackageManager();
            if (target.startsWith("http://") || target.startsWith("https://") || target.contains("://")) {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse(target));
            } else if (target.contains("/")) {
                String[] parts = target.split("/");
                intent = pm.getLaunchIntentForPackage(parts[0]);
                if (intent == null) { call.reject("未找到包: " + parts[0]); return; }
                if (parts.length > 1) intent.setClassName(parts[0], parts[1]);
            } else {
                intent = pm.getLaunchIntentForPackage(target);
                if (intent == null) { call.reject("未找到包: " + target); return; }
            }
            ComponentName resolved = intent.resolveActivity(pm);
            if (resolved == null) { call.reject("无法解析目标 Activity"); return; }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("component", resolved.flattenToShortString());
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject("startActivity 失败: " + t.getMessage());
        }
    }

    @PluginMethod
    public void listApps(PluginCall call) {
        String query = call.getString("query", "").toLowerCase();
        exec.execute(() -> {
            try {
                PackageManager pm = getContext().getPackageManager();
                Intent i = new Intent(Intent.ACTION_MAIN, null);
                i.addCategory(Intent.CATEGORY_LAUNCHER);
                List<ResolveInfo> all = pm.queryIntentActivities(i, 0);
                List<JSObject> matched = new ArrayList<>();
                int limit = 80;
                for (ResolveInfo ri : all) {
                    String label = ri.loadLabel(pm).toString();
                    String pkg = ri.activityInfo.packageName;
                    if (!query.isEmpty() && !label.toLowerCase().contains(query) && !pkg.toLowerCase().contains(query)) continue;
                    JSObject app = new JSObject();
                    app.put("label", label);
                    app.put("package", pkg);
                    app.put("activity", ri.activityInfo.name);
                    matched.add(app);
                    if (matched.size() >= limit) break;
                }
                JSObject ret = new JSObject();
                ret.put("apps", matched);
                ret.put("count", matched.size());
                call.resolve(ret);
            } catch (Throwable t) {
                call.reject("listApps 失败: " + t.getMessage());
            }
        });
    }

    // --- AI 手动操作（tap / swipe / type / findClick / dump） ---

    @PluginMethod
    public void inputTap(PluginCall call) {
        int x = call.getInt("x", -1);
        int y = call.getInt("y", -1);
        if (x < 0 || y < 0) { call.reject("缺 x / y"); return; }
        // 1) AccessibilityService 优先
        if (KhyAccessibilityService.isReady()) {
            boolean ok = KhyAccessibilityService.INSTANCE.tap(x, y);
            if (ok) { okWithMessage(call, "已通过无障碍点击", true); return; }
        }
        // 2) Shizuku 优先（adb 身份跑 input tap）
        if (isShizukuGranted()) {
            boolean ok = runShizukuCommand("input tap " + x + " " + y);
            if (ok) { okWithMessage(call, "已通过 Shizuku 点击", false); return; }
        }
        // 3) 兜底：普通 exec（无 SELinux 权限基本会被拒）
        runShellAsync("input tap " + x + " " + y, call, "已尝试点击",
            "无无障碍 + 无 Shizuku 授权，普通 shell 通常被 SELinux 拒");
    }

    @PluginMethod
    public void inputSwipe(PluginCall call) {
        int x1 = call.getInt("x1", -1);
        int y1 = call.getInt("y1", -1);
        int x2 = call.getInt("x2", -1);
        int y2 = call.getInt("y2", -1);
        int durationMs = call.getInt("durationMs", 300);
        if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0) { call.reject("缺坐标"); return; }
        if (KhyAccessibilityService.isReady()) {
            boolean ok = KhyAccessibilityService.INSTANCE.swipe(x1, y1, x2, y2, durationMs);
            if (ok) { okWithMessage(call, "已通过无障碍滑动", true); return; }
        }
        if (isShizukuGranted()) {
            boolean ok = runShizukuCommand("input swipe " + x1 + " " + y1 + " " + x2 + " " + y2 + " " + Math.max(50, durationMs));
            if (ok) { okWithMessage(call, "已通过 Shizuku 滑动", false); return; }
        }
        runShellAsync("input swipe " + x1 + " " + y1 + " " + x2 + " " + y2 + " " + Math.max(50, durationMs),
            call, "已尝试滑动", "无无障碍 + 无 Shizuku 授权");
    }

    @PluginMethod
    public void inputText(PluginCall call) {
        String text = call.getString("text", "");
        if (text.isEmpty()) { call.reject("缺 text"); return; }
        if (KhyAccessibilityService.isReady()) {
            boolean ok = KhyAccessibilityService.INSTANCE.typeText(text);
            if (ok) { okWithMessage(call, "已通过无障碍输入", true); return; }
        }
        if (isShizukuGranted()) {
            String escaped = text.replace("'", "'\\''").replace(" ", "%s");
            boolean ok = runShizukuCommand("input text '" + escaped + "'");
            if (ok) { okWithMessage(call, "已通过 Shizuku 输入", false); return; }
        }
        String escaped = text.replace("'", "'\\''").replace(" ", "%s");
        runShellAsync("input text '" + escaped + "'", call, "已尝试输入", "无无障碍 + 无 Shizuku 授权");
    }

    @PluginMethod
    public void findAndClick(PluginCall call) {
        String query = call.getString("query", "");
        if (query.isEmpty()) { call.reject("缺 query（text=... / id=... / class=...）"); return; }
        if (!KhyAccessibilityService.isReady()) { call.reject("需要先在「无障碍」中授权本 App"); return; }
        boolean ok = KhyAccessibilityService.INSTANCE.findAndClick(query);
        if (ok) { okWithMessage(call, "已找到并点击", true); return; }
        call.reject("未找到匹配 \"" + query + "\" 的元素（或不可点击）");
    }

    /** 找元素 + 返回屏幕中心坐标 + 边界。Agent "先 find 元素 → 拿坐标 → 坐标 tap" 的混合模式桥。 */
    @PluginMethod
    public void findWithBounds(PluginCall call) {
        String query = call.getString("query", "");
        if (query.isEmpty()) { call.reject("缺 query"); return; }
        if (!KhyAccessibilityService.isReady()) { call.reject("需要无障碍授权"); return; }
        int[] r = KhyAccessibilityService.INSTANCE.findCenterBounds(query);
        if (r == null) { call.reject("未找到 \"" + query + "\""); return; }
        JSObject ret = new JSObject();
        ret.put("x", r[0]);
        ret.put("y", r[1]);
        ret.put("w", r[2]);
        ret.put("h", r[3]);
        ret.put("cx", r[0]);
        ret.put("cy", r[1]);
        call.resolve(ret);
    }

    /** 列出当前所有可点击节点（text/desc + class + 坐标 + 尺寸）。Agent 决策用。 */
    @PluginMethod
    public void listClickable(PluginCall call) {
        if (!KhyAccessibilityService.isReady()) { call.reject("需要无障碍授权"); return; }
        java.util.List<String[]> rows = KhyAccessibilityService.INSTANCE.listClickable();
        // 序列化成 [{text, class, clickable, x, y, w, h}, ...]
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        for (String[] row : rows) {
            JSObject o = new JSObject();
            o.put("text", row[0] == null ? "" : row[0]);
            o.put("class", row[1] == null ? "" : row[1]);
            o.put("clickable", "true".equals(row[2]));
            try { o.put("x", Integer.parseInt(row[3])); } catch (Throwable t) { o.put("x", 0); }
            try { o.put("y", Integer.parseInt(row[4])); } catch (Throwable t) { o.put("y", 0); }
            try { o.put("w", Integer.parseInt(row[5])); } catch (Throwable t) { o.put("w", 0); }
            try { o.put("h", Integer.parseInt(row[6])); } catch (Throwable t) { o.put("h", 0); }
            arr.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("items", arr);
        ret.put("count", rows.size());
        call.resolve(ret);
    }

    @PluginMethod
    public void findAndLongClick(PluginCall call) {
        String query = call.getString("query", "");
        if (query.isEmpty()) { call.reject("缺 query"); return; }
        if (!KhyAccessibilityService.isReady()) { call.reject("需要无障碍授权"); return; }
        boolean ok = KhyAccessibilityService.INSTANCE.findAndLongClick(query);
        if (ok) { okWithMessage(call, "已长按", true); return; }
        call.reject("未找到或不可长按");
    }

    @PluginMethod
    public void dumpUi(PluginCall call) {
        if (!KhyAccessibilityService.isReady()) { call.reject("需要无障碍授权"); return; }
        String dump = KhyAccessibilityService.INSTANCE.dumpUi();
        JSObject ret = new JSObject();
        ret.put("dump", dump);
        call.resolve(ret);
    }

    @PluginMethod
    public void globalAction(PluginCall call) {
        int action = call.getInt("action", android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME);
        if (!KhyAccessibilityService.isReady()) { call.reject("需要无障碍授权"); return; }
        boolean ok = KhyAccessibilityService.INSTANCE.performGlobal(action);
        if (ok) { okWithMessage(call, "全局动作已派发", true); return; }
        call.reject("全局动作失败");
    }

    // --- 通用 execShell ---

    @PluginMethod
    public void execShell(PluginCall call) {
        String command = call.getString("command", "");
        if (command.isEmpty()) { call.reject("缺 command"); return; }
        if (!isCommandAllowed(command)) { call.reject("命令被拒绝（白名单/黑名单）"); return; }
        exec.execute(() -> {
            try {
                Process p = Runtime.getRuntime().exec(new String[]{"sh", "-c", command});
                StringBuilder out = new StringBuilder();
                StringBuilder err = new StringBuilder();
                BufferedReader ro = new BufferedReader(new InputStreamReader(p.getInputStream()));
                BufferedReader re = new BufferedReader(new InputStreamReader(p.getErrorStream()));
                String line;
                while ((line = ro.readLine()) != null) out.append(line).append('\n');
                while ((line = re.readLine()) != null) err.append(line).append('\n');
                if (!p.waitFor(15, TimeUnit.SECONDS)) { p.destroyForcibly(); }
                int code = p.exitValue();
                JSObject ret = new JSObject();
                ret.put("stdout", out.toString());
                ret.put("stderr", err.toString());
                ret.put("exitCode", code);
                call.resolve(ret);
            } catch (Throwable t) {
                call.reject("execShell 失败: " + t.getMessage());
            }
        });
    }

    // --- helpers ---

    private void runShellAsync(String command, PluginCall call, String successMessage, String fallbackHint) {
        if (!isCommandAllowed(command)) { call.reject("命令被拒绝"); return; }
        exec.execute(() -> {
            try {
                Process p = Runtime.getRuntime().exec(new String[]{"sh", "-c", command});
                boolean finished = p.waitFor(10, TimeUnit.SECONDS);
                if (!finished) p.destroyForcibly();
                int code = p.exitValue();
                JSObject ret = new JSObject();
                ret.put("exitCode", code);
                ret.put("message", successMessage);
                if (code != 0) ret.put("hint", fallbackHint + "（exit=" + code + "）");
                call.resolve(ret);
            } catch (Throwable t) {
                call.reject(t.getMessage());
            }
        });
    }

    private void okWithMessage(PluginCall call, String message, boolean viaAccessibility) {
        JSObject ret = new JSObject();
        ret.put("message", message);
        ret.put("via", viaAccessibility ? "accessibility" : "shell");
        call.resolve(ret);
    }

    private boolean isCommandAllowed(String cmd) {
        String lower = cmd.toLowerCase().trim();
        for (String deny : SHELL_DENY) {
            if (lower.startsWith(deny) || lower.contains(" " + deny)) return false;
        }
        for (String allow : SHELL_ALLOW) {
            if (lower.startsWith(allow)) return true;
        }
        return false;
    }

    private boolean isShizukuInstalled() {
        try {
            return getContext().getPackageManager().getPackageInfo("moe.shizuku.privileged.api", 0) != null;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private boolean isShizukuGranted() {
        try {
            return Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 用 Shizuku.newProcess 跑一条命令（adb 身份）。
     * 注意：Shizuku 13 的 newProcess() 接受 String[] argv 形式；底层会 fork sh -c。
     * 返回 true 表示进程能 fork；不保证命令本身在目标 App 上生效。
     */
    private boolean runShizukuCommand(String command) {
        ShizukuRemoteProcess proc = null;
        try {
            proc = Shizuku.newProcess(
                new String[] { "sh", "-c", command }, null, null);
            proc.waitFor();
            int code = proc.exitValue();
            return code == 0;
        } catch (Throwable t) {
            Log.e(TAG, "Shizuku 命令失败: " + t.getMessage());
            return false;
        } finally {
            if (proc != null) {
                try { proc.destroy(); } catch (Throwable ignored) {}
            }
        }
    }
}
