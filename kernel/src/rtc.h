/* rtc.h — CMOS real-time-clock wall clock * @pattern Strategy
 *
 * The PIT (timer.c) only counts ticks since boot — it cannot tell what the
 * actual date and time are. The CMOS RTC keeps wall-clock calendar time across
 * resets and is the source every real OS converts into Unix epoch seconds for
 * time()/gettimeofday() and file timestamps. This driver reads it on demand
 * (no IRQ, no init) and returns whole seconds since 1970-01-01 00:00:00 UTC.
 */
#ifndef RTC_H
#define RTC_H

#include <stdint.h>

/* Read the CMOS RTC and return Unix epoch seconds (UTC). The read is taken
 * consistently (it retries across an in-progress RTC update and re-reads until
 * two identical samples agree) and handles both BCD/binary and 12/24-hour CMOS
 * formats. The value is monotonic non-decreasing as wall time advances. */
uint64_t rtc_unix_time(void);

#endif
