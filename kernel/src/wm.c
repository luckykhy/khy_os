/* wm.c — Simple window manager for KHY OS hybrid kernel
 *
 * Minimal compositing window manager with title bars, borders,
 * Z-ordering, and keyboard focus management. Runs as a kernel
 * task and exposes window operations via IPC_PORT_VGA.
 * @pattern Mediator
 */

#include "wm.h"
#include "framebuffer.h"
#include "ipc.h"
#include "sched.h"
#include "serial.h"
#include "string.h"
#include "rtc.h"

/* ── State ───────────────────────────────────────────────────── */

static struct wm_window windows[WM_MAX_WINDOWS];
static int next_z_order;
static wm_handle_t focused_window;
static int wm_ready;

/* ── Chrome rendering helpers ────────────────────────────────── */

/* Soft drop shadow: two translucent black bands offset down-right. The window
 * is painted on top afterward, so only the offset fringe remains visible. */
static void _draw_shadow(int x, int y, int w, int h) {
    fb_fill_rect_alpha(x + 6, y + 6, w, h, WM_COLOR_SHADOW, 45);
    fb_fill_rect_alpha(x + 3, y + 3, w, h, WM_COLOR_SHADOW, 70);
}

/* Format the wall clock as "HH:MM" in China time (UTC+8) into buf[6]. */
static void _format_clock(char buf[6]) {
    uint64_t t = rtc_unix_time() + (uint64_t)8 * 3600; /* UTC -> UTC+8 */
    uint32_t sod = (uint32_t)(t % 86400u);
    int hh = (int)(sod / 3600u);
    int mm = (int)((sod % 3600u) / 60u);
    buf[0] = (char)('0' + (hh / 10) % 10);
    buf[1] = (char)('0' + hh % 10);
    buf[2] = ':';
    buf[3] = (char)('0' + (mm / 10) % 10);
    buf[4] = (char)('0' + mm % 10);
    buf[5] = '\0';
}

/* Draw the bottom taskbar: gradient strip, top highlight, start button on the
 * left, and the clock on the right. Window buttons are added by wm_compose. */
static void _draw_taskbar(const struct fb_info *info) {
    int bar_y = (int)info->height - WM_TASKBAR_HEIGHT;
    int bar_w = (int)info->width;

    fb_fill_vgradient(0, bar_y, bar_w, WM_TASKBAR_HEIGHT,
                      WM_COLOR_TASKBAR_TOP, WM_COLOR_TASKBAR_BOTTOM);
    fb_hline(0, bar_y, bar_w, WM_COLOR_TASKBAR_HILITE);

    /* Start button "开始" with a subtle raised gradient. */
    int sb_w = 56, sb_h = WM_TASKBAR_HEIGHT - 6;
    int sb_x = 4, sb_y = bar_y + 3;
    fb_fill_vgradient(sb_x, sb_y, sb_w, sb_h, WM_COLOR_TITLE_TOP, WM_COLOR_TITLE_BOTTOM);
    fb_draw_rect(sb_x, sb_y, sb_w, sb_h, WM_COLOR_ACCENT);
    fb_draw_utf8(sb_x + 10, sb_y + (sb_h - FB_CJK_HEIGHT) / 2 + 1,
                 "开始", 0xFFFFFF, FB_TRANSPARENT);

    /* Clock on the right edge. */
    char clk[6];
    _format_clock(clk);
    int clk_w = fb_utf8_width(clk);
    fb_draw_utf8(bar_w - clk_w - 10, bar_y + (WM_TASKBAR_HEIGHT - FB_FONT_HEIGHT) / 2,
                 clk, WM_COLOR_ACCENT, FB_TRANSPARENT);
}

/* ── Helpers ─────────────────────────────────────────────────── */

static void _copy_title(char dst[WM_TITLE_MAX], const char *src) {
    int i = 0;
    if (src) {
        while (src[i] && i + 1 < WM_TITLE_MAX) {
            dst[i] = src[i];
            i++;
        }
    }
    dst[i] = '\0';
}

static void _update_content_area(struct wm_window *w) {
    if (w->flags & WM_FLAG_DECORATED) {
        w->content_x = w->x + WM_BORDER_WIDTH;
        w->content_y = w->y + WM_TITLE_HEIGHT;
        w->content_w = w->w - 2 * WM_BORDER_WIDTH;
        w->content_h = w->h - WM_TITLE_HEIGHT - WM_BORDER_WIDTH;
    } else {
        w->content_x = w->x;
        w->content_y = w->y;
        w->content_w = w->w;
        w->content_h = w->h;
    }
    if (w->content_w < 0) w->content_w = 0;
    if (w->content_h < 0) w->content_h = 0;
}

/* ── Public API ──────────────────────────────────────────────── */

void wm_init(void) {
    memset(windows, 0, sizeof(windows));
    next_z_order = 1;
    focused_window = -1;
    wm_ready = 0;

    if (!fb_is_available()) {
        serial_print("[WM] No framebuffer — window manager disabled\n");
        return;
    }

    wm_ready = 1;

    /* Draw desktop background as a vertical gradient. */
    const struct fb_info *info = fb_get_info();
    fb_fill_vgradient(0, 0, (int)info->width, (int)info->height,
                      WM_COLOR_DESKTOP_TOP, WM_COLOR_DESKTOP_BOTTOM);

    /* Draw the taskbar (gradient strip, start button, clock). */
    _draw_taskbar(info);

    serial_print("[WM] Window manager initialized (");
    serial_print_dec(WM_MAX_WINDOWS);
    serial_print(" max windows)\n");
}

wm_handle_t wm_create_window(const char *title, int x, int y, int w, int h,
                              uint32_t flags) {
    if (!wm_ready)
        return -1;

    /* Find free slot */
    int slot = -1;
    for (int i = 0; i < WM_MAX_WINDOWS; i++) {
        if (!windows[i].used) {
            slot = i;
            break;
        }
    }
    if (slot < 0)
        return -1;

    struct wm_window *win = &windows[slot];
    memset(win, 0, sizeof(*win));
    win->used = 1;
    win->x = x;
    win->y = y;
    win->w = w;
    win->h = h;
    win->flags = flags | WM_FLAG_VISIBLE;
    win->bg_color = WM_COLOR_CONTENT_BG;
    win->title_bg = WM_COLOR_TITLE_BG;
    win->title_fg = WM_COLOR_TITLE_FG;
    win->z_order = next_z_order++;
    win->owner_task = sched_current_id();
    _copy_title(win->title, title);
    _update_content_area(win);

    /* Draw the window */
    wm_redraw_window(slot);

    /* Set focus */
    wm_focus_window(slot);

    serial_print("[WM] Created window '");
    serial_print(win->title);
    serial_print("' (");
    serial_print_dec(w);
    serial_print("x");
    serial_print_dec(h);
    serial_print(")\n");

    return slot;
}

void wm_destroy_window(wm_handle_t win) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used)
        return;

    windows[win].used = 0;

    if (focused_window == win)
        focused_window = -1;

    /* Recompose desktop to remove the window */
    wm_compose();
}

void wm_move_window(wm_handle_t win, int x, int y) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used)
        return;

    windows[win].x = x;
    windows[win].y = y;
    _update_content_area(&windows[win]);
    wm_compose();
}

void wm_resize_window(wm_handle_t win, int w, int h) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used)
        return;

    windows[win].w = w;
    windows[win].h = h;
    _update_content_area(&windows[win]);
    wm_compose();
}

void wm_set_title(wm_handle_t win, const char *title) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used)
        return;

    _copy_title(windows[win].title, title);
    wm_redraw_window(win);
}

void wm_focus_window(wm_handle_t win) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used)
        return;

    /* Remove focus from old window */
    if (focused_window >= 0 && focused_window < WM_MAX_WINDOWS &&
        windows[focused_window].used) {
        windows[focused_window].flags &= ~WM_FLAG_FOCUSED;
        windows[focused_window].title_bg = WM_COLOR_TITLE_INACTIVE;
    }

    /* Set focus on new window */
    windows[win].flags |= WM_FLAG_FOCUSED;
    windows[win].title_bg = WM_COLOR_TITLE_BG;
    windows[win].z_order = next_z_order++;
    focused_window = win;

    wm_compose();
}

wm_handle_t wm_get_focused(void) {
    return focused_window;
}

const struct wm_window *wm_get_window(wm_handle_t win) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used)
        return 0;
    return &windows[win];
}

/* ── Hit testing (read-only; drives pointer focus + drag) ────────
 * Find the topmost (highest z_order) visible window whose full extent
 * (decoration included) contains the screen point (sx, sy). Returns -1 when
 * the point lands on bare desktop. Read-only: touches no window state. */
wm_handle_t wm_window_at(int sx, int sy) {
    wm_handle_t best = -1;
    int best_z = -1;
    for (int i = 0; i < WM_MAX_WINDOWS; i++) {
        const struct wm_window *w = &windows[i];
        if (!w->used || !(w->flags & WM_FLAG_VISIBLE))
            continue;
        if (sx < w->x || sx >= w->x + w->w || sy < w->y || sy >= w->y + w->h)
            continue;
        if (w->z_order > best_z) {
            best_z = w->z_order;
            best = i;
        }
    }
    return best;
}

/* True when the screen point falls in a decorated window's title bar (the
 * grab region for dragging). Read-only. */
int wm_point_in_titlebar(wm_handle_t win, int sx, int sy) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used)
        return 0;
    const struct wm_window *w = &windows[win];
    if (!(w->flags & WM_FLAG_DECORATED))
        return 0;
    return sx >= w->x && sx < w->x + w->w &&
           sy >= w->y && sy < w->y + WM_TITLE_HEIGHT;
}

/* ── Drawing into Windows ────────────────────────────────────── */

void wm_fill_content(wm_handle_t win, uint32_t color) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used)
        return;
    const struct wm_window *w = &windows[win];
    fb_fill_rect(w->content_x, w->content_y, w->content_w, w->content_h, color);
}

void wm_draw_text(wm_handle_t win, int x, int y, const char *text,
                  uint32_t fg, uint32_t bg) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used || !text)
        return;
    const struct wm_window *w = &windows[win];
    fb_draw_string(w->content_x + x, w->content_y + y, text, fg, bg);
}

void wm_draw_utf8(wm_handle_t win, int x, int y, const char *text,
                  uint32_t fg, uint32_t bg) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used || !text)
        return;
    const struct wm_window *w = &windows[win];
    fb_draw_utf8(w->content_x + x, w->content_y + y, text, fg, bg);
}

void wm_draw_pixel(wm_handle_t win, int x, int y, uint32_t color) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used)
        return;
    const struct wm_window *w = &windows[win];
    fb_putpixel(w->content_x + x, w->content_y + y, color);
}

void wm_draw_rect(wm_handle_t win, int x, int y, int w, int h, uint32_t color) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used)
        return;
    const struct wm_window *wp = &windows[win];
    fb_fill_rect(wp->content_x + x, wp->content_y + y, w, h, color);
}

/* ── Compositing ─────────────────────────────────────────────── */

void wm_redraw_window(wm_handle_t win) {
    if (win < 0 || win >= WM_MAX_WINDOWS || !windows[win].used || !wm_ready)
        return;

    const struct wm_window *w = &windows[win];
    if (!(w->flags & WM_FLAG_VISIBLE))
        return;

    if (w->flags & WM_FLAG_DECORATED) {
        int focused = (w->flags & WM_FLAG_FOCUSED) != 0;

        /* Soft drop shadow beneath the window. */
        _draw_shadow(w->x, w->y, w->w, w->h);

        /* Border */
        fb_draw_rect(w->x, w->y, w->w, w->h, WM_COLOR_BORDER);

        /* Title bar: vertical gradient (active vs inactive). */
        uint32_t t_top = focused ? WM_COLOR_TITLE_TOP : WM_COLOR_TITLE_INACT_TOP;
        uint32_t t_bot = focused ? WM_COLOR_TITLE_BOTTOM : WM_COLOR_TITLE_INACT_BOT;
        fb_fill_vgradient(w->x + 1, w->y + 1, w->w - 2, WM_TITLE_HEIGHT - 1, t_top, t_bot);

        /* Title text (centered vertically, blended over the gradient). */
        int text_y = w->y + (WM_TITLE_HEIGHT - FB_CJK_HEIGHT) / 2;
        fb_draw_utf8(w->x + 8, text_y, w->title, w->title_fg, FB_TRANSPARENT);

        /* Close button: a rounded-feel red chip with an 'x'. */
        int cb = 13;
        int close_x = w->x + w->w - cb - 5;
        int close_y = w->y + (WM_TITLE_HEIGHT - cb) / 2;
        fb_fill_vgradient(close_x, close_y, cb, cb, 0xE05A4A, 0xC42B1C);
        fb_putpixel(close_x, close_y, t_top);                       /* clip corners */
        fb_putpixel(close_x + cb - 1, close_y, t_top);
        fb_putpixel(close_x, close_y + cb - 1, t_top);
        fb_putpixel(close_x + cb - 1, close_y + cb - 1, t_top);
        fb_draw_char(close_x + 3, close_y - 2, 'x', 0xFFFFFF, FB_TRANSPARENT);

        /* Title bar separator line. */
        fb_hline(w->x + 1, w->y + WM_TITLE_HEIGHT - 1, w->w - 2, WM_COLOR_BORDER);
    }

    /* Content area background */
    fb_fill_rect(w->content_x, w->content_y, w->content_w, w->content_h, w->bg_color);
}

void wm_paint_taskbar(void) {
    if (!wm_ready)
        return;

    const struct fb_info *info = fb_get_info();
    int bar_y = (int)info->height - WM_TASKBAR_HEIGHT;

    /* Taskbar (gradient strip, start button, clock) */
    _draw_taskbar(info);

    /* Draw taskbar window buttons */
    int btn_x = 68;
    int btn_h = WM_TASKBAR_HEIGHT - 6;
    for (int i = 0; i < WM_MAX_WINDOWS; i++) {
        if (!windows[i].used || !(windows[i].flags & WM_FLAG_VISIBLE))
            continue;
        int active = (i == focused_window);
        uint32_t b_top = active ? WM_COLOR_TITLE_TOP : 0x3A3A52;
        uint32_t b_bot = active ? WM_COLOR_TITLE_BOTTOM : 0x2A2A40;
        fb_fill_vgradient(btn_x, bar_y + 3, 92, btn_h, b_top, b_bot);
        if (active)
            fb_hline(btn_x, bar_y + 3, 92, WM_COLOR_ACCENT);
        fb_draw_utf8(btn_x + 5, bar_y + (WM_TASKBAR_HEIGHT - FB_CJK_HEIGHT) / 2 + 1,
                     windows[i].title, 0xFFFFFF, FB_TRANSPARENT);
        btn_x += 96;
    }
}

void wm_compose(void) {
    if (!wm_ready)
        return;

    /* Redraw desktop gradient */
    const struct fb_info *info = fb_get_info();
    fb_fill_vgradient(0, 0, (int)info->width, (int)info->height,
                      WM_COLOR_DESKTOP_TOP, WM_COLOR_DESKTOP_BOTTOM);

    /* Taskbar + window buttons */
    wm_paint_taskbar();

    /* Sort windows by z_order and draw (painter's algorithm) */
    /* Simple insertion-sort of indices by z_order */
    int order[WM_MAX_WINDOWS];
    int count = 0;
    for (int i = 0; i < WM_MAX_WINDOWS; i++) {
        if (windows[i].used && (windows[i].flags & WM_FLAG_VISIBLE)) {
            order[count++] = i;
        }
    }

    /* Sort by z_order (ascending = back to front) */
    for (int i = 1; i < count; i++) {
        int key = order[i];
        int j = i - 1;
        while (j >= 0 && windows[order[j]].z_order > windows[key].z_order) {
            order[j + 1] = order[j];
            j--;
        }
        order[j + 1] = key;
    }

    /* Draw windows back to front */
    for (int i = 0; i < count; i++) {
        wm_redraw_window(order[i]);
    }
}

/* ── IPC Service ─────────────────────────────────────────────── */

/* WM IPC operation codes */
#define WM_OP_CREATE    1
#define WM_OP_DESTROY   2
#define WM_OP_MOVE      3
#define WM_OP_RESIZE    4
#define WM_OP_FOCUS     5
#define WM_OP_DRAW_TEXT 6
#define WM_OP_FILL      7
#define WM_OP_COMPOSE   8

void wm_service_task(void) {
    int rc = ipc_port_register(IPC_PORT_VGA);
    if (rc != IPC_OK) {
        serial_print("[WM-SVC] ERROR: Failed to register port\n");
        for (;;) yield();
    }

    serial_print("[WM-SVC] Window manager service running on port ");
    serial_print_dec(IPC_PORT_VGA);
    serial_print("\n");

    for (;;) {
        struct ipc_message req;
        rc = ipc_recv(IPC_PORT_VGA, &req, 0);
        if (rc != IPC_OK) {
            yield();
            continue;
        }

        struct ipc_message reply;
        memset(&reply, 0, sizeof(reply));
        reply.sender_pid  = (uint16_t)sched_current_id();
        reply.sender_port = IPC_PORT_VGA;
        reply.type        = IPC_MSG_REPLY;
        reply.seq         = req.seq;

        uint8_t op = req.payload[0];
        switch (op) {
        case WM_OP_CREATE: {
            /* payload[1..2]=x, [3..4]=y, [5..6]=w, [7..8]=h, [9..]=title */
            int x = (int16_t)(req.payload[1] | (req.payload[2] << 8));
            int y = (int16_t)(req.payload[3] | (req.payload[4] << 8));
            int w = (int16_t)(req.payload[5] | (req.payload[6] << 8));
            int h = (int16_t)(req.payload[7] | (req.payload[8] << 8));
            char title[16];
            memcpy(title, &req.payload[9], 15);
            title[15] = '\0';
            wm_handle_t wh = wm_create_window(title, x, y, w, h,
                WM_FLAG_DECORATED | WM_FLAG_MOVABLE);
            reply.payload[0] = (wh >= 0) ? 0 : (uint8_t)-1;
            reply.payload[1] = (uint8_t)wh;
            reply.payload_len = 2;
            break;
        }
        case WM_OP_DESTROY:
            wm_destroy_window(req.payload[1]);
            reply.payload[0] = 0;
            reply.payload_len = 1;
            break;
        case WM_OP_FOCUS:
            wm_focus_window(req.payload[1]);
            reply.payload[0] = 0;
            reply.payload_len = 1;
            break;
        case WM_OP_COMPOSE:
            wm_compose();
            reply.payload[0] = 0;
            reply.payload_len = 1;
            break;
        default:
            reply.type = IPC_MSG_ERROR;
            reply.payload[0] = (uint8_t)-1;
            reply.payload_len = 1;
            break;
        }

        if (req.sender_port > 0) {
            ipc_send(req.sender_port, &reply);
        }
    }
}
