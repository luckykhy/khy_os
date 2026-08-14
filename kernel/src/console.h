/* console.h — Unified TTY for KHY OS * @pattern Facade
 *
 * Aggregates the input sources (PS/2 keyboard and COM1 serial) and the output
 * sinks (VGA text mode and COM1 serial) behind one interface, so the shell
 * works identically on bare metal (monitor + keyboard) and over a serial line.
 */
#ifndef CONSOLE_H
#define CONSOLE_H

#include <stdint.h>

void console_putchar(char c);
void console_print(const char *s);
void console_print_hex(uint64_t val);
void console_print_dec(uint64_t val);

/* Non-blocking read: tries the keyboard first, then the serial port. Returns
 * 1 and writes *out when a character is available, otherwise 0. */
int console_getchar_nonblock(char *out);

#endif
