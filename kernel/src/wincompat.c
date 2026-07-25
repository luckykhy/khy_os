/* wincompat.c — Windows API compatibility layer for KHY OS
 *
 * Maps a minimal subset of Windows kernel32.dll functions to
 * KHY OS kernel services. When a PE binary imports a function
 * from kernel32.dll, the import resolver looks up the function
 * here and patches the IAT (Import Address Table) with our
 * compatibility function pointer.
 *
 * This is the hybrid kernel approach: PE loading and API
 * translation run in kernel space for performance, while the
 * actual user code runs in Ring 3.
 * @pattern Adapter
 */

#include "wincompat.h"
#include "serial.h"
#include "string.h"
#include "kheap.h"

/* ── Windows API Implementations ─────────────────────────────── */

static uint64_t win_GetStdHandle(uint64_t nStdHandle) {
    /* Return the handle as-is; we use fixed constants */
    return nStdHandle;
}

static int win_WriteConsoleA(uint64_t hConsoleOutput,
                             const char *lpBuffer,
                             uint32_t nNumberOfCharsToWrite,
                             uint32_t *lpNumberOfCharsWritten,
                             void *lpReserved) {
    (void)hConsoleOutput;
    (void)lpReserved;

    if (!lpBuffer || nNumberOfCharsToWrite == 0) {
        if (lpNumberOfCharsWritten)
            *lpNumberOfCharsWritten = 0;
        return 1;
    }

    /* Write to serial output (maps to the kernel's serial_print) */
    for (uint32_t i = 0; i < nNumberOfCharsToWrite; i++) {
        serial_putchar(lpBuffer[i]);
    }

    if (lpNumberOfCharsWritten)
        *lpNumberOfCharsWritten = nNumberOfCharsToWrite;

    return 1; /* Success (TRUE) */
}

static void win_ExitProcess(uint32_t uExitCode) {
    serial_print("[WINCOMPAT] ExitProcess(");
    serial_print_dec(uExitCode);
    serial_print(")\n");
    /* In a full implementation, this would call sys_exit.
     * For now, halt the current task. */
    for (;;) {
        __asm__ volatile("hlt");
    }
}

static const char *win_GetCommandLineA(void) {
    /* Return a minimal command line string */
    static const char cmdline[] = "program.exe";
    return cmdline;
}

static uint32_t win_GetLastError(void) {
    return 0; /* No error */
}

static void win_SetLastError(uint32_t dwErrCode) {
    (void)dwErrCode; /* No-op */
}

static uint64_t win_GetProcessHeap(void) {
    return 0x10000; /* Fixed heap handle */
}

static void *win_HeapAlloc(uint64_t hHeap, uint32_t dwFlags, uint64_t dwBytes) {
    (void)hHeap;
    (void)dwFlags;
    return kmalloc((size_t)dwBytes);
}

static int win_HeapFree(uint64_t hHeap, uint32_t dwFlags, void *lpMem) {
    (void)hHeap;
    (void)dwFlags;
    if (lpMem)
        kfree(lpMem);
    return 1; /* Success */
}

/* ── Function Resolution Table ───────────────────────────────── */

struct win_func_entry {
    const char *dll;
    const char *name;
    void *func;
};

/* Case-insensitive string comparison for DLL names */
static int _stricmp_limited(const char *a, const char *b) {
    while (*a && *b) {
        char ca = *a, cb = *b;
        if (ca >= 'A' && ca <= 'Z') ca += 32;
        if (cb >= 'A' && cb <= 'Z') cb += 32;
        if (ca != cb) return ca - cb;
        a++;
        b++;
    }
    return *a - *b;
}

static const struct win_func_entry win_functions[] = {
    { "kernel32.dll", "GetStdHandle",    (void *)win_GetStdHandle },
    { "kernel32.dll", "WriteConsoleA",   (void *)win_WriteConsoleA },
    { "kernel32.dll", "ExitProcess",     (void *)win_ExitProcess },
    { "kernel32.dll", "GetCommandLineA", (void *)win_GetCommandLineA },
    { "kernel32.dll", "GetLastError",    (void *)win_GetLastError },
    { "kernel32.dll", "SetLastError",    (void *)win_SetLastError },
    { "kernel32.dll", "GetProcessHeap",  (void *)win_GetProcessHeap },
    { "kernel32.dll", "HeapAlloc",       (void *)win_HeapAlloc },
    { "kernel32.dll", "HeapFree",        (void *)win_HeapFree },
    { 0, 0, 0 },
};

/* ── Public API ──────────────────────────────────────────────── */

void wincompat_init(void) {
    int count = 0;
    for (const struct win_func_entry *e = win_functions; e->dll; e++)
        count++;

    serial_print("[WINCOMPAT] Windows API compatibility layer ready (");
    serial_print_dec(count);
    serial_print(" functions)\n");
}

void *wincompat_resolve(const char *dll_name, const char *func_name) {
    if (!dll_name || !func_name)
        return 0;

    for (const struct win_func_entry *e = win_functions; e->dll; e++) {
        if (_stricmp_limited(e->dll, dll_name) == 0 &&
            strcmp(e->name, func_name) == 0) {
            return e->func;
        }
    }

    serial_print("[WINCOMPAT] Unresolved: ");
    serial_print(dll_name);
    serial_print("!");
    serial_print(func_name);
    serial_print("\n");
    return 0;
}

void wincompat_list_supported(void) {
    serial_print("[WINCOMPAT] Supported Windows API functions:\n");
    for (const struct win_func_entry *e = win_functions; e->dll; e++) {
        serial_print("  ");
        serial_print(e->dll);
        serial_print("!");
        serial_print(e->name);
        serial_print("\n");
    }
}
