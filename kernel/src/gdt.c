/* gdt.c — GDT with user-mode segments and TSS for KHY OS
 *
 * Replaces the minimal boot-time GDT (3 entries) with a full GDT
 * that includes Ring 3 code/data segments and a TSS for stack switching
 * on privilege-level transitions (Ring 3 → Ring 0 via syscall/interrupt).
 * @pattern Builder
 */

#include "gdt.h"
#include "serial.h"
#include "string.h"

/* ── TSS (Task State Segment) ────────────────────────────────── */

struct tss64 {
    uint32_t reserved0;
    uint64_t rsp0;       /* Ring 0 stack pointer — set on each context switch */
    uint64_t rsp1;
    uint64_t rsp2;
    uint64_t reserved1;
    uint64_t ist[7];     /* Interrupt Stack Table entries */
    uint64_t reserved2;
    uint16_t reserved3;
    uint16_t iopb_offset;
} __attribute__((packed));

static struct tss64 tss __attribute__((aligned(16)));

/* ── GDT Entries ─────────────────────────────────────────────── */

/* 5 regular entries + 1 TSS entry (16 bytes = 2 slots) = 7 uint64_t */
static uint64_t gdt[7] __attribute__((aligned(16)));

struct gdt_pointer {
    uint16_t limit;
    uint64_t base;
} __attribute__((packed));

static struct gdt_pointer gdtr;

/* ── Helpers ─────────────────────────────────────────────────── */

/* Build a 64-bit code/data segment descriptor */
static uint64_t _make_segment(uint8_t access, uint8_t flags) {
    /*
     * In long mode, base and limit are ignored for code/data segments.
     * We set base=0, limit=0xFFFFF, granularity=1 for compatibility.
     *
     * Access byte: P(1) DPL(2) S(1) E(1) DC(1) RW(1) A(1)
     * Flags nibble: G(1) DB(1) L(1) reserved(1)
     */
    uint64_t desc = 0;

    /* Limit 0-15 (bits 0-15) */
    desc |= 0xFFFF;
    /* Limit 16-19 (bits 48-51) */
    desc |= (uint64_t)0x0F << 48;

    /* Access byte (bits 40-47) */
    desc |= (uint64_t)access << 40;

    /* Flags nibble (bits 52-55): G=1, L=long mode flag, DB=0 for 64-bit */
    desc |= (uint64_t)(flags & 0x0F) << 52;

    return desc;
}

/* Build a TSS descriptor (16 bytes, spans two GDT slots) */
static void _make_tss_desc(uint64_t *lo, uint64_t *hi, uint64_t base, uint32_t limit) {
    *lo = 0;
    *hi = 0;

    /* Limit 0-15 */
    *lo |= (uint64_t)(limit & 0xFFFF);
    /* Base 0-15 */
    *lo |= ((base & 0xFFFF) << 16);
    /* Base 16-23 */
    *lo |= ((base >> 16) & 0xFF) << 32;
    /* Access: Present=1, DPL=0, type=0x9 (64-bit TSS available) */
    *lo |= (uint64_t)0x89 << 40;
    /* Limit 16-19 */
    *lo |= (uint64_t)((limit >> 16) & 0x0F) << 48;
    /* Flags: G=0 (byte granularity for TSS) */
    /* Base 24-31 */
    *lo |= ((base >> 24) & 0xFF) << 56;

    /* High 8 bytes: Base 32-63, reserved */
    *hi = (base >> 32) & 0xFFFFFFFF;
}

/* Assembly helpers */
static inline void _lgdt(struct gdt_pointer *p) {
    __asm__ volatile("lgdt (%0)" : : "r"(p) : "memory");
}

static inline void _ltr(uint16_t sel) {
    __asm__ volatile("ltr %0" : : "r"(sel));
}

static inline void _reload_segments(void) {
    /* Reload CS via far return, reload data segments directly */
    __asm__ volatile(
        "push $0x08\n\t"       /* Kernel CS */
        "lea 1f(%%rip), %%rax\n\t"
        "push %%rax\n\t"
        "lretq\n\t"
        "1:\n\t"
        "mov $0x10, %%ax\n\t"  /* Kernel DS */
        "mov %%ax, %%ds\n\t"
        "mov %%ax, %%es\n\t"
        "mov %%ax, %%fs\n\t"
        "mov %%ax, %%gs\n\t"
        "mov %%ax, %%ss\n\t"
        : : : "rax", "memory"
    );
}

/* ── Public API ──────────────────────────────────────────────── */

void gdt_init(void) {
    memset(&tss, 0, sizeof(tss));
    tss.iopb_offset = sizeof(tss); /* No I/O bitmap */

    /* Entry 0: Null descriptor */
    gdt[0] = 0;

    /* Entry 1 (0x08): Kernel Code — DPL=0, Executable, Readable, Present, Long mode */
    /* Access: P=1 DPL=00 S=1 E=1 DC=0 RW=1 A=0 = 0x9A */
    /* Flags:  G=1 DB=0 L=1 reserved=0 = 0xA (granularity + long mode) */
    gdt[1] = _make_segment(0x9A, 0x0A);

    /* Entry 2 (0x10): Kernel Data — DPL=0, Writable, Present */
    /* Access: P=1 DPL=00 S=1 E=0 DC=0 RW=1 A=0 = 0x92 */
    /* Flags:  G=1 DB=0 L=0 reserved=0 = 0x08 */
    gdt[2] = _make_segment(0x92, 0x08);

    /* Entry 3 (0x18): User Code — DPL=3, Executable, Readable, Present, Long mode */
    /* Access: P=1 DPL=11 S=1 E=1 DC=0 RW=1 A=0 = 0xFA */
    /* Flags:  G=1 DB=0 L=1 reserved=0 = 0x0A */
    gdt[3] = _make_segment(0xFA, 0x0A);

    /* Entry 4 (0x20): User Data — DPL=3, Writable, Present */
    /* Access: P=1 DPL=11 S=1 E=0 DC=0 RW=1 A=0 = 0xF2 */
    /* Flags:  G=1 DB=0 L=0 reserved=0 = 0x08 */
    gdt[4] = _make_segment(0xF2, 0x08);

    /* Entry 5-6 (0x28): TSS descriptor (16 bytes) */
    uint64_t tss_base = (uint64_t)&tss;
    uint32_t tss_limit = sizeof(tss) - 1;
    _make_tss_desc(&gdt[5], &gdt[6], tss_base, tss_limit);

    /* Load GDT */
    gdtr.limit = sizeof(gdt) - 1;
    gdtr.base  = (uint64_t)&gdt[0];
    _lgdt(&gdtr);

    /* Reload segment registers with new GDT */
    _reload_segments();

    /* Load TSS */
    _ltr(GDT_TSS_SEL);

    serial_print("[GDT] Loaded 5 segments + TSS (user-mode ready)\n");
    serial_print("  Kernel CS=0x08 DS=0x10\n");
    serial_print("  User   CS=0x1B DS=0x23\n");
    serial_print("  TSS    sel=0x28 base=");
    serial_print_hex(tss_base);
    serial_print("\n");
}

void gdt_set_kernel_stack(uint64_t rsp0) {
    tss.rsp0 = rsp0;
}
