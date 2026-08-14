/* mouse.h — PS/2 mouse driver (IRQ12) * @pattern Strategy
 *
 * Mirrors keyboard.h: an IRQ handler is the sole producer into a ring buffer,
 * a desktop task the sole consumer. Motion is reported as signed relative
 * deltas plus a button bitmask (bit0=left, bit1=right, bit2=middle), matching
 * the PS/2 packet and the QEMU `mouse_button` state the host injects.
 */
#ifndef MOUSE_H
#define MOUSE_H

#include <stdint.h>

/* One decoded pointer event: relative motion since the previous event plus the
 * current button state. dy is already flipped to screen orientation (down = +). */
struct mouse_event {
    int     dx;
    int     dy;
    uint8_t buttons; /* bit0=left, bit1=right, bit2=middle */
};

/* Initialize the aux (mouse) device on the i8042 controller: enable the aux
 * port, turn on packet reporting, and reset ring/decoder state. Safe to call
 * once at boot after the PIC is configured. */
void mouse_init(void);

/* IRQ12 handler (registered via irq_register_handler). Reads one byte from the
 * PS/2 data port, assembles 3-byte packets, and enqueues a mouse_event per
 * completed packet. */
void mouse_handler(void);

/* Non-blocking read of one decoded pointer event. Returns 1 and fills *out when
 * an event is available, or 0 when the buffer is empty. Mirrors
 * keyboard_getchar_nonblock(). */
int mouse_poll(struct mouse_event *out);

#endif
