package com.khyos.khy_os_client

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class MainActivity : FlutterActivity() {
    private val CHANNEL = "com.khyos.khy_os_client/device"
    private val exec = Executors.newCachedThreadPool()

    // Shell command whitelist
    private val SHELL_ALLOW = arrayOf(
        "am start ", "am force-stop ", "am kill ",
        "wm size", "wm density",
        "dumpsys ",
        "pm list packages", "pm path ", "pm dump ",
        "settings get ", "settings put ",
        "input tap ", "input swipe ", "input text ", "input keyevent ",
        "screencap ",
        "ls ", "cat ", "echo ", "mkdir ", "rm ", "mv ", "cp ",
        "ps ", "kill ",
    )
    private val SHELL_DENY = arrayOf(
        "rm -rf /", "rm -rf /*", "rm /system", "rm /data",
        "shutdown", "reboot", "stop", "restart",
        "format", "mkfs", "dd if=",
        "iptables", "mount ", "umount ",
    )

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                // --- App / URL ---
                "openApp" -> openApp(call.argument<String>("packageName") ?: "", result)
                "openUrl" -> openUrl(call.argument<String>("url") ?: "", result)
                "searchApps" -> searchApps(call.argument<String>("query") ?: "", result)
                "listApps" -> listApps(result)

                // --- Clipboard ---
                "getClipboard" -> getClipboard(result)
                "setClipboard" -> setClipboard(call.argument<String>("text") ?: "", result)

                // --- Device ---
                "getDeviceInfo" -> getDeviceInfo(result)
                "vibrate" -> vibrate(call.argument<Int>("duration") ?: 200, result)
                "getInstalledPackages" -> getInstalledPackages(result)

                // --- Accessibility Service ---
                "isAccessibilityReady" -> result.success(mapOf("ready" to KhyAccessibilityService.isReady()))
                "openAccessibilitySettings" -> openAccessibilitySettings(result)
                "a11yTap" -> a11yTap(call.argument<Int>("x") ?: 0, call.argument<Int>("y") ?: 0, result)
                "a11ySwipe" -> a11ySwipe(
                    call.argument<Int>("x1") ?: 0, call.argument<Int>("y1") ?: 0,
                    call.argument<Int>("x2") ?: 0, call.argument<Int>("y2") ?: 0,
                    call.argument<Int>("durationMs") ?: 300, result)
                "a11yFindAndClick" -> a11yFindAndClick(call.argument<String>("query") ?: "", result)
                "a11yFindAndLongClick" -> a11yFindAndLongClick(call.argument<String>("query") ?: "", result)
                "a11yFindWithBounds" -> a11yFindWithBounds(call.argument<String>("query") ?: "", result)
                "a11yDumpUi" -> a11yDumpUi(result)
                "a11yListClickable" -> a11yListClickable(result)
                "a11yTypeText" -> a11yTypeText(call.argument<String>("text") ?: "", result)
                "a11yGlobalAction" -> a11yGlobalAction(call.argument<Int>("action") ?: 1, result)

                // --- Permissions ---
                "checkPermissions" -> checkPermissions(result)
                "requestNotifications" -> requestNotifications(result)
                "requestOverlay" -> requestOverlay(result)
                "requestAccessibility" -> requestAccessibility(result)

                // --- Screen Capture ---
                "isScreenCaptureReady" -> result.success(mapOf("ready" to ScreenCaptureService.isReady()))
                "startScreenCapture" -> startScreenCapture(result)
                "captureFrame" -> captureFrame(result)
                "stopScreenCapture" -> stopScreenCapture(result)

                // --- Shell ---
                "execShell" -> execShell(call.argument<String>("command") ?: "", result)

                else -> result.notImplemented()
            }
        }
    }

    // --- App / URL ---

    private fun openApp(packageName: String, result: MethodChannel.Result) {
        try {
            val pm = packageManager
            val intent = pm.getLaunchIntentForPackage(packageName)
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                result.success(mapOf("success" to true, "message" to "已启动 $packageName"))
            } else {
                result.success(mapOf("success" to false, "message" to "未找到应用: $packageName"))
            }
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to "启动失败: ${e.message}"))
        }
    }

    private fun openUrl(url: String, result: MethodChannel.Result) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            result.success(mapOf("success" to true, "message" to "已打开 $url"))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to "打开失败: ${e.message}"))
        }
    }

    private fun searchApps(query: String, result: MethodChannel.Result) {
        try {
            val pm = packageManager
            val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
            val apps = pm.queryIntentActivities(mainIntent, 0)
            val q = query.lowercase().trim()

            // Score-based matching: exact > contains > semantic
            data class ScoredApp(val score: Int, val label: String, val pkg: String)
            val scored = mutableListOf<ScoredApp>()

            for (info in apps) {
                val label = info.loadLabel(pm).toString()
                val pkg = info.activityInfo.packageName
                val labelLc = label.lowercase()
                val pkgLc = pkg.lowercase()

                var score = 0
                if (q.isNotEmpty()) {
                    // Exact matches get highest score
                    if (labelLc == q) score += 100
                    if (pkgLc == q) score += 90
                    // Contains matches
                    if (labelLc.contains(q)) score += 30
                    if (pkgLc.contains(q)) score += 20
                } else {
                    score = 10 // No query, just list all
                }
                if (score > 0) {
                    scored.add(ScoredApp(score, label, pkg))
                }
            }

            scored.sortByDescending { it.score }
            val matched = scored.take(30).map {
                mapOf("label" to it.label, "package" to it.pkg)
            }
            result.success(mapOf("success" to true, "apps" to matched, "total" to scored.size))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "apps" to emptyList<Any>(), "message" to e.message))
        }
    }

    private fun listApps(result: MethodChannel.Result) {
        try {
            val pm = packageManager
            val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
            val apps = pm.queryIntentActivities(mainIntent, 0).map { info ->
                mapOf(
                    "label" to info.loadLabel(pm).toString(),
                    "package" to info.activityInfo.packageName
                )
            }
            result.success(mapOf("success" to true, "apps" to apps))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "apps" to emptyList<Any>(), "message" to e.message))
        }
    }

    // --- Clipboard ---

    private fun getClipboard(result: MethodChannel.Result) {
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = cm.primaryClip
            val text = clip?.getItemAt(0)?.text?.toString() ?: ""
            result.success(mapOf("success" to true, "text" to text))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "text" to "", "message" to e.message))
        }
    }

    private fun setClipboard(text: String, result: MethodChannel.Result) {
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("khy-os", text)
            cm.setPrimaryClip(clip)
            result.success(mapOf("success" to true, "message" to "已复制到剪贴板"))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to e.message))
        }
    }

    // --- Device ---

    private fun getDeviceInfo(result: MethodChannel.Result) {
        try {
            val pm = packageManager
            val pkgInfo = pm.getPackageInfo(packageName, 0)
            result.success(mapOf(
                "success" to true,
                "platform" to "android",
                "brand" to Build.BRAND,
                "model" to Build.MODEL,
                "sdkVersion" to Build.VERSION.SDK_INT,
                "releaseVersion" to Build.VERSION.RELEASE,
                "appVersion" to pkgInfo.versionName,
                "packageName" to packageName
            ))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to e.message))
        }
    }

    private fun vibrate(duration: Int, result: MethodChannel.Result) {
        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as android.os.VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as android.os.Vibrator
            }
            @Suppress("DEPRECATION")
            vibrator.vibrate(duration.toLong())
            result.success(mapOf("success" to true))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to e.message))
        }
    }

    private fun getInstalledPackages(result: MethodChannel.Result) {
        try {
            val pm = packageManager
            val packages = pm.getInstalledPackages(0).map { pkg ->
                mapOf(
                    "label" to (pkg.applicationInfo?.loadLabel(pm)?.toString() ?: pkg.packageName),
                    "package" to pkg.packageName,
                    "versionName" to (pkg.versionName ?: ""),
                    "isSystem" to ((pkg.applicationInfo?.flags ?: 0) and android.content.pm.ApplicationInfo.FLAG_SYSTEM != 0)
                )
            }
            result.success(mapOf("success" to true, "packages" to packages))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "packages" to emptyList<Any>(), "message" to e.message))
        }
    }

    // --- Accessibility Service ---

    private fun openAccessibilitySettings(result: MethodChannel.Result) {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            result.success(mapOf("opened" to true))
        } catch (e: Exception) {
            result.error("ERROR", e.message, null)
        }
    }

    private fun a11yTap(x: Int, y: Int, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.tap(x, y) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "已点击 ($x, $y)" else "点击失败")))
    }

    private fun a11ySwipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.swipe(x1, y1, x2, y2, durationMs) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "已滑动" else "滑动失败")))
    }

    private fun a11yFindAndClick(query: String, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.findAndClick(query) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "已找到并点击" else "未找到匹配元素")))
    }

    private fun a11yFindAndLongClick(query: String, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.findAndLongClick(query) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "已长按" else "未找到或不可长按")))
    }

    private fun a11yFindWithBounds(query: String, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val bounds = KhyAccessibilityService.instance?.findCenterBounds(query)
        if (bounds != null) {
            result.success(mapOf(
                "success" to true,
                "x" to bounds[0], "y" to bounds[1],
                "w" to bounds[2], "h" to bounds[3]
            ))
        } else {
            result.success(mapOf("success" to false, "message" to "未找到 \"$query\""))
        }
    }

    private fun a11yDumpUi(result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "dump" to "", "message" to "无障碍服务未启用"))
            return
        }
        val dump = KhyAccessibilityService.instance?.dumpUi() ?: ""
        result.success(mapOf("success" to true, "dump" to dump))
    }

    private fun a11yListClickable(result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "items" to emptyList<Any>(), "message" to "无障碍服务未启用"))
            return
        }
        val items = KhyAccessibilityService.instance?.listClickable()?.map { row ->
            mapOf(
                "text" to (row[0].ifEmpty { "" }),
                "class" to (row[1].ifEmpty { "" }),
                "clickable" to (row[2] == "true"),
                "x" to (row[3].toIntOrNull() ?: 0),
                "y" to (row[4].toIntOrNull() ?: 0),
                "w" to (row[5].toIntOrNull() ?: 0),
                "h" to (row[6].toIntOrNull() ?: 0)
            )
        } ?: emptyList()
        result.success(mapOf("success" to true, "items" to items, "count" to items.size))
    }

    private fun a11yTypeText(text: String, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.typeText(text) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "已输入文字" else "输入失败")))
    }

    private fun a11yGlobalAction(action: Int, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.performGlobal(action) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "全局动作已执行" else "全局动作失败")))
    }

    // --- Screen Capture ---

    private fun startScreenCapture(result: MethodChannel.Result) {
        try {
            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val captureIntent = mpm.createScreenCaptureIntent()
            startActivityForResult(captureIntent, SCREEN_CAPTURE_REQUEST)
            // Note: result will be handled in onActivityResult
            result.success(mapOf("success" to true, "message" to "请在弹窗中授权屏幕捕获"))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to "启动屏幕捕获失败: ${e.message}"))
        }
    }

    private fun captureFrame(result: MethodChannel.Result) {
        if (!ScreenCaptureService.isReady()) {
            result.success(mapOf("success" to false, "data" to "", "message" to "屏幕捕获服务未就绪"))
            return
        }
        exec.execute {
            val frame = ScreenCaptureService.instance?.captureFrame()
            runOnUiThread {
                if (frame != null) {
                    result.success(mapOf("success" to true, "data" to frame))
                } else {
                    result.success(mapOf("success" to false, "data" to "", "message" to "截屏失败"))
                }
            }
        }
    }

    private fun stopScreenCapture(result: MethodChannel.Result) {
        val intent = Intent(this, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_STOP
        }
        startService(intent)
        result.success(mapOf("success" to true, "message" to "已停止屏幕捕获"))
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == SCREEN_CAPTURE_REQUEST) {
            if (resultCode == RESULT_OK && data != null) {
                val intent = Intent(this, ScreenCaptureService::class.java).apply {
                    action = ScreenCaptureService.ACTION_START
                    putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
                    putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
                }
                startForegroundService(intent)
            }
        }
    }

    // --- Shell ---

    private fun execShell(command: String, result: MethodChannel.Result) {
        if (!isCommandAllowed(command)) {
            result.success(mapOf("success" to false, "stdout" to "", "stderr" to "命令被拒绝（白名单/黑名单）", "exitCode" to -1))
            return
        }
        exec.execute {
            try {
                val p = Runtime.getRuntime().exec(arrayOf("sh", "-c", command))
                val out = StringBuilder()
                val err = StringBuilder()
                val ro = BufferedReader(InputStreamReader(p.inputStream))
                val re = BufferedReader(InputStreamReader(p.errorStream))
                var line: String?
                while (ro.readLine().also { line = it } != null) out.append(line).append("\n")
                while (re.readLine().also { line = it } != null) err.append(line).append("\n")
                if (!p.waitFor(15, TimeUnit.SECONDS)) p.destroyForcibly()
                val code = p.exitValue()
                runOnUiThread {
                    result.success(mapOf(
                        "success" to (code == 0),
                        "stdout" to out.toString(),
                        "stderr" to err.toString(),
                        "exitCode" to code
                    ))
                }
            } catch (e: Exception) {
                runOnUiThread {
                    result.success(mapOf("success" to false, "stdout" to "", "stderr" to e.message, "exitCode" to -1))
                }
            }
        }
    }

    private fun isCommandAllowed(cmd: String): Boolean {
        val lower = cmd.lowercase().trim()
        for (deny in SHELL_DENY) {
            if (lower.startsWith(deny) || lower.contains(" $deny")) return false
        }
        for (allow in SHELL_ALLOW) {
            if (lower.startsWith(allow)) return true
        }
        return false
    }

    // --- Permissions ---

    private fun checkPermissions(result: MethodChannel.Result) {
        val ctx = this
        val notifGranted = if (Build.VERSION.SDK_INT >= 33) {
            ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        val overlayGranted = if (Build.VERSION.SDK_INT >= 23) {
            Settings.canDrawOverlays(ctx)
        } else {
            true
        }
        val a11yGranted = KhyAccessibilityService.isReady()
        result.success(mapOf(
            "notifications" to notifGranted,
            "overlay" to overlayGranted,
            "accessibility" to a11yGranted
        ))
    }

    private fun requestNotifications(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(
                arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                REQ_NOTIF
            )
            result.success(mapOf("requested" to true))
        } else {
            result.success(mapOf("requested" to true, "message" to "Android < 13 无需请求"))
        }
    }

    private fun requestOverlay(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT >= 23) {
            try {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                )
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                result.success(mapOf("requested" to true))
            } catch (e: Exception) {
                result.success(mapOf("requested" to false, "message" to e.message))
            }
        } else {
            result.success(mapOf("requested" to true, "message" to "Android < 6 自动授予"))
        }
    }

    private fun requestAccessibility(result: MethodChannel.Result) {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            result.success(mapOf("requested" to true))
        } catch (e: Exception) {
            result.success(mapOf("requested" to false, "message" to e.message))
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIF) {
            val granted = grantResults.isNotEmpty() &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED
            // The checkPermissions method will reflect this on next call
        }
    }

    companion object {
        private const val SCREEN_CAPTURE_REQUEST = 1001
        private const val REQ_NOTIF = 1002
    }
}
