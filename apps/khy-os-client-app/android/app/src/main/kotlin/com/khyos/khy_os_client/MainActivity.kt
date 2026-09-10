package com.khyos.khy_os_client

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val CHANNEL = "com.khyos.khy_os_client/device"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "openApp" -> openApp(call.argument<String>("packageName") ?: "", result)
                "openUrl" -> openUrl(call.argument<String>("url") ?: "", result)
                "searchApps" -> searchApps(call.argument<String>("query") ?: "", result)
                "listApps" -> listApps(result)
                "getClipboard" -> getClipboard(result)
                "setClipboard" -> setClipboard(call.argument<String>("text") ?: "", result)
                "getDeviceInfo" -> getDeviceInfo(result)
                "vibrate" -> vibrate(call.argument<Int>("duration") ?: 200, result)
                "getInstalledPackages" -> getInstalledPackages(result)
                else -> result.notImplemented()
            }
        }
    }

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
            val q = query.lowercase()
            val matched = apps.filter { info ->
                val label = info.loadLabel(pm).toString().lowercase()
                val pkg = info.activityInfo.packageName.lowercase()
                label.contains(q) || pkg.contains(q)
            }.take(20).map { info ->
                mapOf(
                    "label" to info.loadLabel(pm).toString(),
                    "package" to info.activityInfo.packageName
                )
            }
            result.success(mapOf("success" to true, "apps" to matched))
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
}
