/* moonbit_os_api.c — Stable C ABI exposed to MoonBit modules * @pattern Strategy
 */

#include "moonbit_os_api.h"
#include "net.h"
#include "pmm.h"
#include "process.h"
#include "string.h"
#include "timer.h"
#include "vfs.h"

uint64_t mb_os_uptime_ticks(void) {
    return timer_get_ticks();
}

uint64_t mb_os_free_memory_kb(void) {
    return pmm_free_memory() / 1024;
}

uint64_t mb_os_total_memory_mb(void) {
    return pmm_total_memory() / (1024 * 1024);
}

uint64_t mb_os_current_pid(void) {
    return process_current_pid();
}

int mb_os_fs_read(const char *path, char *out_buf, uint64_t max_len) {
    if (!path || !out_buf || max_len == 0)
        return -1;
    int n = vfs_read_file(path, out_buf, (size_t)(max_len - 1));
    if (n < 0)
        return n;
    out_buf[n] = '\0';
    return n;
}

int mb_os_fs_write(const char *path, const char *text, uint64_t len, int append) {
    if (!path || !text)
        return -1;
    return vfs_write_file(path, text, (size_t)len, append ? 1 : 0);
}

int mb_os_net_send(const char *buf, uint64_t len) {
    if (!buf || len == 0)
        return -1;
    return net_send(buf, (size_t)len);
}

int mb_os_net_recv(char *buf, uint64_t max_len) {
    if (!buf || max_len == 0)
        return -1;
    int n = net_recv(buf, (size_t)max_len);
    if (n > 0 && (uint64_t)n < max_len)
        buf[n] = '\0';
    return n;
}
