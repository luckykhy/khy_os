package com.khyos.khy_os_client

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * KhyAccessibilityService — AI assistant's "fingers".
 *
 * Capabilities:
 *   - tap(x, y) / swipe(x1,y1,x2,y2)
 *   - find UI elements by text/id/class
 *   - findAndClick / findAndLongClick
 *   - global actions: HOME / BACK / NOTIFICATIONS / RECENTS
 *   - dump UI tree for VLM decision making
 *   - typeText into focused input
 *   - listClickable elements
 */
class KhyAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "KhyAccessibility"
        @Volatile
        var instance: KhyAccessibilityService? = null
            private set

        fun isReady(): Boolean = instance != null
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "KhyAccessibilityService connected")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        super.onDestroy()
        instance = null
    }

    // --- Gesture dispatch ---

    fun tap(x: Int, y: Int): Boolean = dispatchGesture(x, y, x, y, 50)

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean =
        dispatchGesture(x1, y1, x2, y2, maxOf(50, durationMs))

    private fun dispatchGesture(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean {
        val svc = instance ?: return false
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val desc = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.toLong()))
            .build()

        val latch = CountDownLatch(1)
        val result = booleanArrayOf(false)

        val cb = object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription) {
                result[0] = true
                latch.countDown()
            }
            override fun onCancelled(gestureDescription: GestureDescription) {
                result[0] = false
                latch.countDown()
            }
        }

        svc.dispatchGesture(desc, cb, mainHandler)
        latch.await(2, TimeUnit.SECONDS)
        return result[0]
    }

    // --- Global actions ---

    fun performGlobal(action: Int): Boolean {
        val svc = instance ?: return false
        return try { svc.performGlobalAction(action) } catch (_: Throwable) { false }
    }

    // --- Find elements ---

    fun find(query: String): AccessibilityNodeInfo? {
        val svc = instance ?: return null
        val root = svc.rootInActiveWindow ?: return null
        if (query.isEmpty()) return root

        val q = query.trim()
        return when {
            q.startsWith("text=") -> findByText(root, q.removePrefix("text="))
            q.startsWith("id=") -> findById(root, q.removePrefix("id="))
            q.startsWith("class=") -> findByClass(root, q.removePrefix("class="))
            else -> findByText(root, q)
        }
    }

    private fun findByText(root: AccessibilityNodeInfo, text: String): AccessibilityNodeInfo? {
        for (n in root.findAccessibilityNodeInfosByText(text)) {
            if (n != null) return n
        }
        return null
    }

    private fun findById(root: AccessibilityNodeInfo, id: String): AccessibilityNodeInfo? {
        return try {
            root.findAccessibilityNodeInfosByViewId(id)?.firstOrNull()
        } catch (_: Throwable) { null }
    }

    private fun findByClass(root: AccessibilityNodeInfo, className: String): AccessibilityNodeInfo? {
        return walk(root) { it.className?.toString() == className }
    }

    private fun walk(node: AccessibilityNodeInfo?, pred: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (node == null) return null
        if (pred(node)) return node
        for (i in 0 until node.childCount) {
            val r = walk(node.getChild(i), pred)
            if (r != null) return r
        }
        return null
    }

    // --- Find + action ---

    fun findAndClick(query: String): Boolean {
        val n = find(query) ?: return false
        if (n.isClickable) return n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        var parent = n.parent
        while (parent != null) {
            if (parent.isClickable) return parent.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            parent = parent.parent
        }
        return false
    }

    fun findAndLongClick(query: String): Boolean {
        val n = find(query) ?: return false
        if (n.isLongClickable) return n.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)
        return false
    }

    fun findCenterBounds(query: String): IntArray? {
        val n = find(query) ?: return null
        var target = n
        if (!n.isClickable) {
            var p = n.parent
            var hops = 0
            while (p != null && hops < 4) {
                if (p.isClickable) { target = p; break }
                p = p.parent
                hops++
            }
        }
        val r = android.graphics.Rect()
        target.getBoundsInScreen(r)
        if (r.isEmpty) return null
        return intArrayOf(r.centerX(), r.centerY(), r.width(), r.height())
    }

    // --- UI dump ---

    fun dumpUi(): String {
        val svc = instance ?: return ""
        val root = svc.rootInActiveWindow ?: return ""
        val sb = StringBuilder()
        walkDump(root, sb, 0, 6)
        return sb.toString()
    }

    private fun walkDump(n: AccessibilityNodeInfo, sb: StringBuilder, depth: Int, maxDepth: Int) {
        if (depth > maxDepth) return
        val text = n.text?.toString() ?: ""
        val desc = n.contentDescription?.toString() ?: ""
        val id = n.viewIdResourceName ?: ""
        val cls = n.className?.toString()?.let { shortClass(it) } ?: ""

        if (text.isNotEmpty() || desc.isNotEmpty() || id.isNotEmpty()) {
            sb.append("  ".repeat(depth))
            if (text.isNotEmpty()) sb.append("text=\"$text\" ")
            if (desc.isNotEmpty()) sb.append("desc=\"$desc\" ")
            if (id.isNotEmpty()) sb.append("id=$id ")
            if (cls.isNotEmpty()) sb.append("class=$cls")
            sb.append("\n")
        }
        for (i in 0 until n.childCount) {
            walkDump(n.getChild(i), sb, depth + 1, maxDepth)
        }
    }

    private fun shortClass(c: String): String {
        val dot = c.lastIndexOf('.')
        return if (dot >= 0) c.substring(dot + 1) else c
    }

    // --- List clickable ---

    fun listClickable(): List<Array<String>> {
        val out = mutableListOf<Array<String>>()
        val svc = instance ?: return out
        val root = svc.rootInActiveWindow ?: return out
        walkClickable(root, out, 0, 8)
        return out
    }

    private fun walkClickable(n: AccessibilityNodeInfo, out: MutableList<Array<String>>, depth: Int, maxDepth: Int) {
        if (depth > maxDepth) return
        if (n.isClickable) {
            val text = n.text?.toString() ?: ""
            val desc = n.contentDescription?.toString() ?: ""
            val cls = n.className?.toString()?.let { shortClass(it) } ?: ""
            val label = if (text.isNotEmpty()) text else desc
            val r = android.graphics.Rect()
            n.getBoundsInScreen(r)
            if (!r.isEmpty) {
                out.add(arrayOf(label, cls, n.isClickable.toString(),
                    r.centerX().toString(), r.centerY().toString(),
                    r.width().toString(), r.height().toString()))
            }
        }
        for (i in 0 until n.childCount) {
            walkClickable(n.getChild(i), out, depth + 1, maxDepth)
        }
    }

    // --- Type text ---

    fun typeText(text: String): Boolean {
        val svc = instance ?: return false
        val root = svc.rootInActiveWindow ?: return false
        var focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused == null) {
            focused = walk(root) { it.className?.toString() == "android.widget.EditText" }
        }
        focused ?: return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
}
