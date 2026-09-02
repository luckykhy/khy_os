package com.khyos.companion;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Path;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * KhyAccessibilityService —— AI 助手的"手指"。
 *
 * 启用后可以做：
 *   - 模拟点击（x, y）：dispatchGesture(tap)
 *   - 模拟滑动 (x1,y1)→(x2,y2)：dispatchGesture(swipe)
 *   - 找 UI 元素（按 viewId / text / className）并 click/longClick
 *   - 全局动作：HOME / BACK / NOTIFICATIONS / RECENTS
 *   - 拿到当前 UI 树（树形文本，供 VLM 决策）
 *
 * 用户授权一次后永久有效。AI 调工具的所有"动手"操作都走这里。
 */
public class KhyAccessibilityService extends AccessibilityService {

    private static final String TAG = "KhyAccessibility";
    public static volatile KhyAccessibilityService INSTANCE;

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        INSTANCE = this;
        Log.i(TAG, "KhyAccessibilityService 已连接");
    }

    @Override
    public boolean onUnbind(Intent intent) {
        INSTANCE = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onInterrupt() {
        // 系统在中断时回调。无状态需要清理。
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        INSTANCE = null;
    }

    public static boolean isReady() { return INSTANCE != null; }

    /** 模拟点击。返回是否派发成功（gesture 已被系统接受，不一定等于 UI 真的被点了）。 */
    public boolean tap(int x, int y) {
        return dispatchGesture(x, y, x, y, 50);
    }

    /** 模拟滑动。durationMs 默认 200，太短会被某些 App 判为 fling。 */
    public boolean swipe(int x1, int y1, int x2, int y2, int durationMs) {
        return dispatchGesture(x1, y1, x2, y2, Math.max(50, durationMs));
    }

    private boolean dispatchGesture(int x1, int y1, int x2, int y2, int durationMs) {
        if (INSTANCE == null) return false;
        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
        GestureDescription desc = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, durationMs))
                .build();
        CountDownLatch latch = new CountDownLatch(1);
        boolean[] result = { false };
        try {
            // dispatchGesture 必须在主线程；callback 通过 Handler 切回主线程。
            Handler handler = new Handler(Looper.getMainLooper());
            AccessibilityService.GestureResultCallback cb = new AccessibilityService.GestureResultCallback() {
                @Override public void onCompleted(GestureDescription g) { result[0] = true; latch.countDown(); }
                @Override public void onCancelled(GestureDescription g) { result[0] = false; latch.countDown(); }
            };
            INSTANCE.dispatchGesture(desc, cb, handler);
            latch.await(2, TimeUnit.SECONDS);
        } catch (Throwable t) {
            Log.e(TAG, "dispatchGesture 失败: " + t.getMessage());
            return false;
        }
        return result[0];
    }

    /** 全局动作：HOME / BACK / RECENTS / NOTIFICATIONS */
    public boolean performGlobal(int action) {
        if (INSTANCE == null) return false;
        try { return INSTANCE.performGlobalAction(action); }
        catch (Throwable t) { return false; }
    }

    /** 找 UI 元素。query: text=xxx / id=xxx / class=xxx，前面加前缀决定匹配方式。 */
    public AccessibilityNodeInfo find(String query) {
        if (INSTANCE == null) return null;
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return null;
        if (query == null || query.isEmpty()) return root;
        String q = query.trim();
        if (q.startsWith("text=")) return findByText(root, q.substring(5));
        if (q.startsWith("id=")) return findById(root, q.substring(3));
        if (q.startsWith("class=")) return findByClass(root, q.substring(6));
        // 默认按 text 找
        return findByText(root, q);
    }

    private AccessibilityNodeInfo findByText(AccessibilityNodeInfo root, String text) {
        if (root == null) return null;
        for (AccessibilityNodeInfo n : root.findAccessibilityNodeInfosByText(text)) {
            if (n != null) return n;
        }
        return null;
    }

    private AccessibilityNodeInfo findById(AccessibilityNodeInfo root, String id) {
        if (root == null) return null;
        if (Build.VERSION.SDK_INT < 18) return null;
        try {
            // Android 11+ 推荐用 BySelector 包 ID
            if (Build.VERSION.SDK_INT >= 30) {
                AccessibilityNodeInfo n = findByIdRec(root, id);
                if (n != null) return n;
            }
            List<AccessibilityNodeInfo> list = root.findAccessibilityNodeInfosByViewId(id);
            if (list != null && !list.isEmpty()) return list.get(0);
        } catch (Throwable ignored) {}
        return null;
    }

    private AccessibilityNodeInfo findByIdRec(AccessibilityNodeInfo node, String id) {
        if (node == null) return null;
        String vid = node.getViewIdResourceName();
        if (id.equals(vid)) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo r = findByIdRec(node.getChild(i), id);
            if (r != null) return r;
        }
        return null;
    }

    private AccessibilityNodeInfo findByClass(AccessibilityNodeInfo root, String className) {
        if (root == null) return null;
        return walk(root, (n) -> className.equals(n.getClassName()));
    }

    /** 树形遍历：拿到所有文本和 viewId，用于 VLM 决策。 */
    public String dumpUi() {
        if (INSTANCE == null) return "";
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return "";
        StringBuilder sb = new StringBuilder();
        walkDump(root, sb, 0, 6);
        return sb.toString();
    }

    private void walkDump(AccessibilityNodeInfo n, StringBuilder sb, int depth, int maxDepth) {
        if (n == null || depth > maxDepth) return;
        String text = n.getText() != null ? n.getText().toString() : "";
        String desc = n.getContentDescription() != null ? n.getContentDescription().toString() : "";
        String id = n.getViewIdResourceName() != null ? n.getViewIdResourceName() : "";
        String cls = n.getClassName() != null ? shortClass(n.getClassName().toString()) : "";
        if (!text.isEmpty() || !desc.isEmpty() || !id.isEmpty()) {
            for (int i = 0; i < depth; i++) sb.append("  ");
            if (!text.isEmpty()) sb.append("text=\"").append(text).append("\" ");
            if (!desc.isEmpty()) sb.append("desc=\"").append(desc).append("\" ");
            if (!id.isEmpty()) sb.append("id=").append(id).append(" ");
            if (!cls.isEmpty()) sb.append("class=").append(cls);
            sb.append("\n");
        }
        for (int i = 0; i < n.getChildCount(); i++) {
            walkDump(n.getChild(i), sb, depth + 1, maxDepth);
        }
    }

    private static String shortClass(String c) {
        int dot = c.lastIndexOf('.');
        return dot >= 0 ? c.substring(dot + 1) : c;
    }

    private AccessibilityNodeInfo walk(AccessibilityNodeInfo node, java.util.function.Predicate<AccessibilityNodeInfo> pred) {
        if (node == null) return null;
        if (pred.test(node)) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo r = walk(node.getChild(i), pred);
            if (r != null) return r;
        }
        return null;
    }

    /** 找 + 点击。失败返回 false（含节点没找到、节点不可点击、click 被拒）。 */
    public boolean findAndClick(String query) {
        AccessibilityNodeInfo n = find(query);
        if (n == null) return false;
        // 尝试节点 click action
        if (n.isClickable()) {
            return n.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        }
        // 不可点击 → 找其父节点
        AccessibilityNodeInfo parent = n.getParent();
        while (parent != null) {
            if (parent.isClickable()) return parent.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            parent = parent.getParent();
        }
        return false;
    }

    /** 找 + 长按。 */
    public boolean findAndLongClick(String query) {
        AccessibilityNodeInfo n = find(query);
        if (n == null) return false;
        if (n.isLongClickable()) return n.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK);
        return false;
    }

    /**
     * 找节点 + 返回屏幕坐标（center 模式）。用于 Agent "先 find 元素 → 拿坐标 → 坐标 tap" 的混合模式。
     * 返回 null 表示未找到。
     */
    public int[] findCenterBounds(String query) {
        AccessibilityNodeInfo n = find(query);
        if (n == null) return null;
        // 节点自己若不可点击，沿父链找一个可点击的（视觉边界更接近用户点击位置）
        AccessibilityNodeInfo target = n;
        if (!n.isClickable()) {
            AccessibilityNodeInfo p = n.getParent();
            int hops = 0;
            while (p != null && hops < 4) {
                if (p.isClickable()) { target = p; break; }
                p = p.getParent();
                hops++;
            }
        }
        android.graphics.Rect r = new android.graphics.Rect();
        target.getBoundsInScreen(r);
        if (r.isEmpty()) return null;
        int cx = r.centerX();
        int cy = r.centerY();
        return new int[]{ cx, cy, r.width(), r.height() };
    }

    /**
     * 列出当前 UI 树中所有可点击节点（text + bounds + class + clickable）。
     * 供 Agent "我能点哪几个" 决策用。
     * 返回 List<List<String>> 序列化为 JSON：每条 [text, cls, clickable, x, y, w, h]
     */
    public java.util.List<String[]> listClickable() {
        java.util.List<String[]> out = new java.util.ArrayList<>();
        if (INSTANCE == null) return out;
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return out;
        walkClickable(root, out, 0, 8);
        return out;
    }

    private void walkClickable(AccessibilityNodeInfo n, java.util.List<String[]> out, int depth, int maxDepth) {
        if (n == null || depth > maxDepth) return;
        if (n.isClickable()) {
            String text = n.getText() != null ? n.getText().toString() : "";
            String desc = n.getContentDescription() != null ? n.getContentDescription().toString() : "";
            String cls = n.getClassName() != null ? shortClass(n.getClassName().toString()) : "";
            String label = !text.isEmpty() ? text : desc;
            android.graphics.Rect r = new android.graphics.Rect();
            n.getBoundsInScreen(r);
            if (r.isEmpty()) return;
            out.add(new String[]{
                    label, cls, String.valueOf(n.isClickable()),
                    String.valueOf(r.centerX()), String.valueOf(r.centerY()),
                    String.valueOf(r.width()), String.valueOf(r.height())
            });
        }
        for (int i = 0; i < n.getChildCount(); i++) {
            walkClickable(n.getChild(i), out, depth + 1, maxDepth);
        }
    }

    /** 在当前焦点的输入框里塞文字。需要先 click 到输入框。 */
    public boolean typeText(String text) {
        if (INSTANCE == null) return false;
        AccessibilityNodeInfo root = INSTANCE.getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focused == null) {
            // 退路：找第一个 EditText
            focused = walk(root, (n) -> "android.widget.EditText".equals(n.getClassName()));
        }
        if (focused == null) return false;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // 不存事件历史（无障碍服务不应该偷偷记录用户操作历史）
        // 监听只是为了保持 root 引用活跃
    }
}
