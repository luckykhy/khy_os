/* serial.c — COM1 serial port driver for KHY OS * @pattern Adapter
 */

#include "serial.h"

static inline void outb(uint16_t port, uint8_t val) {
    __asm__ volatile("outb %0, %1" : : "a"(val), "Nd"(port));
}

static inline uint8_t inb(uint16_t port) {
    uint8_t ret;
    __asm__ volatile("inb %1, %0" : "=a"(ret) : "Nd"(port));
    return ret;
}

/* Configure one 16550 UART at `base` for 38400 8N1 with FIFO enabled. Both COM1
 * (human TTY) and COM2 (agent channel) use identical line settings; only the
 * base I/O port differs. */
static void serial_init_port(uint16_t base) {
    outb(base + 1, 0x00); /* Disable all interrupts */
    outb(base + 3, 0x80); /* Enable DLAB (set baud rate divisor) */
    outb(base + 0, 0x03); /* Set divisor to 3 (38400 baud) lo byte */
    outb(base + 1, 0x00); /*                                hi byte */
    outb(base + 3, 0x03); /* 8 bits, no parity, one stop bit */
    outb(base + 2, 0xC7); /* Enable FIFO, clear, 14-byte threshold */
    outb(base + 4, 0x0B); /* IRQs enabled, RTS/DSR set */
}

void serial_init(void) {
    serial_init_port(SERIAL_COM1);
}

static int port_tx_empty(uint16_t base) {
    return inb(base + 5) & 0x20;
}

static int port_has_data(uint16_t base) {
    return inb(base + 5) & 0x01;
}

/* Upper bound on the transmit-ready poll. A wedged or absent UART must never
 * be able to wedge the whole kernel. */
#define SERIAL_TX_POLL_LIMIT 1000000u

/* [SAFE] Bounded transmit. The original `while (!tx_empty()) ;` is an unbounded
 * spin: if the UART is absent, or its Line Status Register never asserts the
 * transmit-holding-empty bit (faulty/emulated-without-serial hardware), the loop
 * never returns and the entire kernel hangs — a single wedged peripheral freezing
 * the whole system. Bound the poll and, on timeout, drop the byte (graceful
 * degradation) rather than block forever. Mirrors the ATA driver's ATA_POLL_LIMIT
 * pattern. Shared by COM1 (serial_print) and COM2 (agent channel). */
static void port_putchar(uint16_t base, uint8_t b) {
    uint32_t spins = 0;
    while (!port_tx_empty(base)) {
        if (++spins >= SERIAL_TX_POLL_LIMIT)
            return; /* give up on this byte; never wedge the kernel */
    }
    outb(base, b);
}

int serial_has_data(void) {
    return port_has_data(SERIAL_COM1);
}

void serial_putchar(char c) {
    port_putchar(SERIAL_COM1, (uint8_t)c);
}

void serial_print(const char *s) {
    while (*s) {
        if (*s == '\n')
            serial_putchar('\r');
        serial_putchar(*s);
        s++;
    }
}

void serial_print_hex(uint64_t val) {
    static const char hex[] = "0123456789ABCDEF";
    serial_print("0x");
    for (int i = 60; i >= 0; i -= 4) {
        serial_putchar(hex[(val >> i) & 0xF]);
    }
}

void serial_print_dec(uint64_t val) {
    if (val == 0) {
        serial_putchar('0');
        return;
    }
    char buf[21];
    int i = 0;
    while (val > 0) {
        buf[i++] = '0' + (val % 10);
        val /= 10;
    }
    while (--i >= 0)
        serial_putchar(buf[i]);
}

int serial_getchar_nonblock(char *out) {
    if (!out)
        return 0;
    if (!serial_has_data())
        return 0;
    *out = (char)inb(SERIAL_COM1);
    return 1;
}

/* ── COM2: agent control channel (raw binary, no text translation) ───────── */

void serial_com2_init(void) {
    serial_init_port(SERIAL_COM2);
}

void serial_com2_putchar(char c) {
    port_putchar(SERIAL_COM2, (uint8_t)c);
}

int serial_com2_has_data(void) {
    return port_has_data(SERIAL_COM2);
}

int serial_com2_getchar_nonblock(char *out) {
    if (!out)
        return 0;
    if (!port_has_data(SERIAL_COM2))
        return 0;
    *out = (char)inb(SERIAL_COM2);
    return 1;
}
