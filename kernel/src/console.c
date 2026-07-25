/* console.c — Unified TTY implementation for KHY OS * @pattern Facade
 *
 * Output is mirrored to both VGA text mode and the serial port so command
 * results are visible on a physical monitor and on a serial terminal alike.
 * Input is drawn from the keyboard first, then serial.
 */

#include "console.h"
#include "vga.h"
#include "serial.h"
#include "keyboard.h"

void console_putchar(char c) {
    vga_putchar(c);
    serial_putchar(c);
}

void console_print(const char *s) {
    vga_print(s);
    serial_print(s);
}

void console_print_hex(uint64_t val) {
    static const char hex[] = "0123456789ABCDEF";
    console_print("0x");
    for (int i = 60; i >= 0; i -= 4)
        console_putchar(hex[(val >> i) & 0xF]);
}

void console_print_dec(uint64_t val) {
    if (val == 0) {
        console_putchar('0');
        return;
    }
    char buf[21];
    int i = 0;
    while (val > 0) {
        buf[i++] = (char)('0' + (val % 10));
        val /= 10;
    }
    while (--i >= 0)
        console_putchar(buf[i]);
}

int console_getchar_nonblock(char *out) {
    if (keyboard_getchar_nonblock(out))
        return 1;
    return serial_getchar_nonblock(out);
}
