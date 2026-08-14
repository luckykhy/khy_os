/* idt.h — Interrupt Descriptor Table * @pattern Strategy
 */
#ifndef IDT_H
#define IDT_H

#include <stdint.h>

/* IDT entry (gate descriptor) for x86_64 */
struct idt_entry {
    uint16_t offset_low;    /* Offset bits 0-15 */
    uint16_t selector;      /* Code segment selector in GDT */
    uint8_t  ist;           /* Interrupt Stack Table offset (bits 0-2) */
    uint8_t  type_attr;     /* Gate type + DPL + Present bit */
    uint16_t offset_mid;    /* Offset bits 16-31 */
    uint32_t offset_high;   /* Offset bits 32-63 */
    uint32_t zero;          /* Reserved, must be zero */
} __attribute__((packed));

/* IDT pointer for LIDT instruction */
struct idt_ptr {
    uint16_t limit;
    uint64_t base;
} __attribute__((packed));

/* Gate types */
#define IDT_INTERRUPT_GATE  0x8E  /* Present, DPL=0, 64-bit interrupt gate */
#define IDT_TRAP_GATE       0x8F  /* Present, DPL=0, 64-bit trap gate */
#define IDT_USER_INT_GATE   0xEE  /* Present, DPL=3, 64-bit interrupt gate */

/* Initialize the IDT */
void idt_init(void);

/* Set a single IDT entry */
void idt_set_gate(uint8_t num, uint64_t handler, uint16_t selector, uint8_t type_attr);

/* Interrupt handler type */
struct interrupt_frame {
    uint64_t rip;
    uint64_t cs;
    uint64_t rflags;
    uint64_t rsp;
    uint64_t ss;
};

/* Register a C handler for an IRQ (IRQ 0-15 → vector 32-47) */
typedef void (*irq_handler_t)(void);
void irq_register_handler(uint8_t irq, irq_handler_t handler);

#endif
