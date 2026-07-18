/* vga.c — VGA text mode driver for KHY OS * @pattern Adapter
 */

#include "vga.h"

#define VGA_BUFFER  ((volatile uint16_t *)0xB8000)
#define VGA_WIDTH   80
#define VGA_HEIGHT  25

static int vga_row;
static int vga_col;
static uint8_t vga_attr;

static inline uint16_t vga_entry(char c, uint8_t attr) {
    return (uint16_t)c | ((uint16_t)attr << 8);
}

static inline uint8_t make_color(enum vga_color fg, enum vga_color bg) {
    return (uint8_t)fg | ((uint8_t)bg << 4);
}

void vga_init(void) {
    vga_row = 0;
    vga_col = 0;
    vga_attr = make_color(VGA_LIGHT_GREEN, VGA_BLACK);
    vga_clear();
}

void vga_clear(void) {
    uint16_t blank = vga_entry(' ', vga_attr);
    for (int i = 0; i < VGA_WIDTH * VGA_HEIGHT; i++) {
        VGA_BUFFER[i] = blank;
    }
    vga_row = 0;
    vga_col = 0;
}

void vga_set_color(enum vga_color fg, enum vga_color bg) {
    vga_attr = make_color(fg, bg);
}

static void vga_scroll(void) {
    /* Move all lines up by one */
    for (int i = 0; i < (VGA_HEIGHT - 1) * VGA_WIDTH; i++) {
        VGA_BUFFER[i] = VGA_BUFFER[i + VGA_WIDTH];
    }
    /* Clear last line */
    uint16_t blank = vga_entry(' ', vga_attr);
    for (int i = (VGA_HEIGHT - 1) * VGA_WIDTH; i < VGA_HEIGHT * VGA_WIDTH; i++) {
        VGA_BUFFER[i] = blank;
    }
    vga_row = VGA_HEIGHT - 1;
}

void vga_putchar(char c) {
    if (c == '\n') {
        vga_col = 0;
        vga_row++;
    } else if (c == '\r') {
        vga_col = 0;
    } else if (c == '\t') {
        vga_col = (vga_col + 8) & ~7;
    } else if (c == '\b') {
        /* Backspace: move the cursor back one column. The shell erases with
         * "\b \b", so the following space overwrites the glyph and the second
         * backspace repositions the cursor. */
        if (vga_col > 0)
            vga_col--;
    } else {
        VGA_BUFFER[vga_row * VGA_WIDTH + vga_col] = vga_entry(c, vga_attr);
        vga_col++;
    }

    if (vga_col >= VGA_WIDTH) {
        vga_col = 0;
        vga_row++;
    }

    if (vga_row >= VGA_HEIGHT) {
        vga_scroll();
    }
}

void vga_print(const char *s) {
    while (*s) {
        vga_putchar(*s);
        s++;
    }
}
