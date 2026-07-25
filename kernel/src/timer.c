/* timer.c — PIT timer driver for KHY OS * @pattern Strategy
 */

#include "timer.h"
#include "pic.h"
#include "serial.h"
#include "sched.h"

#define PIT_CHANNEL0  0x40
#define PIT_CMD       0x43

static volatile uint64_t tick_count;

/* Preemption gate: stays 0 (off) until kernel_main has set up the scheduler
 * and the initial tasks, so an early timer tick cannot drive schedule() before
 * any task control blocks exist. Flipped on via timer_enable_preemption(). */
static volatile int preempt_enabled;

static inline void outb(uint16_t port, uint8_t val) {
    __asm__ volatile("outb %0, %1" : : "a"(val), "Nd"(port));
}

void timer_init(void) {
    tick_count = 0;

    /* Calculate divisor for desired frequency */
    uint16_t divisor = PIT_BASE_FREQ / TIMER_HZ;

    /* Channel 0, access mode lo/hi byte, mode 3 (square wave) */
    outb(PIT_CMD, 0x36);
    outb(PIT_CHANNEL0, (uint8_t)(divisor & 0xFF));        /* Low byte */
    outb(PIT_CHANNEL0, (uint8_t)((divisor >> 8) & 0xFF)); /* High byte */

    /* Unmask IRQ0 (timer) */
    pic_unmask_irq(0);

    serial_print("[TIMER] PIT initialized at ");
    serial_print_dec(TIMER_HZ);
    serial_print(" Hz\n");
}

void timer_handler(void) {
    tick_count++;

    /* Print heartbeat every 30 seconds to reduce serial jitter */
    if (tick_count % (TIMER_HZ * 30) == 0) {
        serial_print("[TIMER] Tick: ");
        serial_print_dec(tick_count);
        serial_print(" (");
        serial_print_dec(tick_count / TIMER_HZ);
        serial_print("s uptime)\n");
    }

    /* Acknowledge the IRQ BEFORE switching tasks. schedule() may not return
     * until this task is rescheduled (possibly far in the future); if the EOI
     * came after, the PIC would stay in-service and block all further timer
     * IRQs, so preemption would never recur. */
    pic_send_eoi(0);

    if (preempt_enabled)
        schedule();
}

void timer_enable_preemption(void) {
    preempt_enabled = 1;
}

uint64_t timer_get_ticks(void) {
    return tick_count;
}
