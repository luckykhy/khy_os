/* rtc.c — CMOS real-time-clock wall clock * @pattern Strategy
 */

#include "rtc.h"

/* CMOS index/data ports. Writing a register number to 0x70 selects it; the
 * value is then read from / written to 0x71. */
#define CMOS_ADDR 0x70
#define CMOS_DATA 0x71

/* CMOS register numbers (standard MC146818 layout). */
#define CMOS_SEC     0x00
#define CMOS_MIN     0x02
#define CMOS_HOUR    0x04
#define CMOS_DAY     0x07
#define CMOS_MONTH   0x08
#define CMOS_YEAR    0x09
#define CMOS_CENTURY 0x32
#define CMOS_STATUS_A 0x0A
#define CMOS_STATUS_B 0x0B

#define STATUS_A_UPDATE_IN_PROGRESS 0x80
#define STATUS_B_BINARY             0x04   /* set: values are binary, not BCD   */
#define STATUS_B_24HOUR             0x02   /* set: hour is 0-23, not 1-12 + AM/PM */
#define HOUR_PM_FLAG                0x80   /* in 12-hour mode, set on PM hours    */

static inline uint8_t inb(uint16_t port) {
    uint8_t val;
    __asm__ volatile("inb %1, %0" : "=a"(val) : "Nd"(port));
    return val;
}

static inline void outb(uint16_t port, uint8_t val) {
    __asm__ volatile("outb %0, %1" : : "a"(val), "Nd"(port));
}

static uint8_t cmos_read(uint8_t reg) {
    outb(CMOS_ADDR, reg);
    return inb(CMOS_DATA);
}

static int update_in_progress(void) {
    return cmos_read(CMOS_STATUS_A) & STATUS_A_UPDATE_IN_PROGRESS;
}

/* Days since 1970-01-01 for a proleptic-Gregorian civil date (Howard Hinnant's
 * algorithm). Correct for all leap-year rules; `m` is 1-12, `d` is 1-31. */
static int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= (m <= 2);
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    unsigned yoe = (unsigned)(y - era * 400);                 /* [0, 399]      */
    unsigned doy = (153u * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1; /* [0, 365] */
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;     /* [0, 146096]   */
    return era * 146097 + (int64_t)doe - 719468;
}

uint64_t rtc_unix_time(void) {
    uint8_t sec, min, hour, day, mon, year, cent;
    uint8_t last_sec, last_min, last_hour, last_day, last_mon, last_year, last_cent;
    uint8_t status_b;

    /* Take a consistent snapshot: wait out any in-progress update, sample every
     * field, then keep re-sampling until two consecutive reads agree — so the
     * clock cannot tick mid-read and hand back a torn time. Bounded so a stuck
     * RTC can never wedge the caller. */
    int guard = 1000000;
    while (update_in_progress() && --guard) { }

    sec  = cmos_read(CMOS_SEC);
    min  = cmos_read(CMOS_MIN);
    hour = cmos_read(CMOS_HOUR);
    day  = cmos_read(CMOS_DAY);
    mon  = cmos_read(CMOS_MONTH);
    year = cmos_read(CMOS_YEAR);
    cent = cmos_read(CMOS_CENTURY);

    guard = 1000;
    do {
        last_sec = sec; last_min = min; last_hour = hour;
        last_day = day; last_mon = mon; last_year = year; last_cent = cent;

        while (update_in_progress() && --guard) { }
        sec  = cmos_read(CMOS_SEC);
        min  = cmos_read(CMOS_MIN);
        hour = cmos_read(CMOS_HOUR);
        day  = cmos_read(CMOS_DAY);
        mon  = cmos_read(CMOS_MONTH);
        year = cmos_read(CMOS_YEAR);
        cent = cmos_read(CMOS_CENTURY);
    } while (--guard &&
             (sec != last_sec || min != last_min || hour != last_hour ||
              day != last_day || mon != last_mon || year != last_year ||
              cent != last_cent));

    status_b = cmos_read(CMOS_STATUS_B);

    /* The PM flag must be stripped from the hour BEFORE any BCD conversion, then
     * reapplied after, since it occupies the high bit of the raw register. */
    int pm = (hour & HOUR_PM_FLAG) != 0;
    hour &= ~HOUR_PM_FLAG;

    if (!(status_b & STATUS_B_BINARY)) {
        /* Values are BCD: each nibble is a decimal digit. */
        #define BCD2BIN(v) (uint8_t)(((v) & 0x0F) + (((v) >> 4) * 10))
        sec  = BCD2BIN(sec);
        min  = BCD2BIN(min);
        hour = BCD2BIN(hour);
        day  = BCD2BIN(day);
        mon  = BCD2BIN(mon);
        year = BCD2BIN(year);
        cent = BCD2BIN(cent);
        #undef BCD2BIN
    }

    if (!(status_b & STATUS_B_24HOUR)) {
        /* 12-hour mode: 12 AM is 0h, 12 PM is 12h, PM adds 12 otherwise. */
        if (hour == 12) hour = pm ? 12 : 0;
        else if (pm)    hour += 12;
    }

    /* Resolve a full four-digit year. Prefer the century register when it holds
     * a plausible value (some chips/emulators leave it zero); otherwise assume
     * the 2000s, matching every machine this kernel can run on today. */
    int full_year;
    if (cent >= 19 && cent <= 21)
        full_year = cent * 100 + year;
    else
        full_year = 2000 + year;

    int64_t days = days_from_civil(full_year, mon, day);
    return (uint64_t)(days * 86400 + hour * 3600 + min * 60 + sec);
}
