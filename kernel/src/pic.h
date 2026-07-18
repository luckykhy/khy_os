/* pic.h — 8259 Programmable Interrupt Controller * @pattern Strategy
 */
#ifndef PIC_H
#define PIC_H

#include <stdint.h>

#define PIC1_CMD    0x20
#define PIC1_DATA   0x21
#define PIC2_CMD    0xA0
#define PIC2_DATA   0xA1

#define PIC_EOI     0x20   /* End-of-interrupt command */

#define IRQ_OFFSET  32     /* Remap IRQs to start at vector 32 */

/* Initialize and remap the 8259 PICs */
void pic_init(void);

/* Send End-of-Interrupt signal */
void pic_send_eoi(uint8_t irq);

/* Mask/unmask individual IRQ lines */
void pic_mask_irq(uint8_t irq);
void pic_unmask_irq(uint8_t irq);

#endif
