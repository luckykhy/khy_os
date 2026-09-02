package com.khyos.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.concurrent.atomic.AtomicReference;

/**
 * OverlayService —— AI Agent 任务执行中的"贴边小卡片"前台服务。
 *
 * 设计目标（受 Roubao v1.x 启发，结合 khyos 现有 Material 风格）：
 *   - TYPE_APPLICATION_OVERLAY 窗口（无需 root，需用户授"显示在其他应用上"）
 *   - 默认贴屏幕右侧上部，1/3 宽 × 自适应高，圆角 + 阴影（layout/overlay_card.xml）
 *   - 折叠态：单行状态（图标 + 阶段 + 步数）
 *   - 展开态：4 行（阶段 / 工具 / 步数 / 摘要）+ 停止按钮
 *   - 可拖动到屏幕任意位置（单指拖）
 *   - 用户点"停止"按钮 → ACTION_USER_STOP 广播 → OverlayPlugin 收 → notifyListeners
 *
 * 2026 重构：UI 改用 res/layout/overlay_card.xml + ViewBinding 风格的 findViewById。
 * 不再代码里 new TextView/LinearLayout，类型和样式在 XML 里管。
 *
 * 工作流程：
 *   1) startForeground 拉起服务 + 通知
 *   2) 外部通过 Intent action 控制：UPDATE / HIDE / SHOW / STOP
 *   3) 不抢焦点（FLAG_NOT_FOCUSABLE）—— 用户照常操作下面 App
 *   4) Agent 结束时 service stopSelf()
 */
public class OverlayService extends Service {

    private static final String TAG = "KhyOverlay";
    public static final String ACTION_SHOW = "com.khyos.companion.OVERLAY_SHOW";
    public static final String ACTION_HIDE = "com.khyos.companion.OVERLAY_HIDE";
    public static final String ACTION_UPDATE = "com.khyos.companion.OVERLAY_UPDATE";
    public static final String ACTION_STOP = "com.khyos.companion.OVERLAY_STOP";
    public static final String ACTION_USER_STOP = "com.khyos.companion.OVERLAY_USER_STOP";
    public static final String CHANNEL_ID = "khy_agent_overlay";
    public static final int NOTIF_ID = 8201;

    public static final String EXTRA_PHASE = "phase";
    public static final String EXTRA_TOOL = "tool";
    public static final String EXTRA_SUMMARY = "summary";
    public static final String EXTRA_STEPS = "steps";
    public static final String EXTRA_EXPANDED = "expanded";

    private WindowManager windowManager;
    private View rootView;
    private TextView headerView;
    private TextView phaseView;
    private TextView toolView;
    private TextView stepsView;
    private TextView summaryView;
    private LinearLayout expandedContainer;
    private ImageButton stopButton;
    private ImageButton collapseButton;
    private WindowManager.LayoutParams layoutParams;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean expanded = true;
    private int initialX = 0, initialY = 0;
    private float touchStartX = 0, touchStartY = 0;

    public static final AtomicReference<OverlayService> INSTANCE = new AtomicReference<>();

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        INSTANCE.set(this);
        ensureChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            return START_NOT_STICKY;
        }
        // 必须先 startForeground，否则系统 5 秒内会杀服务
        startForegroundCompat();

        String action = intent.getAction();
        if (ACTION_SHOW.equals(action)) {
            showOverlay(intent);
        } else if (ACTION_HIDE.equals(action)) {
            hideOverlay();
        } else if (ACTION_UPDATE.equals(action)) {
            updateContent(intent);
        } else if (ACTION_STOP.equals(action)) {
            // 用户点停止按钮：广播 + 结束自己
            broadcastUserStop();
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private void startForegroundCompat() {
        Notification n = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle("AI Agent 运行中")
                .setContentText("点击收起/展开悬浮卡片")
                .setOngoing(true)
                .setContentIntent(buildContentIntent())
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private PendingIntent buildContentIntent() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, 0, i, flags);
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "AI Agent", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("AI Agent 任务执行时的状态卡片 + 通知");
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
    }

    private void showOverlay(Intent initial) {
        if (windowManager == null) return;
        mainHandler.post(() -> {
            if (rootView != null) return; // 已经在显示
            inflateView();
            applyLayoutParams();
            try {
                windowManager.addView(rootView, layoutParams);
            } catch (Throwable t) {
                Log.e(TAG, "addView 失败（可能未授 SYSTEM_ALERT_WINDOW）: " + t.getMessage());
                stopSelf();
                return;
            }
            applyContent(initial);
        });
    }

    private void hideOverlay() {
        mainHandler.post(() -> {
            if (rootView != null && windowManager != null) {
                try { windowManager.removeView(rootView); } catch (Throwable ignored) {}
                rootView = null;
            }
        });
    }

    private void updateContent(Intent intent) {
        mainHandler.post(() -> applyContent(intent));
    }

    private void applyContent(Intent intent) {
        if (intent == null) return;
        String phase = intent.getStringExtra(EXTRA_PHASE);
        String tool = intent.getStringExtra(EXTRA_TOOL);
        String summary = intent.getStringExtra(EXTRA_SUMMARY);
        int steps = intent.getIntExtra(EXTRA_STEPS, 0);
        boolean wantExpanded = intent.getBooleanExtra(EXTRA_EXPANDED, expanded);
        if (phaseView != null) phaseView.setText("阶段：" + (phase == null || phase.isEmpty() ? "—" : phase));
        if (toolView != null) toolView.setText("工具：" + (tool == null || tool.isEmpty() ? "—" : tool));
        if (stepsView != null) stepsView.setText("已走 " + steps + " 步");
        if (summaryView != null && summary != null) summaryView.setText(summary);
        if (headerView != null) {
            String emoji = phaseEmoji(phase);
            headerView.setText(emoji + " AI Agent " + (steps > 0 ? "· " + steps + " 步" : ""));
        }
        setExpanded(wantExpanded);
    }

    private static String phaseEmoji(String phase) {
        if (phase == null) return "◌";
        if (phase.contains("planner") || phase.contains("规划")) return "◌";
        if (phase.contains("executor") || phase.contains("执行")) return "⚡";
        if (phase.contains("reflector") || phase.contains("反思")) return "◐";
        if (phase.contains("finish") || phase.contains("完成")) return "✓";
        if (phase.contains("stop") || phase.contains("停止")) return "⏹";
        if (phase.contains("match")) return "✺";
        return "·";
    }

    private void setExpanded(boolean e) {
        expanded = e;
        if (expandedContainer != null) {
            expandedContainer.setVisibility(e ? View.VISIBLE : View.GONE);
        }
        if (collapseButton != null) {
            collapseButton.setImageResource(e ? android.R.drawable.arrow_up_float : android.R.drawable.arrow_down_float);
        }
    }

    private void applyLayoutParams() {
        int type;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
        } else {
            type = WindowManager.LayoutParams.TYPE_PHONE;
        }
        int width = (int) (getResources().getDisplayMetrics().widthPixels * 0.34);
        int height = WindowManager.LayoutParams.WRAP_CONTENT;
        layoutParams = new WindowManager.LayoutParams(
                width, height, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        layoutParams.gravity = Gravity.TOP | Gravity.END;
        layoutParams.x = 16;
        layoutParams.y = (int) (getResources().getDisplayMetrics().heightPixels * 0.30);
    }

    private void inflateView() {
        LayoutInflater inflater = LayoutInflater.from(this);
        rootView = inflater.inflate(R.layout.overlay_card, null);
        // 简单阴影：Android 9+ 用 elevation
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            rootView.setElevation(dp(8));
        }

        headerView = rootView.findViewById(R.id.overlay_header);
        phaseView = rootView.findViewById(R.id.overlay_phase);
        toolView = rootView.findViewById(R.id.overlay_tool);
        stepsView = rootView.findViewById(R.id.overlay_steps);
        summaryView = rootView.findViewById(R.id.overlay_summary);
        expandedContainer = rootView.findViewById(R.id.overlay_expanded);
        stopButton = rootView.findViewById(R.id.overlay_stop);
        collapseButton = rootView.findViewById(R.id.overlay_collapse);

        // 折叠/停止按钮
        collapseButton.setOnClickListener(v -> setExpanded(!expanded));
        stopButton.setOnClickListener(v -> {
            // 通过 ACTION_STOP 让本服务发广播 + 停服
            Intent stopI = new Intent(this, OverlayService.class);
            stopI.setAction(ACTION_STOP);
            startService(stopI);
        });

        // 拖动 + 点击空白处折叠
        rootView.setOnTouchListener((v, ev) -> {
            switch (ev.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    initialX = layoutParams.x;
                    initialY = layoutParams.y;
                    touchStartX = ev.getRawX();
                    touchStartY = ev.getRawY();
                    return true;
                case MotionEvent.ACTION_MOVE:
                    int dx = (int) (ev.getRawX() - touchStartX);
                    int dy = (int) (ev.getRawY() - touchStartY);
                    layoutParams.x = initialX - dx;
                    layoutParams.y = initialY - dy;
                    try { windowManager.updateViewLayout(rootView, layoutParams); } catch (Throwable ignored) {}
                    return true;
                case MotionEvent.ACTION_UP:
                    // 拖动距离 < 8dp 视为点击（点空白处折叠）
                    if (Math.abs(ev.getRawX() - touchStartX) < dp(8)
                            && Math.abs(ev.getRawY() - touchStartY) < dp(8)) {
                        setExpanded(!expanded);
                    }
                    return true;
            }
            return false;
        });
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    private void broadcastUserStop() {
        try {
            Intent i = new Intent(ACTION_USER_STOP);
            sendBroadcast(i);
        } catch (Throwable t) {
            Log.w(TAG, "broadcastUserStop 失败: " + t.getMessage());
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (rootView != null && windowManager != null) {
            try { windowManager.removeView(rootView); } catch (Throwable ignored) {}
        }
        rootView = null;
        INSTANCE.set(null);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
