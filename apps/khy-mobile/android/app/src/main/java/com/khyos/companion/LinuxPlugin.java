package com.khyos.companion;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

/**
 * LinuxPlugin —— 在 APK 内运行完整 Linux 环境（Alpine + PRoot）。
 *
 * 架构：
 * 1. APK assets 包含 alpine-rootfs.tar.gz（~4MB）
 * 2. jniLibs/arm64-v8a/libproot.so（PRoot 静态编译，~400KB）
 * 3. 首次运行时解压 rootfs 到 filesDir/linux-rootfs
 * 4. 通过 proot 执行 shell 命令
 *
 * 注意：Android W^X 策略要求 proot 必须从 nativeLibraryDir 执行。
 */
@CapacitorPlugin(name = "Linux")
public class LinuxPlugin extends Plugin {

    private static final String TAG = "LinuxPlugin";
    private final ExecutorService exec = Executors.newCachedThreadPool();
    private File rootfsDir;
    private volatile boolean extracting = false;

    @Override
    public void load() {
        rootfsDir = new File(getContext().getFilesDir(), "linux-rootfs");
    }

    /**
     * 检查 Linux 环境状态（是否已解压、proot 是否可用）
     */
    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        boolean rootfsExists = rootfsDir.exists() && new File(rootfsDir, "bin/sh").exists();
        boolean prootExists = getProotPath() != null;
        ret.put("rootfsExtracted", rootfsExists);
        ret.put("prootAvailable", prootExists);
        ret.put("rootfsPath", rootfsDir.getAbsolutePath());
        ret.put("ready", rootfsExists && prootExists);
        call.resolve(ret);
    }

    /**
     * 解压 Linux rootfs（首次运行或重置时调用）
     */
    @PluginMethod
    public void extractRootfs(PluginCall call) {
        if (extracting) {
            call.reject("正在解压中，请稍候");
            return;
        }
        if (rootfsDir.exists() && new File(rootfsDir, "bin/sh").exists()) {
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("message", "rootfs 已存在");
            ret.put("path", rootfsDir.getAbsolutePath());
            call.resolve(ret);
            return;
        }
        extracting = true;
        exec.execute(() -> {
            try {
                // 清理旧目录
                if (rootfsDir.exists()) deleteRecursive(rootfsDir);
                rootfsDir.mkdirs();

                // 先将 asset 复制到 filesDir（因为 tar 无法直接读取 assets）
                File tarFile = new File(getContext().getFilesDir(), "alpine-rootfs.tar.gz");
                AssetManager am = getContext().getAssets();
                try (InputStream is = am.open("alpine-rootfs.tar.gz");
                     FileOutputStream fos = new FileOutputStream(tarFile)) {
                    byte[] buffer = new byte[8192];
                    int len;
                    while ((len = is.read(buffer)) > 0) {
                        fos.write(buffer, 0, len);
                    }
                }

                // 使用系统 tar 命令解压（Android Toybox 内置）
                ProcessBuilder pb = new ProcessBuilder("tar", "-xzf", tarFile.getAbsolutePath(), "-C", rootfsDir.getAbsolutePath());
                pb.redirectErrorStream(true);
                Process p = pb.start();
                StringBuilder err = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                    String line;
                    while ((line = reader.readLine()) != null) err.append(line).append("\n");
                }
                int exitCode = p.waitFor();
                if (exitCode != 0) {
                    throw new RuntimeException("tar 解压失败（退出码 " + exitCode + "）: " + err);
                }

                // 删除临时 tar 文件
                tarFile.delete();

                // 创建必要目录
                new File(rootfsDir, "proc").mkdirs();
                new File(rootfsDir, "sys").mkdirs();
                new File(rootfsDir, "dev").mkdirs();
                new File(rootfsDir, "tmp").mkdirs();

                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("message", "解压完成");
                ret.put("path", rootfsDir.getAbsolutePath());
                saveCall(call);
                notifyListeners("rootfsExtracted", ret);
                call.resolve(ret);
            } catch (Throwable t) {
                Log.e(TAG, "解压失败", t);
                if (rootfsDir.exists()) deleteRecursive(rootfsDir);
                call.reject("解压失败: " + t.getMessage());
            } finally {
                extracting = false;
            }
        });
    }

    /**
     * 在 Linux 环境中执行 shell 命令
     */
    @PluginMethod
    public void exec(PluginCall call) {
        String command = call.getString("command", "");
        if (command.isEmpty()) {
            call.reject("缺少 command 参数");
            return;
        }
        if (!rootfsDir.exists() || !new File(rootfsDir, "bin/sh").exists()) {
            call.reject("Linux 环境未就绪，请先调用 extractRootfs");
            return;
        }
        exec.execute(() -> {
            try {
                String result = runInProot(command);
                JSObject ret = new JSObject();
                ret.put("output", result);
                ret.put("success", true);
                call.resolve(ret);
            } catch (Throwable t) {
                call.reject("执行失败: " + t.getMessage());
            }
        });
    }

    /**
     * 通过 proot 执行命令
     */
    private String runInProot(String command) throws Exception {
        String nativeLibDir = getContext().getApplicationInfo().nativeLibraryDir;
        String prootPath = nativeLibDir + "/libproot.so";
        File tmpDir = new File(getContext().getFilesDir(), "tmp");
        tmpDir.mkdirs();

        ProcessBuilder pb = new ProcessBuilder(
            prootPath,
            "--rootfs=" + rootfsDir.getAbsolutePath(),
            "--bind=/dev",
            "--bind=/proc",
            "--bind=/sys",
            "--bind=" + getContext().getFilesDir().getAbsolutePath() + ":/host",
            "-0",
            "-w", "/root",
            "/bin/sh", "-c", command
        );
        pb.redirectErrorStream(true);
        pb.environment().put("HOME", "/root");
        pb.environment().put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        pb.environment().put("TMPDIR", "/tmp");
        pb.directory(rootfsDir);

        Process process = pb.start();
        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }
        process.waitFor();
        String result = output.toString();
        return result.isBlank() ? "（无输出，退出码: " + process.exitValue() + ")" : result;
    }

    /**
     * 删除 proot 二进制（不需要了，因为我们使用静态编译版本）
     */
    private String getProotPath() {
        String nativeLibDir = getContext().getApplicationInfo().nativeLibraryDir;
        File proot = new File(nativeLibDir, "libproot.so");
        return proot.exists() ? proot.getAbsolutePath() : null;
    }

    private void deleteRecursive(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursive(child);
            }
        }
        file.delete();
    }
}
