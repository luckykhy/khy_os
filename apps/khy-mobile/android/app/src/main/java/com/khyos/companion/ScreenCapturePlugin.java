package com.khyos.companion;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * ScreenCapturePlugin — 屏看能力（前台服务版本）。
 *
 * - capture()       : 一次性。弹授权窗（每次都弹）→ 截屏 → 释放。无需前台服务。
 * - startService()  : 弹一次授权窗 → 启前台服务保存 MediaProjection。后续截屏不再弹窗。
 * - captureFrame()  : 仅当前台服务在线时静默截屏。返回 { dataUrl, width, height } 或 null。
 * - stopService()   : 关停前台服务。
 *
 * 推荐用法：UI 上「开启看屏模式」按钮调 startService；之后所有 lookScreen 工具都走 captureFrame。
 * Android 14+ 仍然强制第一次必须用户授权一次（系统限制）。
 */
@CapacitorPlugin(name = "ScreenCapture")
public class ScreenCapturePlugin extends Plugin {

    private static final String TAG = "ScreenCapturePlugin";
    private static final int REQUEST_CODE = 0xCAFE;
    private static final int REQUEST_CODE_SERVICE = 0xCAFF;

    private PluginCall pendingCall;
    private boolean waitingForService = false;

    @PluginMethod
    public void capture(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) { call.reject("Activity 不可用"); return; }
        MediaProjectionManager mpm = (MediaProjectionManager) activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) { call.reject("设备不支持屏幕捕获"); return; }
        pendingCall = call;
        saveCall(call);
        try {
            startActivityForResult(call, mpm.createScreenCaptureIntent(), REQUEST_CODE);
        } catch (Exception e) {
            call.reject("无法启动系统授权窗: " + e.getMessage());
        }
    }

    @PluginMethod
    public void startService(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) { call.reject("Activity 不可用"); return; }
        // 前台服务已运行：直接返回 ready
        if (ScreenCaptureService.INSTANCE != null && ScreenCaptureService.INSTANCE.isReady()) {
            JSObject ret = new JSObject();
            ret.put("ready", true);
            call.resolve(ret);
            return;
        }
        MediaProjectionManager mpm = (MediaProjectionManager) activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) { call.reject("设备不支持屏幕捕获"); return; }
        pendingCall = call;
        waitingForService = true;
        saveCall(call);
        try {
            startActivityForResult(call, mpm.createScreenCaptureIntent(), REQUEST_CODE_SERVICE);
        } catch (Exception e) {
            call.reject("无法启动系统授权窗: " + e.getMessage());
        }
    }

    @PluginMethod
    public void captureFrame(PluginCall call) {
        ScreenCaptureService svc = ScreenCaptureService.INSTANCE;
        if (svc == null || !svc.isReady()) {
            JSObject ret = new JSObject();
            ret.put("dataUrl", (String) null);
            ret.put("ready", false);
            call.resolve(ret);
            return;
        }
        String dataUrl = svc.captureFrame();
        JSObject ret = new JSObject();
        ret.put("dataUrl", dataUrl);
        ret.put("ready", dataUrl != null);
        call.resolve(ret);
    }

    @PluginMethod
    public void captureFrames(PluginCall call) {
        ScreenCaptureService svc = ScreenCaptureService.INSTANCE;
        int intervalMs = call.getInt("intervalMs", 1000);
        int count = call.getInt("count", 3);
        if (svc == null || !svc.isReady()) {
            JSObject ret = new JSObject();
            ret.put("frames", "[]");
            ret.put("ready", false);
            call.resolve(ret);
            return;
        }
        String frames = svc.captureFrames(intervalMs, count);
        JSObject ret = new JSObject();
        ret.put("frames", frames);
        ret.put("count", count);
        ret.put("intervalMs", intervalMs);
        ret.put("ready", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopService(PluginCall call) {
        if (ScreenCaptureService.INSTANCE == null) {
            JSObject ret = new JSObject();
            ret.put("stopped", true);
            call.resolve(ret);
            return;
        }
        Intent stop = new Intent(getContext(), ScreenCaptureService.class);
        stop.setAction(ScreenCaptureService.ACTION_STOP);
        getContext().startService(stop);
        JSObject ret = new JSObject();
        ret.put("stopped", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void isReady(PluginCall call) {
        boolean ready = ScreenCaptureService.INSTANCE != null && ScreenCaptureService.INSTANCE.isReady();
        JSObject ret = new JSObject();
        ret.put("ready", ready);
        call.resolve(ret);
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_CODE && requestCode != REQUEST_CODE_SERVICE) return;
        PluginCall call = pendingCall;
        pendingCall = null;
        boolean isService = requestCode == REQUEST_CODE_SERVICE;
        waitingForService = false;
        if (call == null) return;

        if (resultCode != Activity.RESULT_OK || data == null) {
            call.reject("用户取消了屏幕授权");
            return;
        }

        if (isService) {
            try {
                Intent svc = new Intent(getContext(), ScreenCaptureService.class);
                svc.setAction(ScreenCaptureService.ACTION_START);
                svc.putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode);
                svc.putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data);
                if (Build.VERSION.SDK_INT >= 26) {
                    getContext().startForegroundService(svc);
                } else {
                    getContext().startService(svc);
                }
                JSObject ret = new JSObject();
                ret.put("ready", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("启动前台服务失败: " + e.getMessage());
            }
            return;
        }

        // 一次性 capture 路径：直接用 Plugin 拿到的 resultCode + data
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            android.media.projection.MediaProjection projection = mpm.getMediaProjection(resultCode, data);
            String dataUrl = oneShotCapture(projection);
            projection.stop();
            JSObject ret = new JSObject();
            ret.put("dataUrl", dataUrl);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("截屏失败: " + e.getMessage());
        }
    }

    private String oneShotCapture(android.media.projection.MediaProjection projection) {
        if (projection == null) return null;
        android.graphics.Bitmap bmp = null;
        try {
            android.hardware.display.DisplayManager dm = (android.hardware.display.DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE);
            android.util.DisplayMetrics dm_metrics = getContext().getResources().getDisplayMetrics();
            int w = dm_metrics.widthPixels;
            int h = dm_metrics.heightPixels;
            android.media.ImageReader reader = android.media.ImageReader.newInstance(w, h, android.graphics.PixelFormat.RGBA_8888, 2);
            android.hardware.display.VirtualDisplay display = projection.createVirtualDisplay(
                "khy-one-shot", w, h, dm_metrics.densityDpi,
                android.hardware.display.DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.getSurface(), null, null);
            android.media.Image image = reader.acquireLatestImage();
            if (image == null) { try { Thread.sleep(200); image = reader.acquireLatestImage(); } catch (InterruptedException ignored) {} }
            if (image == null) return null;
            try {
                bmp = imageToBitmap(image, w, h);
                bmp = scaleIfTooBig(bmp, 1280);
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out);
                return "data:image/jpeg;base64," + android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP);
            } finally {
                image.close();
                reader.close();
                display.release();
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (bmp != null) bmp.recycle();
        }
    }

    private static android.graphics.Bitmap imageToBitmap(android.media.Image image, int w, int h) {
        android.media.Image.Plane[] planes = image.getPlanes();
        java.nio.ByteBuffer buffer = planes[0].getBuffer();
        int pixelStride = planes[0].getPixelStride();
        int rowStride = planes[0].getRowStride();
        int rowPadding = rowStride - pixelStride * w;
        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(w + rowPadding / pixelStride, h, android.graphics.Bitmap.Config.ARGB_8888);
        bitmap.copyPixelsFromBuffer(buffer);
        if (rowPadding != 0) {
            android.graphics.Bitmap cropped = android.graphics.Bitmap.createBitmap(bitmap, 0, 0, w, h);
            bitmap.recycle();
            return cropped;
        }
        return bitmap;
    }

    private static android.graphics.Bitmap scaleIfTooBig(android.graphics.Bitmap bmp, int maxLongSide) {
        int w = bmp.getWidth();
        int h = bmp.getHeight();
        if (Math.max(w, h) <= maxLongSide) return bmp;
        double scale = (double) maxLongSide / Math.max(w, h);
        android.graphics.Bitmap scaled = android.graphics.Bitmap.createScaledBitmap(bmp, (int) Math.round(w * scale), (int) Math.round(h * scale), true);
        if (scaled != bmp) bmp.recycle();
        return scaled;
    }
}
