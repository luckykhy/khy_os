/* moonbit_bridge.c — Bridge between kernel and MoonBit runtime
 *
 * MoonBit runtime (compiled with MOONBIT_NATIVE_NO_SYS_HEADER) expects
 * the following C symbols: putchar, write, malloc, realloc, free,
 * memset, memcpy, memmove, strlen, strcmp, strncmp, memcmp, exit, abort.
 *
 * Our kernel already provides most of these via kheap.c and string.c.
 * This file provides the remaining glue.
 * @pattern Bridge
 */

#include "serial.h"
#include "string.h"
#include "kheap.h"
#include <stdint.h>

/* === Standard C symbols needed by MoonBit runtime === */

/* putchar — used by moonbit_println to output UTF-16→UTF-8 characters */
int putchar(int c) {
    serial_putchar((char)c);
    return c;
}

/* write — used by moonbit_panic for stderr output */
long write(int fd, const void *buf, unsigned long n) {
    (void)fd;  /* kernel has no fd concept; always output to serial */
    const char *p = (const char *)buf;
    for (unsigned long i = 0; i < n; i++) {
        serial_putchar(p[i]);
    }
    return (long)n;
}

/* exit — MoonBit may call exit(1) on panic */
_Noreturn void exit(int status) {
    serial_print("[MOONBIT] exit(");
    serial_print_dec(status);
    serial_print(") called — halting.\n");
    __asm__ volatile("cli");
    for (;;) __asm__ volatile("hlt");
}

/* abort — MoonBit calls abort() on panic */
_Noreturn void abort(void) {
    serial_print("[MOONBIT] abort() called — halting.\n");
    __asm__ volatile("cli");
    for (;;) __asm__ volatile("hlt");
}

/* === MoonBit entry point wrapper === */

/* These are defined in the MoonBit-generated C code */
extern void moonbit_runtime_init(int argc, char **argv);
extern void moonbit_init(void);

/* The MoonBit-generated main() will be renamed to moonbit_main()
 * via a #define in the build system. We declare the wrapper here. */
extern int moonbit_entry(int argc, char **argv);

/* Call this from kernel_main to run MoonBit module */
void moonbit_kernel_run(void) {
    serial_print("[BRIDGE] Initializing MoonBit runtime...\n");

    /* MoonBit runtime_init just stores argc/argv, we pass dummy values */
    static char *dummy_argv[] = {"khy-os", (char *)0};
    moonbit_runtime_init(1, dummy_argv);

    /* Run MoonBit init and main */
    moonbit_init();
    serial_print("[BRIDGE] Running MoonBit kernel module...\n");
    moonbit_entry(1, dummy_argv);

    serial_print("[BRIDGE] MoonBit kernel module finished.\n");
}
