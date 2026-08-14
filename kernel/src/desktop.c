/* desktop.c — Live system-monitor desktop for KHY OS
 *
 * The graphical desktop must reflect *real* system state, not static text. This
 * module owns the desktop's windows and a background task that repaints them
 * once per second from live kernel sources:
 *   - memory:   pmm_total_memory() / pmm_free_memory()
 *   - processes: process_list() (live process table + states)
 *   - IPC ports: ipc_port_owner() scan over the port table
 *   - uptime:   timer_get_ticks() / TIMER_HZ
 * @pattern Observer
 */

#include "desktop.h"
#include "wm.h"
#include "framebuffer.h"
#include "pmm.h"
#include "timer.h"
#include "process.h"
#include "ipc.h"
#include "sched.h"
#include "string.h"
#include "keyboard.h"
#include "mouse.h"

/* ── Window handles (owned by this module) ───────────────────── */

static wm_handle_t term_win    = -1;
static wm_handle_t sysinfo_win = -1;
static wm_handle_t proc_win    = -1;

/* Scratch process table for the monitor task (avoid a large stack frame). */
static struct process_info proc_buf[PROCESS_MAX];

/* ── Small formatting helpers (no libc in the kernel) ────────── */

/* Unsigned -> decimal string. Returns the number of characters written. */
static int _utoa(uint64_t v, char *buf) {
    char tmp[24];
    int n = 0;
    if (v == 0)
        tmp[n++] = '0';
    while (v > 0) {
        tmp[n++] = (char)('0' + (int)(v % 10));
        v /= 10;
    }
    for (int i = 0; i < n; i++)
        buf[i] = tmp[n - 1 - i];
    buf[n] = '\0';
    return n;
}

/* Append a C string to dst at offset `off`; returns the new offset. */
static int _puts(char *dst, int off, const char *src) {
    while (*src)
        dst[off++] = *src++;
    dst[off] = '\0';
    return off;
}

/* Append an unsigned number to dst at offset `off`; returns the new offset. */
static int _putu(char *dst, int off, uint64_t v) {
    off += _utoa(v, dst + off);
    return off;
}

/* ── Live data sources ───────────────────────────────────────── */

static int _ipc_active_ports(void) {
    int n = 0;
    for (int p = 0; p < IPC_MAX_PORTS; p++) {
        if (ipc_port_owner((uint16_t)p) >= 0)
            n++;
    }
    return n;
}

/* ── Panel painters ──────────────────────────────────────────── */

#define DESK_FG       0xFFFFFF
#define DESK_FG_DIM   0xB4B4C8
#define DESK_FG_OK    0x64FF96
#define DESK_FG_ACC   0x64B4FF
#define DESK_LINE_H   22

static void _paint_sysinfo(void) {
    if (sysinfo_win < 0)
        return;
    wm_fill_content(sysinfo_win, WM_COLOR_CONTENT_BG);

    uint64_t total_mb = pmm_total_memory() >> 20;
    uint64_t free_mb  = pmm_free_memory()  >> 20;
    uint64_t used_mb  = (total_mb >= free_mb) ? (total_mb - free_mb) : 0;
    uint64_t total_b  = pmm_total_memory();
    uint64_t used_pct = total_b ? ((pmm_total_memory() - pmm_free_memory()) * 100u) / total_b : 0;

    size_t nproc = process_list(proc_buf, PROCESS_MAX);
    int nports   = _ipc_active_ports();
    uint64_t secs = timer_get_ticks() / TIMER_HZ;

    char buf[96];
    int y = 8;

    wm_draw_utf8(sysinfo_win, 8, y, "架构：x86_64", DESK_FG, WM_COLOR_CONTENT_BG);
    y += DESK_LINE_H;

    int o = _puts(buf, 0, "内存：");
    o = _putu(buf, o, used_mb);
    o = _puts(buf, o, " / ");
    o = _putu(buf, o, total_mb);
    o = _puts(buf, o, " MB");
    wm_draw_utf8(sysinfo_win, 8, y, buf, DESK_FG, WM_COLOR_CONTENT_BG);
    y += DESK_LINE_H;

    o = _puts(buf, 0, "已用：");
    o = _putu(buf, o, used_pct);
    o = _puts(buf, o, "%");
    wm_draw_utf8(sysinfo_win, 8, y, buf,
                 (used_pct >= 90) ? 0xFF6464 : DESK_FG_DIM, WM_COLOR_CONTENT_BG);
    y += DESK_LINE_H;

    o = _puts(buf, 0, "进程：");
    o = _putu(buf, o, (uint64_t)nproc);
    o = _puts(buf, o, " / ");
    o = _putu(buf, o, (uint64_t)PROCESS_MAX);
    wm_draw_utf8(sysinfo_win, 8, y, buf, DESK_FG, WM_COLOR_CONTENT_BG);
    y += DESK_LINE_H;

    o = _puts(buf, 0, "端口：");
    o = _putu(buf, o, (uint64_t)nports);
    o = _puts(buf, o, " / ");
    o = _putu(buf, o, (uint64_t)IPC_MAX_PORTS);
    wm_draw_utf8(sysinfo_win, 8, y, buf, DESK_FG, WM_COLOR_CONTENT_BG);
    y += DESK_LINE_H;

    o = _puts(buf, 0, "运行：");
    o = _putu(buf, o, secs);
    o = _puts(buf, o, " 秒");
    wm_draw_utf8(sysinfo_win, 8, y, buf, DESK_FG_OK, WM_COLOR_CONTENT_BG);
}

static void _paint_proclist(void) {
    if (proc_win < 0)
        return;
    wm_fill_content(proc_win, WM_COLOR_CONTENT_BG);

    size_t n = process_list(proc_buf, PROCESS_MAX);
    int y = 8;
    wm_draw_utf8(proc_win, 8, y, "进程列表", DESK_FG_ACC, WM_COLOR_CONTENT_BG);
    y += DESK_LINE_H;

    /* Cap visible rows to the content height (~11 rows fit in this panel). */
    size_t max_rows = 11;
    for (size_t i = 0; i < n && i < max_rows; i++) {
        char buf[80];
        int o = _putu(buf, 0, (uint64_t)proc_buf[i].pid);
        o = _puts(buf, o, " ");
        o = _puts(buf, o, proc_buf[i].name);
        /* pad to a column so the state lines up loosely */
        while (o < 22)
            buf[o++] = ' ';
        buf[o] = '\0';
        o = _puts(buf, o, process_state_string(proc_buf[i].state));
        uint32_t fg = (proc_buf[i].state == PROCESS_ZOMBIE) ? 0xFF6464
                    : (proc_buf[i].state == PROCESS_RUNNING) ? DESK_FG_OK
                    : DESK_FG_DIM;
        wm_draw_utf8(proc_win, 8, y, buf, fg, WM_COLOR_CONTENT_BG);
        y += FB_CJK_HEIGHT + 2;
    }
}

/* ── Public API ──────────────────────────────────────────────── */

void desktop_start(const char *version) {
    if (!fb_is_available())
        return;

    /* Create all windows first, then draw content: each wm_create_window
     * triggers a wm_compose() that clears every content area, so content drawn
     * before the last compose would be wiped. */
    term_win = wm_create_window("终端", 50, 30, 400, 300,
                                WM_FLAG_DECORATED | WM_FLAG_MOVABLE);
    sysinfo_win = wm_create_window("系统信息", 480, 50, 300, 210,
                                   WM_FLAG_DECORATED | WM_FLAG_MOVABLE);
    proc_win = wm_create_window("进程", 480, 290, 300, 300,
                                WM_FLAG_DECORATED | WM_FLAG_MOVABLE);

    if (term_win >= 0) {
        char buf[64];
        int o = _puts(buf, 0, "KHY 混合内核 v");
        _puts(buf, o, version ? version : "?");
        wm_draw_utf8(term_win, 8, 8, buf, DESK_FG_OK, WM_COLOR_CONTENT_BG);
        wm_draw_utf8(term_win, 8, 30, "图形桌面已就绪", DESK_FG_DIM, WM_COLOR_CONTENT_BG);
        wm_draw_utf8(term_win, 8, 54, "$> _", 0x00FF00, WM_COLOR_CONTENT_BG);
    }

    /* Initial live snapshot. */
    _paint_sysinfo();
    _paint_proclist();

    /* Spawn the background repaint task so the desktop tracks live state. */
    int tid = sched_create_task(desktop_monitor_task, "desktop-monitor");
    if (tid >= 0)
        process_register_kernel_task("desktop-monitor", tid);

    /* Spawn the input router so the graphical desktop consumes real keyboard +
     * mouse input (typed chars echo into the terminal panel; the pointer drives
     * focus + title-bar drag). This is what a browser viewer drives via QEMU. */
    int itid = sched_create_task(desktop_input_task, "desktop-input");
    if (itid >= 0)
        process_register_kernel_task("desktop-input", itid);
}

void desktop_monitor_task(void) {
    for (;;) {
        _paint_sysinfo();
        _paint_proclist();
        wm_paint_taskbar();          /* tick the clock + refresh window buttons */
        sched_sleep_ticks(TIMER_HZ); /* once per second */
    }
}

/* ── Input router ────────────────────────────────────────────────
 * Polls the keyboard ring + PS/2 mouse ~50x/sec, echoing typed characters into
 * the terminal panel and driving pointer focus / title-bar drag. Accumulates
 * the PS/2-relative cursor position kernel-side (per the interactive-desktop
 * design) and draws its own arrow cursor so a headless framebuffer capture
 * shows the pointer. */

/* Cursor arrow footprint (px) and color. */
#define CURSOR_W      8
#define CURSOR_H      12
#define CURSOR_COLOR  0xF5F5F5
#define CURSOR_EDGE   0x101010

/* Terminal-echo layout inside term_win's content area (below the boot banner). */
#define TERM_ECHO_X   8
#define TERM_ECHO_Y0  78
#define TERM_ECHO_MAX 44   /* chars per echoed line before wrap */

/* Draw a tiny arrow cursor at (cx, cy) as a diagonal of shrinking bars so it
 * reads as a pointer without a bitmap. Clamped by fb_fill_rect itself. */
static void _draw_cursor(int cx, int cy) {
    for (int row = 0; row < CURSOR_H; row++) {
        int width = CURSOR_W - (row * CURSOR_W) / CURSOR_H;
        if (width < 1) width = 1;
        fb_fill_rect(cx, cy + row, width + 1, 1, CURSOR_EDGE); /* 1px dark edge */
        fb_fill_rect(cx, cy + row, width, 1, CURSOR_COLOR);
    }
}

void desktop_input_task(void) {
    const struct fb_info *fb = fb_get_info();
    int scr_w = fb ? (int)fb->width : 1024;
    int scr_h = fb ? (int)fb->height : 768;

    /* Cursor starts centered; kernel-side accumulation of PS/2 relative deltas. */
    int cx = scr_w / 2;
    int cy = scr_h / 2;

    /* Terminal echo cursor + drag state. */
    int echo_col = 0;
    int echo_row = 0;
    uint8_t prev_buttons = 0;
    int dragging = 0;            /* 1 while a title-bar drag is in progress */
    wm_handle_t drag_win = -1;
    int drag_off_x = 0, drag_off_y = 0; /* pointer offset within the window */

    for (;;) {
        /* ── Keyboard → terminal panel ────────────────────────────── */
        char ch;
        while (keyboard_getchar_nonblock(&ch)) {
            if (term_win < 0)
                continue;
            if (ch == '\n' || ch == '\r') {
                echo_col = 0;
                echo_row++;
            } else if (ch == '\b') {
                if (echo_col > 0) echo_col--;
                int px = TERM_ECHO_X + echo_col * FB_FONT_WIDTH;
                int py = TERM_ECHO_Y0 + echo_row * (FB_FONT_HEIGHT + 2);
                wm_draw_text(term_win, px, py, " ", DESK_FG, WM_COLOR_CONTENT_BG);
            } else if (ch >= ' ' && ch < 0x7F) {
                char s[2] = { ch, '\0' };
                int px = TERM_ECHO_X + echo_col * FB_FONT_WIDTH;
                int py = TERM_ECHO_Y0 + echo_row * (FB_FONT_HEIGHT + 2);
                wm_draw_text(term_win, px, py, s, DESK_FG_OK, WM_COLOR_CONTENT_BG);
                echo_col++;
                if (echo_col >= TERM_ECHO_MAX) { echo_col = 0; echo_row++; }
            }
            /* Wrap back to the top of the echo region when it fills. */
            if (echo_row >= 8) { echo_row = 0; echo_col = 0; }
        }

        /* ── Mouse → cursor accumulation + focus/drag ─────────────── */
        struct mouse_event ev;
        while (mouse_poll(&ev)) {
            cx += ev.dx;
            cy += ev.dy;
            if (cx < 0) cx = 0;
            if (cx >= scr_w) cx = scr_w - 1;
            if (cy < 0) cy = 0;
            if (cy >= scr_h) cy = scr_h - 1;

            int left = (ev.buttons & 0x01) != 0;
            int left_was = (prev_buttons & 0x01) != 0;

            if (left && !left_was) {
                /* Press: focus the window under the pointer; if the press is on
                 * its title bar, begin a drag. */
                wm_handle_t hit = wm_window_at(cx, cy);
                if (hit >= 0) {
                    wm_focus_window(hit);
                    if (wm_point_in_titlebar(hit, cx, cy)) {
                        const struct wm_window *w = wm_get_window(hit);
                        if (w) {
                            dragging = 1;
                            drag_win = hit;
                            drag_off_x = cx - w->x;
                            drag_off_y = cy - w->y;
                        }
                    }
                }
            } else if (!left && left_was) {
                dragging = 0;
                drag_win = -1;
            } else if (left && dragging && drag_win >= 0) {
                /* Drag: keep the grab point under the pointer. */
                wm_move_window(drag_win, cx - drag_off_x, cy - drag_off_y);
            }

            prev_buttons = ev.buttons;
        }

        /* Redraw the cursor every pass so it survives the monitor task's
         * ~1/sec wm_compose(); a headless capture then always shows it. */
        _draw_cursor(cx, cy);

        sched_sleep_ticks(2); /* ~50 Hz poll — responsive, cheap */
    }
}
