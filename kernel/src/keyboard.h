/* keyboard.h — PS/2 keyboard driver (IRQ1) * @pattern Strategy
 */
#ifndef KEYBOARD_H
#define KEYBOARD_H

#include <stdint.h>

/* Initialize keyboard driver state (input ring + modifier flags). */
void keyboard_init(void);

/* IRQ1 handler (registered via irq_register_handler). Reads one scancode
 * from the PS/2 data port, translates it, and enqueues any resulting ASCII. */
void keyboard_handler(void);

/* Non-blocking read of one decoded character. Returns 1 and writes *out when
 * a character is available, or 0 when the input buffer is empty. Mirrors the
 * serial_getchar_nonblock() convention. */
int keyboard_getchar_nonblock(char *out);

#endif
