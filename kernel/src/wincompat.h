/* wincompat.h — Windows API compatibility layer
 *
 * Provides a minimal subset of Windows API (kernel32.dll) functions
 * that can be resolved when loading PE executables. These functions
 * map Windows API calls to KHY OS kernel services.
 *
 * Supported functions:
 *   kernel32!GetStdHandle      → returns fixed handle constants
 *   kernel32!WriteConsoleA     → serial_print (maps to sys_write)
 *   kernel32!ExitProcess       → sys_exit
 *   kernel32!GetCommandLineA   → returns empty command line
 *   kernel32!GetLastError      → returns 0
 *   kernel32!SetLastError      → no-op
 *   kernel32!GetProcessHeap    → returns fixed heap handle
 *   kernel32!HeapAlloc         → kmalloc wrapper
 *   kernel32!HeapFree          → kfree wrapper
 * @pattern Adapter
 */
#ifndef WINCOMPAT_H
#define WINCOMPAT_H

#include <stdint.h>

/* Standard handle values (compatible with Windows) */
#define WIN_STD_INPUT_HANDLE  ((uint64_t)-10)
#define WIN_STD_OUTPUT_HANDLE ((uint64_t)-11)
#define WIN_STD_ERROR_HANDLE  ((uint64_t)-12)

/* Initialize the Windows compatibility layer */
void wincompat_init(void);

/* Resolve a Windows API function by DLL and function name.
 * Returns function pointer, or NULL if not supported. */
void *wincompat_resolve(const char *dll_name, const char *func_name);

/* List all supported Windows API functions (for diagnostics) */
void wincompat_list_supported(void);

#endif
