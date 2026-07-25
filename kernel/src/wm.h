/* wm.h — Simple window manager for KHY OS
 *
 * Provides basic windowing: create/destroy/move/resize windows,
 * draw title bars, manage Z-order, and route keyboard focus.
 * Designed to be lightweight (~400 lines implementation).
 * @pattern Strategy
 */
#ifndef WM_H
#define WM_H

#include <stdint.h>

#define WM_MAX_WINDOWS   16
#define WM_TITLE_MAX     32
#define WM_TITLE_HEIGHT  20
#define WM_BORDER_WIDTH  1

/* Window flags */
#define WM_FLAG_VISIBLE     (1 << 0)
#define WM_FLAG_FOCUSED     (1 << 1)
#define WM_FLAG_MOVABLE     (1 << 2)
#define WM_FLAG_DECORATED   (1 << 3)  /* Has title bar and border */

/* Window handle (ID) */
typedef int wm_handle_t;

/* Window descriptor */
struct wm_window {
    int       used;
    int       x, y;             /* Position (top-left, including decoration) */
    int       w, h;             /* Size (including decoration) */
    int       content_x, content_y; /* Content area position */
    int       content_w, content_h; /* Content area size */
    uint32_t  flags;
    uint32_t  bg_color;         /* Content background color */
    uint32_t  title_bg;         /* Title bar color */
    uint32_t  title_fg;         /* Title text color */
    int       z_order;          /* Higher = on top */
    char      title[WM_TITLE_MAX];
    int       owner_task;       /* Task that owns this window */
};

/* ── Theme Colors ────────────────────────────────────────────── */

#define WM_COLOR_DESKTOP     0x1E3A5F  /* Dark blue desktop (legacy flat) */
#define WM_COLOR_TITLE_BG    0x2B579A  /* Active title bar */
#define WM_COLOR_TITLE_FG    0xFFFFFF  /* Title text */
#define WM_COLOR_TITLE_INACTIVE 0x555555
#define WM_COLOR_BORDER      0x333333
#define WM_COLOR_CONTENT_BG  0x1A1A2E  /* Dark content background */

/* Gradient endpoints for the beautified desktop (top → bottom). */
#define WM_COLOR_DESKTOP_TOP     0x0F2027  /* deep teal-blue */
#define WM_COLOR_DESKTOP_BOTTOM  0x203A53  /* lighter slate-blue */

/* Active / inactive title-bar gradients. */
#define WM_COLOR_TITLE_TOP       0x4A82C4
#define WM_COLOR_TITLE_BOTTOM    0x2B579A
#define WM_COLOR_TITLE_INACT_TOP 0x606060
#define WM_COLOR_TITLE_INACT_BOT 0x434343

/* Taskbar gradient + accents. */
#define WM_COLOR_TASKBAR_TOP     0x2A2A46
#define WM_COLOR_TASKBAR_BOTTOM  0x141426
#define WM_COLOR_TASKBAR_HILITE  0x4A4A6A  /* 1px top highlight */
#define WM_COLOR_ACCENT          0x64B4FF  /* bright accent blue */
#define WM_COLOR_SHADOW          0x000000  /* drop-shadow ink (blended) */

/* Taskbar height (px) — a touch taller for the clock + start button. */
#define WM_TASKBAR_HEIGHT  26

/* ── Public API ──────────────────────────────────────────────── */

/* Initialize the window manager (requires framebuffer to be init'd first) */
void wm_init(void);

/* Create a window. Returns handle or -1 on failure. */
wm_handle_t wm_create_window(const char *title, int x, int y, int w, int h,
                              uint32_t flags);

/* Destroy a window */
void wm_destroy_window(wm_handle_t win);

/* Move a window to a new position */
void wm_move_window(wm_handle_t win, int x, int y);

/* Resize a window */
void wm_resize_window(wm_handle_t win, int w, int h);

/* Set window title */
void wm_set_title(wm_handle_t win, const char *title);

/* Bring a window to the front (set focus) */
void wm_focus_window(wm_handle_t win);

/* Get the currently focused window */
wm_handle_t wm_get_focused(void);

/* Get window info */
const struct wm_window *wm_get_window(wm_handle_t win);

/* ── Hit testing (read-only) ─────────────────────────────────── */

/* Topmost visible window whose extent contains the screen point, or -1 for
 * bare desktop. Read-only — used by the desktop input router to pick a click
 * target without mutating window state. */
wm_handle_t wm_window_at(int sx, int sy);

/* Non-zero when (sx, sy) lands in the given decorated window's title bar
 * (the drag-grab region). Read-only. */
int wm_point_in_titlebar(wm_handle_t win, int sx, int sy);

/* ── Drawing into Windows ────────────────────────────────────── */

/* Fill the content area of a window with a color */
void wm_fill_content(wm_handle_t win, uint32_t color);

/* Draw text into a window's content area (relative coordinates) */
void wm_draw_text(wm_handle_t win, int x, int y, const char *text,
                  uint32_t fg, uint32_t bg);

/* Draw UTF-8 text (ASCII + CJK) into a window's content area (relative coords). */
void wm_draw_utf8(wm_handle_t win, int x, int y, const char *text,
                  uint32_t fg, uint32_t bg);

/* Draw a pixel in a window's content area (relative coordinates) */
void wm_draw_pixel(wm_handle_t win, int x, int y, uint32_t color);

/* Draw a filled rectangle in a window's content area */
void wm_draw_rect(wm_handle_t win, int x, int y, int w, int h, uint32_t color);

/* ── Compositing ─────────────────────────────────────────────── */

/* Redraw the entire desktop (desktop background + all visible windows) */
void wm_compose(void);

/* Redraw a single window (title bar + border + content) */
void wm_redraw_window(wm_handle_t win);

/* Repaint just the bottom taskbar (gradient strip, start button, live clock,
 * window buttons) without recompositing the whole desktop — lets a live monitor
 * tick the clock cheaply and flicker-free. */
void wm_paint_taskbar(void);

/* Window manager service task (IPC event loop on IPC_PORT_VGA) */
void wm_service_task(void);

#endif
