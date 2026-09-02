package com.khyos.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * ScreenCaptureService —— 前台服务，保存 MediaProjection 句柄。
 *
 * 流程（一次生命周期）：
 *   1) startForeground(id, notification) —— 通知常驻
 *   2) handleStartProjection(intentData)  —— 接收授权 Intent，createMediaProjection
 *   3) captureFrame()                      —— 任何时刻静默截屏（不再弹窗）
 *   4) stopProjection()                    —— 用户从通知/UI 关停
 *
 * 设计要点：
 *   - 严格不持有 Activity 引用；只接受 Intent extras。
 *   - 截屏在 HandlerThread 完成；通知 UI 用 AtomicReference + CountDownLatch（最多 2s）。
 *   - 屏幕授权必须由 Activity 弹一次（Android 14+ 系统强制）；
 *     拿到的 resultCode + data 通过 startService(Intent) extras 传进来。
 */
public class ScreenCaptureService extends Service {

    private static final String TAG = "ScreenCaptureService";
    public static final String ACTION_START = "com.khyos.companion.action.START_PROJECTION";
    public static final String ACTION_STOP = "com.khyos.companion.action.STOP_PROJECTION";
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData"; // Intent（Parcelable）

    public static final int NOTIF_ID = 0x5C5C;
    private static final String CHANNEL_ID = "khy_screen_capture";
    private static final int MAX_LONG_SIDE = 1280;
    private static final int JPEG_QUALITY = 80;
    private static final long FRAME_TIMEOUT_MS = 2000;

    private MediaProjection projection;
    private ImageReader imageReader;
    private VirtualDisplay virtualDisplay;
    private HandlerThread thread;
    private Handler handler;
    private int width;
    private int height;
    private int density;

    public static volatile ScreenCaptureService INSTANCE;

    @Override
    public void onCreate() {
        super.onCreate();
        INSTANCE = this;
        DisplayMetrics m = getResources().getDisplayMetrics();
        width = m.widthPixels;
        height = m.heightPixels;
        density = m.densityDpi;
        thread = new HandlerThread("khy-screen-capture");
        thread.start();
        handler = new Handler(thread.getLooper());
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_START.equals(intent.getAction())) {
            int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
            Intent data = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            if (resultCode != 0 && data != null) {
                startForegroundWithNotification();
                setupProjection(resultCode, data);
                return START_STICKY;
            }
        }
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // 第一次启动还没拿到授权 intent 时，先起一个空通知占位（避免 ANR）
        startForegroundWithNotification();
        return START_STICKY;
    }

    private void startForegroundWithNotification() {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "屏幕捕获", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("khy.os 看屏模式：服务运行中");
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.createNotificationChannel(channel);

        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = open != null
            ? PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE)
            : null;

        Notification notif = new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Khy-OS 看屏模式")
            .setContentText("服务运行中（点击返回）")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .setContentIntent(pi)
            .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIF_ID, notif);
        }
    }

    private void createChannel() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID);
        if (existing != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "屏幕捕获", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("khy.os 看屏模式：服务运行中");
        nm.createNotificationChannel(channel);
    }

    private void setupProjection(int resultCode, Intent data) {
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        projection = mpm.getMediaProjection(resultCode, data);
        // Android 14+：必须注册 callback 才能后续 createVirtualDisplay
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                handler.post(() -> teardownProjection());
            }
        }, handler);
        handler.post(() -> {
            try {
                imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
                virtualDisplay = projection.createVirtualDisplay(
                    "khy-screen-capture",
                    width, height, density,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    imageReader.getSurface(), null, null
                );
            } catch (Exception e) {
                Log.e(TAG, "setupProjection failed: " + e.getMessage());
            }
        });
    }

    /**
     * 截一帧。UI 线程阻塞等待，但有 FRAME_TIMEOUT_MS 上限。
     */
    public String captureFrame() {
        if (projection == null || imageReader == null) {
            return null;
        }
        AtomicReference<String> result = new AtomicReference<>(null);
        CountDownLatch latch = new CountDownLatch(1);
        handler.post(() -> {
            try {
                Image image = imageReader.acquireLatestImage();
                if (image == null) {
                    Thread.sleep(200);
                    image = imageReader.acquireLatestImage();
                }
                if (image != null) {
                    try {
                        Bitmap bmp = imageToBitmap(image, width, height);
                        bmp = scaleIfTooBig(bmp, MAX_LONG_SIDE);
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        bmp.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
                        result.set("data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                        bmp.recycle();
                    } finally {
                        image.close();
                    }
                }
            } catch (Throwable t) {
                Log.e(TAG, "captureFrame error: " + t.getMessage());
            } finally {
                latch.countDown();
            }
        });
        try {
            latch.await(FRAME_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {}
        return result.get();
    }

    /**
     * 多帧截屏：每 intervalMs 截一帧，截 count 张后返回。
     * 适用于"操作回放" / "看一段时间变化"。
     * 返回 JSON 数组字符串：[dataUrl, dataUrl, ...]
     * 整段超时 = (intervalMs * count) + count*500ms buffer
     */
    public String captureFrames(int intervalMs, int count) {
        if (projection == null || imageReader == null) return "[]";
        if (intervalMs < 200) intervalMs = 200;
        if (count < 1) count = 1;
        if (count > 20) count = 20; // 安全上限，避免长时间锁死
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < count; i++) {
            if (i > 0) {
                try { Thread.sleep(intervalMs); } catch (InterruptedException e) { break; }
            }
            String frame = captureFrame();
            if (frame != null) {
                if (out.length() > 1) out.append(',');
                // 去掉 "data:image/jpeg;base64," 前缀减轻传输，AI 端我们已知道是 jpeg
                int comma = frame.indexOf(',');
                out.append(comma >= 0 ? frame.substring(comma + 1) : frame);
            }
        }
        out.append(']');
        return out.toString();
    }

    public boolean isReady() {
        return projection != null && imageReader != null;
    }

    public void teardownProjection() {
        if (virtualDisplay != null) { try { virtualDisplay.release(); } catch (Exception ignored) {} virtualDisplay = null; }
        if (imageReader != null) { try { imageReader.close(); } catch (Exception ignored) {} imageReader = null; }
        if (projection != null) { try { projection.stop(); } catch (Exception ignored) {} projection = null; }
    }

    @Override
    public void onDestroy() {
        handler.post(() -> teardownProjection());
        if (thread != null) thread.quitSafely();
        INSTANCE = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private static Bitmap imageToBitmap(Image image, int w, int h) {
        Image.Plane[] planes = image.getPlanes();
        ByteBuffer buffer = planes[0].getBuffer();
        int pixelStride = planes[0].getPixelStride();
        int rowStride = planes[0].getRowStride();
        int rowPadding = rowStride - pixelStride * w;
        Bitmap bitmap = Bitmap.createBitmap(w + rowPadding / pixelStride, h, Bitmap.Config.ARGB_8888);
        bitmap.copyPixelsFromBuffer(buffer);
        if (rowPadding != 0) {
            Bitmap cropped = Bitmap.createBitmap(bitmap, 0, 0, w, h);
            bitmap.recycle();
            return cropped;
        }
        return bitmap;
    }

    private static Bitmap scaleIfTooBig(Bitmap bmp, int maxLongSide) {
        int w = bmp.getWidth();
        int h = bmp.getHeight();
        if (Math.max(w, h) <= maxLongSide) return bmp;
        double scale = (double) maxLongSide / Math.max(w, h);
        Bitmap scaled = Bitmap.createScaledBitmap(bmp, (int) Math.round(w * scale), (int) Math.round(h * scale), true);
        if (scaled != bmp) bmp.recycle();
        return scaled;
    }
}
