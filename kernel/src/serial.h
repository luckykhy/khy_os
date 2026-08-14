/* serial.h — COM1 serial port driver * @pattern Strategy
 */
#ifndef SERIAL_H
#define SERIAL_H

#include <stdint.h>

#define SERIAL_COM1 0x3F8
#define SERIAL_COM2 0x2F8

void serial_init(void);
void serial_putchar(char c);
void serial_print(const char *s);
void serial_print_hex(uint64_t val);
void serial_print_dec(uint64_t val);
int  serial_has_data(void);
int  serial_getchar_nonblock(char *out);

/* COM2 — the agent control channel (Agent ⇄ OS bridge, stage A1).
 *
 * COM1 is the human TTY: serial_print() drives all kernel output and
 * serial_getchar_nonblock() is the console's keyboard fallback. To carry the
 * agent frame protocol without fighting the shell for bytes, the bridge runs on
 * a physically separate UART, COM2. These are raw byte primitives (no '\n'→CRLF
 * translation, no hex/dec helpers): the channel is binary, not a text console.
 * serial_com2_putchar() bounds its transmit poll exactly like serial_putchar()
 * so an absent or wedged COM2 can never hang the kernel. */
void serial_com2_init(void);
void serial_com2_putchar(char c);
int  serial_com2_has_data(void);
int  serial_com2_getchar_nonblock(char *out);

#endif
