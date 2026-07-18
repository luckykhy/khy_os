/* moonbit_os_api.h — Stable C ABI exposed to MoonBit modules * @pattern Strategy
 */
#ifndef MOONBIT_OS_API_H
#define MOONBIT_OS_API_H

#include <stdint.h>

/* System */
uint64_t mb_os_uptime_ticks(void);
uint64_t mb_os_free_memory_kb(void);
uint64_t mb_os_total_memory_mb(void);
uint64_t mb_os_current_pid(void);

/* Filesystem */
int mb_os_fs_read(const char *path, char *out_buf, uint64_t max_len);
int mb_os_fs_write(const char *path, const char *text, uint64_t len, int append);

/* Network */
int mb_os_net_send(const char *buf, uint64_t len);
int mb_os_net_recv(char *buf, uint64_t max_len);

#endif
