/* gdt.h — Global Descriptor Table with user-mode segments and TSS
 *
 * GDT layout:
 *   0x00  Null
 *   0x08  Kernel Code (Ring 0, 64-bit)
 *   0x10  Kernel Data (Ring 0)
 *   0x18  User Code   (Ring 3, 64-bit)
 *   0x20  User Data   (Ring 3)
 *   0x28  TSS         (16 bytes, spans 0x28-0x37)
 *
 * Selectors with RPL:
 *   Kernel CS = 0x08, Kernel DS = 0x10
 *   User CS   = 0x1B (0x18 | RPL=3), User DS = 0x23 (0x20 | RPL=3)
 * @pattern Strategy
 */
#ifndef GDT_H
#define GDT_H

#include <stdint.h>

#define GDT_KERNEL_CS  0x08
#define GDT_KERNEL_DS  0x10
#define GDT_USER_CS    0x18   /* selector: 0x1B with RPL=3 */
#define GDT_USER_DS    0x20   /* selector: 0x23 with RPL=3 */
#define GDT_TSS_SEL    0x28

/* Initialize GDT with kernel+user segments and TSS, then load via lgdt + ltr */
void gdt_init(void);

/* Update TSS.rsp0 — called on every context switch to a user-mode task */
void gdt_set_kernel_stack(uint64_t rsp0);

#endif
