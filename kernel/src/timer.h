/* timer.h — PIT (Programmable Interval Timer) driver * @pattern Strategy
 */
#ifndef TIMER_H
#define TIMER_H

#include <stdint.h>

/* PIT runs at ~1.193182 MHz base frequency */
#define PIT_BASE_FREQ  1193182

/* Target tick frequency */
#define TIMER_HZ  100

/* Initialize PIT to fire at TIMER_HZ */
void timer_init(void);

/* Get current tick count */
uint64_t timer_get_ticks(void);

/* IRQ0 handler (called from ISR stub) */
void timer_handler(void);

/* Enable timer-driven preemptive scheduling. Call only after the scheduler
 * and initial tasks are set up (see kernel_main). */
void timer_enable_preemption(void);

#endif
