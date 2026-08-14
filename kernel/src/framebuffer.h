/* framebuffer.h — Linear framebuffer driver for graphical output
 *
 * Provides pixel-level drawing primitives over the Multiboot2 framebuffer.
 * Includes an embedded 8x16 bitmap font for text rendering.
 * Designed to be lightweight (<1000 lines total with font data).
 * @pattern Strategy
 */
#ifndef FRAMEBUFFER_H
#define FRAMEBUFFER_H

#include <stdint.h>
#include <stddef.h>

/* Framebuffer info (populated from Multiboot2 or manually) */
struct fb_info {
    uint32_t *addr;         /* Linear framebuffer address */
    uint32_t  width;        /* Pixels */
    uint32_t  height;       /* Pixels */
    uint32_t  pitch;        /* Bytes per scanline */
    uint8_t   bpp;          /* Bits per pixel (expect 32) */
    int       available;    /* 1 if framebuffer is usable */
};

/* Initialize framebuffer from Multiboot2 info.
 * If no graphical framebuffer is found, falls back to VGA text mode
 * and sets fb_info.available = 0. */
void fb_init(uint32_t multiboot_info_addr);

/* Get framebuffer info */
const struct fb_info *fb_get_info(void);

/* Check if graphical framebuffer is available */
int fb_is_available(void);

/* ── Drawing Primitives ──────────────────────────────────────── */

/* Pack RGB color */
static inline uint32_t fb_rgb(uint8_t r, uint8_t g, uint8_t b) {
    return ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b;
}

/* Sentinel "background": when passed as the bg color to text rendering, ink is
 * blended over the existing on-screen pixels instead of a solid fill — lets
 * antialiased text sit cleanly over gradients and shadows. Uses bit 24, which
 * is outside the 24-bit RGB range, so it can never collide with a real color. */
#define FB_TRANSPARENT  0x01000000u

/* Set a single pixel */
void fb_putpixel(int x, int y, uint32_t color);

/* Read a single pixel (0 if unavailable/out of bounds) */
uint32_t fb_getpixel(int x, int y);

/* Alpha-composite fg over bg (per-channel, a in [0,255]) */
uint32_t fb_blend(uint32_t fg, uint32_t bg, uint8_t a);

/* Fill a rectangle */
void fb_fill_rect(int x, int y, int w, int h, uint32_t color);

/* Fill a rectangle with a vertical gradient from `top` to `bottom` */
void fb_fill_vgradient(int x, int y, int w, int h, uint32_t top, uint32_t bottom);

/* Blend a color over an existing rectangle at the given alpha (soft shadows) */
void fb_fill_rect_alpha(int x, int y, int w, int h, uint32_t color, uint8_t alpha);

/* Draw a horizontal line */
void fb_hline(int x, int y, int w, uint32_t color);

/* Draw a vertical line */
void fb_vline(int x, int y, int h, uint32_t color);

/* Draw a rectangle outline */
void fb_draw_rect(int x, int y, int w, int h, uint32_t color);

/* Clear entire screen with a color */
void fb_clear(uint32_t color);

/* ── Text Rendering (8x16 bitmap font) ───────────────────────── */

#define FB_FONT_WIDTH   8
#define FB_FONT_HEIGHT  16

/* Draw a single character at pixel position */
void fb_draw_char(int x, int y, char c, uint32_t fg, uint32_t bg);

/* Draw a null-terminated string at pixel position */
void fb_draw_string(int x, int y, const char *s, uint32_t fg, uint32_t bg);

/* Draw string with word wrap within a bounding box */
void fb_draw_text_box(int x, int y, int w, int h, const char *s,
                      uint32_t fg, uint32_t bg);

/* ── UTF-8 / CJK Text Rendering (16x16 CJK font) ─────────────── */

#define FB_CJK_WIDTH   16
#define FB_CJK_HEIGHT  16

/* Draw a UTF-8 string with mixed-width glyphs: ASCII via the 8x16 font
 * (advances 8px), CJK via the embedded 16x16 font (advances 16px). Unknown
 * code points render as a hollow box placeholder. Handles '\n' (resets x,
 * +16 y). Returns the end x pixel position so callers can chain. */
int fb_draw_utf8(int x, int y, const char *s, uint32_t fg, uint32_t bg);

/* Pixel width a UTF-8 string would occupy under fb_draw_utf8 (ignores '\n'). */
int fb_utf8_width(const char *s);

/* Scroll the framebuffer content up by n pixels */
void fb_scroll_up(int n, uint32_t bg_color);

#endif
