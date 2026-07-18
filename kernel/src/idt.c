/* idt.c — Interrupt Descriptor Table for KHY OS * @pattern Builder
 */

#include "idt.h"
#include "serial.h"
#include "string.h"
#include "sched.h"
#include "process.h"
#include "agentevent.h"
#include "vmm.h"

#define IDT_ENTRIES 256

static struct idt_entry idt[IDT_ENTRIES];
static struct idt_ptr   idtp;

/* C handlers for IRQs 0-15 */
static irq_handler_t irq_handlers[16];

void idt_set_gate(uint8_t num, uint64_t handler, uint16_t selector, uint8_t type_attr) {
    idt[num].offset_low  = (uint16_t)(handler & 0xFFFF);
    idt[num].selector    = selector;
    idt[num].ist         = 0;
    idt[num].type_attr   = type_attr;
    idt[num].offset_mid  = (uint16_t)((handler >> 16) & 0xFFFF);
    idt[num].offset_high = (uint32_t)((handler >> 32) & 0xFFFFFFFF);
    idt[num].zero        = 0;
}

/* Exception names for debug output */
static const char *exception_names[] = {
    "Division Error",           /* 0 */
    "Debug",                    /* 1 */
    "NMI",                      /* 2 */
    "Breakpoint",               /* 3 */
    "Overflow",                 /* 4 */
    "Bound Range Exceeded",     /* 5 */
    "Invalid Opcode",           /* 6 */
    "Device Not Available",     /* 7 */
    "Double Fault",             /* 8 */
    "Coprocessor Segment",      /* 9 */
    "Invalid TSS",              /* 10 */
    "Segment Not Present",      /* 11 */
    "Stack-Segment Fault",      /* 12 */
    "General Protection Fault", /* 13 */
    "Page Fault",               /* 14 */
    "Reserved",                 /* 15 */
    "x87 FP Exception",        /* 16 */
    "Alignment Check",          /* 17 */
    "Machine Check",            /* 18 */
    "SIMD FP Exception",        /* 19 */
};

/* Print the shared fault diagnostic line(s): vector name, error code, faulting
 * RIP/CS, and CR2 for page faults. Used by both the user-fault and kernel-panic
 * paths so the two never drift. */
static void print_fault_detail(uint64_t vector, uint64_t error_code, uint64_t rip, uint64_t cs) {
    serial_print("Exception: ");
    if (vector < 20)
        serial_print(exception_names[vector]);
    else {
        serial_print("Unknown (#");
        serial_print_dec(vector);
        serial_print(")");
    }
    serial_print("\n");
    serial_print("Error code: ");
    serial_print_hex(error_code);
    serial_print("\n");
    serial_print("RIP: ");
    serial_print_hex(rip);
    serial_print("  CS: ");
    serial_print_hex(cs);
    serial_print((cs & 3) == 3 ? " (Ring 3)\n" : " (Ring 0)\n");
    if (vector == 14) {
        uint64_t cr2;
        __asm__ volatile("mov %%cr2, %0" : "=r"(cr2));
        serial_print("Faulting addr (CR2): ");
        serial_print_hex(cr2);
        serial_print("\n");
    }
}

/* Generic exception handler (called from ISR stubs).
 *
 * Fault isolation is what separates a real OS from a toy: an exception raised in
 * Ring 3 is the fault of an untrusted user process, not the kernel. Halting the
 * whole machine there would let any unprivileged program crash the entire OS by
 * dereferencing a bad pointer — a trivial denial of service. So a recoverable
 * Ring 3 fault terminates only the offending process and hands the CPU to
 * another task (no "KERNEL PANIC": the kernel is fine). Only a genuine Ring 0
 * fault — real kernel corruption — or an inherently unrecoverable vector
 * (NMI/Double-Fault/Machine-Check) escalates to a system halt. */
void exception_handler(uint64_t vector, uint64_t error_code, uint64_t rip, uint64_t cs) {
    int from_ring3   = ((cs & 3) == 3);
    int unrecoverable = (vector == 2 || vector == 8 || vector == 18);

    if (from_ring3 && !unrecoverable) {
        uint32_t pid = process_current_pid();
        if (pid != 0) {
            /* Demand paging: a not-present (#PF, error bit0=0) write into the
             * user stack window is not a bug — it's the stack growing past its
             * initially-mapped pages. Map the missing page and retry the
             * faulting instruction instead of killing the process. This is the
             * difference between a fixed-stack toy and a real OS that lets a
             * program recurse or allocate large local frames on demand. */
            if (vector == 14 && (error_code & 0x1) == 0) {
                uint64_t cr2;
                __asm__ volatile("mov %%cr2, %0" : "=r"(cr2));
                struct task *t = sched_current_task();
                if (t && t->space && vmm_grow_user_stack(t->space, cr2) == 0)
                    return; /* page mapped — resume the user instruction */
            }

            /* Copy-on-write: a write (#PF error bit1=1) to a present page that
             * fork() shared read-only is legitimate — give the writer a private
             * copy and retry. Only a genuine write to a truly read-only page
             * (vmm_cow_break returns 0) falls through to the kill path. */
            if (vector == 14 && (error_code & 0x1) && (error_code & 0x2)) {
                uint64_t cr2;
                __asm__ volatile("mov %%cr2, %0" : "=r"(cr2));
                struct task *t = sched_current_task();
                if (t && t->space && vmm_cow_break(t->space, cr2) == 1)
                    return; /* page copied/reclaimed — resume the user instruction */
            }

            /* A user process faulted: report it like a segfault and reap it.
             * The kernel keeps running, so this is NOT a panic. */
            serial_print("\n[FAULT] Ring 3 process pid=");
            serial_print_dec(pid);
            serial_print(" killed by ");
            serial_print(vector < 20 ? exception_names[vector] : "exception");
            serial_print("\n");
            print_fault_detail(vector, error_code, rip, cs);
            /* Event plane (stage A6): push a FAULT notification carrying the
             * trap vector before reaping. Enqueue-only (no I/O) and safe here
             * with interrupts already masked. The name/tid arrive with the
             * paired EXIT event posted by process_mark_exited(); the agent
             * correlates the two by pid. */
            agentevent_post(AGENTEVENT_FAULT, pid, 0, (int32_t)vector, (const char *)0);
            process_mark_exited(pid, (int)(128 + vector));
            task_exit(); /* marks zombie + switches away; never returns */
        }
    }

    /* Genuine kernel fault (Ring 0), an unrecoverable vector, or a fault before
     * the process layer exists: this is unrecoverable — halt the machine. */
    serial_print("\n!!! KERNEL PANIC !!!\n");
    print_fault_detail(vector, error_code, rip, cs);
    serial_print("System halted.\n");

    __asm__ volatile("cli");
    for (;;)
        __asm__ volatile("hlt");
}

/* Generic IRQ handler (called from ISR stubs) */
void irq_dispatch(uint64_t irq_num) {
    if (irq_num < 16 && irq_handlers[irq_num]) {
        irq_handlers[irq_num]();
    }
}

void irq_register_handler(uint8_t irq, irq_handler_t handler) {
    if (irq < 16)
        irq_handlers[irq] = handler;
}

/* Assembly ISR stubs (defined in isr.asm) */
extern void isr0(void);
extern void isr1(void);
extern void isr2(void);
extern void isr3(void);
extern void isr4(void);
extern void isr5(void);
extern void isr6(void);
extern void isr7(void);
extern void isr8(void);
extern void isr9(void);
extern void isr10(void);
extern void isr11(void);
extern void isr12(void);
extern void isr13(void);
extern void isr14(void);
extern void isr15(void);
extern void isr16(void);
extern void isr17(void);
extern void isr18(void);
extern void isr19(void);

/* IRQ stubs (vectors 32-47) */
extern void irq0(void);
extern void irq1(void);
extern void irq2(void);
extern void irq3(void);
extern void irq4(void);
extern void irq5(void);
extern void irq6(void);
extern void irq7(void);
extern void irq8(void);
extern void irq9(void);
extern void irq10(void);
extern void irq11(void);
extern void irq12(void);
extern void irq13(void);
extern void irq14(void);
extern void irq15(void);
extern void isr128(void);

void idt_init(void) {
    memset(idt, 0, sizeof(idt));
    memset(irq_handlers, 0, sizeof(irq_handlers));

    /* Code segment selector = 0x08 (first GDT entry after null) */
    uint16_t cs = 0x08;

    /* CPU exceptions (vectors 0-19) */
    idt_set_gate(0,  (uint64_t)isr0,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(1,  (uint64_t)isr1,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(2,  (uint64_t)isr2,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(3,  (uint64_t)isr3,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(4,  (uint64_t)isr4,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(5,  (uint64_t)isr5,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(6,  (uint64_t)isr6,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(7,  (uint64_t)isr7,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(8,  (uint64_t)isr8,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(9,  (uint64_t)isr9,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(10, (uint64_t)isr10, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(11, (uint64_t)isr11, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(12, (uint64_t)isr12, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(13, (uint64_t)isr13, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(14, (uint64_t)isr14, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(15, (uint64_t)isr15, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(16, (uint64_t)isr16, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(17, (uint64_t)isr17, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(18, (uint64_t)isr18, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(19, (uint64_t)isr19, cs, IDT_INTERRUPT_GATE);

    /* Hardware IRQs (vectors 32-47) */
    idt_set_gate(32, (uint64_t)irq0,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(33, (uint64_t)irq1,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(34, (uint64_t)irq2,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(35, (uint64_t)irq3,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(36, (uint64_t)irq4,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(37, (uint64_t)irq5,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(38, (uint64_t)irq6,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(39, (uint64_t)irq7,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(40, (uint64_t)irq8,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(41, (uint64_t)irq9,  cs, IDT_INTERRUPT_GATE);
    idt_set_gate(42, (uint64_t)irq10, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(43, (uint64_t)irq11, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(44, (uint64_t)irq12, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(45, (uint64_t)irq13, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(46, (uint64_t)irq14, cs, IDT_INTERRUPT_GATE);
    idt_set_gate(47, (uint64_t)irq15, cs, IDT_INTERRUPT_GATE);

    /* System call gate (int 0x80), callable from ring 3 */
    idt_set_gate(128, (uint64_t)isr128, cs, IDT_USER_INT_GATE);

    /* Load IDT */
    idtp.limit = sizeof(idt) - 1;
    idtp.base  = (uint64_t)&idt;
    __asm__ volatile("lidt (%0)" : : "r"(&idtp));

    serial_print("[IDT] Interrupt Descriptor Table loaded (");
    serial_print_dec(IDT_ENTRIES);
    serial_print(" entries)\n");
}
