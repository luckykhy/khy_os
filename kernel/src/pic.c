/* pic.c — 8259 PIC initialization and control for KHY OS * @pattern Adapter
 */

#include "pic.h"

static inline void outb(uint16_t port, uint8_t val) {
    __asm__ volatile("outb %0, %1" : : "a"(val), "Nd"(port));
}

static inline uint8_t inb(uint16_t port) {
    uint8_t ret;
    __asm__ volatile("inb %1, %0" : "=a"(ret) : "Nd"(port));
    return ret;
}

static inline void io_wait(void) {
    outb(0x80, 0); /* Write to unused port for I/O delay */
}

void pic_init(void) {
    /* Save masks */
    uint8_t mask1 = inb(PIC1_DATA);
    uint8_t mask2 = inb(PIC2_DATA);

    /* ICW1: Begin initialization sequence (cascade mode, ICW4 needed) */
    outb(PIC1_CMD, 0x11);
    io_wait();
    outb(PIC2_CMD, 0x11);
    io_wait();

    /* ICW2: Set vector offsets */
    outb(PIC1_DATA, IRQ_OFFSET);       /* Master PIC: IRQ 0-7  → vectors 32-39 */
    io_wait();
    outb(PIC2_DATA, IRQ_OFFSET + 8);   /* Slave PIC:  IRQ 8-15 → vectors 40-47 */
    io_wait();

    /* ICW3: Configure cascading */
    outb(PIC1_DATA, 0x04);  /* Master: slave on IRQ2 */
    io_wait();
    outb(PIC2_DATA, 0x02);  /* Slave: cascade identity = 2 */
    io_wait();

    /* ICW4: 8086 mode */
    outb(PIC1_DATA, 0x01);
    io_wait();
    outb(PIC2_DATA, 0x01);
    io_wait();

    /* Restore saved masks (mask all by default) */
    outb(PIC1_DATA, mask1);
    outb(PIC2_DATA, mask2);
}

void pic_send_eoi(uint8_t irq) {
    if (irq >= 8)
        outb(PIC2_CMD, PIC_EOI);
    outb(PIC1_CMD, PIC_EOI);
}

void pic_mask_irq(uint8_t irq) {
    uint16_t port;
    if (irq < 8) {
        port = PIC1_DATA;
    } else {
        port = PIC2_DATA;
        irq -= 8;
    }
    uint8_t val = inb(port) | (1 << irq);
    outb(port, val);
}

void pic_unmask_irq(uint8_t irq) {
    uint16_t port;
    if (irq < 8) {
        port = PIC1_DATA;
    } else {
        port = PIC2_DATA;
        irq -= 8;
    }
    uint8_t val = inb(port) & ~(1 << irq);
    outb(port, val);
}
