/* mouse.c — PS/2 mouse driver for KHY OS * @pattern Adapter
 *
 * Reads the classic 3-byte PS/2 mouse packet from the i8042 aux device on
 * IRQ12, decodes signed relative motion + button state, and pushes one
 * mouse_event into a single-producer/single-consumer ring buffer. The IRQ
 * handler is the sole producer; the desktop input router the sole consumer.
 *
 * Mirrors keyboard.c's Adapter shape (ring buffer + IRQ producer + *_nonblock
 * consumer). The host feeds motion via QEMU HMP `mouse_move`/`mouse_button`
 * against QEMU's default PS/2 mouse, so this driver sees ordinary PS/2 packets.
 */

#include "mouse.h"
#include "pic.h"

/* PS/2 controller I/O ports (shared with the keyboard controller) */
#define PS2_DATA    0x60  /* read: data / write: device command       */
#define PS2_STATUS  0x64  /* read: status register                    */
#define PS2_CMD     0x64  /* write: controller command                */

/* Status register bits */
#define PS2_STATUS_OUTPUT_FULL  0x01  /* output buffer has data to read   */
#define PS2_STATUS_INPUT_FULL   0x02  /* input buffer busy; wait to write */
#define PS2_STATUS_AUX_DATA     0x20  /* byte came from the aux (mouse) port */

/* Controller commands */
#define PS2_CMD_ENABLE_AUX      0xA8  /* enable the second (mouse) PS/2 port */
#define PS2_CMD_READ_CONFIG     0x20  /* read controller configuration byte  */
#define PS2_CMD_WRITE_CONFIG    0x60  /* write controller configuration byte */
#define PS2_CMD_WRITE_AUX       0xD4  /* next data byte is routed to the mouse */

/* Configuration byte bits */
#define PS2_CFG_AUX_IRQ         0x02  /* enable IRQ12 for the aux device      */
#define PS2_CFG_AUX_CLOCK       0x20  /* aux clock (0 = enabled)              */

/* Mouse device commands (written via PS2_CMD_WRITE_AUX) */
#define MOUSE_CMD_ENABLE_REPORT 0xF4  /* enable data reporting (streaming)    */
#define MOUSE_CMD_SET_DEFAULTS  0xF6  /* restore default sampling/resolution  */

/* First packet byte flags */
#define MOUSE_PKT_LEFT     0x01
#define MOUSE_PKT_RIGHT    0x02
#define MOUSE_PKT_MIDDLE   0x04
#define MOUSE_PKT_ALWAYS1  0x08  /* bit 3 is always 1 in a valid byte-0      */
#define MOUSE_PKT_X_SIGN   0x10
#define MOUSE_PKT_Y_SIGN   0x20
#define MOUSE_PKT_X_OVFLOW 0x40
#define MOUSE_PKT_Y_OVFLOW 0x80

/* Event ring buffer. Size must be a power of two for the cheap mask wrap. */
#define MOUSE_BUF_SIZE 64
#define MOUSE_BUF_MASK (MOUSE_BUF_SIZE - 1)

static struct mouse_event mouse_buf[MOUSE_BUF_SIZE];
static volatile uint32_t mouse_head; /* producer (IRQ) write index */
static volatile uint32_t mouse_tail; /* consumer (router) read index */

/* Packet assembly state: PS/2 mouse packets are 3 bytes. `packet_index` counts
 * 0..2; `packet[]` holds the bytes as they arrive. */
static uint8_t packet[3];
static int     packet_index;

static inline uint8_t inb(uint16_t port) {
    uint8_t ret;
    __asm__ volatile("inb %1, %0" : "=a"(ret) : "Nd"(port));
    return ret;
}

static inline void outb(uint16_t port, uint8_t val) {
    __asm__ volatile("outb %0, %1" : : "a"(val), "Nd"(port));
}

/* Spin until the controller's input buffer is clear so a write won't be lost.
 * Bounded so a wedged controller can't hang boot. */
static void ps2_wait_write(void) {
    for (int i = 0; i < 100000; i++) {
        if (!(inb(PS2_STATUS) & PS2_STATUS_INPUT_FULL))
            return;
    }
}

/* Spin until the controller's output buffer has a byte to read. Bounded. */
static void ps2_wait_read(void) {
    for (int i = 0; i < 100000; i++) {
        if (inb(PS2_STATUS) & PS2_STATUS_OUTPUT_FULL)
            return;
    }
}

/* Send one command byte to the mouse (aux) device and consume its ACK (0xFA). */
static void mouse_write(uint8_t value) {
    ps2_wait_write();
    outb(PS2_CMD, PS2_CMD_WRITE_AUX);
    ps2_wait_write();
    outb(PS2_DATA, value);
    /* Device replies 0xFA (ACK); read and discard so it doesn't leak into the
     * first real packet. Bounded read tolerates a mute/absent device. */
    ps2_wait_read();
    (void)inb(PS2_DATA);
}

static void mouse_push(int dx, int dy, uint8_t buttons) {
    uint32_t next = (mouse_head + 1) & MOUSE_BUF_MASK;
    if (next == mouse_tail)
        return; /* buffer full → drop, never block the IRQ */
    mouse_buf[mouse_head].dx = dx;
    mouse_buf[mouse_head].dy = dy;
    mouse_buf[mouse_head].buttons = buttons;
    mouse_head = next;
}

void mouse_init(void) {
    mouse_head = 0;
    mouse_tail = 0;
    packet_index = 0;

    /* Enable the aux (mouse) PS/2 port. */
    ps2_wait_write();
    outb(PS2_CMD, PS2_CMD_ENABLE_AUX);

    /* Read the controller config, enable the aux IRQ + clock, write it back. */
    ps2_wait_write();
    outb(PS2_CMD, PS2_CMD_READ_CONFIG);
    ps2_wait_read();
    uint8_t config = inb(PS2_DATA);
    config |= PS2_CFG_AUX_IRQ;      /* raise IRQ12 on aux data */
    config &= ~PS2_CFG_AUX_CLOCK;   /* clear disable bit → clock enabled */
    ps2_wait_write();
    outb(PS2_CMD, PS2_CMD_WRITE_CONFIG);
    ps2_wait_write();
    outb(PS2_DATA, config);

    /* Restore defaults, then turn on streaming reports (device now IRQs). */
    mouse_write(MOUSE_CMD_SET_DEFAULTS);
    mouse_write(MOUSE_CMD_ENABLE_REPORT);
}

void mouse_handler(void) {
    /* Always drain the data port once — leaving the byte unread wedges the
     * controller and stops further IRQs. */
    uint8_t status = inb(PS2_STATUS);
    if (!(status & PS2_STATUS_OUTPUT_FULL)) {
        pic_send_eoi(12);
        return;
    }
    uint8_t byte = inb(PS2_DATA);

    /* Only bytes flagged as aux data belong to the mouse; anything else is a
     * keyboard byte that arrived on this line — ignore it. */
    if (!(status & PS2_STATUS_AUX_DATA)) {
        pic_send_eoi(12);
        return;
    }

    /* Resync: a valid byte-0 always has bit 3 set. If we're at index 0 and the
     * bit is clear, the stream is misaligned — drop the byte and wait. */
    if (packet_index == 0 && !(byte & MOUSE_PKT_ALWAYS1)) {
        pic_send_eoi(12);
        return;
    }

    packet[packet_index++] = byte;
    if (packet_index < 3) {
        pic_send_eoi(12);
        return;
    }
    packet_index = 0;

    uint8_t flags = packet[0];
    /* Discard packets whose overflow bits are set — the delta is meaningless. */
    if (flags & (MOUSE_PKT_X_OVFLOW | MOUSE_PKT_Y_OVFLOW)) {
        pic_send_eoi(12);
        return;
    }

    /* Sign-extend the 9-bit deltas (byte1/byte2 + sign bit in byte0). */
    int dx = (int)packet[1];
    int dy = (int)packet[2];
    if (flags & MOUSE_PKT_X_SIGN) dx |= ~0xFF; /* extend to negative */
    if (flags & MOUSE_PKT_Y_SIGN) dy |= ~0xFF;

    /* PS/2 reports +Y as up; screens grow +Y downward, so flip. */
    uint8_t buttons = (uint8_t)(flags & (MOUSE_PKT_LEFT | MOUSE_PKT_RIGHT | MOUSE_PKT_MIDDLE));
    mouse_push(dx, -dy, buttons);

    pic_send_eoi(12);
}

int mouse_poll(struct mouse_event *out) {
    if (!out)
        return 0;
    if (mouse_tail == mouse_head)
        return 0; /* empty */
    *out = mouse_buf[mouse_tail];
    mouse_tail = (mouse_tail + 1) & MOUSE_BUF_MASK;
    return 1;
}
